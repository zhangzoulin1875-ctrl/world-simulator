import {
  noteGameActivity,
  registerSchedulerWake,
  skipIfNotDue,
  toMs,
} from "./schedulerWake";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
// 循環引用（diplomacyNotify 也 import treatyTypeLabel）安全：雙方都只在
// 執行期函式內使用對方的匯出，模組載入時不會互相取值。
import {
  notifyTreatyExpired,
  notifyTreatyExpiringSoon,
} from "./diplomacyNotify";

/**
 * Task #34 — 外交系統純邏輯與到期迴圈。
 * 純函式（canonical pair、關係值夾限、距離 BFS）拆在這裡供單元測試。
 */

// ── 條約類型 ───────────────────────────────────────────────────

export const TREATY_TYPES = [
  {
    slug: "nonaggression",
    label: "互不侵犯條約",
    description: "生效期間雙方無法互相宣戰。",
  },
  {
    slug: "military_access",
    label: "軍事通行權",
    description: "目前尚無實際效果。",
  },
  {
    slug: "guarantee",
    label: "保障獨立",
    description: "提案方保障對方獨立：對方被宣戰時，提案方自動參戰。",
  },
  {
    slug: "vassal",
    label: "附庸條約",
    description:
      "一方成為另一方的附庸：附庸每回合上繳稅收的一定比例作為貢金；雙方強制和平；附庸被宣戰時宗主自動參戰；附庸的宣戰與聯盟行動需經宗主同意。",
  },
  {
    slug: "custom",
    label: "自訂條約",
    description:
      "自由約定條款文字，並可設定每回合經常性轉移（金錢／科技點數／生產力）。",
  },
] as const;

export type TreatyType = (typeof TREATY_TYPES)[number]["slug"];

export function isTreatyType(v: unknown): v is TreatyType {
  return (
    typeof v === "string" && TREATY_TYPES.some((t) => t.slug === v)
  );
}

/**
 * Task #215 — 已停用的歷史條約類型標籤（同盟條約已改制為聯盟）。
 * 現行 TREATY_TYPES 不再包含 alliance，但資料庫仍留有歷史（已退場／被拒）的
 * alliance 條約列；顯示時給它一個可讀標籤，避免直接露出 slug。
 */
const LEGACY_TREATY_LABELS: Record<string, string> = {
  alliance: "同盟條約（已停用）",
};

export function treatyTypeLabel(slug: string): string {
  return (
    TREATY_TYPES.find((t) => t.slug === slug)?.label ??
    LEGACY_TREATY_LABELS[slug] ??
    slug
  );
}

// ── 關係值操作 ─────────────────────────────────────────────────

export const RELATION_MIN = -100;
export const RELATION_MAX = 100;

/** 關係值夾限在 −100～100。 */
export function clampRelationScore(score: number): number {
  return Math.max(RELATION_MIN, Math.min(RELATION_MAX, score));
}

/**
 * Task #228 — 每次 AI 對話／條約談判判定的「單次關係值增減」夾限（−20～+20）。
 * 純函式，可單元測試；非有限數字回 0，並取整。實際套用時再與總分一起以
 * clampRelationScore 夾在 −100～100。
 */
export const CHAT_RELATION_DELTA_MIN = -20;
export const CHAT_RELATION_DELTA_MAX = 20;

export function clampChatRelationDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  return Math.max(
    CHAT_RELATION_DELTA_MIN,
    Math.min(CHAT_RELATION_DELTA_MAX, Math.trunc(delta)),
  );
}

/**
 * Task #499 — 「純文字對話」可獲得的正向關係值上限（伺服器端硬性守門）。
 * 對話本身沒有實際利益轉移（送禮／條約等真實行動各有自己的關係事件與 delta），
 * 嘴甜不該洗出高關係值：正向壓到極小上限；負向（挑釁、羞辱）維持原範圍
 * −20，嘴賤照樣扣。不信任 AI 自律——就算 prompt 被繞過，這裡也鎖死。
 */
export const CHAT_TALK_POSITIVE_DELTA_MAX = 3;

/** Task #499 — 對話關係值增減的伺服器端夾限：正向 ≤ +3、負向照舊 −20。 */
export function clampChatTalkRelationDelta(delta: number): number {
  return Math.min(clampChatRelationDelta(delta), CHAT_TALK_POSITIVE_DELTA_MAX);
}

/** Task #228 — 每回合每位玩家與 AI（NPC）對話的總量上限（所有 NPC 合計）。 */
export const AI_CHAT_TURN_CAP = 5;

export const RELATION_ACTIONS = {
  embassy: { label: "派遣大使館", delta: 10 },
  gift: { label: "送禮", delta: 10 },
  insult: { label: "送出污辱", delta: -20 },
  withdraw: { label: "撤回外交官", delta: -40 },
} as const;

export type RelationAction = keyof typeof RELATION_ACTIONS;

/** 廢除生效中條約造成的關係值下降幅度（Task #49）。 */
export const TREATY_ANNUL_RELATION_PENALTY = 30;

/**
 * 系統／衍生關係事件：不是玩家在「交流」分頁主動觸發的親善操作，而是
 * 廢約、宣戰等行為的副作用。與 RELATION_ACTIONS 分開，避免這些類型
 * 意外通過 isRelationAction 而能被 /action 端點直接呼叫（會亂扣分）。
 * delta 僅供互動紀錄顯示用，實際扣分仍在各自路由內處理。
 */
export const SYSTEM_RELATION_ACTIONS = {
  annul_treaty: { label: "廢除生效中條約", delta: -TREATY_ANNUL_RELATION_PENALTY },
  declare_war: { label: "宣戰", delta: 0 },
  // Task #228 — 與 NPC 對話／條約談判時 AI 判定的關係變化（實際 delta 逐次不同，
  // 此處 0 僅為顯示占位；事件表不儲存 delta）。
  chat: { label: "對話往來", delta: 0 },
  treaty_negotiation: { label: "條約談判", delta: 0 },
} as const;

export type SystemRelationAction = keyof typeof SYSTEM_RELATION_ACTIONS;

export function isRelationAction(v: unknown): v is RelationAction {
  return typeof v === "string" && v in RELATION_ACTIONS;
}

/**
 * 查出任一 action（玩家親善或系統衍生）的 zh-TW 標籤與 delta，供互動紀錄
 * 端點顯示。未知 action 回 null（呼叫端 fallback 到原始字串、delta 0）。
 */
export function describeRelationAction(
  action: string,
): { label: string; delta: number } | null {
  if (action in RELATION_ACTIONS) {
    return RELATION_ACTIONS[action as RelationAction];
  }
  if (action in SYSTEM_RELATION_ACTIONS) {
    return SYSTEM_RELATION_ACTIONS[action as SystemRelationAction];
  }
  return null;
}

/** 送禮成本：當前金錢的 5%（無收入概念前的暫行規則），至少 1。 */
export function giftCost(currentMoney: number): number {
  return Math.max(1, Math.floor(currentMoney * 0.05));
}

/**
 * Canonical pair：uuid 字串比較，小的在前。關係值與交戰列都以此排序存放，
 * 確保同一對國家只有一列。
 */
export function canonicalPair(
  a: string,
  b: string,
): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

// ── 距離排序（BFS） ────────────────────────────────────────────

/**
 * 多源 BFS：從自己掌控的地區出發，依陸地鄰接計算每個地區的最短距離。
 * 回傳 Map<regionId, hops>（自己的地區為 0）。
 */
export function bfsRegionDistances(
  myRegionIds: number[],
  adjacency: Map<number, number[]>,
): Map<number, number> {
  const dist = new Map<number, number>();
  const queue: number[] = [];
  for (const id of myRegionIds) {
    if (!dist.has(id)) {
      dist.set(id, 0);
      queue.push(id);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const d = dist.get(cur)!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

/**
 * 一個國家與請求者的距離 = 該國掌控地區到請求者地區集合的最小 BFS 距離。
 * 無法判定（自己或對方無地區、或不連通）回 null → 排序時放最後。
 */
export function nationDistance(
  nationRegionIds: number[],
  distances: Map<number, number>,
): number | null {
  let best: number | null = null;
  for (const id of nationRegionIds) {
    const d = distances.get(id);
    if (d !== undefined && (best === null || d < best)) best = d;
  }
  return best;
}

/** 排序比較：距離近在前、無法判定最後、同距離按名稱。 */
export function compareByDistance(
  a: { distance: number | null; name: string },
  b: { distance: number | null; name: string },
): number {
  if (a.distance === null && b.distance === null)
    return a.name.localeCompare(b.name, "zh-TW");
  if (a.distance === null) return 1;
  if (b.distance === null) return -1;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.name.localeCompare(b.name, "zh-TW");
}

// ── NPC 重提冷卻（Task #72） ───────────────────────────────────

/**
 * 對 NPC 對象的重提冷卻時間：同一對國家的提案被拒絕或撤回後，
 * 需等待 10 分鐘才能再向該 NPC 提出新條約。防止玩家用
 * 「提案 → NPC 拒絕/對案 → 撤回 → 立刻重提」無限刷 AI 判斷。
 * 玩家對玩家的提案不受此限制。
 */
export const NPC_REPROPOSAL_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 距離冷卻結束還剩多少毫秒（0 = 冷卻已過，可提案）。
 * lastEndedAt = 該 pair 最近一筆 rejected/withdrawn 條約的 updatedAt。
 */
export function npcReproposalCooldownRemainingMs(
  lastEndedAt: Date,
  now: Date = new Date(),
): number {
  const remaining =
    lastEndedAt.getTime() + NPC_REPROPOSAL_COOLDOWN_MS - now.getTime();
  return remaining > 0 ? remaining : 0;
}

/** 冷卻中的 zh-TW 錯誤訊息（分鐘無條件進位、至少 1）。 */
export function npcReproposalCooldownMessage(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `與該國的上一份提案剛被拒絕或撤回，請於 ${minutes} 分鐘後再向該國提出新條約`;
}

// ── NPC 提案歷史摘要（Task #76） ───────────────────────────────

/** NPC 判斷 prompt 最多納入的近期歷史筆數。 */
export const NPC_HISTORY_MAX_ENTRIES = 5;
/** 只回顧這段時間內的歷史（7 天）。 */
export const NPC_HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 每筆 NPC 回覆理由（responseNote）納入 prompt 的最大字數。 */
export const NPC_HISTORY_NOTE_MAX_CHARS = 80;

/** 摘要一筆歷史條約所需的最小欄位（routes 從 DB 列直接餵入）。 */
export interface NpcTreatyHistoryRow {
  type: string;
  status: string; // rejected | withdrawn | superseded
  durationDays: number | null;
  offerMoney: number;
  offerTechPoints: number;
  offerRegionIds: number[];
  /** 這筆提案是否由 NPC 提出（NPC 對案列）。 */
  proposedByNpc: boolean;
  responseNote: string | null;
  updatedAt: Date;
}

const NPC_HISTORY_STATUS_LABELS: Record<string, string> = {
  rejected: "被拒絕",
  withdrawn: "提案方撤回",
  superseded: "NPC 提出對案取代",
};

/** 歷史提案結果的 zh-TW 標籤（給玩家端顯示，與 prompt 摘要一致）。 */
export function npcHistoryStatusLabel(status: string): string {
  return NPC_HISTORY_STATUS_LABELS[status] ?? status;
}

/**
 * 把同一 pair 近期已結束的提案（rejected / withdrawn / superseded）
 * 摘要成給 NPC 判斷 prompt 的字串陣列（新→舊）。
 * 有上限：最多 NPC_HISTORY_MAX_ENTRIES 筆、只看 NPC_HISTORY_MAX_AGE_MS 內、
 * responseNote 截斷至 NPC_HISTORY_NOTE_MAX_CHARS 字。
 */
export function summarizeNpcTreatyHistory(
  rows: NpcTreatyHistoryRow[],
  now: Date = new Date(),
): string[] {
  const cutoff = now.getTime() - NPC_HISTORY_MAX_AGE_MS;
  return rows
    .filter((r) => r.updatedAt.getTime() >= cutoff)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, NPC_HISTORY_MAX_ENTRIES)
    .map((r) => {
      const daysAgo = Math.max(
        0,
        Math.floor((now.getTime() - r.updatedAt.getTime()) / 86_400_000),
      );
      const when = daysAgo === 0 ? "今天" : `${daysAgo} 天前`;
      const statusLabel = NPC_HISTORY_STATUS_LABELS[r.status] ?? r.status;
      const who = r.proposedByNpc ? "我方（NPC）對案" : "對方提案";
      const offer = [
        `金錢 ${r.offerMoney}`,
        `科技點數 ${r.offerTechPoints}`,
        `領土 ${r.offerRegionIds.length} 區`,
      ].join("、");
      const duration =
        r.durationDays === null ? "無期限" : `${r.durationDays} 天`;
      const parts = [
        `${when}：${who}【${treatyTypeLabel(r.type)}／${duration}】附帶：${offer}，結果：${statusLabel}`,
      ];
      const note = r.responseNote?.trim();
      if (note) {
        const truncated =
          note.length > NPC_HISTORY_NOTE_MAX_CHARS
            ? `${note.slice(0, NPC_HISTORY_NOTE_MAX_CHARS)}…`
            : note;
        parts.push(`當時回覆：「${truncated}」`);
      }
      return parts.join("；");
    });
}

// ── NPC 關係動作摘要（Task #84） ───────────────────────────────

/** NPC 判斷 prompt 最多納入的近期關係動作筆數。 */
export const NPC_RELATION_EVENTS_MAX_ENTRIES = 8;
/** 只回顧這段時間內的關係動作（7 天，與提案歷史一致）。 */
export const NPC_RELATION_EVENTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 摘要一筆關係動作所需的最小欄位（routes 從 DB 列直接餵入）。 */
export interface NpcRelationEventRow {
  /** embassy | gift | insult | withdraw */
  action: string;
  /** 這筆動作是否由 NPC 執行（actor = NPC）。 */
  actedByNpc: boolean;
  createdAt: Date;
}

const NPC_RELATION_EVENT_LABELS: Record<
  string,
  { byOther: string; byNpc: string }
> = {
  embassy: { byOther: "對方在我國設立大使館", byNpc: "我方在對方設立大使館" },
  gift: { byOther: "對方向我國送禮", byNpc: "我方向對方送禮" },
  insult: { byOther: "對方公開侮辱我國", byNpc: "我方公開侮辱對方" },
  withdraw: {
    byOther: "對方從我國撤回外交官（撤館）",
    byNpc: "我方從對方撤回外交官（撤館）",
  },
  annul_treaty: {
    byOther: "對方廢除了與我國生效中的條約",
    byNpc: "我方廢除了與對方生效中的條約",
  },
  declare_war: {
    byOther: "對方向我國宣戰",
    byNpc: "我方向對方宣戰",
  },
};

/** 相對時間標籤：今天／N 天前（與提案歷史摘要一致）。 */
function relativeDayLabel(at: Date, now: Date): string {
  const daysAgo = Math.max(
    0,
    Math.floor((now.getTime() - at.getTime()) / 86_400_000),
  );
  return daysAgo === 0 ? "今天" : `${daysAgo} 天前`;
}

/**
 * 把同一 pair 近期關係動作（送禮／侮辱／設館／撤館）摘要成給 NPC 判斷
 * prompt 的字串陣列（新→舊）。上限：最多 NPC_RELATION_EVENTS_MAX_ENTRIES
 * 筆、只看 NPC_RELATION_EVENTS_MAX_AGE_MS 內。
 */
export function summarizeNpcRelationEvents(
  rows: NpcRelationEventRow[],
  now: Date = new Date(),
): string[] {
  const cutoff = now.getTime() - NPC_RELATION_EVENTS_MAX_AGE_MS;
  return rows
    .filter((r) => r.createdAt.getTime() >= cutoff)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, NPC_RELATION_EVENTS_MAX_ENTRIES)
    .map((r) => {
      const labels = NPC_RELATION_EVENT_LABELS[r.action];
      const what = labels
        ? r.actedByNpc
          ? labels.byNpc
          : labels.byOther
        : `${r.actedByNpc ? "我方" : "對方"}執行了外交動作（${r.action}）`;
      return `${relativeDayLabel(r.createdAt, now)}：${what}`;
    });
}

// ── 關係動作紀錄清理（Task #93） ───────────────────────────────

/**
 * diplomacy_relation_events 保留窗（30 天）。NPC 判斷只回顧
 * NPC_RELATION_EVENTS_MAX_AGE_MS（7 天），保留窗必須 ≥ 該值，
 * 否則 NPC 會看不到應納入判斷的紀錄（單元測試守住這個關係）。
 * 若之後有 UI 顯示互動歷史，保留窗要配合該需求調整。
 */
export const RELATION_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 清理截止點：早於此時間的關係動作紀錄可刪除（純函式，供測試）。 */
export function relationEventsPruneCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - RELATION_EVENTS_RETENTION_MS);
}

/** 刪除超過保留窗的關係動作紀錄，回傳刪除筆數。 */
export async function pruneOldRelationEvents(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = relationEventsPruneCutoff(now);
  const result = await db.execute(sql`
    DELETE FROM diplomacy_relation_events
    WHERE created_at < ${cutoff}
  `);
  return result.rowCount ?? 0;
}

const RELATION_EVENTS_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 每 6 小時清一次過舊關係動作紀錄；啟動後 ~40 秒先跑一次。錯誤只記錄，不中斷。 */
export function startRelationEventPruneLoop(): void {
  const tick = () => {
    pruneOldRelationEvents()
      .then((deleted) => {
        if (deleted > 0) {
          logger.info({ deleted }, "old diplomacy relation events pruned");
        }
      })
      .catch((err) =>
        logger.error({ err }, "relation event prune tick failed"),
      );
  };
  setTimeout(tick, 40 * 1000);
  setInterval(tick, RELATION_EVENTS_PRUNE_INTERVAL_MS);
  logger.info("relation event prune loop started");
}

// ── 條約規則效果（Task #40） ───────────────────────────────────

/** 條約規則判斷所需的最小欄位（routes 從 DB 列直接餵入）。 */
export interface TreatyEffectView {
  type: string;
  proposerNationId: string;
  targetNationId: string;
  status: string;
  expiresAt: Date | null;
  /**
   * 附庸條約方向（僅 type='vassal' 有意義）：true = 提案方為附庸。
   * 選填以相容既有五欄位 SELECT；需要附庸語意的呼叫端必須把
   * proposer_is_vassal 一併撈出來，未載入時視為 true（預設值）。
   */
  proposerIsVassal?: boolean;
}

/** 條約是否正在生效：status=active 且未過期（到期迴圈每 10 分鐘掃一次，這裡即時判斷）。 */
export function isTreatyInEffect(
  treaty: Pick<TreatyEffectView, "status" | "expiresAt">,
  now: Date = new Date(),
): boolean {
  return (
    treaty.status === "active" &&
    (treaty.expiresAt === null || treaty.expiresAt.getTime() > now.getTime())
  );
}

/** 條約是否涉及這對國家（方向不拘）。 */
function treatyBetween(
  treaty: TreatyEffectView,
  a: string,
  b: string,
): boolean {
  return (
    (treaty.proposerNationId === a && treaty.targetNationId === b) ||
    (treaty.proposerNationId === b && treaty.targetNationId === a)
  );
}

/**
 * 宣戰阻擋（條約層）：兩國之間有生效中的互不侵犯條約或附庸條約
 * （宗主↔附庸強制和平，雙向）時，禁止宣戰。
 * 回傳阻擋的條約類型 slug，無阻擋回 null。
 * 註：同盟已改制為「聯盟」（見 lib/alliances.ts），同盟成員間的宣戰阻擋
 * 改由聯盟成員關係判斷，不再走條約層。
 */
export function findWarBlockingTreatyType(
  treaties: TreatyEffectView[],
  a: string,
  b: string,
  now: Date = new Date(),
): "nonaggression" | "vassal" | null {
  for (const t of treaties) {
    if (!isTreatyInEffect(t, now)) continue;
    if (!treatyBetween(t, a, b)) continue;
    if (t.type === "nonaggression") return "nonaggression";
    if (t.type === "vassal") return "vassal";
  }
  return null;
}

// ── 附庸條約（宗主／附庸）純函式 ─────────────────────────────

/** 從附庸條約列取出附庸方與宗主方（proposerIsVassal 未載入時視為 true）。 */
export function vassalPartiesOf(t: TreatyEffectView): {
  vassalId: string;
  suzerainId: string;
} {
  const proposerIsVassal = t.proposerIsVassal ?? true;
  return proposerIsVassal
    ? { vassalId: t.proposerNationId, suzerainId: t.targetNationId }
    : { vassalId: t.targetNationId, suzerainId: t.proposerNationId };
}

/**
 * 找出某國生效中的宗主國 id；沒有附庸條約時回 null。
 * （部分唯一索引保證每個附庸最多一個生效中的宗主。）
 */
export function findActiveSuzerainId(
  treaties: TreatyEffectView[],
  nationId: string,
  now: Date = new Date(),
): string | null {
  for (const t of treaties) {
    if (t.type !== "vassal") continue;
    if (!isTreatyInEffect(t, now)) continue;
    const { vassalId, suzerainId } = vassalPartiesOf(t);
    if (vassalId === nationId) return suzerainId;
  }
  return null;
}

/**
 * 自動參戰：被宣戰方（defender）的生效中保障獨立
 * （提案國保障 target 的獨立 → target 被攻擊時提案國參戰）夥伴，
 * 與被宣戰方的宗主國（附庸被宣戰 → 宗主自動參戰保護），
 * 自動對侵略方（aggressor）進入交戰。
 * 註：聯盟成員「不」自動參戰（Task #215）——只有保障獨立與宗主會自動參戰。
 * 宗主被宣戰時附庸「不」自動參戰（保護是單向的）。
 * 排除侵略方與被宣戰方本身；若夥伴自己與侵略方有互不侵犯／附庸強制和平
 * （宣戰會被擋下的組合），則不自動參戰（條約優先，不互相矛盾）。
 * 呼叫端的條約查詢必須帶 proposerIsVassal 欄位，宗主方向才會正確。
 */
export function autoJoinNationIds(
  treaties: TreatyEffectView[],
  defenderId: string,
  aggressorId: string,
  now: Date = new Date(),
): string[] {
  const joiners = new Set<string>();
  for (const t of treaties) {
    if (!isTreatyInEffect(t, now)) continue;
    if (t.type === "guarantee") {
      // 提案國保障 target 的獨立：target 被攻擊 → 提案國參戰。
      if (t.targetNationId === defenderId) joiners.add(t.proposerNationId);
    }
    if (t.type === "vassal") {
      // 附庸被攻擊 → 宗主自動參戰（反向不成立）。
      const { vassalId, suzerainId } = vassalPartiesOf(t);
      if (vassalId === defenderId) joiners.add(suzerainId);
    }
  }
  joiners.delete(aggressorId);
  joiners.delete(defenderId);
  return [...joiners].filter(
    (id) => findWarBlockingTreatyType(treaties, id, aggressorId, now) === null,
  );
}

// ── 條約到期迴圈 ───────────────────────────────────────────────

const EXPIRY_INTERVAL_MS = 10 * 60 * 1000;

export type ExpiredTreatyRow = {
  id: number;
  proposerNationId: string;
  targetNationId: string;
  type: string;
};

/**
 * 將已過期的生效中條約標記為 expired（讀取端也會即時過濾）。
 * 回傳被標記的條約列，供到期迴圈通知締約雙方；UPDATE 只轉換 active 列，
 * 同一條約只會被回傳一次，因此通知不會重複。
 */
export async function expireOverdueTreaties(): Promise<ExpiredTreatyRow[]> {
  const result = await db.execute(sql`
    UPDATE diplomacy_treaties
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW()
    RETURNING id, proposer_nation_id, target_nation_id, type
  `);
  return result.rows.map((row) => ({
    id: Number(row["id"]),
    proposerNationId: String(row["proposer_nation_id"]),
    targetNationId: String(row["target_nation_id"]),
    type: String(row["type"]),
  }));
}

/**
 * 到期前預警窗（24 小時）：生效中且有到期時間的條約，在到期前這段時間內
 * 預警締約雙方一次，讓玩家有時間重新締約。
 */
export const EXPIRY_WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 認領即將到期（24 小時內）且尚未預警過的生效中條約，將 expiry_warned_at
 * 設為 NOW()，回傳被認領的條約列供迴圈通知締約雙方。
 * UPDATE ... WHERE expiry_warned_at IS NULL RETURNING 原子認領，同一條約
 * 只會被回傳一次（即使重啟或多實例），確保預警只發一次。
 * 已過期（expires_at < NOW()）的條約留給 expireOverdueTreaties 處理。
 */
export async function warnExpiringTreaties(): Promise<ExpiredTreatyRow[]> {
  const result = await db.execute(sql`
    UPDATE diplomacy_treaties
    SET expiry_warned_at = NOW()
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expiry_warned_at IS NULL
      AND expires_at > NOW()
      AND expires_at <= NOW() + (${EXPIRY_WARNING_WINDOW_MS} || ' milliseconds')::interval
    RETURNING id, proposer_nation_id, target_nation_id, type
  `);
  return result.rows.map((row) => ({
    id: Number(row["id"]),
    proposerNationId: String(row["proposer_nation_id"]),
    targetNationId: String(row["target_nation_id"]),
    type: String(row["type"]),
  }));
}

/**
 * 每 10 分鐘掃一次：先發到期前預警，再標記已過期條約；啟動後先跑一次。
 * 兩者各自 catch，任一失敗只記錄、不影響另一個或中斷迴圈。
 */
export function startTreatyExpiryLoop(): void {
  // 省電喚醒快取：沒有即將到期/預警的條約就純記憶體返回（零 DB 查詢）。
  registerSchedulerWake("treatyExpiry", (raw) => {
    const exp = toMs(raw["tr_exp"]);
    const warn = toMs(raw["tr_warn"]);
    const warnDue = warn === null ? null : warn - EXPIRY_WARNING_WINDOW_MS;
    if (exp === null && warnDue === null) return null;
    return Math.min(
      exp ?? Number.POSITIVE_INFINITY,
      warnDue ?? Number.POSITIVE_INFINITY,
    );
  });
  const tick = () => {
    void skipIfNotDue("treatyExpiry").then((skip) => {
      if (skip) return;
      treatyExpiryPass();
    });
  };
  const treatyExpiryPass = () => {
    warnExpiringTreaties()
      .then((expiring) => {
        if (expiring.length === 0) return;
        logger.info({ expiring: expiring.length }, "treaties expiring soon");
        for (const treaty of expiring) {
          notifyTreatyExpiringSoon({
            proposerNationId: treaty.proposerNationId,
            targetNationId: treaty.targetNationId,
            treatyType: treaty.type,
          });
        }
      })
      .catch((err) =>
        logger.error({ err }, "treaty expiry-warning tick failed"),
      );

    expireOverdueTreaties()
      .then((expired) => {
        if (expired.length === 0) return;
        logger.info({ expired: expired.length }, "treaties expired");
        for (const treaty of expired) {
          notifyTreatyExpired({
            proposerNationId: treaty.proposerNationId,
            targetNationId: treaty.targetNationId,
            treatyType: treaty.type,
          });
        }
      })
      .catch((err) => logger.error({ err }, "treaty expiry tick failed"));
    noteGameActivity();
  };
  setTimeout(tick, 20 * 1000);
  setInterval(tick, EXPIRY_INTERVAL_MS);
  logger.info("treaty expiry loop started");
}

// ── Task #374 — 條約雙向交換：地區選擇驗證（純函式，供提案端點與單元測試共用） ──

export type TreatyRegionSelectionResult =
  | { ok: true; regionIds: number[]; regionPercents: Record<string, number> }
  | { ok: false; error: string };

/**
 * 驗證一側（我方提供或要求對方提供）的領土選擇：
 * - 最多 10 個地區、id 為正整數、自動去重。
 * - 每區可附轉移百分比（整數 1–100，缺項＝整份轉移）。
 * - 每個地區必須在 held（該側國家目前的掌控 regionId → percent）之中，
 *   且指定的百分比不得超過實際掌控份額。
 * sideLabel 用於繁中錯誤訊息（例如「我方提供」／「要求對方提供」）。
 */
export function parseTreatyRegionSelection(params: {
  rawRegionIds: unknown;
  rawRegionPercents: unknown;
  held: Map<number, number>;
  sideLabel: string;
}): TreatyRegionSelectionResult {
  const { rawRegionIds, rawRegionPercents, held, sideLabel } = params;

  const idsInput = rawRegionIds ?? [];
  if (!Array.isArray(idsInput) || idsInput.length > 10) {
    return { ok: false, error: `${sideLabel}的領土最多 10 個地區` };
  }
  const regionIds: number[] = [];
  for (const v of idsInput) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return { ok: false, error: `${sideLabel}的領土地區 id 不正確` };
    }
    if (!regionIds.includes(v)) regionIds.push(v);
  }

  const pctInput = rawRegionPercents ?? {};
  if (
    typeof pctInput !== "object" ||
    pctInput === null ||
    Array.isArray(pctInput)
  ) {
    return { ok: false, error: `${sideLabel}的領土轉移百分比格式不正確` };
  }
  const regionPercents: Record<string, number> = {};
  for (const [key, value] of Object.entries(
    pctInput as Record<string, unknown>,
  )) {
    const regionId = Number(key);
    if (!Number.isInteger(regionId) || !regionIds.includes(regionId)) {
      return {
        ok: false,
        error: `${sideLabel}的轉移百分比包含未選擇的地區`,
      };
    }
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 100
    ) {
      return {
        ok: false,
        error: `${sideLabel}的領土轉移百分比必須是 1 到 100 的整數`,
      };
    }
    regionPercents[String(regionId)] = value;
  }

  for (const regionId of regionIds) {
    const heldPct = held.get(regionId);
    if (heldPct === undefined || heldPct <= 0) {
      return {
        ok: false,
        error: `${sideLabel}的領土必須是該國目前掌控的地區`,
      };
    }
    const pct = regionPercents[String(regionId)];
    if (pct !== undefined && pct > heldPct) {
      return {
        ok: false,
        error: `${sideLabel}的領土轉移百分比超過該國實際掌控份額`,
      };
    }
  }

  return { ok: true, regionIds, regionPercents };
}

// ── Task #376 — NPC 對案的領土索求（純函式，供 npcTreatyDecision 與單元測試共用） ──

export interface NpcCounterRegionDemand {
  /** AI 回覆的地區名稱（將以名稱 → id 對映解析；不在對映中 → 錯誤）。 */
  name: string;
  /** 索求的轉移百分比（1–100；null/缺項＝整份轉移，即提案方目前掌控的全部份額）。 */
  percent?: number | null;
}

export type NpcCounterDemandMergeResult =
  | { ok: true; offerRegionIds: number[]; offerRegionPercents: Record<string, number> }
  | { ok: false; error: string };

/**
 * 把 NPC 對案索求的地區（名稱＋百分比）併入條約 offer 側
 * （offer 一律由提案方付出；NPC 索求領土＝要求提案方多給地，
 * 與 demandMoney/demandTechPoints 疊到 offer 側的語意一致）。
 *
 * 規則：
 * - 名稱以 regionIdByName（trim 後完全比對）解析；解析不到 → 錯誤。
 * - 索求集合重用 parseTreatyRegionSelection 驗證（≤10 區、百分比 1–100、
 *   必須是提案方目前掌控的地區、百分比不得超過實際掌控份額）。
 * - 與原 offer 合併：已在 offer 中的地區取「較高」百分比（NPC 只會加碼，
 *   不會替提案方減碼）；缺項百分比＝整份轉移（沿用既有語意）。
 * - 合併後總地區數仍不得超過 10。
 */
export function mergeNpcCounterDemandRegions(params: {
  demands: NpcCounterRegionDemand[];
  regionIdByName: Map<string, number>;
  proposerHeld: Map<number, number>;
  existingOfferIds: number[];
  existingOfferPercents: Record<string, number>;
}): NpcCounterDemandMergeResult {
  const {
    demands,
    regionIdByName,
    proposerHeld,
    existingOfferIds,
    existingOfferPercents,
  } = params;

  const rawIds: number[] = [];
  const rawPercents: Record<string, number> = {};
  for (const d of demands) {
    const name = typeof d.name === "string" ? d.name.trim() : "";
    const id = name ? regionIdByName.get(name) : undefined;
    if (id === undefined) {
      return { ok: false, error: `NPC 索求的地區「${name || "（空白）"}」不存在` };
    }
    if (!rawIds.includes(id)) rawIds.push(id);
    if (d.percent !== undefined && d.percent !== null) {
      rawPercents[String(id)] = d.percent;
    }
  }

  const parsed = parseTreatyRegionSelection({
    rawRegionIds: rawIds,
    rawRegionPercents: rawPercents,
    held: proposerHeld,
    sideLabel: "NPC 索求",
  });
  if (!parsed.ok) return parsed;

  // 與原 offer 合併：已存在者取較高百分比（缺項＝整份＝該區掌控全額）。
  const mergedIds = [...existingOfferIds];
  const mergedPercents: Record<string, number> = { ...existingOfferPercents };
  const effectivePct = (
    id: number,
    percents: Record<string, number>,
  ): number => percents[String(id)] ?? proposerHeld.get(id) ?? 100;

  for (const id of parsed.regionIds) {
    if (!mergedIds.includes(id)) {
      mergedIds.push(id);
      const pct = parsed.regionPercents[String(id)];
      if (pct !== undefined) mergedPercents[String(id)] = pct;
      continue;
    }
    const existing = effectivePct(id, existingOfferPercents);
    const demanded = effectivePct(id, parsed.regionPercents);
    if (demanded >= existing) {
      // 加碼：取較高者；若索求為整份（缺項）就移除百分比（＝整份轉移）。
      if (parsed.regionPercents[String(id)] === undefined) {
        delete mergedPercents[String(id)];
      } else {
        mergedPercents[String(id)] = demanded;
      }
    }
  }

  if (mergedIds.length > 10) {
    return { ok: false, error: "NPC 索求後的領土超過 10 個地區上限" };
  }

  return {
    ok: true,
    offerRegionIds: mergedIds,
    offerRegionPercents: mergedPercents,
  };
}
