/**
 * 聯合政府 — 純邏輯核心(無 DB / Express / AI 依賴)。
 *
 * 設計決定(2026-10-07,使用者確認):
 *  - 聯合政府由議會「自己組」,玩家不能干涉、沒有談判與承諾。
 *  - 政策由組成聯合政府的各黨折衷:政府態度 = 成員各黨態度按席次加權平均。
 *  - 全部用公式,不問 AI;所有隨機都可注入 rng 以便測試。
 *  - 專制不適用(單一黨橡皮圖章);半專制由現任黨自動組閣,不走相容度組閣。
 */
import {
  PARLIAMENT_TOTAL_SEATS, rulingParty,
  type ParliamentStance, type SeatedParty,
} from "./core";
import { partyAttitude, type PolicyTag, type VoteStand } from "./vote";

/** 執政門檻:過半。 */
export const MAJORITY_SEATS = Math.floor(PARLIAMENT_TOTAL_SEATS / 2) + 1;
/** 連續組閣失敗幾次後提前大選。 */
export const MAX_FORMATION_FAILURES = 3;
/** 看守政府每回合扣的議會滿意度。 */
export const CARETAKER_SAT_PENALTY = 1;
/** 看守政府的扣分下限:滿意度只會被它磨到這個值,更低要靠別的原因(戰敗、政策被否決…)。 */
export const CARETAKER_SAT_FLOOR = 20;
/** 聯合倒閣(席次跌破過半)時扣的議會滿意度。 */
export const COLLAPSE_SAT_PENALTY = 10;
/** 立場相容度低於此值的黨不會被拉進聯合。 */
export const MIN_COMPATIBILITY = 0.25;
/** 單一成員黨每回合退出機率的上限(避免穩定度算出離譜值)。 */
export const MAX_DEFECT_CHANCE = 0.35;

export type Rng = () => number;

/**
 * 立場相容度 0–1(1 = 同立場,0 = 水火不容)。對稱。
 * 規則:同立場 1;天然對立組(擴軍/和平、宗教/世俗、節流/福利)0;
 * 其餘用一張手寫的「近親」表,表上沒有的一律 0.4(中性)。
 */
const AFFINITY: Record<string, number> = {
  "fiscal_hawk|mercantile": 0.85,
  "mercantile|welfare": 0.5,
  "militarist|religious": 0.7,
  "militarist|fiscal_hawk": 0.45,
  "militarist|mercantile": 0.5,
  "pacifist|secular": 0.75,
  "pacifist|welfare": 0.8,
  "secular|welfare": 0.7,
  "religious|fiscal_hawk": 0.55,
  "religious|welfare": 0.4,
  "mercantile|secular": 0.6,
  "mercantile|pacifist": 0.55,
};
const HOSTILE = new Set(["militarist|pacifist", "religious|secular", "fiscal_hawk|welfare"]);
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function compatibility(a: ParliamentStance, b: ParliamentStance): number {
  if (a === b) return 1;
  // 忠誠黨(橡皮圖章)只會在專制出現,與誰都談不上相容
  if (a === "loyalist" || b === "loyalist") return 0;
  const k = key(a, b);
  if (HOSTILE.has(k)) return 0;
  return AFFINITY[k] ?? 0.4;
}

export interface CoalitionResult {
  /** 組成聯合政府的黨 id(含總理黨);空陣列 = 組閣失敗。 */
  memberIds: string[];
  /** 總理黨 id(聯合內席次最多者);失敗時 null。 */
  primeId: string | null;
  seats: number;
  /** 是否單獨過半(不需要夥伴)。 */
  single: boolean;
  ok: boolean;
}

const byStrength = (a: SeatedParty, b: SeatedParty) => b.seats - a.seats || Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);

/**
 * 組閣(確定性):最大黨當組閣者;單獨過半就直接執政;
 * 否則依「與組閣者的相容度高→低(同分席次多者優先)」逐個拉黨,
 * 直到合計過半。相容度低於 MIN_COMPATIBILITY 的黨不拉;拉完還不過半 → 失敗。
 */
export function formCoalition(parties: readonly SeatedParty[]): CoalitionResult {
  const fail: CoalitionResult = { memberIds: [], primeId: null, seats: 0, single: false, ok: false };
  const sorted = [...parties].filter((p) => p.seats > 0).sort(byStrength);
  const lead = sorted[0];
  if (!lead) return fail;
  if (lead.seats >= MAJORITY_SEATS) {
    return { memberIds: [lead.id], primeId: lead.id, seats: lead.seats, single: true, ok: true };
  }
  const candidates = sorted.slice(1)
    .map((p) => ({ p, c: compatibility(lead.stance, p.stance) }))
    .filter((x) => x.c >= MIN_COMPATIBILITY)
    .sort((a, b) => b.c - a.c || byStrength(a.p, b.p));
  const members = [lead];
  let seats = lead.seats;
  for (const { p } of candidates) {
    if (seats >= MAJORITY_SEATS) break;
    members.push(p); seats += p.seats;
  }
  if (seats < MAJORITY_SEATS) return fail;
  return { memberIds: members.map((m) => m.id), primeId: lead.id, seats, single: false, ok: true };
}

/** 半專制:現任執政黨自動組閣(不論是否過半)。找不到現任就退回一般組閣。 */
export function semiCoalition(parties: readonly SeatedParty[], incumbentId: string | null): CoalitionResult {
  const inc = parties.find((p) => p.id === incumbentId) ?? rulingParty(parties);
  if (!inc) return { memberIds: [], primeId: null, seats: 0, single: false, ok: false };
  return { memberIds: [inc.id], primeId: inc.id, seats: inc.seats, single: inc.seats >= MAJORITY_SEATS, ok: true };
}

// ── 政策折衷 ───────────────────────────────────────────────────────────
export interface GovernmentStand {
  stand: VoteStand;
  /** 加權平均態度(-1 ~ 1),給 UI 顯示「折衷傾向」。 */
  score: number;
  /** 聯合內各成員的態度,給 UI 說明為何折衷成這樣。 */
  members: { partyId: string; name: string; seats: number; attitude: number }[];
}

/** 折衷的死區:|加權平均| 小於此值視為棄權(內部意見相左就不表態)。 */
export const COMPROMISE_DEADZONE = 0.15;

/**
 * 政府對一項政策的態度 = 成員態度按席次加權平均。
 * 單黨政府 = 該黨自己的態度;平均落在死區內 = 棄權。
 */
export function governmentStand(
  members: readonly SeatedParty[],
  tags: readonly PolicyTag[],
): GovernmentStand {
  const total = members.reduce((n, p) => n + p.seats, 0);
  const rows = members.map((p) => ({
    partyId: p.id, name: p.name, seats: p.seats, attitude: partyAttitude(p.stance, tags),
  }));
  if (total <= 0) return { stand: "abstain", score: 0, members: rows };
  // 單項態度可能 > 1(多個標籤疊加),先夾到 -1~1 再平均,避免一個極端黨壓過全部
  const score = rows.reduce((n, r) => n + Math.max(-1, Math.min(1, r.attitude)) * r.seats, 0) / total;
  const stand: VoteStand = score > COMPROMISE_DEADZONE ? "for" : score < -COMPROMISE_DEADZONE ? "against" : "abstain";
  return { stand, score: Math.round(score * 100) / 100, members: rows };
}

// ── 穩定度與裂解 ───────────────────────────────────────────────────────
export type CoalitionRisk = "low" | "mid" | "high";

/**
 * 聯合穩定度 0–1:成員兩兩相容度的席次加權平均,再乘上「過半餘裕」係數
 * (剛好過半的聯合更脆弱)。單黨政府 = 1。
 */
export function coalitionStability(members: readonly SeatedParty[]): number {
  if (members.length <= 1) return 1;
  let num = 0, den = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const w = members[i]!.seats * members[j]!.seats;
      num += compatibility(members[i]!.stance, members[j]!.stance) * w; den += w;
    }
  }
  const avgCompat = den > 0 ? num / den : 1;
  const seats = members.reduce((n, p) => n + p.seats, 0);
  const margin = Math.max(0, Math.min(1, (seats - MAJORITY_SEATS) / 15)); // 超過半數 15 席以上 = 穩
  return Math.round(avgCompat * (0.7 + 0.3 * margin) * 100) / 100;
}

export function coalitionRisk(stability: number): CoalitionRisk {
  return stability >= 0.7 ? "low" : stability >= 0.5 ? "mid" : "high";
}

/** 非總理黨的成員每回合退出機率(穩定度越低、自己與總理黨越不合,越容易走)。 */
export function defectChance(stability: number, memberCompatWithPrime: number): number {
  const base = (1 - stability) * 0.3 + (1 - memberCompatWithPrime) * 0.1;
  return Math.max(0, Math.min(MAX_DEFECT_CHANCE, Math.round(base * 1000) / 1000));
}

export interface CoalitionTick {
  /** 本回合退出的黨 id。 */
  defectors: string[];
  /** 退出後剩下的成員是否仍過半。 */
  collapsed: boolean;
}

/** 每回合檢查裂解。總理黨不會自己退出;單黨政府不會裂解。rng 可注入。 */
export function rollDefections(
  members: readonly SeatedParty[], primeId: string | null, rng: Rng = Math.random,
): CoalitionTick {
  if (members.length <= 1 || !primeId) return { defectors: [], collapsed: false };
  const prime = members.find((m) => m.id === primeId);
  if (!prime) return { defectors: [], collapsed: false };
  const st = coalitionStability(members);
  const defectors = members
    .filter((m) => m.id !== primeId && rng() < defectChance(st, compatibility(prime.stance, m.stance)))
    .map((m) => m.id);
  const remaining = members.filter((m) => !defectors.includes(m.id));
  const seats = remaining.reduce((n, p) => n + p.seats, 0);
  return { defectors, collapsed: defectors.length > 0 && seats < MAJORITY_SEATS };
}

/** 看守政府的政策表決門檻:贊成席需比反對席多出此比例(正常是 > 0)。 */
export const CARETAKER_VOTE_MARGIN = 0.1;
