import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  generalDrawsTable,
  militaryUnitTemplatesTable,
  recruitProductionSpendsTable,
} from "@workspace/db";

/**
 * Task #568 — 招募「立即性生產力花費」的當回合判定 SQL 片段：
 * created_at > world_game_state.last_turn_at；last_turn_at 為 NULL（從未
 * 跑過回合）時全部視為當回合。回合引擎認領新回合後會刪除過期列，這個
 * 述詞是保險（引擎刪除與讀取之間的競態窗口、以及 force 回合）。
 */
const CURRENT_TURN_PREDICATE = sql`(
  (SELECT last_turn_at FROM world_game_state WHERE id = 1) IS NULL
  OR ${recruitProductionSpendsTable.createdAt} >
     (SELECT last_turn_at FROM world_game_state WHERE id = 1)
)`;

/** 可在交易內使用的 db/tx 共同介面（Drizzle transaction 與 db 同形）。 */
type DbLike = Pick<typeof db, "select">;

/**
 * 該國「本回合」招募花費合計（flow）。可傳入交易物件在
 * conditional-UPDATE 取得列鎖後讀取（同國序列化，競態安全）。
 */
export async function loadCurrentTurnRecruitSpend(
  nationId: string,
  dbc: DbLike = db,
): Promise<number> {
  // 武將系統 — 抽取/升階的生產力消耗同為當回合流量（general_draws.
  // production_spent），一併計入，讓所有可用生產力守衛自動涵蓋。
  const generalTurnPredicate = sql`(
    (SELECT last_turn_at FROM world_game_state WHERE id = 1) IS NULL
    OR ${generalDrawsTable.createdAt} >
       (SELECT last_turn_at FROM world_game_state WHERE id = 1)
  )`;
  const [recruitRow] = await dbc
    .select({
      total: sql<string>`COALESCE(SUM(${recruitProductionSpendsTable.amount}), 0)`,
    })
    .from(recruitProductionSpendsTable)
    .where(
      sql`${eq(recruitProductionSpendsTable.nationId, nationId)} AND ${CURRENT_TURN_PREDICATE}`,
    );
  const [generalRow] = await dbc
    .select({
      total: sql<string>`COALESCE(SUM(${generalDrawsTable.productionSpent}), 0)`,
    })
    .from(generalDrawsTable)
    .where(
      sql`${eq(generalDrawsTable.ownerNationId, nationId)} AND ${generalTurnPredicate}`,
    );
  return Number(recruitRow?.total ?? 0) + Number(generalRow?.total ?? 0);
}

/** 本回合招募花費的單筆紀錄（顯示用）。 */
export interface RecruitSpendLine {
  templateId: number;
  name: string;
  quantity: number;
  amount: number;
  createdAt: string;
}

/**
 * 該國「本回合」招募花費逐筆明細（新→舊），供數據面板展開顯示。
 */
export async function loadRecruitSpendLines(
  nationId: string,
): Promise<RecruitSpendLine[]> {
  const rows = await db
    .select({
      templateId: recruitProductionSpendsTable.templateId,
      name: militaryUnitTemplatesTable.name,
      quantity: recruitProductionSpendsTable.quantity,
      amount: recruitProductionSpendsTable.amount,
      createdAt: recruitProductionSpendsTable.createdAt,
    })
    .from(recruitProductionSpendsTable)
    .innerJoin(
      militaryUnitTemplatesTable,
      eq(militaryUnitTemplatesTable.id, recruitProductionSpendsTable.templateId),
    )
    .where(
      sql`${eq(recruitProductionSpendsTable.nationId, nationId)} AND ${CURRENT_TURN_PREDICATE}`,
    )
    .orderBy(desc(recruitProductionSpendsTable.createdAt));
  return rows.map((r) => ({
    templateId: r.templateId,
    name: r.name,
    quantity: r.quantity,
    amount: r.amount,
    createdAt: r.createdAt.toISOString(),
  }));
}
