import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * Task #501 — 「玩家操縱 NPC 未遂」紀錄。
 *
 * Task #499 的反操縱守門（sanitizeChatActions）在剔除 NPC 對話中的
 * 無對價讓利動作（送禮／交換）時，除了 server log 也持久化一筆事件，
 * 供管理員於 /world-sim 後台檢視「哪些玩家在嘗試操縱 NPC」。
 *
 * 名稱以快照保存（notNull），國家 id 為 nullable ON DELETE SET NULL —
 * 國家被刪除後紀錄仍可讀。全域保留最新 200 則（寫入時順手清舊，
 * 見 api-server lib/npcChatGuardLog.ts）。
 */
export const npcChatGuardEventsTable = pgTable(
  "npc_chat_guard_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 嘗試操縱的玩家國家（刪除後保留紀錄、id 置空）。 */
    playerNationId: uuid("player_nation_id").references(
      () => playerNationsTable.id,
      { onDelete: "set null" },
    ),
    /** 被嘗試操縱的 NPC 國家（刪除後保留紀錄、id 置空）。 */
    npcNationId: uuid("npc_nation_id").references(() => playerNationsTable.id, {
      onDelete: "set null",
    }),
    /** 玩家國家名稱快照（顯示用）。 */
    playerName: text("player_name").notNull(),
    /** NPC 國家名稱快照（顯示用）。 */
    npcName: text("npc_name").notNull(),
    /** 被擋下的動作類型（gift／exchange 等 ChatActionType）。 */
    actionType: text("action_type").notNull(),
    /** 守門剔除原因（zh-TW）。 */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdIdx: index("npc_chat_guard_events_created_idx").on(t.createdAt),
  }),
);

export type NpcChatGuardEvent = typeof npcChatGuardEventsTable.$inferSelect;
export type InsertNpcChatGuardEvent =
  typeof npcChatGuardEventsTable.$inferInsert;
