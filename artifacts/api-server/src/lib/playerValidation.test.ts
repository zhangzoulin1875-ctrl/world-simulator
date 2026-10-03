import { strict as assert } from "node:assert";
import test from "node:test";
import {
  MAX_IMAGE_URL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NATION_NAME_LENGTH,
  pgErrorCode,
  validateImageUrl,
  validateName,
  validateNationName,
} from "./playerValidation";

// ---------------------------------------------------------------------------
// pgErrorCode — walks the drizzle error cause chain to find the pg code
// ---------------------------------------------------------------------------

test("pgErrorCode 讀取頂層 code", () => {
  assert.equal(pgErrorCode(Object.assign(new Error("x"), { code: "23505" })), "23505");
});

test("pgErrorCode 走 cause 鏈找到被 drizzle 包裹的 pg code", () => {
  const pgErr = Object.assign(new Error("duplicate key"), { code: "23505" });
  const wrapped = new Error("Failed query", { cause: pgErr });
  assert.equal(pgErrorCode(wrapped), "23505");

  const doubleWrapped = new Error("outer", { cause: wrapped });
  assert.equal(pgErrorCode(doubleWrapped), "23505");
});

test("pgErrorCode 忽略非 5 碼格式的 code，繼續往 cause 找", () => {
  const pgErr = Object.assign(new Error("fk"), { code: "23503" });
  const wrapped = Object.assign(new Error("wrapped"), {
    code: "NOT_A_PG_CODE",
    cause: pgErr,
  });
  assert.equal(pgErrorCode(wrapped), "23503");
});

test("pgErrorCode 找不到 code 時回 null", () => {
  assert.equal(pgErrorCode(new Error("plain")), null);
  assert.equal(pgErrorCode(null), null);
  assert.equal(pgErrorCode(undefined), null);
  assert.equal(pgErrorCode("string error"), null);
  assert.equal(pgErrorCode({ code: 23505 }), null); // numeric code doesn't count
});

test("pgErrorCode 對循環 cause 鏈最多走 5 層不會無窮迴圈", () => {
  const a: { cause?: unknown } = {};
  const b: { cause?: unknown } = { cause: a };
  a.cause = b;
  assert.equal(pgErrorCode(a), null);
});

// ---------------------------------------------------------------------------
// validateImageUrl
// ---------------------------------------------------------------------------

test("validateImageUrl：null/undefined/空字串 → 清除（value null）", () => {
  assert.deepEqual(validateImageUrl(null, "f"), { ok: true, value: null });
  assert.deepEqual(validateImageUrl(undefined, "f"), { ok: true, value: null });
  assert.deepEqual(validateImageUrl("", "f"), { ok: true, value: null });
  assert.deepEqual(validateImageUrl("   ", "f"), { ok: true, value: null });
});

test("validateImageUrl：接受 http(s) 絕對網址與站內相對路徑", () => {
  assert.deepEqual(validateImageUrl("https://example.com/a.png", "f"), {
    ok: true,
    value: "https://example.com/a.png",
  });
  assert.deepEqual(validateImageUrl("http://example.com/a.png", "f"), {
    ok: true,
    value: "http://example.com/a.png",
  });
  assert.deepEqual(validateImageUrl("/api/storage/images/abc", "f"), {
    ok: true,
    value: "/api/storage/images/abc",
  });
});

test("validateImageUrl：trim 前後空白", () => {
  assert.deepEqual(validateImageUrl("  /a.png  ", "f"), { ok: true, value: "/a.png" });
});

test("validateImageUrl：拒絕非字串型別", () => {
  for (const bad of [123, true, {}, []]) {
    const r = validateImageUrl(bad, "f");
    assert.equal(r.ok, false);
  }
});

test("validateImageUrl：拒絕過長網址", () => {
  const long = "https://example.com/" + "a".repeat(MAX_IMAGE_URL_LENGTH);
  const r = validateImageUrl(long, "f");
  assert.equal(r.ok, false);
  // exactly at the cap is fine
  const atCap = "/" + "a".repeat(MAX_IMAGE_URL_LENGTH - 1);
  assert.deepEqual(validateImageUrl(atCap, "f"), { ok: true, value: atCap });
});

test("validateImageUrl：拒絕 scheme-relative 與路徑穿越", () => {
  assert.equal(validateImageUrl("//evil.com/a.png", "f").ok, false);
  assert.equal(validateImageUrl("/images/../secret", "f").ok, false);
  assert.equal(validateImageUrl("/..", "f").ok, false);
});

test("validateImageUrl：拒絕非 http(s) 協定與無效網址", () => {
  assert.equal(validateImageUrl("javascript:alert(1)", "f").ok, false);
  assert.equal(validateImageUrl("ftp://example.com/a.png", "f").ok, false);
  assert.equal(validateImageUrl("data:image/png;base64,AAAA", "f").ok, false);
  assert.equal(validateImageUrl("not a url", "f").ok, false);
  assert.equal(validateImageUrl("example.com/a.png", "f").ok, false);
});

test("validateImageUrl：錯誤訊息含欄位名稱", () => {
  const r = validateImageUrl(123, "國旗圖片");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("國旗圖片"));
});

// ---------------------------------------------------------------------------
// validateName（領導者名稱等，上限 40，不限字元集）
// ---------------------------------------------------------------------------

test("validateName：合法名稱通過並 trim", () => {
  assert.deepEqual(validateName("大和王國", "國名"), { ok: true, value: "大和王國" });
  assert.deepEqual(validateName("  Alice  ", "領導者名稱"), {
    ok: true,
    value: "Alice",
  });
});

test("validateName：拒絕非字串、空字串與純空白", () => {
  assert.equal(validateName(null, "國名").ok, false);
  assert.equal(validateName(undefined, "國名").ok, false);
  assert.equal(validateName(42, "國名").ok, false);
  assert.equal(validateName("", "國名").ok, false);
  assert.equal(validateName("   ", "國名").ok, false);
});

test("validateName：長度上限 40，超過拒絕、剛好通過", () => {
  const atCap = "a".repeat(MAX_NAME_LENGTH);
  assert.deepEqual(validateName(atCap, "國名"), { ok: true, value: atCap });
  const over = "a".repeat(MAX_NAME_LENGTH + 1);
  const r = validateName(over, "國名");
  assert.equal(r.ok, false);
});

test("validateName：錯誤訊息含欄位名稱", () => {
  const r = validateName("", "領導者名稱");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("領導者名稱"));
});

// ---------------------------------------------------------------------------
// validateNationName（國名與城市自訂名：上限 25，禁空白與標點）
// ---------------------------------------------------------------------------

test("validateNationName：合法中文國名通過", () => {
  assert.deepEqual(validateNationName("大和王國", "國名"), {
    ok: true,
    value: "大和王國",
  });
});

test("validateNationName：合法英數名通過", () => {
  assert.deepEqual(validateNationName("Albion123", "國名"), {
    ok: true,
    value: "Albion123",
  });
});

test("validateNationName：trim 前後空白後合法則通過", () => {
  assert.deepEqual(validateNationName("  大和  ", "國名"), {
    ok: true,
    value: "大和",
  });
});

test("validateNationName：拒絕非字串、空字串與純空白", () => {
  assert.equal(validateNationName(null, "國名").ok, false);
  assert.equal(validateNationName(undefined, "國名").ok, false);
  assert.equal(validateNationName(42, "國名").ok, false);
  assert.equal(validateNationName("", "國名").ok, false);
  assert.equal(validateNationName("   ", "國名").ok, false);
});

test("validateNationName：長度上限 25，超過拒絕、剛好通過", () => {
  const atCap = "國".repeat(MAX_NATION_NAME_LENGTH);
  assert.deepEqual(validateNationName(atCap, "國名"), { ok: true, value: atCap });
  const over = "國".repeat(MAX_NATION_NAME_LENGTH + 1);
  const r = validateNationName(over, "國名");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("25"));
});

test("validateNationName：拒絕含空白的名稱", () => {
  assert.equal(validateNationName("大 和", "國名").ok, false);
  assert.equal(validateNationName("Albi on", "國名").ok, false);
  assert.equal(validateNationName("大 和 王", "國名").ok, false);
});

test("validateNationName：拒絕含標點符號的名稱", () => {
  assert.equal(validateNationName("大和！", "國名").ok, false);
  assert.equal(validateNationName("大和-王國", "國名").ok, false);
  assert.equal(validateNationName("Nation_1", "國名").ok, false);
  assert.equal(validateNationName("A.B.C", "國名").ok, false);
  assert.equal(validateNationName("大和（王）", "國名").ok, false);
  assert.equal(validateNationName("<script>", "國名").ok, false);
});

test("validateNationName：錯誤訊息含欄位名稱", () => {
  const r = validateNationName("", "國名");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("國名"));
});
