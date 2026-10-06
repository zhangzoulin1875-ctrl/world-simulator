import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getMemory, rememberTurn, memoryKey, pruneMemory, memorySize, memoryToMessages, __resetMemoryForTest,
  MEMORY_TTL_MS, MEMORY_MAX_TURNS, MEMORY_MAX_USERS, MEMORY_A_CHARS, MEMORY_Q_CHARS,
} from "./supportMemory";

beforeEach(() => __resetMemoryForTest());

test("隔離：A 的問答絕不會出現在 B 的記憶（同頻道不同人）", () => {
  const a = memoryKey("ch1", "userA"), b = memoryKey("ch1", "userB");
  rememberTurn(a, { q: "A的秘密問題", a: "A的答案" });
  assert.deepEqual(getMemory(b), []);
  rememberTurn(b, { q: "B的問題", a: "B的答案" });
  assert.deepEqual(getMemory(a).map((t) => t.q), ["A的秘密問題"]);
  assert.deepEqual(getMemory(b).map((t) => t.q), ["B的問題"]);
  assert.ok(!JSON.stringify(getMemory(b)).includes("A的"));
});

test("隔離：同一個人在不同頻道的記憶也分開", () => {
  rememberTurn(memoryKey("ch1", "u"), { q: "頻道1", a: "x" });
  assert.deepEqual(getMemory(memoryKey("ch2", "u")), []);
});

test("key 不會因為 ID 串接而碰撞（'1:23' vs '12:3'）", () => {
  rememberTurn(memoryKey("1", "23"), { q: "q", a: "a" });
  assert.deepEqual(getMemory(memoryKey("12", "3")), []);
});

test("回傳的是複本：呼叫端改動不會污染儲存", () => {
  const k = memoryKey("c", "u");
  rememberTurn(k, { q: "q", a: "a" });
  getMemory(k)[0]!.q = "被竄改";
  assert.equal(getMemory(k)[0]!.q, "q");
});

test("連續對話：依序累積，最多保留最近 N 輪", () => {
  const k = memoryKey("c", "u");
  for (let i = 1; i <= MEMORY_MAX_TURNS + 2; i++) rememberTurn(k, { q: `q${i}`, a: `a${i}` });
  const m = getMemory(k);
  assert.equal(m.length, MEMORY_MAX_TURNS);
  assert.equal(m[0]!.q, `q${MEMORY_MAX_TURNS + 2 - MEMORY_MAX_TURNS + 1}`);
  assert.equal(m.at(-1)!.q, `q${MEMORY_MAX_TURNS + 2}`);
});

test("逾時視為新話題：超過 TTL 就清空；TTL 內仍保留；每次互動會續期", () => {
  const k = memoryKey("c", "u"), t0 = 1_000_000;
  rememberTurn(k, { q: "舊", a: "a" }, t0);
  assert.equal(getMemory(k, t0 + MEMORY_TTL_MS - 1).length, 1);
  assert.equal(getMemory(k, t0 + MEMORY_TTL_MS + 1).length, 0);
  assert.equal(memorySize(), 0, "過期時順手清掉");
  // 續期：第二輪發生在 TTL 內，之後再等一段不到 TTL 的時間仍有效
  rememberTurn(k, { q: "1", a: "a" }, t0);
  rememberTurn(k, { q: "2", a: "a" }, t0 + MEMORY_TTL_MS - 10);
  assert.equal(getMemory(k, t0 + MEMORY_TTL_MS + 1000).length, 2);
});

test("過期後再問不會把舊輪次帶進新話題", () => {
  const k = memoryKey("c", "u"), t0 = 5_000;
  rememberTurn(k, { q: "很久以前", a: "a" }, t0);
  rememberTurn(k, { q: "新話題", a: "a" }, t0 + MEMORY_TTL_MS + 10);
  assert.deepEqual(getMemory(k, t0 + MEMORY_TTL_MS + 20).map((t) => t.q), ["新話題"]);
});

test("單輪內容會截短（省 token、防洗版）", () => {
  const k = memoryKey("c", "u");
  rememberTurn(k, { q: "問".repeat(MEMORY_Q_CHARS + 500), a: "答".repeat(MEMORY_A_CHARS + 500) });
  const t = getMemory(k)[0]!;
  assert.ok(t.q.length <= MEMORY_Q_CHARS + 1 && t.a.length <= MEMORY_A_CHARS + 1);
});

test("人數上限：超過就淘汰最久沒互動的人，不影響剛互動的", () => {
  for (let i = 0; i < MEMORY_MAX_USERS; i++) rememberTurn(memoryKey("c", `u${i}`), { q: `q${i}`, a: "a" });
  rememberTurn(memoryKey("c", "u0"), { q: "u0又來了", a: "a" }); // u0 變成最新
  rememberTurn(memoryKey("c", "new"), { q: "新人", a: "a" });
  assert.equal(memorySize(), MEMORY_MAX_USERS);
  assert.equal(getMemory(memoryKey("c", "u1")).length, 0, "最久沒互動的 u1 被淘汰");
  assert.ok(getMemory(memoryKey("c", "u0")).length > 0);
  assert.ok(getMemory(memoryKey("c", "new")).length > 0);
});

test("pruneMemory 只清過期的", () => {
  const t0 = 10_000;
  rememberTurn(memoryKey("c", "old"), { q: "q", a: "a" }, t0);
  rememberTurn(memoryKey("c", "fresh"), { q: "q", a: "a" }, t0 + MEMORY_TTL_MS);
  assert.equal(pruneMemory(t0 + MEMORY_TTL_MS + 1), 1);
  assert.equal(memorySize(), 1);
});

test("memoryToMessages：問答交錯、user 開頭", () => {
  const msgs = memoryToMessages([{ q: "q1", a: "a1" }, { q: "q2", a: "a2" }]);
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(memoryToMessages([]), []);
});
