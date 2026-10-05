import { and, eq } from "drizzle-orm";
import { db, focusBranchesTable, focusBranchRootsTable } from "@workspace/db";
import { drawBranches } from "./branchDraw";
import { edgesFrom } from "./regimeGraph";

type Db = Pick<typeof db, "select">;
/** 呼叫端的交易(或 db 本身):需要 select / insert / execute */
type Tx = Pick<typeof db, "select" | "insert" | "execute">;

/** 讀出某國在某政體已抽到的分支目的地(沒抽過回傳 null)。 */
export async function readBranches(nationId: string, fromGovernment: string, conn: Db = db): Promise<string[] | null> {
  const rows = await conn
    .select({ to: focusBranchesTable.toGovernment })
    .from(focusBranchesTable)
    .where(and(eq(focusBranchesTable.nationId, nationId), eq(focusBranchesTable.fromGovernment, fromGovernment)));
  return rows.length > 0 ? rows.map((r) => r.to) : null;
}

/**
 * 取得(必要時才抽)某國在某政體的分支。
 *  - 抽過就沿用,**不重抽**;回到舊政體也沿用當初那批,避免繞一圈刷新分支破壞「隨機命運」。
 *  - 併發安全靠資料庫主鍵,不靠鎖:先 INSERT focus_branch_roots (nation, from) ON CONFLICT DO NOTHING RETURNING,
 *    只有「真的插入成功」的那個請求有權寫分支,其他請求讀取結果即可。
 *    (唯一索引只擋得住完全相同的列,擋不住各請求抽出不同組合而變成聯集,所以要有這個單一裁決者。)
 *  - 整段在同一個交易裡:標記與分支一起提交,不會出現「標記有了、分支還沒寫」被別人讀到空集合。
 *  - 出邊為 0 的政體不會寫任何列,直接回傳空陣列。
 *  - 已有 conn(呼叫端的交易)時沿用該交易,否則自己開一個。
 */
export async function ensureBranches(
  nationId: string,
  fromGovernment: string,
  rand: () => number = Math.random,
  conn?: Tx,
): Promise<string[]> {
  if (edgesFrom(fromGovernment).length === 0) return [];
  // 快路徑:已抽過就直接回傳(絕大多數呼叫都走這裡)
  const existing = await readBranches(nationId, fromGovernment, conn ?? db);
  if (existing) return existing;

  const run = async (tx: Tx): Promise<string[]> => {
    const won = await tx
      .insert(focusBranchRootsTable)
      .values({ nationId, fromGovernment })
      .onConflictDoNothing()
      .returning({ n: focusBranchRootsTable.nationId });
    if (won.length > 0) {
      // 我是唯一的寫入者
      const drawn = drawBranches(fromGovernment, rand);
      if (drawn.length > 0) {
        await tx.insert(focusBranchesTable).values(drawn.map((to) => ({ nationId, fromGovernment, toGovernment: to })));
      }
      return drawn;
    }
    // 別人搶先了(可能還沒提交):以資料庫現況為準。沒看到就稍等重讀,直到對方提交
    for (let i = 0; i < 40; i++) {
      const got = await readBranches(nationId, fromGovernment, tx);
      if (got) return got;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`focus branches for ${nationId}/${fromGovernment} not visible after waiting`);
  };
  return conn ? run(conn) : db.transaction(run);
}

/** 這條轉型(from -> to)在該國的樹上嗎?沒有抽過會先抽。 */
export async function isBranchAllowed(
  nationId: string,
  fromGovernment: string,
  toGovernment: string,
  rand: () => number = Math.random,
  conn?: Tx,
): Promise<boolean> {
  return (await ensureBranches(nationId, fromGovernment, rand, conn)).includes(toGovernment);
}
