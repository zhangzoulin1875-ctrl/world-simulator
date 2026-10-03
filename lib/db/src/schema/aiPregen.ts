import {
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * AI 預產快取（v3 閒時預產）。背景 worker 在 AI 佇列閒置時，預先把
 * 「不急但重要」的 AI 判定（財政政策想法、政治政策想法）算好存在這裡；
 * 回合結算時輸入雜湊相符就直接取用，不再打 AI——把結算高峰的 AI 呼叫
 * 量移轉到閒時消化。玩家完全看不到本表內容，效果一律在結算當下才套用。
 *
 * 一國一種類一列（unique nation_id+kind）：想法被玩家改過 → 輸入雜湊
 * 不同 → 快取自動失效，worker 會重生成。
 */
export const aiPregenCacheTable = pgTable(
  "ai_pregen_cache",
  {
    id: serial("id").primaryKey(),
    /** 判定種類：fiscal_idea | politics_idea。 */
    kind: text("kind").notNull(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 生成當下所有 prompt 輸入的 SHA-256；結算時比對，不符即重打 AI。 */
    inputHash: text("input_hash").notNull(),
    /** AI 判定結果（與 judgeFiscalPolicyIdea / judgePolicyIdea 回傳同形）。 */
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationKindIdx: uniqueIndex("ai_pregen_cache_nation_kind_idx").on(
      t.nationId,
      t.kind,
    ),
  }),
);
