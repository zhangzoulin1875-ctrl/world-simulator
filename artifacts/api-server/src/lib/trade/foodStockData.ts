import { and, eq, sql } from "drizzle-orm";
import { db, nationGoodsTable } from "@workspace/db";
import { initialFoodStock } from "./stock";
import { logger } from "../logger";

/**
 * 糧食庫存的資料存取(貿易系統階段 1-C)。
 *
 * 懶初始化:查不到 food 庫存列 = 尚未初始化,以「6 回合消耗」當期初庫存。
 * 這樣既有國家、新建國家、NPC、內戰分裂出的國家全部自動涵蓋,
 * 不需要改 5 個建國路徑,也不需要一次性回填遷移。
 *
 * 讀取函式(readFoodStock)絕不寫入:顯示路由與 AI 內閣會頻繁呼叫,
 * 玩家每刷新一次頁面都不能讓庫存多結算一次。唯一的寫入點是回合引擎
 * 呼叫 writeFoodStock。
 */

export interface FoodStockRead {
  /** 目前庫存(尚未初始化時為期初庫存推算值)。 */
  stock: number;
  /** 資料庫裡是否已有這一列;false = 推算值,回合結算時會建立。 */
  initialized: boolean;
}

/** 純讀取。consumptionPerTurn 用於尚未初始化時推算期初庫存。 */
export async function readFoodStock(
  nationId: string,
  consumptionPerTurn: number,
): Promise<FoodStockRead> {
  let rows: { stock: unknown }[];
  try {
    rows = await db
      .select({ stock: nationGoodsTable.stock })
      .from(nationGoodsTable)
      .where(
        and(eq(nationGoodsTable.nationId, nationId), eq(nationGoodsTable.good, "food")),
      )
      .limit(1);
  } catch (err) {
    // 表或欄位缺失(遷移尚未跑完)時退回期初庫存推算,絕不讓「讀國家」整個失敗。
    // 這正是 ammo 欄位事故的教訓:新增的讀取路徑不能成為單點故障。
    logger.error({ err, nationId }, "food stock read failed, using initial estimate");
    return { stock: initialFoodStock(consumptionPerTurn), initialized: false };
  }
  if (rows.length === 0) {
    return { stock: initialFoodStock(consumptionPerTurn), initialized: false };
  }
  return { stock: Math.max(0, Math.floor(Number(rows[0]!.stock))), initialized: true };
}

/**
 * 寫入結算後的庫存(回合引擎專用,唯一寫入點)。UPSERT:第一次結算同時完成初始化。
 * stock 必須是非負整數(settleFoodStock 保證);這裡再夾一次當保險,
 * 避免小數寫進 bigint 欄位(曾因厭戰度小數造成整條 UPDATE 失敗)。
 */
export async function writeFoodStock(nationId: string, stock: number): Promise<void> {
  const safe = Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0;
  await db
    .insert(nationGoodsTable)
    .values({ nationId, good: "food", stock: safe })
    .onConflictDoUpdate({
      target: [nationGoodsTable.nationId, nationGoodsTable.good],
      set: { stock: safe, updatedAt: sql`NOW()` },
    });
}
