/**
 * 憲法系統 — 純邏輯核心（無 DB / Express / AI 依賴，方便單元測試）。
 *
 * 設計決定（2026-10-06，使用者確認）：
 *  - 玩家開局憲法是空的，需手寫（最多 12000 字）交議會審查。
 *  - 審查流程：草稿 → 審議中 → (退回 | 否決 | 通過)。通過後永久鎖定、不可更改。
 *  - 憲法只有文字與漏洞危機，不改任何遊戲數值。NPC 不做。
 *  - 沒有通過憲法時，議會滿意度每回合被扣一點（有下限，不會單憑此事逼出革命）。
 *  - 專制（橡皮圖章）議會不問政，不受此懲罰。
 */
import type { ParliamentTier } from "../parliament/core";

export const CONSTITUTION_MAX_LEN = 12000;
/** 送審的最低字數：太短的根本不是憲法，直接擋在 AI 之前（省額度、防灌水）。 */
export const CONSTITUTION_MIN_LEN = 300;
/** 兩次送審至少間隔幾個議會回合（AI 審查成本高，防連續洗版）。 */
export const SUBMIT_COOLDOWN_TICKS = 4;
/** 送審費用（金錢）。 */
export const SUBMIT_COST_MONEY = 1000;
/** AI 品質分低於此值直接退回，不進入投票。 */
export const QUALITY_PASS_SCORE = 40;
/** 席次超過此比例才算通過。 */
export const PASS_SEAT_RATIO = 0.5;

/** 沒有憲法時，議會滿意度每個議會回合的扣分，與扣到的下限。 */
export const NO_CONSTITUTION_PENALTY_PER_TICK = 1;
/** 下限：懲罰只能把滿意度壓到這裡，不會單獨逼出革命（革命會割 40% 領土）。 */
export const NO_CONSTITUTION_SAT_FLOOR = 15;

export type ConstitutionStatus =
  | "none"       // 從未存過草稿
  | "draft"      // 有草稿、尚未送審，或上次被退回/否決後重寫中
  | "reviewing"  // 送審中（AI 審查/投票進行中，不可改稿）
  | "ratified";  // 已通過，永久鎖定

export type ReviewOutcome = "rejected_quality" | "rejected_vote" | "ratified";

export interface PartyVote {
  partyName: string;
  stanceLabel: string;
  seats: number;
  vote: "yes" | "no" | "abstain";
  reason: string;
}

/** 最近一次審查結果（存 jsonb，給玩家看）。 */
export interface ReviewRecord {
  outcome: ReviewOutcome;
  qualityScore: number | null;
  feedback: string;
  flaws: string[];
  votes: PartyVote[];
  yesSeats: number;
  totalSeats: number;
  source: "ai" | "fallback";
  reviewedTick: number;
}

/** 這個政體的議會是否會過問憲法（橡皮圖章議會不問政）。 */
export function constitutionRequired(tier: ParliamentTier): boolean {
  return tier !== "autocracy";
}

export function validateDraft(text: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "請填寫憲法內容" };
  // 只去頭尾空白；內文的換行與縮排是憲法的一部分，不動它。
  const t = text.replace(/\r\n/g, "\n").trim();
  if (t.length > CONSTITUTION_MAX_LEN) {
    return { ok: false, error: `憲法最多 ${CONSTITUTION_MAX_LEN} 字（目前 ${t.length} 字）` };
  }
  return { ok: true, text: t };
}

export function validateSubmission(text: string): { ok: true } | { ok: false; error: string } {
  if (text.length < CONSTITUTION_MIN_LEN) {
    return { ok: false, error: `送審至少需要 ${CONSTITUTION_MIN_LEN} 字（目前 ${text.length} 字）` };
  }
  if (text.length > CONSTITUTION_MAX_LEN) {
    return { ok: false, error: `憲法最多 ${CONSTITUTION_MAX_LEN} 字` };
  }
  // 灌水檢查：不重複字元佔比過低（例如整篇複製貼上同一段/全是同一個字）。
  const chars = new Set(Array.from(text.replace(/\s/g, "")));
  if (chars.size < 40) return { ok: false, error: "內容過於重複，不像一部憲法" };
  return { ok: true };
}

/** 能不能存草稿：已通過或審議中都不行。 */
export function canEditDraft(status: ConstitutionStatus): { ok: true } | { ok: false; error: string } {
  if (status === "ratified") return { ok: false, error: "憲法已經生效，不可更改" };
  if (status === "reviewing") return { ok: false, error: "憲法正在議會審議中，審議期間不可改稿" };
  return { ok: true };
}

export function submitCooldownLeft(tick: number, lastSubmitTick: number | null): number {
  if (lastSubmitTick === null) return 0;
  return Math.max(0, SUBMIT_COOLDOWN_TICKS - (tick - lastSubmitTick));
}

/** 能不能送審（狀態 + 冷卻）。字數與金錢由呼叫端另外檢查。 */
export function canSubmit(
  status: ConstitutionStatus, tick: number, lastSubmitTick: number | null,
): { ok: true } | { ok: false; error: string } {
  if (status === "ratified") return { ok: false, error: "憲法已經生效，不可更改" };
  if (status === "reviewing") return { ok: false, error: "憲法正在審議中" };
  if (status === "none") return { ok: false, error: "請先寫下憲法草稿" };
  const left = submitCooldownLeft(tick, lastSubmitTick);
  if (left > 0) return { ok: false, error: `議會剛審議過，還需 ${left} 個議會回合才能再次送審` };
  return { ok: true };
}

/**
 * 票數統計：席次過半才通過。棄權不算贊成，也不算反對（門檻仍以總席次計，
 * 所以大量棄權會讓憲法過不了——這是刻意的，逼玩家爭取支持而不是只避免反對）。
 */
export function tallyVotes(votes: readonly PartyVote[], totalSeats: number): {
  yesSeats: number; noSeats: number; abstainSeats: number; passed: boolean;
} {
  let yes = 0, no = 0, abstain = 0;
  for (const v of votes) {
    if (v.vote === "yes") yes += v.seats;
    else if (v.vote === "no") no += v.seats;
    else abstain += v.seats;
  }
  return { yesSeats: yes, noSeats: no, abstainSeats: abstain, passed: yes > totalSeats * PASS_SEAT_RATIO };
}

/**
 * 沒有憲法的議會滿意度懲罰（純函式）。
 * - 專制（橡皮圖章）、已通過憲法：不罰。
 * - 其餘：每回合 -1，但最低只壓到 NO_CONSTITUTION_SAT_FLOOR；本來就低於下限的不再扣。
 * 回傳新的滿意度與實際扣分（<= 0）。
 */
export function noConstitutionPenalty(
  tier: ParliamentTier, status: ConstitutionStatus, satisfaction: number,
): { satisfaction: number; delta: number } {
  if (!constitutionRequired(tier) || status === "ratified") return { satisfaction, delta: 0 };
  if (satisfaction <= NO_CONSTITUTION_SAT_FLOOR) return { satisfaction, delta: 0 };
  const next = Math.max(NO_CONSTITUTION_SAT_FLOOR, satisfaction - NO_CONSTITUTION_PENALTY_PER_TICK);
  return { satisfaction: next, delta: next - satisfaction };
}

// ── 階段 3:憲法漏洞與危機 ────────────────────────────────────────────────
/** 每次擲骰回合,通過後的憲法觸發危機的機率。獨立於一般隨機事件的 30%。 */
export const CRISIS_CHANCE = 0.15;
/** 通過後至少要過幾個議會回合才會開始出現危機(給玩家喘息,也避開剛通過的滿意度加成)。 */
export const CRISIS_GRACE_TICKS = 6;
/** 兩次憲法危機之間至少間隔幾個回合。 */
export const CRISIS_SPACING_TICKS = 32;
export const FLAWS_MIN = 3;
export const FLAWS_MAX = 6;

/** 一個憲法漏洞。AI 只產生 title / description;triggered 由程式維護。 */
export interface ConstitutionFlaw {
  id: string;              // f1..f6,程式指定,不信 AI
  title: string;           // 危機事件標題(<= 24 字)
  description: string;     // 危機事件敘述(<= 140 字)
  triggered: boolean;      // 是否已引發過危機
  triggeredTick: number | null;
}

/** 挑出下一個要引爆的漏洞:尚未觸發者中,依 id 順序取第一個(可預期、可測試)。 */
export function nextUntriggeredFlaw(flaws: readonly ConstitutionFlaw[] | null | undefined): ConstitutionFlaw | null {
  if (!flaws) return null;
  return flaws.find((f) => !f.triggered) ?? null;
}

/**
 * 這個回合憲法危機要不要發生(純函式)。條件全部成立才擲骰:
 *  - 憲法已通過、且還有未觸發的漏洞;
 *  - 通過後已過 CRISIS_GRACE_TICKS 回合;
 *  - 距離上一次危機至少 CRISIS_SPACING_TICKS 回合。
 */
export function shouldRollCrisis(args: {
  status: ConstitutionStatus; tick: number; ratifiedTick: number | null;
  flaws: readonly ConstitutionFlaw[] | null | undefined;
}): boolean {
  if (args.status !== "ratified" || args.ratifiedTick === null) return false;
  if (!nextUntriggeredFlaw(args.flaws)) return false;
  if (args.tick - args.ratifiedTick < CRISIS_GRACE_TICKS) return false;
  const last = (args.flaws ?? []).reduce<number | null>(
    (m, f) => (f.triggeredTick !== null && (m === null || f.triggeredTick > m) ? f.triggeredTick : m), null);
  if (last !== null && args.tick - last < CRISIS_SPACING_TICKS) return false;
  return true;
}
