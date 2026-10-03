/**
 * 說明／新手教學狀態的「純儲存層」：只依賴 localStorage，不含任何 React 相依，
 * 因此可獨立做單元測試（見 help-storage-core.test.ts）。
 *
 * 狀態以「儲存範圍（scope）」區隔：登入時為 Discord 使用者 ID，未登入退回 "anon"。
 * scope 的取得（React hook）放在 help-storage.ts，避免此檔引入 React。
 */

export const SEEN_PREFIX = "discord-news.help-seen.";
export const ONBOARDING_PREFIX = "discord-news.onboarding.";

/** 匿名（未登入）時的儲存範圍。 */
export const ANON_SCOPE = "anon";

function seenKey(scope: string): string {
  return `${SEEN_PREFIX}${scope}`;
}

/** 讀取某範圍下「已看過的說明 key」集合。 */
function readSeenSet(scope: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(seenKey(scope));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function writeSeenSet(scope: string, set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(seenKey(scope), JSON.stringify([...set]));
  } catch {
    // ignore（隱私模式 / 容量已滿等）
  }
}

/** 這個範圍是否已看過某個說明 key（首次自動彈出用）。 */
export function isHelpSeen(scope: string, key: string): boolean {
  return readSeenSet(scope).has(key);
}

/** 標記某個說明 key 為已看過。 */
export function markHelpSeen(scope: string, key: string): void {
  const set = readSeenSet(scope);
  if (set.has(key)) return;
  set.add(key);
  writeSeenSet(scope, set);
}

// ── 新手教學（歡迎彈窗＋互動導覽）狀態 ──

function onboardingKey(scope: string): string {
  return `${ONBOARDING_PREFIX}${scope}`;
}

/** 這個範圍是否已完成（或略過）新手教學的首次觸發。 */
export function isOnboardingDone(scope: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(onboardingKey(scope)) === "1";
  } catch {
    return true;
  }
}

/** 標記新手教學首次觸發已完成（之後只能從百科手動再開）。 */
export function markOnboardingDone(scope: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(onboardingKey(scope), "1");
  } catch {
    // ignore
  }
}
