import type { FocusDef } from "./types";
import { buildRegimeFocuses } from "./regimeFocuses";

/**
 * 正式國策目錄。
 *  - 轉型國策:由政體有向圖自動產生(regimeFocuses.ts),圖與國策不會不同步。
 *  - 各政體的特色國策之後分批加入;加入時 validateCatalog 會在測試中把關。
 * 範例目錄(catalog.sample.ts)只用於測試,不進正式環境。
 */
export const FOCUS_CATALOG: FocusDef[] = [...buildRegimeFocuses()];

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
