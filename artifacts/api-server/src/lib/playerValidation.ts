/**
 * Task #30 / Task #36 — pure validation helpers for the player nation routes,
 * extracted from routes/player.ts so they can be unit tested.
 */

export const MAX_IMAGE_URL_LENGTH = 2000;
/** 國名與城市自訂名的上限（Task #604）。 */
export const MAX_NATION_NAME_LENGTH = 25;
/** 領導者名稱等其他顯示名稱的上限。 */
export const MAX_NAME_LENGTH = 40;

/** 國名允許字元：Unicode 字母與數字（含中文），禁止空白與標點。 */
const NATION_NAME_PATTERN = /^[\p{L}\p{N}]+$/u;

/**
 * Extract a Postgres error code from an error, walking nested `cause`s —
 * drizzle wraps the pg error in a DrizzleQueryError whose `.code` is absent.
 */
export function pgErrorCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Validate an appearance image URL. Accepts:
 * - absolute http(s) URLs
 * - site-relative paths starting with "/" (no ".." traversal, no "//" scheme-relative)
 * Returns the normalized value, or an error string. Explicitly rejects rather
 * than silently dropping so a bad value never "succeeds" invisibly.
 */
export function validateImageUrl(
  raw: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} 必須是字串或 null` };
  }
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (value.length > MAX_IMAGE_URL_LENGTH) {
    return { ok: false, error: `${field} 長度不可超過 ${MAX_IMAGE_URL_LENGTH} 字元` };
  }
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("..")) {
      return { ok: false, error: `${field} 的相對路徑格式不正確` };
    }
    return { ok: true, value };
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `${field} 只接受 http(s) 網址或以 / 開頭的站內路徑` };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: `${field} 不是有效的網址` };
  }
}

/**
 * 驗證國名（或玩家自訂城市名）：
 * - 只允許 Unicode 字母與數字（含中文），禁止空白與標點符號。
 * - 長度 1–25 字元。
 * Task #604。
 */
export function validateNationName(
  raw: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} 必須是字串` };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: `${field} 不可為空` };
  }
  if (value.length > MAX_NATION_NAME_LENGTH) {
    return { ok: false, error: `${field} 長度不可超過 ${MAX_NATION_NAME_LENGTH} 字元` };
  }
  if (!NATION_NAME_PATTERN.test(value)) {
    return { ok: false, error: `${field} 只允許文字與數字，不得含空白或標點符號` };
  }
  return { ok: true, value };
}

/** Validate a required display name (領導者名稱等，不限字元集）. */
export function validateName(
  raw: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} 必須是字串` };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, error: `${field} 不可為空` };
  }
  if (value.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `${field} 長度不可超過 ${MAX_NAME_LENGTH} 字元` };
  }
  return { ok: true, value };
}
