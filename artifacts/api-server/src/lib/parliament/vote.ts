/**
 * 議會政策表決 — 純邏輯核心（無 DB / Express / AI 依賴，方便單元測試）。
 *
 * 設計決定（2026-10-07，使用者確認）：
 *  - 民主國家：玩家提出的「全部」政策想法交議會表決，取代結算時的成功率骰子。
 *  - 半專制：只有「重大政策」（tradition／reform 類）需表決，一般政策照舊。
 *  - 專制（橡皮圖章）：不表決，維持舊的成功率機制。
 *  - AI 只負責「政策性質標籤」與成功／失敗版內容；各黨態度、票數、過不過全部由本檔公式算。
 *  - 被否決時玩家可「強行通過」：政策照樣生效，但議會滿意度被大扣（幅度隨反對席次比例）。
 */
import {
  type ParliamentStance,
  type ParliamentTier,
  type SeatedParty,
  clampSat,
} from "./core";

/** 政策性質標籤可用的立場（loyalist 不是政策性質，不可被 AI 指定）。 */
export const POLICY_TAG_STANCES = [
  "militarist",
  "pacifist",
  "fiscal_hawk",
  "welfare",
  "religious",
  "secular",
  "mercantile",
] as const;
export type PolicyTagStance = (typeof POLICY_TAG_STANCES)[number];

/** 一個標籤：政策「往這個立場的方向」推進（+1）或反向（-1）。 */
export interface PolicyTag {
  stance: PolicyTagStance;
  direction: 1 | -1;
}

/** 最多採用幾個標籤（AI 給太多時截斷，避免所有黨都被牽扯而失去鑑別力）。 */
export const MAX_POLICY_TAGS = 3;

/** 宗教與世俗、擴軍與和平是天然對立，同向推進其中一方 = 反向推進另一方。 */
const OPPOSITE: Partial<Record<PolicyTagStance, PolicyTagStance>> = {
  militarist: "pacifist",
  pacifist: "militarist",
  religious: "secular",
  secular: "religious",
  fiscal_hawk: "welfare",
  welfare: "fiscal_hawk",
};

/**
 * 單一黨對政策的態度分數。
 *  - 忠誠黨（執政支持者）一律 +1：橡皮圖章式的支持。
 *  - 其他黨：標籤與其立場同向 +1、反向 -1；標籤指向其對立立場時，同向 -1、反向 +1。
 *  - 商貿派沒有對立面，只看自己的標籤。
 */
export function partyAttitude(stance: ParliamentStance, tags: readonly PolicyTag[]): number {
  if (stance === "loyalist") return 1;
  let score = 0;
  for (const t of tags) {
    if (t.stance === stance) score += t.direction;
    else if (OPPOSITE[t.stance] === stance) score -= t.direction;
  }
  return score;
}

/** 政府折衷態度(與 coalition.governmentStand 同公式;放這裡避免循環引用)。 */
const COMPROMISE_DEADZONE_V = 0.15;
function govStandOf(members: readonly SeatedParty[], tags: readonly PolicyTag[]): { stand: VoteStand; score: number } {
  const total = members.reduce((n, p) => n + p.seats, 0);
  if (total <= 0) return { stand: "abstain", score: 0 };
  const score = members.reduce((n, p) => n + Math.max(-1, Math.min(1, partyAttitude(p.stance, tags))) * p.seats, 0) / total;
  const stand: VoteStand = score > COMPROMISE_DEADZONE_V ? "for" : score < -COMPROMISE_DEADZONE_V ? "against" : "abstain";
  return { stand, score: Math.round(score * 100) / 100 };
}

export type VoteStand = "for" | "against" | "abstain";

export interface PartyVote {
  partyId: string;
  name: string;
  stance: ParliamentStance;
  seats: number;
  stand: VoteStand;
  attitude: number;
}

export interface VoteResult {
  votes: PartyVote[];
  seatsFor: number;
  seatsAgainst: number;
  seatsAbstain: number;
  passed: boolean;
  /** 反對席次占「有表態席次」的比例（0–1）；強行通過的扣分依此。 */
  againstRatio: number;
}

/**
 * 表決：贊成席 > 反對席 即通過；棄權不計；全員棄權（或無黨）視為通過
 * （議會對這項政策沒有意見，不該卡住玩家）。平手視為否決。
 */
export function tallyVote(
  parties: readonly SeatedParty[],
  tags: readonly PolicyTag[],
): VoteResult {
  const cleaned = normalizeTags(tags);
  const votes: PartyVote[] = parties.map((p) => {
    const attitude = partyAttitude(p.stance, cleaned);
    const stand: VoteStand = attitude > 0 ? "for" : attitude < 0 ? "against" : "abstain";
    return { partyId: p.id, name: p.name, stance: p.stance, seats: p.seats, stand, attitude };
  });
  const sum = (s: VoteStand) => votes.filter((v) => v.stand === s).reduce((a, v) => a + v.seats, 0);
  const seatsFor = sum("for");
  const seatsAgainst = sum("against");
  const seatsAbstain = sum("abstain");
  const decided = seatsFor + seatsAgainst;
  const passed = decided === 0 ? true : seatsFor > seatsAgainst;
  const againstRatio = decided === 0 ? 0 : seatsAgainst / decided;
  return { votes, seatsFor, seatsAgainst, seatsAbstain, passed, againstRatio };
}

/**
 * 聯合政府版表決:成員黨合成「政府」一票(席次 = 成員席次總和,態度 = 成員折衷),
 * 其餘反對黨照舊各自表態。沒有聯合(成員 < 2 黨)時與 tallyVote 完全等價。
 * `caretaker` = 看守政府:贊成席需明顯多於反對席(多出有表態席次的 CARETAKER_VOTE_MARGIN)才算通過。
 */
export function tallyVoteWithGovernment(
  parties: readonly SeatedParty[],
  tags: readonly PolicyTag[],
  memberIds: readonly string[],
  opts: { caretaker?: boolean; marginRatio?: number } = {},
): VoteResult {
  const ids = new Set(memberIds);
  const members = parties.filter((p) => ids.has(p.id));
  if (members.length < 2 && !opts.caretaker) return tallyVote(parties, tags);
  const cleaned = normalizeTags(tags);
  const gov = members.length >= 2 ? govStandOf(members, cleaned) : null;
  const votes: PartyVote[] = [];
  if (gov) {
    const seats = members.reduce((n, p) => n + p.seats, 0);
    const lead = [...members].sort((a, b) => b.seats - a.seats || a.id.localeCompare(b.id))[0]!;
    votes.push({
      partyId: lead.id, name: `執政聯盟(${members.map((m) => m.name).join("、")})`,
      stance: lead.stance, seats, stand: gov.stand, attitude: gov.score,
    });
  }
  for (const p of parties) {
    if (gov && ids.has(p.id)) continue;
    const attitude = partyAttitude(p.stance, cleaned);
    const stand: VoteStand = attitude > 0 ? "for" : attitude < 0 ? "against" : "abstain";
    votes.push({ partyId: p.id, name: p.name, stance: p.stance, seats: p.seats, stand, attitude });
  }
  const sum = (st: VoteStand) => votes.filter((v) => v.stand === st).reduce((a, v) => a + v.seats, 0);
  const seatsFor = sum("for"), seatsAgainst = sum("against"), seatsAbstain = sum("abstain");
  const decided = seatsFor + seatsAgainst;
  const margin = opts.caretaker ? (opts.marginRatio ?? 0.1) * decided : 0;
  const passed = decided === 0 ? true : seatsFor - seatsAgainst > margin;
  const againstRatio = decided === 0 ? 0 : seatsAgainst / decided;
  return { votes, seatsFor, seatsAgainst, seatsAbstain, passed, againstRatio };
}

/** 去除無效/重複標籤並截斷到上限；同一立場出現多次以第一次為準。 */
export function normalizeTags(raw: readonly PolicyTag[] | null | undefined): PolicyTag[] {
  if (!raw) return [];
  const seen = new Set<PolicyTagStance>();
  const out: PolicyTag[] = [];
  for (const t of raw) {
    if (!t || !(POLICY_TAG_STANCES as readonly string[]).includes(t.stance)) continue;
    if (t.direction !== 1 && t.direction !== -1) continue;
    if (seen.has(t.stance)) continue;
    seen.add(t.stance);
    out.push({ stance: t.stance, direction: t.direction });
    if (out.length >= MAX_POLICY_TAGS) break;
  }
  return out;
}

// ── 哪些政策需要表決 ───────────────────────────────────────────────────
export type PolicyResultType = "policy" | "tradition" | "reform";

/** 這項政策想法在該檔位下是否要交議會表決。 */
export function needsParliamentVote(tier: ParliamentTier, resultType: PolicyResultType): boolean {
  if (tier === "democracy") return true;
  if (tier === "semi") return resultType === "tradition" || resultType === "reform";
  return false;
}

// ── 強行通過的代價 ─────────────────────────────────────────────────────
/** 強行通過扣議會滿意度：基本 6，反對比例越高越重，最高 20。 */
export const OVERRIDE_PENALTY_MIN = 6;
export const OVERRIDE_PENALTY_MAX = 20;

export function overridePenalty(againstRatio: number): number {
  const r = Math.max(0, Math.min(1, againstRatio));
  return Math.round(OVERRIDE_PENALTY_MIN + (OVERRIDE_PENALTY_MAX - OVERRIDE_PENALTY_MIN) * r);
}

/** 強行通過後的新議會滿意度。 */
export function satisfactionAfterOverride(current: number, againstRatio: number): number {
  return clampSat(current - overridePenalty(againstRatio));
}

// ── 玩家可見的簡短說明 ─────────────────────────────────────────────────
const STAND_LABEL: Record<VoteStand, string> = { for: "贊成", against: "反對", abstain: "棄權" };

/** 一行摘要，用於通知與預覽，例如「贊成 58 席 · 反對 31 席 · 棄權 11 席，通過」。 */
export function summarizeVote(r: VoteResult): string {
  return `贊成 ${r.seatsFor} 席 · 反對 ${r.seatsAgainst} 席 · 棄權 ${r.seatsAbstain} 席，${r.passed ? "通過" : "否決"}`;
}

export function standLabel(s: VoteStand): string {
  return STAND_LABEL[s];
}
