import {
  DEFAULT_ERA_SLUG,
  ERAS,
  getEraIndex,
  isEraSlug,
} from "./mapRegionEras";

/**
 * Task #176 — NPC 科技時代指標的純粹輔助（無 DB 相依，可單元測試）。
 *
 * NPC 不使用玩家的「已研發科技列（player_researched_*）＋ 三選一抽牌」機制——
 * 那些表以 discord_user_id NOT NULL 為鍵，NPC（discord_user_id = null）無法擁有
 * 對應列。因此 NPC 科技水準改以 player_nations 上三個輕量「時代指標」欄位表示
 * （tech_era_military / _social / _production）：null = 沿用世界 current_era，
 * 具體 slug = 該領域停在某時代。本模組提供生成（T5）與自主推進（T10）共用的
 * 正規化／解析／推進輔助，確保 NPC 科技永不超越世界當前時代（尊重時代解鎖上限）。
 */

/** NPC 三大科技領域鍵。 */
export const NPC_TECH_DOMAINS = ["military", "social", "production"] as const;
export type NpcTechDomain = (typeof NPC_TECH_DOMAINS)[number];

/** 三領域「有效時代」解析結果（一律為具體合法 slug）。 */
export interface NpcTechEras {
  military: string;
  social: string;
  production: string;
}

/** 安全取得時代 index：合法回其 index，否則回 fallbackIndex（避免 getEraIndex 丟例外）。 */
function eraIndexOr(
  slug: string | null | undefined,
  fallbackIndex: number,
): number {
  if (slug != null && isEraSlug(slug)) return getEraIndex(slug);
  return fallbackIndex;
}

/**
 * 把時代 slug 夾在 [classical(0), maxSlug] 範圍內，回傳具體合法 slug。
 * - slug 非法／null → 視為 classical（index 0）。
 * - maxSlug 非法 → 視為無上限（最後一個時代）。
 */
export function clampEraSlug(
  slug: string | null | undefined,
  maxSlug: string,
): string {
  const maxIdx = eraIndexOr(maxSlug, ERAS.length - 1);
  const rawIdx = eraIndexOr(slug, 0);
  const idx = Math.min(Math.max(rawIdx, 0), maxIdx);
  return ERAS[idx].slug;
}

/**
 * 正規化要「寫入」player_nations 的單一領域科技指標。
 * - null/undefined/"" → null（代表沿用世界 current_era）。
 * - 具體 slug → 夾到 [classical, worldEra]（超過世界時代者壓回世界時代）。
 * - 非法 slug → null（防禦：退回沿用世界時代）。
 */
export function normalizeNpcTechEra(
  value: string | null | undefined,
  worldEraSlug: string,
): string | null {
  if (value == null || value === "") return null;
  if (!isEraSlug(value)) return null;
  return clampEraSlug(value, worldEraSlug);
}

/**
 * 解析單一領域的「有效科技時代」（一律回具體合法 slug）：
 * 指標為 null／非法 → 用世界 current_era；否則用指標並再夾一次防呆。
 */
export function effectiveNpcTechEra(
  pointer: string | null | undefined,
  worldEraSlug: string,
): string {
  const base = isEraSlug(worldEraSlug) ? worldEraSlug : DEFAULT_ERA_SLUG;
  if (pointer == null || !isEraSlug(pointer)) return base;
  return clampEraSlug(pointer, base);
}

/** 三領域一次解析為有效時代。 */
export function resolveNpcTechEras(
  n: {
    techEraMilitary?: string | null;
    techEraSocial?: string | null;
    techEraProduction?: string | null;
  },
  worldEraSlug: string,
): NpcTechEras {
  return {
    military: effectiveNpcTechEra(n.techEraMilitary, worldEraSlug),
    social: effectiveNpcTechEra(n.techEraSocial, worldEraSlug),
    production: effectiveNpcTechEra(n.techEraProduction, worldEraSlug),
  };
}

// Task #481 — NPC 改沿全球科技樹逐格研發（npcTechTree.ts）：舊「整代跳級」的
// advanceNpcTechEra / computeNpcTechAdvance 與批次關鍵科技的指標近似
// npcGrantKeyTechEra / npcRevokeKeyTechEra 已移除。本模組僅保留指標的
// 正規化／有效時代解析（techEra* 欄位保留為樹狀態的唯讀鏡像與初始化來源）。
