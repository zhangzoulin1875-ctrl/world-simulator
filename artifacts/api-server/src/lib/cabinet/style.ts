import type { CabinetStyle } from "@workspace/db";
import type { AgencyLevel } from "./types";
import { AGENCY_LEVEL_LABELS } from "./types";

/**
 * Task #242 — 內閣執政風格的純函式（單元測試）。
 * 供 AI prompt 片段、前端顯示與下游領域模組共用；不觸碰 DB／IO。
 */

/** 把 0–100 分成 低／中／高 三個帶（<34 低、<67 中、其餘 高）。 */
export function styleBand(value: number): "低" | "中" | "高" {
  const v = clamp0to100(value);
  if (v < 34) return "低";
  if (v < 67) return "中";
  return "高";
}

export function clamp0to100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 正規化 AI／輸入的風格為安全值（數值夾在 0–100、敘述去頭尾空白）。 */
export function normalizeStyle(style: CabinetStyle): CabinetStyle {
  return {
    overreach: clamp0to100(style.overreach),
    timidity: clamp0to100(style.timidity),
    description: style.description.trim(),
  };
}

/**
 * 產生給下游 AI prompt 的執政風格片段（zh-TW），讓大臣行動符合其性格。
 * 例：越權傾向高、膽小程度低的大臣會更主動、敢冒險。
 */
export function styleToPromptFragment(style: CabinetStyle): string {
  const s = normalizeStyle(style);
  const overreach = styleBand(s.overreach);
  const timidity = styleBand(s.timidity);
  const overreachHint =
    overreach === "高"
      ? "傾向自作主張、可能超出授權範圍行動"
      : overreach === "中"
        ? "多半依授權行事，偶爾主動加碼"
        : "嚴守授權，絕不越權";
  const timidityHint =
    timidity === "高"
      ? "非常保守、迴避風險，寧可按兵不動"
      : timidity === "中"
        ? "審慎評估風險後才行動"
        : "膽識過人、敢於承擔風險";
  return [
    `執政風格：越權傾向${overreach}（${overreachHint}）；膽小程度${timidity}（${timidityHint}）。`,
    s.description ? `性格：${s.description}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** 代理程度的一句話說明（供 AI prompt 與前端提示共用）。 */
export function agencyLevelHint(level: AgencyLevel): string {
  switch (level) {
    case "conservative":
      return "保守：僅在明確有利且低風險時才代理行動，其餘一律進待批准佇列。";
    case "aggressive":
      return "積極：在授權範圍內主動出擊，把握機會果斷行動。";
    case "balanced":
    default:
      return "均衡：在風險與收益間取平衡，重大決策才需玩家批准。";
  }
}

export function agencyLevelLabel(level: AgencyLevel): string {
  return AGENCY_LEVEL_LABELS[level];
}
