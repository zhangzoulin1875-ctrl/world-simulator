import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * 貿易系統 — 各國貨物庫存(2026-10-08)。
 *
 * 一國一貨物一列(複合主鍵)。木材與礦石沿用 player_nations.wood / ore,
 * 不存在這裡(避免雙帳);糧食庫存化後存在這裡。
 * 不在 player_nations 加欄位:啟動遷移順序踩過坑(見專案筆記 backlog 第 5 項)。
 *
 * stock 一律非負整數(CHECK),由 lib/trade/stock.ts 的純函式算出後寫入。
 */
export const nationGoodsTable = pgTable(
  "nation_goods",
  {
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** GoodSlug(lib/trade/goods.ts):food | ironcoal | oil | rare | spice | cloth */
    good: text("good").notNull(),
    stock: bigint("stock", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.nationId, t.good] }),
    goodIdx: index("nation_goods_good_idx").on(t.good),
  }),
);

export type NationGoods = typeof nationGoodsTable.$inferSelect;
