import { z } from "zod";
import { isTreatyType, type TreatyType } from "./diplomacy";

/**
 * Task #256 — NPC 在與玩家的外交對話中「即時執行真實決策」的純邏輯層。
 *
 * 這裡只放：AI 回傳動作的 zod schema、可執行動作的型別、以及把 AI 產出的
 * 原始動作清單「淨化 / 夾限 / 依積極度分級」成一份安全的執行計畫的純函式
 * （sanitizeChatActions）。所有 DB 副作用都在 executeNpcChatActions（executor）
 * 與其呼叫的既有寫入層裡，本檔完全無副作用，方便單元測試涵蓋所有分支。
 *
 * 設計要點與護欄：
 * - 目標一律必須落在「候選集合」內（candidates map）。AI 亂編 id → 直接丟棄。
 * - 戰爭類（宣戰／出兵）只能對「真人玩家」發動：NPC↔NPC 戰爭列永遠不會被戰爭引擎
 *   結算而變成卡死的無效列（見 memory: npc-npc-inert-war）。
 * - 送禮／土地資源交換只對「正在對話的那位玩家」發動（chat 語意最自然，且避免
 *   NPC 對第三方亂送資源）。
 * - 積極度（chatActionLevel 1..3）決定每則訊息可執行的動作上限與「戰爭門檻」。
 *   實際的關係值 < 0、阻擋條約、冷卻等硬性條件仍由 executor 呼叫的寫入層再次把關。
 */

// ── AI 回傳的單一動作 schema ───────────────────────────────────

export const CHAT_ACTION_TYPES = [
  "declare_war",
  "initiate_campaign",
  "ceasefire",
  "propose_treaty",
  "alliance",
  "gift",
  "exchange",
] as const;

export type ChatActionType = (typeof CHAT_ACTION_TYPES)[number];

/** 動作類型 → 繁體中文短標籤（用於回覆摘要與前端晶片）。 */
export const CHAT_ACTION_LABELS: Record<ChatActionType, string> = {
  declare_war: "宣戰",
  initiate_campaign: "出兵",
  ceasefire: "停戰",
  propose_treaty: "締約",
  alliance: "結盟",
  gift: "送禮",
  exchange: "交換",
};

export function chatActionLabel(type: ChatActionType): string {
  return CHAT_ACTION_LABELS[type];
}

/** propose_treaty 允許的條約類型（同盟走 alliance 動作、custom 走 exchange 動作）。 */
const PROPOSABLE_TREATY_TYPES: readonly TreatyType[] = [
  "nonaggression",
  "military_access",
  "guarantee",
];

const MAX_OFFER_MONEY = 1_000_000_000_000;
const MAX_OFFER_TECH = 2_000_000_000;
const MAX_OFFER_REGIONS = 10;

/**
 * Task #499 — 反操縱硬性守門（不信任 AI 自律；就算 prompt 被玩家繞過，
 * 這裡也擋住無對價的單方面讓利）：
 * - 送禮＝純讓利：關係值需 ≥ CHAT_GIFT_MIN_RELATION 才可能發生，
 *   且單次送出量以 NPC 現有資源的 CHAT_GIFT_MAX_FRACTION 比例封頂——被騙也送不出家底。
 * - 交換（以 custom 條約提案落地、條款文字不具強制力）：關係值為負一律剔除，
 *   出價以 CHAT_EXCHANGE_MAX_FRACTION 比例封頂、讓地至多 CHAT_EXCHANGE_MAX_REGIONS 區。
 */
export const CHAT_GIFT_MIN_RELATION = 20;
export const CHAT_GIFT_MAX_FRACTION = 0.05;
export const CHAT_EXCHANGE_MIN_RELATION = 0;
export const CHAT_EXCHANGE_MAX_FRACTION = 0.1;
export const CHAT_EXCHANGE_MAX_REGIONS = 3;

/** Task #499 — 被守門剔除的動作紀錄（供呼叫端記 log 觀察玩家操縱嘗試）。 */
export interface ChatActionRejection {
  type: ChatActionType;
  targetId: string;
  reason: string;
}

/**
 * AI 對話動作的原始 schema（寬鬆解析：未知欄位忽略、缺漏給預設）。
 * 真正的規則檢查在 sanitizeChatActions；schema 只保證型別與基本範圍。
 */
export const chatActionSchema = z.object({
  type: z.enum(CHAT_ACTION_TYPES),
  /** 目標國家 id（必須是候選集合內的其中一個 id）。 */
  targetId: z.string().trim().min(1).max(64),
  /** propose_treaty 專用：條約類型 slug。 */
  treatyType: z.string().trim().max(32).nullish(),
  /** propose_treaty / exchange 專用：條約天數（null = 無期限）。 */
  durationDays: z.number().int().min(1).max(3650).nullish(),
  /** gift / exchange 專用：NPC 一次性附上的金錢。 */
  offerMoney: z.number().int().min(0).max(MAX_OFFER_MONEY).nullish(),
  /** gift / exchange 專用：NPC 一次性附上的科技點數。 */
  offerTechPoints: z.number().int().min(0).max(MAX_OFFER_TECH).nullish(),
  /** exchange 專用：NPC 願意讓出的地區 id（必須是 NPC 自己掌控的地區）。 */
  offerRegionIds: z.array(z.number().int()).max(50).nullish(),
  /** exchange 專用：交換條件的說明文字。 */
  clause: z.string().trim().max(300).nullish(),
  /**
   * Task #341 — ceasefire 專用：向「正在對話的玩家」索求的停戰條件。
   * 這些金額 / 地區是要求對方（玩家）交付的，皆會被夾限於對方實際擁有的資源。
   */
  demandMoney: z.number().int().min(0).max(MAX_OFFER_MONEY).nullish(),
  demandTechPoints: z.number().int().min(0).max(MAX_OFFER_TECH).nullish(),
  /** 要求玩家割讓的地區與百分比（regionId 必須是對方掌控的地區）。 */
  demandRegions: z
    .array(
      z.object({
        regionId: z.number().int(),
        percent: z.number().int().min(1).max(100),
      }),
    )
    .max(50)
    .nullish(),
});

export type RawChatAction = z.infer<typeof chatActionSchema>;

// ── 淨化後的可執行動作 ─────────────────────────────────────────

export interface PlannedChatAction {
  type: ChatActionType;
  targetId: string;
  targetIsPlayer: boolean;
  /** propose_treaty 的條約類型；其他動作為 null。 */
  treatyType: TreatyType | null;
  durationDays: number | null;
  /** gift / exchange 的一次性金錢（已夾限於 NPC 現有金錢）。 */
  offerMoney: number;
  /** gift / exchange 的一次性科技點數（已夾限於 NPC 現有科技點數）。 */
  offerTechPoints: number;
  /** exchange 的讓出地區（已過濾為 NPC 實際掌控且去重）。 */
  offerRegionIds: number[];
  /** exchange 的條件說明。 */
  clause: string | null;
  /** Task #341 — ceasefire 向玩家索求的金錢（已夾限於玩家現有金錢）。 */
  demandMoney: number;
  /** Task #341 — ceasefire 向玩家索求的科技點數（已夾限於玩家現有科技點數）。 */
  demandTechPoints: number;
  /** Task #341 — ceasefire 向玩家索求割讓的地區與百分比（已過濾為玩家實際掌控且夾限）。 */
  demandRegions: { regionId: number; percent: number }[];
}

// ── 候選集合與情境 ─────────────────────────────────────────────

export interface ChatActionCandidate {
  kind: "player" | "npc";
  relationScore: number;
  /** 與發動 NPC 是否交戰中。 */
  atWar: boolean;
  /** 與發動 NPC 之間是否已有待回覆（proposed）的條約提案。 */
  hasPendingProposal: boolean;
}

export interface ChatActionContext {
  /** 發動動作的 NPC 國家 id。 */
  actorId: string;
  /** 正在與 NPC 對話的那位玩家國家 id（gift / exchange 只能對它）。 */
  counterpartId: string;
  /** 目標候選集合：id → 情境。不在集合內的 targetId 一律丟棄。 */
  candidates: ReadonlyMap<string, ChatActionCandidate>;
  npcMoney: number;
  npcTechPoints: number;
  /** NPC 目前掌控的地區 id（exchange 讓地時過濾用）。 */
  npcRegionIds: ReadonlySet<number>;
  /** Task #341 — 正在對話玩家的金錢（ceasefire 索求金錢時夾限用）。 */
  counterpartMoney: number;
  /** Task #341 — 正在對話玩家的科技點數（ceasefire 索求科技時夾限用）。 */
  counterpartTechPoints: number;
  /** Task #341 — 正在對話玩家掌控的地區 → 百分比（ceasefire 索求割地時夾限用）。 */
  counterpartRegionPercents: ReadonlyMap<number, number>;
  /** 積極度 1(保守)／2(中等)／3(積極)。 */
  level: number;
}

export interface ChatActionCaps {
  /** 每則訊息最多可執行的動作數。 */
  maxActions: number;
  /**
   * 戰爭類（宣戰／出兵）允許的關係值上限：關係值 ≤ 此值（或已交戰）才可發動。
   * 保守 NPC 需要更深的敵意才會開戰；積極 NPC 只要關係為負即可。
   */
  warRelationThreshold: number;
}

/** 依積極度回傳動作上限與戰爭門檻（純函式）。 */
export function chatActionCaps(level: number): ChatActionCaps {
  switch (level) {
    case 1:
      return { maxActions: 1, warRelationThreshold: -40 };
    case 2:
      return { maxActions: 2, warRelationThreshold: -1 };
    default:
      // 3（積極）及任何越界值都退回積極設定。
      return { maxActions: 2, warRelationThreshold: -1 };
  }
}

function clampInt(v: number | null | undefined, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

const isWarClass = (t: ChatActionType): boolean =>
  t === "declare_war" || t === "initiate_campaign";

/**
 * 純函式：把 AI 產出的原始動作清單淨化成可安全執行的計畫。
 *
 * 規則：
 * - 目標必須在候選集合內、且不是 NPC 自己。
 * - 同一 (type,targetId) 只保留第一筆（去重）。
 * - 戰爭類每則訊息至多 1 個，且需通過積極度的關係門檻（或已交戰）。
 * - 送禮／交換只能對正在對話的玩家；且必須實際提供了資源（否則丟棄）。
 * - 締約需無待回覆提案且未交戰；結盟需關係為正且未交戰。
 * - 全部動作合計不超過積極度上限。
 */
export function sanitizeChatActions(
  raw: readonly RawChatAction[],
  ctx: ChatActionContext,
  /** Task #499 — 反操縱守門剔除讓利動作時通知（記 log 觀察操縱嘗試）。 */
  onReject?: (rejection: ChatActionRejection) => void,
): PlannedChatAction[] {
  const caps = chatActionCaps(ctx.level);
  const planned: PlannedChatAction[] = [];
  const usedKeys = new Set<string>();
  let warClassCount = 0;

  for (const a of raw) {
    if (planned.length >= caps.maxActions) break;
    if (a.targetId === ctx.actorId) continue;

    const cand = ctx.candidates.get(a.targetId);
    if (!cand) continue; // 嚴格：目標必須在候選集合內。

    const key = `${a.type}:${a.targetId}`;
    if (usedKeys.has(key)) continue;

    const targetIsPlayer = cand.kind === "player";
    let plan: PlannedChatAction | null = null;

    switch (a.type) {
      case "declare_war":
      case "initiate_campaign": {
        if (!targetIsPlayer) break; // 戰爭只能對真人玩家。
        if (warClassCount >= 1) break; // 每則訊息至多一個戰爭類動作。
        if (!cand.atWar && cand.relationScore > caps.warRelationThreshold) break;
        plan = basePlan(a.type, a.targetId, true);
        break;
      }
      case "ceasefire": {
        if (!targetIsPlayer) break; // 只有 NPC↔玩家戰爭會被結算。
        if (!cand.atWar) break; // 沒在交戰無從停戰。
        // Task #341 — 附條件停戰：僅能向「正在對話的玩家」索求，且需夾限於其實際資源。
        // 對其他交戰中的玩家仍走無條件停戰（沒有對方資源快照可夾限）。
        if (a.targetId === ctx.counterpartId) {
          const demandMoney = clampInt(a.demandMoney, 0, ctx.counterpartMoney);
          const demandTech = clampInt(
            a.demandTechPoints,
            0,
            ctx.counterpartTechPoints,
          );
          const demandRegions = clampDemandRegions(
            a.demandRegions,
            ctx.counterpartRegionPercents,
          );
          plan = {
            ...basePlan("ceasefire", a.targetId, true),
            demandMoney,
            demandTechPoints: demandTech,
            demandRegions,
          };
        } else {
          plan = basePlan("ceasefire", a.targetId, true);
        }
        break;
      }
      case "propose_treaty": {
        if (cand.atWar) break; // 交戰中不締約。
        if (cand.hasPendingProposal) break; // 已有待回覆提案。
        const type =
          isTreatyType(a.treatyType) &&
          PROPOSABLE_TREATY_TYPES.includes(a.treatyType)
            ? a.treatyType
            : "nonaggression";
        plan = {
          ...basePlan("propose_treaty", a.targetId, targetIsPlayer),
          treatyType: type,
          durationDays: a.durationDays ?? null,
        };
        break;
      }
      case "alliance": {
        if (cand.atWar) break; // 交戰中不結盟。
        if (cand.relationScore <= 0) break; // 關係非正不結盟。
        plan = basePlan("alliance", a.targetId, targetIsPlayer);
        break;
      }
      case "gift": {
        if (a.targetId !== ctx.counterpartId || !targetIsPlayer) break;
        // Task #499 — 送禮＝無對價的純讓利：關係值不夠高一律剔除（賣慘／
        // 恭維／假身分都洗不出禮物），且送出量以現有資源比例封頂。
        if (cand.relationScore < CHAT_GIFT_MIN_RELATION) {
          onReject?.({
            type: "gift",
            targetId: a.targetId,
            reason: `關係值 ${cand.relationScore} 低於送禮門檻 ${CHAT_GIFT_MIN_RELATION}`,
          });
          break;
        }
        const moneyCap = Math.floor(ctx.npcMoney * CHAT_GIFT_MAX_FRACTION);
        const techCap = Math.floor(
          ctx.npcTechPoints * CHAT_GIFT_MAX_FRACTION,
        );
        const money = clampInt(a.offerMoney, 0, moneyCap);
        const tech = clampInt(a.offerTechPoints, 0, techCap);
        if (money <= 0 && tech <= 0) {
          onReject?.({
            type: "gift",
            targetId: a.targetId,
            reason: "比例上限夾限後沒有可送出的資源",
          });
          break;
        }
        plan = {
          ...basePlan("gift", a.targetId, true),
          offerMoney: money,
          offerTechPoints: tech,
        };
        break;
      }
      case "exchange": {
        if (a.targetId !== ctx.counterpartId || !targetIsPlayer) break;
        if (cand.hasPendingProposal) break; // 已有待回覆提案。
        // Task #499 — 交換提案的條款文字不具強制力，實質仍是 NPC 先出價：
        // 關係值為負一律剔除，出價比例封頂、讓地數量另設更低上限。
        if (cand.relationScore < CHAT_EXCHANGE_MIN_RELATION) {
          onReject?.({
            type: "exchange",
            targetId: a.targetId,
            reason: `關係值 ${cand.relationScore} 低於交換門檻 ${CHAT_EXCHANGE_MIN_RELATION}`,
          });
          break;
        }
        const money = clampInt(
          a.offerMoney,
          0,
          Math.floor(ctx.npcMoney * CHAT_EXCHANGE_MAX_FRACTION),
        );
        const tech = clampInt(
          a.offerTechPoints,
          0,
          Math.floor(ctx.npcTechPoints * CHAT_EXCHANGE_MAX_FRACTION),
        );
        const regionIds = dedupeRegions(
          a.offerRegionIds,
          ctx.npcRegionIds,
          CHAT_EXCHANGE_MAX_REGIONS,
        );
        if (money <= 0 && tech <= 0 && regionIds.length === 0) {
          onReject?.({
            type: "exchange",
            targetId: a.targetId,
            reason: "比例上限夾限後沒有可交換的資源或地區",
          });
          break;
        }
        plan = {
          ...basePlan("exchange", a.targetId, true),
          offerMoney: money,
          offerTechPoints: tech,
          offerRegionIds: regionIds,
          clause: a.clause && a.clause.length > 0 ? a.clause : null,
        };
        break;
      }
    }

    if (!plan) continue;
    if (isWarClass(plan.type)) warClassCount++;
    usedKeys.add(key);
    planned.push(plan);
  }

  return planned;
}

function basePlan(
  type: ChatActionType,
  targetId: string,
  targetIsPlayer: boolean,
): PlannedChatAction {
  return {
    type,
    targetId,
    targetIsPlayer,
    treatyType: null,
    durationDays: null,
    offerMoney: 0,
    offerTechPoints: 0,
    offerRegionIds: [],
    clause: null,
    demandMoney: 0,
    demandTechPoints: 0,
    demandRegions: [],
  };
}

/**
 * Task #341 — 過濾／夾限 ceasefire 索求的割地：只留玩家實際掌控的地區，
 * 每區百分比夾限於玩家該區掌控（1..持有），去重，至多 MAX_OFFER_REGIONS 個。
 */
function clampDemandRegions(
  regions:
    | readonly { regionId: number; percent: number }[]
    | null
    | undefined,
  held: ReadonlyMap<number, number>,
): { regionId: number; percent: number }[] {
  if (!regions || regions.length === 0) return [];
  const out: { regionId: number; percent: number }[] = [];
  const seen = new Set<number>();
  for (const r of regions) {
    if (!Number.isInteger(r.regionId) || seen.has(r.regionId)) continue;
    const heldPct = held.get(r.regionId);
    if (heldPct === undefined || heldPct <= 0) continue;
    const pct = Math.max(1, Math.min(Math.trunc(r.percent), heldPct));
    seen.add(r.regionId);
    out.push({ regionId: r.regionId, percent: pct });
    if (out.length >= MAX_OFFER_REGIONS) break;
  }
  return out;
}

/** 過濾為 NPC 實際掌控的地區、去重、且至多 maxRegions（預設 MAX_OFFER_REGIONS）個。 */
function dedupeRegions(
  ids: readonly number[] | null | undefined,
  owned: ReadonlySet<number>,
  maxRegions: number = MAX_OFFER_REGIONS,
): number[] {
  if (!ids || ids.length === 0) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || !owned.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= maxRegions) break;
  }
  return out;
}
