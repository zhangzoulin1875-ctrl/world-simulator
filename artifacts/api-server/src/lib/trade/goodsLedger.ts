import { eq, sql } from "drizzle-orm";
import { db, regionControlsTable, mapRegionsTable } from "@workspace/db";
import { TABLE_GOOD_SLUGS, type GoodSlug } from "./goods";

/**
 * 貨物帳本的寫入(貿易系統階段 1-D)。
 *
 * 累加一律用單一 SQL 原子完成(`stock = stock + n`),不先讀後寫:
 * 回合引擎與未來的交易、黑市可能並行改同一國的庫存,先讀後寫會互相覆蓋。
 * 只接受存在 nation_goods 的貨物(木材/礦石沿用 player_nations 欄位,
 * 糧食有自己的結算路徑 writeFoodStock),其餘一律忽略,避免雙帳。
 */

const ADDABLE: ReadonlySet<GoodSlug> = new Set(
  TABLE_GOOD_SLUGS.filter((g) => g !== "food"),
);

/** 把任意數字夾成非負整數(NaN/Infinity/負值歸 0,小數向下取整)。 */
export function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * 一次替一個國家累加多種貨物。回傳實際寫入的 {貨物: 數量}(已濾掉 0、
 * 不可累加的貨物)。沒有可寫的就不打資料庫。
 */
export async function addGoods(
  nationId: string,
  amounts: Partial<Record<GoodSlug, number>>,
): Promise<Partial<Record<GoodSlug, number>>> {
  const applied: Partial<Record<GoodSlug, number>> = {};
  const rows: { good: GoodSlug; n: number }[] = [];
  for (const g of Object.keys(amounts) as GoodSlug[]) {
    if (!ADDABLE.has(g)) continue;
    const n = toNonNegInt(amounts[g]);
    if (n <= 0) continue;
    rows.push({ good: g, n });
    applied[g] = n;
  }
  if (rows.length === 0) return applied;

  const values = sql.join(
    rows.map((r) => sql`(${nationId}::uuid, ${r.good}, ${r.n})`),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO nation_goods (nation_id, good, stock)
    VALUES ${values}
    ON CONFLICT (nation_id, good)
    DO UPDATE SET stock = nation_goods.stock + EXCLUDED.stock, updated_at = NOW()
  `);
  return applied;
}

/** 讀一國所有貨物庫存(測試與未來的市場畫面用;純讀取)。 */
export async function readGoods(
  nationId: string,
): Promise<Partial<Record<GoodSlug, number>>> {
  const res = await db.execute(
    sql`SELECT good, stock FROM nation_goods WHERE nation_id = ${nationId}::uuid`,
  );
  const out: Partial<Record<GoodSlug, number>> = {};
  for (const row of res.rows as { good: GoodSlug; stock: string | number }[]) {
    out[row.good] = Number(row.stock);
  }
  return out;
}

/**
 * 一國控制的地區(名稱 + 控制比例),與回合引擎特產產出用同一個條件
 * (percent > 0、以 map_regions.name 對特產表)。倉庫頁用,純讀取。
 */
export async function readControlledRegions(
  nationId: string,
): Promise<{ name: string; percent: number }[]> {
  const rows = await db
    .select({ name: mapRegionsTable.name, percent: regionControlsTable.percent })
    .from(regionControlsTable)
    .innerJoin(mapRegionsTable, eq(mapRegionsTable.id, regionControlsTable.regionId))
    .where(sql`${regionControlsTable.nationId} = ${nationId} AND ${regionControlsTable.percent} > 0`);
  return rows.map((r) => ({ name: r.name, percent: Number(r.percent) }));
}
