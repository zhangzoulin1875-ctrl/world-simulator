import { db, nationFinanceLedgerTable } from "@workspace/db";
import type { FinanceLedgerCategory } from "./economy";

/**
 * 財政流水寫入工具（Task #117）。
 *
 * 外交與內政「事件」造成的金錢收支（外交贈禮、條約款項、政變損失、
 * 財政政策一次性金錢…；內政政策已禁止直接動錢，policy_penalty 類別僅
 * 供歷史帳目顯示）在來源處已即時變動 money；本工具僅
 * 額外寫入一筆「純顯示用」流水，回合結算絕不再次套用到 money（避免重複
 * 計算）。因此必須與來源的金錢變動在同一交易內呼叫（傳入該交易的 tx）。
 */

type Db = typeof db;
/** drizzle 交易物件型別（與 db 共用 query builder 介面）。 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** 可執行寫入的目標：db 本身或一個交易。 */
export type LedgerExecutor = Db | Tx;

/**
 * 寫入一筆財政流水。amount 為有號值（正 = 收入、負 = 支出）；amount === 0
 * 直接略過（不寫零額列）。務必傳入與金錢變動同一交易的 exec。
 */
export async function recordFinanceLedger(
  exec: LedgerExecutor,
  entry: {
    nationId: string;
    category: FinanceLedgerCategory;
    amount: number;
    description: string;
  },
): Promise<void> {
  const amount = Math.trunc(entry.amount);
  if (amount === 0) return;
  await exec.insert(nationFinanceLedgerTable).values({
    nationId: entry.nationId,
    category: entry.category,
    amount,
    description: entry.description,
  });
}
