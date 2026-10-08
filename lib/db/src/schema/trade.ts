import {
  pgTable,
  uuid,
  text,
  bigint,
  doublePrecision,
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

/**
 * 黑市 — 各貨物的中間價(2026-10-08)。一貨物一列;查不到列 = 尚未交易過,
 * 以基準價當中間價(懶初始化,與糧食庫存同一套做法,不需要回填遷移)。
 * 玩家買賣推動 mid,回合引擎每回合向基準價回歸。
 */
export const marketPricesTable = pgTable("market_prices", {
  good: text("good").primaryKey(),
  mid: doublePrecision("mid").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * 黑市成交紀錄。同時是「本回合已用額度」的依據(自上次回合結算後的成交量加總)。
 * actor = player | npc;NPC 做市成交也記,方便稽核價格是誰推的。
 */
export const marketTradesTable = pgTable(
  "market_trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    good: text("good").notNull(),
    side: text("side").notNull(),
    qty: bigint("qty", { mode: "number" }).notNull(),
    /** 玩家總付出(買)/ 總收入(賣)。 */
    money: bigint("money", { mode: "number" }).notNull(),
    fee: bigint("fee", { mode: "number" }).notNull().default(0),
    midAfter: doublePrecision("mid_after").notNull(),
    actor: text("actor").notNull().default("player"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nationGoodIdx: index("market_trades_nation_good_idx").on(t.nationId, t.good, t.createdAt),
  }),
);

export type MarketPrice = typeof marketPricesTable.$inferSelect;
export type MarketTrade = typeof marketTradesTable.$inferSelect;
