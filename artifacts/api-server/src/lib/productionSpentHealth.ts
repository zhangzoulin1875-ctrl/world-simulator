import { shouldRunPeriodicWhenActive } from "./schedulerWake";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Task #560 — production_spent 幽靈佔用健檢。
 *
 * 不變量：player_nations.production_spent
 *   = Σ(player_armies.production_reserved) + Σ(region_buildings.production_reserved)
 *     + Σ(recruit_queue.production_reserved)（訓練佇列中尚未完成的訂單）。
 *
 * 佇列那一項不能漏：訂單在完成前，佔用放在 recruit_queue 而不在 player_armies，
 * 漏算會讓健檢把「訓練中的佔用」當成幽靈佔用下修，玩家平白多出可用生產力、
 * 可以無限囤單繞過生產力上限。
 *
 * 開機時的 reconcileNationProductionSpent 只會「往上補」（spent 太低時補到
 * Σ reserved）；反方向（spent 高於 Σ reserved，例如未來某條釋放路徑漏扣）
 * 不會被自動修復也不會被偵測——這種幽靈佔用會讓玩家的剩餘可用額度憑空
 * 變少、招募／購買被 409 擋下，且沒有任何 log 可追。
 *
 * 本模組比照 regionControlHealth：啟動後與每小時掃描 spent > Σ reserved 的
 * 國家，記 warning log（含國家與差額）。自動下修採兩道保險，避免誤修交易
 * 進行中的暫時狀態：
 *  1. 「持續存在」門檻：同一國家連續兩次掃描（相隔一小時）都超額才修復，
 *     第一次只記 warning。
 *  2. 修復本身在交易內先 SELECT ... FOR UPDATE 鎖住國家列、重新加總後
 *     再次確認仍超額才下修（所有 spend 路徑都在交易內以 conditional
 *     UPDATE 觸碰國家列，故取得列鎖後看到的一定是已提交的一致狀態）。
 *
 * Task #565 根因稽核（全數 army/building 刪減路徑）：徵召／購買／解散／
 * 範本刪除（路由與內閣）、建造／升級／拆除、退出／刪除國家皆已對稱調整
 * spent；戰死／逃兵／濫用懲處只減 quantity、不動 reserved（不變量不受影響，
 * 份額由日後解散時按比例釋放）。歷史幽靈佔用來自舊時代係數公式（已由
 * armyReservationRecalc 一次性對齊）；另補上退出路徑保留建築份額
 * （routes/player.ts quit），避免反向（spent < Σreserved）的低估。
 */

export type OverchargedNation = {
  nationId: string;
  nationName: string | null;
  discordUserId: string | null;
  productionSpent: number;
  armyReserved: number;
  buildingReserved: number;
  /** 訓練佇列中尚未完成訂單的佔用（完成後才轉入 player_armies）。 */
  queueReserved: number;
  /** 幽靈佔用量 = productionSpent − (army + building + queue) > 0。 */
  excess: number;
};

const HEALTH_INTERVAL_MS = 60 * 60 * 1000;
/** 純閒置時的保底間隔（毫秒）：拖再久也必須跑一次。 */
const MAX_DEFER_MS = 6 * 60 * 60 * 1000;

/** 掃描 player_nations，回傳 spent > Σ reserved 的國家與完整差額明細。 */
export async function findOverchargedProductionNations(): Promise<
  OverchargedNation[]
> {
  const result = await db.execute(sql`
    SELECT id, name, "discordUserId", spent, army, building, queue
    FROM (
      SELECT n.id,
             n.name,
             n.discord_user_id AS "discordUserId",
             n.production_spent AS spent,
             COALESCE((SELECT SUM(a.production_reserved) FROM player_armies a
                       WHERE a.discord_user_id = n.discord_user_id), 0) AS army,
             COALESCE((SELECT SUM(b.production_reserved) FROM region_buildings b
                       WHERE b.nation_id = n.id), 0) AS building,
             COALESCE((SELECT SUM(q.production_reserved) FROM recruit_queue q
                       WHERE q.nation_id = n.id), 0) AS queue
      FROM player_nations n
    ) t
    WHERE spent > army + building + queue
    ORDER BY id
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => {
    const productionSpent = Number(row["spent"]);
    const armyReserved = Number(row["army"]);
    const buildingReserved = Number(row["building"]);
    const queueReserved = Number(row["queue"]);
    return {
      nationId: String(row["id"]),
      nationName: row["name"] === null ? null : String(row["name"]),
      discordUserId:
        row["discordUserId"] === null ? null : String(row["discordUserId"]),
      productionSpent,
      armyReserved,
      buildingReserved,
      queueReserved,
      excess: productionSpent - armyReserved - buildingReserved - queueReserved,
    };
  });
}

export type RepairedNation = OverchargedNation & {
  /** 下修後的 production_spent（= 鎖內重新加總的 Σ reserved）。 */
  repairedTo: number;
};

/**
 * 單一國家的幽靈佔用修復：交易內 SELECT ... FOR UPDATE 鎖住國家列、
 * 重新加總 Σ reserved，仍超額才把 spent 下修到 Σ reserved。
 * 已被其他路徑修正（或掃描時看到的是暫時狀態）→ 回傳 null、不動資料。
 */
export async function repairOverchargedProductionNation(
  flagged: OverchargedNation,
): Promise<RepairedNation | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT production_spent AS spent, discord_user_id AS "discordUserId"
      FROM player_nations
      WHERE id = ${flagged.nationId}
      FOR UPDATE
    `);
    const nation = locked.rows[0] as
      | { spent: unknown; discordUserId: unknown }
      | undefined;
    if (!nation) return null; // 國家已被刪除

    const spent = Number(nation.spent);
    const sums = await tx.execute(sql`
      SELECT
        COALESCE((SELECT SUM(a.production_reserved) FROM player_armies a
                  WHERE a.discord_user_id = ${
                    nation.discordUserId === null
                      ? null
                      : String(nation.discordUserId)
                  }), 0) AS army,
        COALESCE((SELECT SUM(b.production_reserved) FROM region_buildings b
                  WHERE b.nation_id = ${flagged.nationId}), 0) AS building,
        COALESCE((SELECT SUM(q.production_reserved) FROM recruit_queue q
                  WHERE q.nation_id = ${flagged.nationId}), 0) AS queue
    `);
    const row = sums.rows[0] as { army: unknown; building: unknown; queue: unknown };
    const armyReserved = Number(row.army);
    const buildingReserved = Number(row.building);
    const queueReserved = Number(row.queue);
    const expected = armyReserved + buildingReserved + queueReserved;
    if (spent <= expected) return null; // 已被修正／掃描時為暫時狀態

    await tx.execute(sql`
      UPDATE player_nations
      SET production_spent = ${expected}
      WHERE id = ${flagged.nationId}
    `);

    return {
      nationId: flagged.nationId,
      nationName: flagged.nationName,
      discordUserId:
        nation.discordUserId === null ? null : String(nation.discordUserId),
      productionSpent: spent,
      armyReserved,
      buildingReserved,
      queueReserved,
      excess: spent - expected,
      repairedTo: expected,
    };
  });
}

export type ProductionSpentHealthTickResult = {
  /** 本次掃描到的所有超額國家（每一筆都已記 warning log）。 */
  flagged: OverchargedNation[];
  /** 連續兩次掃描皆超額、且鎖內複核仍超額而被下修的國家。 */
  repaired: RepairedNation[];
};

/**
 * 一次健檢：掃描 → 每個超額國家記 warning；上次也被掃到的國家
 * （previouslyFlagged）才進一步修復。回傳本次掃描結果供呼叫端保存
 * 為下一輪的 previouslyFlagged。
 */
export async function runProductionSpentHealthTick(
  previouslyFlagged: ReadonlySet<string>,
): Promise<ProductionSpentHealthTickResult> {
  const flagged = await findOverchargedProductionNations();
  const repaired: RepairedNation[] = [];

  for (const nation of flagged) {
    const persistent = previouslyFlagged.has(nation.nationId);
    logger.warn(
      {
        nationId: nation.nationId,
        nationName: nation.nationName,
        discordUserId: nation.discordUserId,
        productionSpent: nation.productionSpent,
        armyReserved: nation.armyReserved,
        buildingReserved: nation.buildingReserved,
        excess: nation.excess,
        persistent,
      },
      persistent
        ? "nation production_spent exceeds reserved sums (persisted across scans) — repairing"
        : "nation production_spent exceeds reserved sums (ghost reservation) — will repair if it persists",
    );
    if (!persistent) continue;

    const result = await repairOverchargedProductionNation(nation);
    if (result) {
      logger.warn(
        {
          nationId: result.nationId,
          nationName: result.nationName,
          productionSpent: result.productionSpent,
          repairedTo: result.repairedTo,
          excess: result.excess,
        },
        "nation production_spent ghost reservation repaired down to reserved sums",
      );
      repaired.push(result);
    }
  }

  return { flagged, repaired };
}

/** 啟動後 ~45 秒先掃一次（錯開 regionControlHealth 的 30 秒），之後每小時。 */
export function startProductionSpentHealthLoop(): void {
  let previouslyFlagged: ReadonlySet<string> = new Set();
  let lastRunAt = 0;
  const tick = () => {
    // 省電：小時健檢只在「Neon 本來就醒著」（有遊戲活動／剛結算）時跑；
    // 純閒置時最多拖到 6 小時保底必跑。健檢修正的是寫入造成的漂移，
    // 閒置時沒有寫入就不會有新漂移（見 schedulerWake.ts）。
    if (!shouldRunPeriodicWhenActive(lastRunAt, HEALTH_INTERVAL_MS, MAX_DEFER_MS)) {
      return;
    }
    lastRunAt = Date.now();
    runProductionSpentHealthTick(previouslyFlagged)
      .then((result) => {
        previouslyFlagged = new Set(result.flagged.map((n) => n.nationId));
      })
      .catch((err) =>
        logger.error({ err }, "production spent health tick failed"),
      );
  };
  setTimeout(tick, 45 * 1000);
  setInterval(tick, HEALTH_INTERVAL_MS);
  logger.info("production spent health loop started");
}
