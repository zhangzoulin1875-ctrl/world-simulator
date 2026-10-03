import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import type { MilitaryTechBonus } from "@workspace/db";
import { logger } from "./logger";
import { applyTechBonuses, unitProductionReservation } from "./military";
import { loadResearchedNodesByUser } from "./techTreeData";

/**
 * Task #557 — 一次性重算全部軍隊的生產力預留量（game_flags 原子認領，只跑一次）。
 *
 * 招募的生產力占用改與金錢購買同一條公式：
 *   ⌈數量 × 有效（含科技加成）prodUpkeepPerUnit ÷ 100⌉（unitProductionReservation），
 * 不再乘時代係數（舊 recruitProductionEraScale 已移除）。歷史軍隊列的
 * production_reserved 是用舊公式（prodCostPer100 × 時代係數）寫入的，這裡以
 * 新公式全部重算，並把每國 production_spent 重新對齊不變量
 * spent = Σ(軍隊 reserved) + Σ(建築 reserved)。
 *
 * population_reserved 與人口/金錢/木材/礦石成本不變，不在重算範圍。
 *
 * 執行順序：必須在 runMilitaryMigrations（軍隊/模板表）、runResourceMigrations
 * （region_buildings.production_reserved）、runDiplomacyMigrations（game_flags）
 * 與 runTechTreeMigrations（科技樹兩表——重算需查各玩家已研發軍事科技）之後。
 *
 * 整段包在單一交易內：任何失敗會連旗標認領一起回滾，下次開機重試。
 */
const FLAG = "army-prod-reserved-upkeep-basis-557";

export async function recalcArmyProductionReservations(): Promise<void> {
  // 先載科技（交易外的唯讀查詢）：各玩家已研發軍事科技的加成。
  const techsByUser = await loadResearchedNodesByUser("military");

  await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      INSERT INTO game_flags (key) VALUES (${FLAG})
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `);
    if (claimed.rows.length === 0) return;

    const armies = await tx.execute(sql`
      SELECT a.id,
             a.discord_user_id AS "userId",
             a.quantity,
             a.production_reserved AS "productionReserved",
             t.category,
             t.hp, t.attack, t.defense, t.speed, t.accuracy,
             t.prod_cost_per_100 AS "prodCostPer100",
             t.pop_cost_per_unit AS "popCostPerUnit",
             t.money_cost_per_unit AS "moneyCostPerUnit",
             t.upkeep_per_unit AS "upkeepPerUnit",
             t.prod_upkeep_per_unit AS "prodUpkeepPerUnit",
             t.wood_cost_per_unit AS "woodCostPerUnit",
             t.ore_cost_per_unit AS "oreCostPerUnit"
      FROM player_armies a
      JOIN military_unit_templates t ON t.id = a.template_id
    `);

    let recalced = 0;
    for (const row of armies.rows as Array<Record<string, unknown>>) {
      const userId = String(row["userId"]);
      const nodes = techsByUser.get(userId) ?? [];
      const techs = nodes.map((n) => ({
        bonuses: n.effects as MilitaryTechBonus[],
      }));
      const effective = applyTechBonuses(
        {
          category: String(row["category"]),
          hp: Number(row["hp"]),
          attack: Number(row["attack"]),
          defense: Number(row["defense"]),
          speed: Number(row["speed"]),
          accuracy: Number(row["accuracy"]),
          prodCostPer100: Number(row["prodCostPer100"]),
          popCostPerUnit: Number(row["popCostPerUnit"]),
          moneyCostPerUnit: Number(row["moneyCostPerUnit"]),
          upkeepPerUnit: Number(row["upkeepPerUnit"]),
          prodUpkeepPerUnit: Number(row["prodUpkeepPerUnit"]),
          woodCostPerUnit: Number(row["woodCostPerUnit"]),
          oreCostPerUnit: Number(row["oreCostPerUnit"]),
        },
        techs,
      );
      const reserved = unitProductionReservation(
        effective,
        Number(row["quantity"]),
      );
      if (reserved === Number(row["productionReserved"])) continue;
      await tx.execute(sql`
        UPDATE player_armies
        SET production_reserved = ${reserved}
        WHERE id = ${Number(row["id"])}
      `);
      recalced += 1;
    }

    // 全量對齊不變量 spent = Σ(軍隊 reserved) + Σ(建築 reserved)。
    // 舊公式（時代係數）灌出來的 spent 普遍偏高，這是唯一一次「往下調」的
    // 對齊；日常仍由 reconcileNationProductionSpent（只往上補）守住不變量。
    const realigned = await tx.execute(sql`
      UPDATE player_nations n
      SET production_spent =
        COALESCE((SELECT SUM(a.production_reserved) FROM player_armies a
                  WHERE a.discord_user_id = n.discord_user_id), 0)
        + COALESCE((SELECT SUM(b.production_reserved) FROM region_buildings b
                    WHERE b.nation_id = n.id), 0)
      WHERE n.production_spent <>
        COALESCE((SELECT SUM(a.production_reserved) FROM player_armies a
                  WHERE a.discord_user_id = n.discord_user_id), 0)
        + COALESCE((SELECT SUM(b.production_reserved) FROM region_buildings b
                    WHERE b.nation_id = n.id), 0)
      RETURNING n.id
    `);

    logger.info(
      { recalced, realignedNations: realigned.rows.length },
      "task #557: army production reservations recalculated to upkeep basis",
    );
  });
}
