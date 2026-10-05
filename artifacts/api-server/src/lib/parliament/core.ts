/**
 * 選舉與議會 — 純邏輯核心（無 DB / Express / AI 依賴，方便單元測試）。
 *
 * 設計決定（2026-10-04，使用者確認）：
 *  - 政體分三檔：專制（橡皮圖章）／半專制（可提政策要求，單次扣分上限 -8）／民主（全額）。
 *  - 議會三回合提一次要求；要求期間「每回合」都判定是否遵守；沒寫政策視為輕度違背。
 *  - 議會對玩家說的話分兩種：「抗議內容」（不滿什麼）與「政策要求」（要你做什麼）。
 *  - 席次數字由公式算出；AI 只負責黨名與敘述。玩家唯讀。
 */

export type ParliamentTier = "autocracy" | "semi" | "democracy";

/** 政體 slug → 議會檔位。未知政體一律當半專制（最保守的中間值）。 */
export const GOVERNMENT_TIER: Record<string, ParliamentTier> = {
  absolute_monarchy: "autocracy",
  military_dictatorship: "autocracy",
  theocracy: "autocracy",
  elective_monarchy: "autocracy",
  constitutional_monarchy: "semi",
  dual_monarchy: "semi",
  aristocracy: "semi",
  plutocracy: "semi",
  confederation: "semi",
  council_system: "semi",
  socialist_council: "semi",
  presidential_democracy: "democracy",
  parliamentary: "democracy",
  parliamentary_republic: "democracy",
};

export function parliamentTier(governmentSlug: string | null | undefined): ParliamentTier {
  return GOVERNMENT_TIER[governmentSlug ?? ""] ?? "semi";
}

/**
 * 有效議會層級:政體層級 + 實際席次。
 * 專制政體預設是橡皮圖章;但若議會裡出現「非忠誠黨」過半(例如國內事件讓社會黨取得多數),
 * 橡皮圖章失效,議會開始問政,升級為 semi(要求上限 -8、可寫國情報告、滿意度歸零會革命)。
 * 不升到 democracy:專制下議會不該能大砍(上限 25),保留政體差異。
 * 社會黨被逐出(回到單一忠誠黨)後自動恢復橡皮圖章。
 */
export function effectiveParliamentTier(
  baseTier: ParliamentTier,
  parties: readonly { stance: ParliamentStance; seats: number }[],
  total: number = 100,
): ParliamentTier {
  if (baseTier !== "autocracy") return baseTier;
  const activeMajority = parties.some((p) => p.stance !== "loyalist" && p.seats * 2 > total);
  return activeMajority ? "semi" : "autocracy";
}

// ── 常數 ──────────────────────────────────────────────────────────────
export const PARLIAMENT_TOTAL_SEATS = 100;
export const PARLIAMENT_SATISFACTION_START = 60;
/** 革命後議會滿意度回到此值，避免立刻再爆。 */
export const PARLIAMENT_SATISFACTION_AFTER_REVOLUTION = 40;
/** 議會每隔幾回合提一次政策要求。 */
export const DEMAND_INTERVAL_TURNS = 3;
/** 各檔位單次「違背」最大扣分（半專制上限 -8；民主可大砍）。 */
export const MAX_PENALTY: Record<ParliamentTier, number> = {
  autocracy: 0,
  semi: 8,
  democracy: 25,
};
/** 紅色警告 / 國情報告加倍門檻。 */
export const PARLIAMENT_WARN_BELOW = 25;
export const PARLIAMENT_CRITICAL_BELOW = 10;
/** 革命分裂的土地比例。 */
export const REVOLUTION_SPLIT_RATIO = 0.4;

export function clampSat(v: number): number {
  if (!Number.isFinite(v)) return PARLIAMENT_SATISFACTION_START;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ── 政黨與席次 ─────────────────────────────────────────────────────────
export interface PartyInput {
  id: string;
  name: string;
  /** 該黨代表的立場，用來對應政策要求。 */
  stance: ParliamentStance;
  /** 勢力權重（>=0），由現況公式或 AI 建議給出；席次依權重按比例分配。 */
  weight: number;
}

export interface SeatedParty extends PartyInput {
  seats: number;
}

/**
 * 最大餘數法分配席次：總和必為 totalSeats，且每黨至少 1 席（權重 > 0 時）。
 * 權重全為 0 或無黨時回傳空陣列。
 */
export function allocateSeats(
  parties: readonly PartyInput[],
  totalSeats: number = PARLIAMENT_TOTAL_SEATS,
): SeatedParty[] {
  const valid = parties.filter((p) => Number.isFinite(p.weight) && p.weight > 0);
  if (valid.length === 0 || totalSeats <= 0) return [];
  // 黨數多於席次時，只保留權重最大的 totalSeats 個黨
  const kept = [...valid].sort((a, b) => b.weight - a.weight).slice(0, totalSeats);
  const sum = kept.reduce((s, p) => s + p.weight, 0);
  const raw = kept.map((p) => (p.weight / sum) * totalSeats);
  // 先給每黨至少 1 席，再把剩餘依最大餘數分配
  const seats = raw.map((r) => Math.max(1, Math.floor(r)));
  let used = seats.reduce((s, n) => s + n, 0);
  // 若最低保障使總數超過，從席次最多的黨扣
  while (used > totalSeats) {
    let idx = 0;
    for (let i = 1; i < seats.length; i++) if (seats[i]! > seats[idx]!) idx = i;
    if (seats[idx]! <= 1) break;
    seats[idx]!--; used--;
  }
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let k = 0;
  while (used < totalSeats) {
    seats[order[k % order.length]!.i]!++; used++; k++;
  }
  return kept.map((p, i) => ({ ...p, seats: seats[i]! }));
}

/** 專制：單一政黨橡皮圖章，100% 席次。 */
export function rubberStampParliament(party: { id: string; name: string }): SeatedParty[] {
  return [{ id: party.id, name: party.name, stance: "loyalist", weight: 1, seats: PARLIAMENT_TOTAL_SEATS }];
}

/** 執政黨 = 席次最多的黨（平手取 id 字典序小者，保證確定性）。 */
export function rulingParty(parties: readonly SeatedParty[]): SeatedParty | null {
  if (parties.length === 0) return null;
  return [...parties].sort((a, b) => b.seats - a.seats || a.id.localeCompare(b.id))[0]!;
}

// ── 政策要求 ───────────────────────────────────────────────────────────
/** 政黨立場 / 政策方向。要求與遵守判定都用這組。 */
export type ParliamentStance =
  | "loyalist"   // 橡皮圖章專用
  | "militarist" // 增加軍備
  | "pacifist"   // 不要開戰 / 削減軍備
  | "fiscal_hawk"// 減稅、節制支出
  | "welfare"    // 福利、民生、提高稅收用於人民
  | "religious"  // 宗教優先
  | "secular"    // 世俗化
  | "mercantile";// 商業、貿易

export const STANCE_LABELS: Record<ParliamentStance, string> = {
  loyalist: "效忠派",
  militarist: "擴軍派",
  pacifist: "和平派",
  fiscal_hawk: "節流減稅派",
  welfare: "民生福利派",
  religious: "宗教派",
  secular: "世俗派",
  mercantile: "商貿派",
};

/** 一回合內用來判定「有沒有遵守」的玩家行為快照（由 DB 層組出來，這裡只吃數字）。 */
export interface ComplianceSnapshot {
  /** 本回合是否發動或處於進攻性戰爭。 */
  atWar: boolean;
  /** 軍費（或兵力）相對上回合的變化比例，例如 +0.1 = 增加 10%。 */
  militarySpendChange: number;
  /** 稅率相對上回合的變化（百分點），正 = 加稅。 */
  taxChange: number;
  /** 本回合玩家有沒有寫入任何政策（沒寫 = 預設輕度違背）。 */
  wrotePolicy: boolean;
  /** 本回合政策是否朝宗教方向 / 世俗方向（-1 世俗、0 無、+1 宗教）。 */
  religionLean: -1 | 0 | 1;
  /** 本回合貿易 / 建設商業投資是否增加。 */
  commerceUp: boolean;
}

export type ComplianceLevel = "complied" | "minor" | "major" | "severe";

export const COMPLIANCE_LABELS: Record<ComplianceLevel, string> = {
  complied: "遵守",
  minor: "輕度違背",
  major: "明確違背",
  severe: "嚴重違背",
};

/**
 * 單回合遵守判定（純規則，不靠 AI）。
 * 沒寫政策 → 預設「輕度違背」（除非該要求本來就是「維持現狀」類，這裡不特別處理）。
 */
export function judgeCompliance(
  stance: ParliamentStance,
  s: ComplianceSnapshot,
): ComplianceLevel {
  if (!s.wrotePolicy) return "minor";
  switch (stance) {
    case "militarist":
      if (s.militarySpendChange >= 0.05) return "complied";
      if (s.militarySpendChange <= -0.1) return "severe";
      if (s.militarySpendChange < 0) return "major";
      return "minor";
    case "pacifist":
      if (s.atWar) return s.militarySpendChange > 0.1 ? "severe" : "major";
      return s.militarySpendChange <= 0.05 ? "complied" : "minor";
    case "fiscal_hawk":
      if (s.taxChange <= 0) return "complied";
      return s.taxChange >= 5 ? "severe" : s.taxChange >= 2 ? "major" : "minor";
    case "welfare":
      if (s.taxChange >= 0 && s.militarySpendChange <= 0.05) return "complied";
      return s.militarySpendChange > 0.2 ? "major" : "minor";
    case "religious":
      return s.religionLean > 0 ? "complied" : s.religionLean < 0 ? "severe" : "minor";
    case "secular":
      return s.religionLean < 0 ? "complied" : s.religionLean > 0 ? "severe" : "minor";
    case "mercantile":
      return s.commerceUp ? "complied" : "minor";
    case "loyalist":
    default:
      return "complied";
  }
}

const LEVEL_WEIGHT: Record<ComplianceLevel, number> = {
  complied: 0, minor: 1, major: 3, severe: 6,
};
const LEVEL_SAT_GAIN_COMPLIED = 2;

/**
 * 一回合的議會滿意度變化。
 * 遵守 → 小幅 +2；違背 → 依等級扣分，並受該政體檔位的單次上限封頂。
 * 專制檔位不會扣（橡皮圖章）。
 */
export function complianceDelta(level: ComplianceLevel, tier: ParliamentTier): number {
  if (tier === "autocracy") return 0;
  if (level === "complied") return LEVEL_SAT_GAIN_COMPLIED;
  const raw = LEVEL_WEIGHT[level] * (tier === "democracy" ? 2 : 1);
  return -Math.min(raw, MAX_PENALTY[tier]);
}

/**
 * 整個三回合要求期的結算：把每回合的扣分加總，仍受單次上限封頂（半專制 -8）。
 * （民主的「嚴重違背大砍」靠上限 25 體現。）
 */
export function demandPeriodDelta(
  levels: readonly ComplianceLevel[],
  tier: ParliamentTier,
): number {
  if (tier === "autocracy") return 0;
  const total = levels.reduce((s, l) => s + complianceDelta(l, tier), 0);
  return total < 0 ? Math.max(total, -MAX_PENALTY[tier]) : total;
}

// ── 議會滿意度：自然漂移與國情報告 ─────────────────────────────────────
/** 無事發生時，議會滿意度向 50 緩慢回歸（±1 / 回合）。 */
export function naturalDrift(current: number): number {
  const c = clampSat(current);
  if (c > 55) return clampSat(c - 1);
  if (c < 45) return clampSat(c + 1);
  return c;
}

/** 國情報告分數（0–100，AI 評分）→ 議會滿意度加成。低於 10 時效果加倍。 */
export function reportBonus(score: number, currentSat: number): number {
  const s = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const base = Math.round((s - 40) / 6); // 40 分持平，100 分約 +10，0 分約 -7
  const clamped = Math.max(-5, Math.min(10, base));
  const mult = currentSat < PARLIAMENT_CRITICAL_BELOW && clamped > 0 ? 2 : 1;
  return clamped * mult;
}

/** 專制不需要安撫議會，國情報告不開放。 */
export function canSubmitReport(tier: ParliamentTier): boolean {
  return tier !== "autocracy";
}

export type ParliamentAlert = "ok" | "warn" | "critical" | "revolt";
export function parliamentAlert(sat: number): ParliamentAlert {
  if (sat <= 0) return "revolt";
  if (sat < PARLIAMENT_CRITICAL_BELOW) return "critical";
  if (sat < PARLIAMENT_WARN_BELOW) return "warn";
  return "ok";
}

/** 革命條件：議會滿意度歸零，且政體不是專制（專制靠軍方，不靠議會）。 */
export function shouldRevolt(sat: number, tier: ParliamentTier): boolean {
  return tier !== "autocracy" && sat <= 0;
}

// ── 革命分裂 ───────────────────────────────────────────────────────────
export interface RegionShare { regionId: number; percent: number; oppositionStrength?: number }
export interface SplitPlan {
  mode: "split" | "regime_change";
  /** split：每塊地要割給分裂政權的控制度百分點。 */
  transfers: { regionId: number; percent: number }[];
}

/**
 * 革命時的土地分割：
 *  - 只有一塊地 → 該地割 40% 控制度給分裂政權。
 *  - 多塊地 → 挑反對黨勢力最強（同分取 regionId 小者）的地區，整塊或部分脫離，
 *    直到總控制度約達 40%。
 *  - 完全沒有地區 → 改走政體更替（regime_change）。
 */
export function planRevolutionSplit(
  regions: readonly RegionShare[],
  ratio: number = REVOLUTION_SPLIT_RATIO,
): SplitPlan {
  const owned = regions.filter((r) => r.percent > 0);
  if (owned.length === 0) return { mode: "regime_change", transfers: [] };
  const total = owned.reduce((s, r) => s + r.percent, 0);
  let need = Math.round(total * ratio * 100) / 100;
  const ranked = [...owned].sort(
    (a, b) => (b.oppositionStrength ?? 0) - (a.oppositionStrength ?? 0) || a.regionId - b.regionId,
  );
  const transfers: { regionId: number; percent: number }[] = [];
  for (const r of ranked) {
    if (need <= 0) break;
    const take = Math.min(r.percent, need);
    transfers.push({ regionId: r.regionId, percent: Math.round(take * 100) / 100 });
    need = Math.round((need - take) * 100) / 100;
  }
  return { mode: "split", transfers };
}

// ── 議會對玩家說的話：兩種 ─────────────────────────────────────────────
export interface ParliamentMessage {
  /** 抗議內容：議會不滿什麼（描述現況，不下指令）。 */
  protest: string;
  /** 政策要求：要玩家做什麼（下指令）。專制為 null。 */
  demand: { stance: ParliamentStance; text: string } | null;
}

/** 由穩定規則產生的備援措辭（AI 失敗或關閉時使用），確保永遠有內容可顯示。 */
export function fallbackMessage(
  stance: ParliamentStance,
  partyName: string,
  tier: ParliamentTier,
): ParliamentMessage {
  const PROTEST: Record<ParliamentStance, string> = {
    loyalist: "議會一致擁護領袖。",
    militarist: "近來邊防鬆弛，軍備落後於鄰國，令議員憂心。",
    pacifist: "連年征戰使民不聊生，議員要求停止無謂的流血。",
    fiscal_hawk: "賦稅沉重、國庫揮霍，議員對財政紀律極為不滿。",
    welfare: "民生困頓、福利不足，議員認為政府忽視了百姓。",
    religious: "信仰日漸式微，議員認為國家失去了精神根基。",
    secular: "宗教勢力過度干政，議員要求政教分離。",
    mercantile: "商路萎縮、投資停滯，議員擔心國家經濟失去活力。",
  };
  const DEMAND: Record<ParliamentStance, string> = {
    loyalist: "",
    militarist: "請在接下來三回合內增加軍備與兵力。",
    pacifist: "請在接下來三回合內避免發動戰爭並節制軍費。",
    fiscal_hawk: "請在接下來三回合內降低或維持稅率，不得加稅。",
    welfare: "請在接下來三回合內維持稅收並優先民生，不得擴大軍費。",
    religious: "請在接下來三回合內推行有利宗教的政策。",
    secular: "請在接下來三回合內推行世俗化政策。",
    mercantile: "請在接下來三回合內擴大貿易與商業投資。",
  };
  void partyName;
  return {
    protest: PROTEST[stance],
    demand: tier === "autocracy" ? null : { stance, text: DEMAND[stance] },
  };
}

/** 要求是否到期：以回合序號計，每 DEMAND_INTERVAL_TURNS 回合一次。 */
export function isDemandDue(currentTurn: number, lastDemandTurn: number | null): boolean {
  if (lastDemandTurn === null) return true;
  return currentTurn - lastDemandTurn >= DEMAND_INTERVAL_TURNS;
}
