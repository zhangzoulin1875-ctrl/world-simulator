import { and, desc, gt, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  diplomacyWarsTable,
  diplomacyTreatiesTable,
  worldSimAuditsTable,
  politicsHistoryTable,
  playerNationsTable,
  worldGameStateTable,
  gameNewsTable,
} from "@workspace/db";
import { logger } from "./logger";
import {
  curateGameNews,
  type NewsCategory,
  type RawNewsEvent,
} from "./gameNewsAi";

/**
 * Task #184 — 每回合新聞編排。
 *
 * 於回合結算末段（世界模擬之後）呼叫。聚合「上次產生新聞之後（world_game_state
 * .last_news_at 游標）新增」的重大原始事件——玩家/NPC 宣戰、締結生效的條約、
 * 世界模擬（NPC 興亡／領土變動）、政變／政體更替——外加本回合是否推進時代，
 * 交給 bulk AI 挑重點改寫成繁中新聞條目寫入 game_news。
 *
 * 設計原則：
 * - 即使世界模擬（worldSim）關閉，仍會從其他來源聚合，照常產生新聞。
 * - 無任何來源事件時，不呼叫 AI，只推進 last_news_at 游標。
 * - 由呼叫端（turnEngine）以獨立 try/catch 包住；此函式內部任何失敗都不得阻斷回合。
 */

/** 保留最新幾則新聞（寫入後清舊）。 */
const NEWS_RETENTION = 200;
/** 單回合最多送給 AI 的原始事件數（成本上限）。 */
const MAX_RAW_EVENTS = 40;
/** 單回合最多產生幾則新聞。 */
const MAX_NEWS_ITEMS = 8;
/** 首回合（last_news_at 為 null）回溯窗：近 26 小時，避免翻出全部歷史。 */
const FIRST_WINDOW_MS = 26 * 60 * 60 * 1000;

const TREATY_TYPE_LABELS: Record<string, string> = {
  nonaggression: "互不侵犯條約",
  // Task #215 — 同盟條約已改制為聯盟；保留標籤以正確顯示歷史新聞事件。
  alliance: "同盟條約",
  military_access: "軍事通行權協定",
  guarantee: "保障獨立條約",
};

const POLITICS_EVENT_LABELS: Record<string, string> = {
  coup: "政變",
  government_change: "政體更替",
};

function nationName(
  map: Map<string, string | null>,
  id: string | null | undefined,
): string {
  if (!id) return "某國";
  return map.get(id) ?? "某國";
}

export async function runTurnNewsGeneration(params: {
  year: number;
  gameDate: string;
  era: string;
  eraLabel: string;
  eraChanged: boolean;
}): Promise<{ generated: number }> {
  const cursor = new Date();

  const [state] = await db
    .select({ lastNewsAt: worldGameStateTable.lastNewsAt })
    .from(worldGameStateTable)
    .where(sql`${worldGameStateTable.id} = 1`);
  const windowStart =
    state?.lastNewsAt ?? new Date(cursor.getTime() - FIRST_WINDOW_MS);

  // ── 聚合各來源原始事件 ──
  const [wars, treaties, audits, politics] = await Promise.all([
    db
      .select({
        nationAId: diplomacyWarsTable.nationAId,
        nationBId: diplomacyWarsTable.nationBId,
        declaredByNationId: diplomacyWarsTable.declaredByNationId,
      })
      .from(diplomacyWarsTable)
      .where(gt(diplomacyWarsTable.createdAt, windowStart)),
    db
      .select({
        proposerNationId: diplomacyTreatiesTable.proposerNationId,
        targetNationId: diplomacyTreatiesTable.targetNationId,
        type: diplomacyTreatiesTable.type,
      })
      .from(diplomacyTreatiesTable)
      .where(
        and(
          sql`${diplomacyTreatiesTable.status} = 'active'`,
          gt(diplomacyTreatiesTable.acceptedAt, windowStart),
        ),
      ),
    db
      .select({
        summary: worldSimAuditsTable.summary,
        changes: worldSimAuditsTable.changes,
      })
      .from(worldSimAuditsTable)
      .where(gt(worldSimAuditsTable.createdAt, windowStart)),
    db
      .select({
        nationId: politicsHistoryTable.nationId,
        eventType: politicsHistoryTable.eventType,
        title: politicsHistoryTable.title,
      })
      .from(politicsHistoryTable)
      .where(
        and(
          gt(politicsHistoryTable.createdAt, windowStart),
          inArray(politicsHistoryTable.eventType, ["coup", "government_change"]),
        ),
      ),
  ]);

  // 蒐集所有被引用的國家 id → 查名稱。
  const nationIds = new Set<string>();
  for (const w of wars) {
    nationIds.add(w.nationAId);
    nationIds.add(w.nationBId);
    nationIds.add(w.declaredByNationId);
  }
  for (const t of treaties) {
    nationIds.add(t.proposerNationId);
    nationIds.add(t.targetNationId);
  }
  for (const p of politics) nationIds.add(p.nationId);

  const nameMap = new Map<string, string | null>();
  if (nationIds.size > 0) {
    const rows = await db
      .select({ id: playerNationsTable.id, name: playerNationsTable.name })
      .from(playerNationsTable)
      .where(inArray(playerNationsTable.id, [...nationIds]));
    for (const r of rows) nameMap.set(r.id, r.name);
  }

  // ── 組成原始事件清單 ──
  const events: RawNewsEvent[] = [];

  if (params.eraChanged) {
    events.push({
      category: "era",
      fact: `世界推進至新時代「${params.eraLabel}」（西元 ${params.year} 年）。`,
    });
  }

  for (const w of wars) {
    const attacker = nationName(nameMap, w.declaredByNationId);
    const defenderId =
      w.declaredByNationId === w.nationAId ? w.nationBId : w.nationAId;
    const defender = nationName(nameMap, defenderId);
    events.push({
      category: "war",
      fact: `${attacker} 向 ${defender} 宣戰，兩國進入戰爭狀態。`,
    });
  }

  for (const t of treaties) {
    const label = TREATY_TYPE_LABELS[t.type] ?? "條約";
    events.push({
      category: "treaty",
      fact: `${nationName(nameMap, t.proposerNationId)} 與 ${nationName(
        nameMap,
        t.targetNationId,
      )} 締結${label}並生效。`,
    });
  }

  for (const p of politics) {
    const label = POLITICS_EVENT_LABELS[p.eventType] ?? "重大政治事件";
    events.push({
      category: "politics",
      fact: `${nationName(nameMap, p.nationId)} 發生${label}：${p.title}`,
    });
  }

  for (const a of audits) {
    const changes = Array.isArray(a.changes) ? a.changes : [];
    if (changes.length > 0) {
      for (const c of changes as Array<{
        action?: string;
        nationName?: string;
        detail?: string;
      }>) {
        const parts = [c.nationName, c.detail].filter(Boolean).join("：");
        events.push({
          category: "rise_fall",
          fact: parts || c.detail || a.summary,
        });
      }
    } else if (a.summary) {
      events.push({ category: "world", fact: a.summary });
    }
  }

  if (events.length === 0) {
    await advanceCursor(cursor);
    return { generated: 0 };
  }

  const curated = await curateGameNews({
    year: params.year,
    eraLabel: params.eraLabel,
    events: events.slice(0, MAX_RAW_EVENTS),
    maxItems: MAX_NEWS_ITEMS,
  });

  if (curated.length > 0) {
    await db.insert(gameNewsTable).values(
      curated.map((item) => ({
        gameDate: params.gameDate,
        year: params.year,
        era: params.era,
        category: item.category as NewsCategory,
        title: item.title,
        body: item.body,
      })),
    );
    await pruneNews();
  }

  await advanceCursor(cursor);
  logger.info(
    { rawEvents: events.length, generated: curated.length },
    "game news generated for turn",
  );
  return { generated: curated.length };
}

/** 推進新聞時間窗游標。 */
async function advanceCursor(cursor: Date): Promise<void> {
  await db
    .update(worldGameStateTable)
    .set({ lastNewsAt: cursor })
    .where(sql`${worldGameStateTable.id} = 1`);
}

/** 寫入後清舊，只保留最新 NEWS_RETENTION 則。 */
async function pruneNews(): Promise<void> {
  await db.execute(sql`
    DELETE FROM game_news
    WHERE id NOT IN (
      SELECT id FROM game_news
      ORDER BY created_at DESC
      LIMIT ${NEWS_RETENTION}
    )
  `);
}
