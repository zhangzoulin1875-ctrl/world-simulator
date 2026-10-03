import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import {
  db,
  npcChatGuardEventsTable,
  type NpcChatGuardEvent,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * Task #501 — 「玩家操縱 NPC 未遂」事件的持久化與查詢。
 *
 * Task #499 的反操縱守門（sanitizeChatActions onReject）剔除讓利動作時，
 * 除了 req.log.warn 也寫入 npc_chat_guard_events，供管理員於 /world-sim
 * 後台檢視。寫入為 fire-and-forget：失敗只記 log，不影響對話主流程。
 */

/** 全域保留的事件上限（寫入時順手清舊，避免無限成長）。 */
export const NPC_CHAT_GUARD_EVENT_RETENTION = 200;

export type NewNpcChatGuardEvent = {
  playerNationId: string;
  npcNationId: string;
  playerName: string;
  npcName: string;
  actionType: string;
  reason: string;
};

/**
 * 寫入一筆被守門擋下的事件，並清掉超過保留上限的舊事件。
 * 保留清理用子查詢一次完成，不需交易 — 併發下各自多刪／少刪一列無礙
 * （下次寫入會再修正），比照 playerNotify.ts 的通知保留模式。
 */
export async function recordNpcChatGuardEvent(
  e: NewNpcChatGuardEvent,
): Promise<void> {
  await db.insert(npcChatGuardEventsTable).values({
    playerNationId: e.playerNationId,
    npcNationId: e.npcNationId,
    playerName: e.playerName,
    npcName: e.npcName,
    actionType: e.actionType,
    reason: e.reason,
  });
  await db.execute(sql`
    DELETE FROM npc_chat_guard_events
    WHERE id NOT IN (
      SELECT id FROM npc_chat_guard_events
      ORDER BY created_at DESC, id DESC
      LIMIT ${NPC_CHAT_GUARD_EVENT_RETENTION}
    )
  `);
}

/** fire-and-forget 寫入（對話路徑用；失敗只記 log，不影響回覆）。 */
export function recordNpcChatGuardEventInBackground(
  e: NewNpcChatGuardEvent,
): void {
  recordNpcChatGuardEvent(e).catch((err) => {
    logger.warn(
      { err, playerNationId: e.playerNationId, npcNationId: e.npcNationId },
      "npc chat guard event write failed",
    );
  });
}

/** 依玩家篩選事件清單的可選條件（Task #505）。 */
export type NpcChatGuardEventFilter = {
  /** 精確比對玩家國家 id（uuid）。 */
  playerNationId?: string;
  /** 玩家名稱子字串（不分大小寫）。 */
  playerName?: string;
};

/** 把使用者輸入的名稱子字串跳脫成安全的 ILIKE pattern。 */
function toIlikePattern(input: string): string {
  return `%${input.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function buildFilterCondition(
  filter?: NpcChatGuardEventFilter,
): SQL | undefined {
  const conds: SQL[] = [];
  if (filter?.playerNationId) {
    conds.push(eq(npcChatGuardEventsTable.playerNationId, filter.playerNationId));
  }
  if (filter?.playerName) {
    conds.push(
      ilike(npcChatGuardEventsTable.playerName, toIlikePattern(filter.playerName)),
    );
  }
  if (conds.length === 0) return undefined;
  return conds.length === 1 ? conds[0] : and(...conds);
}

/** 最近事件清單（新→舊，至多保留上限筆；可選依玩家篩選，篩選在 DB 端做）。 */
export async function listNpcChatGuardEvents(
  filter?: NpcChatGuardEventFilter,
): Promise<NpcChatGuardEvent[]> {
  const cond = buildFilterCondition(filter);
  const base = db.select().from(npcChatGuardEventsTable);
  const query = cond ? base.where(cond) : base;
  return query
    .orderBy(
      desc(npcChatGuardEventsTable.createdAt),
      desc(npcChatGuardEventsTable.id),
    )
    .limit(NPC_CHAT_GUARD_EVENT_RETENTION);
}

/** 每玩家嘗試次數摘要（Task #505）。 */
export type NpcChatGuardPlayerSummary = {
  playerNationId: string | null;
  playerName: string;
  count: number;
};

/**
 * 統計保留窗口內（最近 200 則）每個玩家的被擋次數，次數多→少排序。
 * 以 playerNationId 分組（國家已刪除、id 置空者以名稱分組），
 * 名稱取該組最新一筆的快照。
 */
export async function summarizeNpcChatGuardEventsByPlayer(): Promise<
  NpcChatGuardPlayerSummary[]
> {
  const result = await db.execute(sql`
    SELECT
      player_nation_id AS "playerNationId",
      (ARRAY_AGG(player_name ORDER BY created_at DESC, id DESC))[1]
        AS "playerName",
      COUNT(*)::int AS "count"
    FROM npc_chat_guard_events
    GROUP BY player_nation_id, CASE WHEN player_nation_id IS NULL THEN player_name ELSE NULL END
    ORDER BY COUNT(*) DESC, MAX(created_at) DESC
  `);
  return (result.rows as NpcChatGuardPlayerSummary[]).map((r) => ({
    playerNationId: r.playerNationId,
    playerName: r.playerName,
    count: Number(r.count),
  }));
}
