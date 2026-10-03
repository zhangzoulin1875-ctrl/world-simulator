import { getEraIndex, isEraSlug } from "./mapRegionEras";

/**
 * 新玩家「依加入時的世界時代自動補齊科技」的純函式（DB-free、可單元測試）。
 *
 * 規則：玩家建國／接手國家時，依當下世界時代 worldEraSlug，把「相應領域時代的
 * 前一代以前」（即時代 index 嚴格小於世界時代）的所有關鍵科技一次補齊。當下世界
 * 時代本身的關鍵科技不補（仍需自行研發）。此模組只負責「該補哪些 key_slug」的
 * 計算；實際寫入（researched 列＋領域時代）由 keyTechAdmin.ts 的 DB 層處理。
 */

/** 關鍵科技目錄項目最小形狀（各領域的 *_KEY_TECHS 皆滿足）。 */
export interface KeyTechEraEntry {
  keySlug: string;
  eraSlug: string;
}

/**
 * 回傳「時代嚴格早於世界時代」的關鍵科技 key_slug（依傳入順序）。
 * - worldEraSlug 非法 → 回空陣列（防禦：不補任何科技）。
 * - worldEraSlug 為最早的 classical（index 0）→ 無更早時代，回空陣列。
 * - 目錄項目 eraSlug 非法 → 略過該項（防禦）。
 */
export function keyTechSlugsBeforeEra(
  entries: readonly KeyTechEraEntry[],
  worldEraSlug: string,
): string[] {
  if (!isEraSlug(worldEraSlug)) return [];
  const worldIdx = getEraIndex(worldEraSlug);
  if (worldIdx <= 0) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (!isEraSlug(entry.eraSlug)) continue;
    if (getEraIndex(entry.eraSlug) < worldIdx) out.push(entry.keySlug);
  }
  return out;
}
