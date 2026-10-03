/**
 * 時代標籤純函式。抽出來是為了把「政治視圖國情面板的科技水準必須以『目前世界
 * 時代』表示、不受上方時代篩選影響」這個承諾鎖進單元測試（見 eraLabel.test.ts）。
 */

export interface EraOption {
  era: string;
  label: string;
}

/**
 * 回傳目前世界時代對應的標籤；找不到（或無 currentEra）回 null。
 * 刻意「只吃 currentEra」——不接受任何使用者選取的時代，確保呼叫端無法把
 * 篩選用的時代誤傳進來。
 */
export function resolveCurrentEraLabel(
  eras: EraOption[],
  currentEra: string | null | undefined,
): string | null {
  if (!currentEra) return null;
  return eras.find((e) => e.era === currentEra)?.label ?? null;
}
