/**
 * 國情報告:玩家寫一段話向議會報告國情,AI 當議會評分。
 * 分數只影響議會滿意度(換算在 core.reportBonus,且有夾限),AI 失敗時走備援,絕不卡住。
 */
export const REPORT_MIN_LEN = 20;
export const REPORT_MAX_LEN = 600;
/** 冷卻:兩次國情報告至少間隔幾個議會 tick(一天 8 回合,3 tick ≈ 3/8 天)。 */
export const REPORT_COOLDOWN_TICKS = 8;
/** 代價:每次國情報告扣的金錢(不足則不能提交)。 */
/** 國情報告費的基準價(古典時代標準國的金額);實際金額依時代與國力縮放,見 reportCostFor。 */
export const REPORT_COST_MONEY = 500;

/** 縮放後的國情報告費。係數同送審費(主動行為,不比被動災難貴),見 constitution/core.ts 的 ACTIVE_ACTION_SCALE_RATIO。 */
export function reportCostFor(scale: number): number {
  const k = Number.isFinite(scale) && scale > 0 ? Math.max(1, scale * 0.125) : 1;
  return Math.max(1, Math.round(REPORT_COST_MONEY * k));
}

export interface ReportContext {
  nationName: string;
  governmentLabel: string;
  stability: number;
  atWar: boolean;
  protest: string;
  demand: string | null;
  partyLines: string[];   // 例如 "鷹派黨 42席(擴軍派)"
}

export interface ReportResult { score: number; feedback: string; source: "ai" | "fallback" }

export function validateReportText(text: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "請填寫國情報告內容" };
  const t = text.trim();
  if (t.length < REPORT_MIN_LEN) return { ok: false, error: `國情報告至少 ${REPORT_MIN_LEN} 字` };
  if (t.length > REPORT_MAX_LEN) return { ok: false, error: `國情報告最多 ${REPORT_MAX_LEN} 字` };
  return { ok: true, text: t };
}

/** 冷卻是否已過。lastReportTick 為 null = 從未提交。 */
export function reportCooldownLeft(tick: number, lastReportTick: number | null): number {
  if (lastReportTick === null) return 0;
  return Math.max(0, REPORT_COOLDOWN_TICKS - (tick - lastReportTick));
}

/** 嚴格解析 AI 回傳;任何不合法都回 null(交給備援)。 */
export function parseReportJson(raw: string): { score: number; feedback: string } | null {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  let obj: unknown;
  try { obj = JSON.parse(cleaned); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const score = typeof o["score"] === "number" ? o["score"] : Number(o["score"]);
  if (!Number.isFinite(score)) return null;
  const feedback = typeof o["feedback"] === "string" ? o["feedback"].trim().slice(0, 200) : "";
  return { score: Math.max(0, Math.min(100, Math.round(score))), feedback: feedback || "議會已聽取你的報告。" };
}

/** 備援:不靠 AI,依長度給中性偏低分,避免有人用備援刷分。 */
export function fallbackReport(text: string): ReportResult {
  const score = text.length >= 120 ? 48 : 42;
  return { score, feedback: "議會聽取了你的報告(目前無法詳細評議,給予中性評價)。", source: "fallback" };
}

