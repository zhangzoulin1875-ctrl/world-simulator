import type { FocusDef } from "./types";

/**
 * 正式國策目錄。
 * 第一階段先空著:範例目錄(catalog.sample.ts)只用於測試,不進正式環境。
 * 各政體的特色國策之後分批加入;加入時 validateCatalog 會在測試中把關。
 */
export const FOCUS_CATALOG: FocusDef[] = [];

let override: readonly FocusDef[] | null = null;

/** 取得目前生效的目錄(測試可用 setCatalogForTest 暫時替換)。 */
export function getCatalog(): readonly FocusDef[] {
  return override ?? FOCUS_CATALOG;
}

export function getFocusDef(id: string): FocusDef | undefined {
  return getCatalog().find((d) => d.id === id);
}

/** 僅供測試:替換目錄,傳 null 還原。 */
export function setCatalogForTest(defs: readonly FocusDef[] | null): void {
  override = defs;
}
