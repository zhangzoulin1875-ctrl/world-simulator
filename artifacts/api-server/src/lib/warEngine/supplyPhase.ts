import { eq, inArray, sql } from "drizzle-orm";
import { playerNationsTable } from "@workspace/db";
import type { LoadedLegion } from "./shared";
import {
  allocateSupplyFill, collapseMoralePenalty, consumedFromStock, isSupplyCollapsed,
  legionSupplyDemand, nextSupplyState, rationFillFromFamine,
} from "../supply";

/** 交易型別：沿用 applyCycleResult 內 db.transaction 的 tx。 */
type Tx = Parameters<Parameters<typeof import("@workspace/db").db.transaction>[0]>[0];

export interface LegionSupplyOutcome {
  legionId: number;
  nationId: string;
  rationFill: number;
  ammoFill: number;
  supplyBefore: number;
  supplyAfter: number;
  collapsed: boolean;
}

export interface SupplyPhaseResult {
  outcomes: LegionSupplyOutcome[];
  /** 各國本週期實際扣掉的彈藥量。 */
  ammoSpentByNation: Record<string, number>;
}

/**
 * 補給階段：戰力計算「之前」執行。
 *  1. 鎖住所有參戰軍團所屬國家的資料列（FOR UPDATE，依 id 排序避免死結），重讀彈藥與饑荒。
 *     兩場戰役同時扣同一個國家的庫存時，後到的會等前一個提交，看到的是扣完後的庫存。
 *  2. 每個國家把名下所有軍團的需求加總，依庫存比例分配滿足度（與軍團順序無關）。
 *  3. 原子扣庫存（不扣成負數）、更新每個軍團的 supply，崩潰的軍團士氣額外暴跌。
 *
 * 就地修改傳入的 legion.supply / legion.morale（呼叫端稍後會把它們寫回資料庫），
 * 所以接下來的戰力計算看到的就是「這一輪」的補給狀態，不是上一輪的。
 *
 * 僱傭兵軍團不吃本國補給（他們自帶補給，租金已含在維護費），略過。
 */
export async function applySupplyPhase(
  tx: Tx,
  legions: readonly LoadedLegion[],
  eraSlug: string,
): Promise<SupplyPhaseResult> {
  const real = legions.filter((l) => !l.mercenary);
  const result: SupplyPhaseResult = { outcomes: [], ammoSpentByNation: {} };
  if (real.length === 0) return result;

  const nationIds = [...new Set(real.map((l) => l.nationId))].sort();
  // 依 id 排序鎖定，避免兩場戰役以相反順序互鎖。
  const locked = await tx
    .select({
      id: playerNationsTable.id,
      ammo: playerNationsTable.ammo,
      famine: playerNationsTable.consecutiveFamineTurns,
    })
    .from(playerNationsTable)
    .where(inArray(playerNationsTable.id, nationIds))
    .orderBy(playerNationsTable.id)
    .for("update");
  const stockOf = new Map(locked.map((r) => [r.id, Number(r.ammo)]));
  const famineOf = new Map(locked.map((r) => [r.id, Number(r.famine ?? 0)]));

  for (const nationId of nationIds) {
    const mine = real.filter((l) => l.nationId === nationId);
    const demands = mine.map((l) => legionSupplyDemand(l.units, eraSlug));
    const stock = stockOf.get(nationId) ?? 0;
    const ammoFills = allocateSupplyFill(demands.map((d) => d.ammo), stock);
    const rationFill = rationFillFromFamine(famineOf.get(nationId) ?? 0);

    mine.forEach((legion, i) => {
      const supplyBefore = legion.supply;
      const supplyAfter = nextSupplyState(supplyBefore, rationFill, ammoFills[i]!);
      legion.supply = supplyAfter;
      const collapsed = isSupplyCollapsed(supplyAfter);
      if (collapsed) legion.morale = Math.max(0, legion.morale - collapseMoralePenalty(supplyAfter));
      result.outcomes.push({
        legionId: legion.id, nationId, rationFill, ammoFill: ammoFills[i]!,
        supplyBefore, supplyAfter, collapsed,
      });
    });

    const spent = Math.floor(consumedFromStock(demands.map((d) => d.ammo), stock));
    if (spent > 0) {
      // 原子扣庫存；GREATEST 保底，即使資料列在鎖之後被別的程式改過也不會變負數。
      await tx
        .update(playerNationsTable)
        .set({ ammo: sql`GREATEST(0, ${playerNationsTable.ammo} - ${spent})` })
        .where(eq(playerNationsTable.id, nationId));
      result.ammoSpentByNation[nationId] = spent;
    }
  }
  return result;
}
