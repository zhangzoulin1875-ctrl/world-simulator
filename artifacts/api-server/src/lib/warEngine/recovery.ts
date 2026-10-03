import { db, playerWoundedUnitsTable } from "@workspace/db";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { getGameBalanceSettings } from "../gameBalance";
import { computeTurnRecovery } from "../war";
import { getRecoveryBonuses } from "./shared";

// ── 傷兵復原（全國傷兵池，回合制） ────────────────────────────────

let recoveryRunning = false;

/**
 * 全國傷兵池回合制線性復原：
 * 每回合復原 ceil(initial_wounded × pctPerTurn% × speedBonus)，
 * 封頂於現存 wounded。pctPerTurn 從 gameBalance.war.woundedRecoveryPctPerTurn
 * 讀取（預設 10，即 10 回合完全復原），可動態調整。
 * 由回合引擎（runTurnUpdate）在每日回合時呼叫。
 */
export async function recoveryTick(): Promise<void> {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    const settings = await getGameBalanceSettings();
    const pctPerTurn = settings.war.woundedRecoveryPctPerTurn;

    const rows = await db
      .select()
      .from(playerWoundedUnitsTable)
      .where(gt(playerWoundedUnitsTable.wounded, 0));
    const speedByUser = new Map<string, number>();
    for (const row of rows) {
      let speedPct = speedByUser.get(row.discordUserId);
      if (speedPct === undefined) {
        speedPct = (await getRecoveryBonuses(row.discordUserId)).speedPct;
        speedByUser.set(row.discordUserId, speedPct);
      }
      const recovered = computeTurnRecovery(
        row.initialWounded,
        row.wounded,
        speedPct,
        pctPerTurn,
      );
      if (recovered <= 0) continue;
      await db
        .update(playerWoundedUnitsTable)
        .set({
          wounded: sql`${playerWoundedUnitsTable.wounded} - ${recovered}`,
        })
        .where(
          and(
            eq(playerWoundedUnitsTable.id, row.id),
            sql`${playerWoundedUnitsTable.wounded} >= ${recovered}`,
          ),
        );
    }
    await db
      .delete(playerWoundedUnitsTable)
      .where(lte(playerWoundedUnitsTable.wounded, 0));
  } finally {
    recoveryRunning = false;
  }
}
