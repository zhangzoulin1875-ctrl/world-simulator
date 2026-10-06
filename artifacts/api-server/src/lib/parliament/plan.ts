import {
  type ParliamentTier, type ParliamentStance, type ComplianceLevel, type ComplianceSnapshot,
  type SeatedParty, DEMAND_INTERVAL_TURNS, PARLIAMENT_SATISFACTION_AFTER_REVOLUTION, MAX_PENALTY,
  clampSat, judgeCompliance, complianceDelta, naturalDrift, shouldRevolt, rulingParty,
  isDemandDue, fallbackMessage, COMPLIANCE_LABELS,
} from "./core";

/**
 * 單國單回合的議會結算規劃（純函式）。
 * 輸入：議會現況 + 本回合客觀數據；輸出：新狀態 + 要寫的紀錄 + 是否革命。
 * DB 層只負責「讀資料 → 呼叫這裡 → 寫回」，規則全在這，方便測試。
 */
export interface PlanInput {
  tier: ParliamentTier;
  tick: number;                       // 本次結算「之前」的 tick
  satisfaction: number;
  lastDemandTick: number | null;
  activeDemand: { stance: ParliamentStance; text: string; issuedTick: number; levels: ComplianceLevel[] } | null;
  parties: readonly SeatedParty[];
  snapshot: ComplianceSnapshot;       // 本回合玩家行為
  /** 專制下的軍方滿意度（0–100）；用來讓專制議會「只看軍方」。null = 不適用。 */
  militarySatisfaction: number | null;
  /** 目前是否有任何進行中的戰爭(不分攻守);決定抗議措辭是否能提到戰事。預設視為和平。 */
  atWar?: boolean;
  /** 事先由 AI 依國情／國際局勢生成的抗議與要求文字；沒有或失敗就退回模板。立場仍由規則決定。 */
  aiMessage?: { protest: string; demandText: string | null } | null;
}

export interface PlanLogEntry { kind: "demand" | "judgement" | "revolution" | "constitution"; summary: string; satDelta: number }

export interface PlanResult {
  tick: number;                       // 新 tick
  satisfaction: number;
  lastDemandTick: number | null;
  activeDemand: PlanInput["activeDemand"];
  protestText: string | null;         // null = 這回合不更新抗議內容
  revolt: boolean;
  logs: PlanLogEntry[];
}

export function planParliamentTurn(inp: PlanInput): PlanResult {
  const tick = inp.tick + 1;
  const logs: PlanLogEntry[] = [];
  let sat = clampSat(inp.satisfaction);
  let active = inp.activeDemand ? { ...inp.activeDemand, levels: [...inp.activeDemand.levels] } : null;
  let lastDemandTick = inp.lastDemandTick;
  let protestText: string | null = null;

  // ── 專制：橡皮圖章。議會滿意度固定鎖高，不提要求、不扣分、不革命。 ─────
  if (inp.tier === "autocracy") {
    return {
      tick, satisfaction: 80, lastDemandTick, activeDemand: null,
      protestText: "議會一致擁護領袖，無異議。", revolt: false, logs,
    };
  }

  // ── 1. 進行中的要求：每回合都判定一次 ─────────────────────────────────
  if (active) {
    const level = judgeCompliance(active.stance, inp.snapshot);
    // 本要求期「已累計扣掉多少」（只算負的）；單次要求期累計扣分不得超過該檔位上限。
    const spent = active.levels.reduce((n, l) => {
      const x = complianceDelta(l as ComplianceLevel, inp.tier);
      return x < 0 ? n + -x : n;
    }, 0);
    let d = complianceDelta(level, inp.tier);
    if (d < 0) d = -Math.max(0, Math.min(-d, MAX_PENALTY[inp.tier] - spent));
    active.levels.push(level);
    sat = clampSat(sat + d);
    logs.push({
      kind: "judgement",
      summary: `「${active.text}」本回合判定:${COMPLIANCE_LABELS[level]}`,
      satDelta: d,
    });
    // 三回合期滿 → 結案
    if (tick - active.issuedTick >= DEMAND_INTERVAL_TURNS) active = null;
  } else {
    // 沒有要求時，滿意度向中間緩慢回歸
    sat = naturalDrift(sat);
  }

  // ── 2. 到期就提新要求（上一個已結案才提）─────────────────────────────
  if (!active && isDemandDue(tick, lastDemandTick)) {
    const ruling = rulingParty(inp.parties);
    if (ruling) {
      const base = fallbackMessage(ruling.stance, ruling.name, inp.tier, inp.atWar === true);
      const ai = inp.aiMessage;
      const msg = {
        protest: ai && ai.protest.trim() ? ai.protest.trim() : base.protest,
        demand: base.demand
          ? { stance: base.demand.stance, text: ai && ai.demandText && ai.demandText.trim() ? ai.demandText.trim() : base.demand.text }
          : null,
      };
      protestText = msg.protest;
      if (msg.demand) {
        active = { stance: msg.demand.stance, text: msg.demand.text, issuedTick: tick, levels: [] };
        lastDemandTick = tick;
        logs.push({ kind: "demand", summary: `${ruling.name}提出要求:${msg.demand.text}`, satDelta: 0 });
      }
    }
  }

  // ── 3. 革命 ─────────────────────────────────────────────────────────
  const revolt = shouldRevolt(sat, inp.tier);
  if (revolt) {
    logs.push({ kind: "revolution", summary: "議會滿意度歸零,革命爆發,部分地區宣布獨立並向你宣戰。", satDelta: 0 });
    sat = PARLIAMENT_SATISFACTION_AFTER_REVOLUTION;
    active = null;
  }

  return { tick, satisfaction: sat, lastDemandTick, activeDemand: active, protestText, revolt, logs };
}
