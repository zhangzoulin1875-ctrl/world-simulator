import test from "node:test";
import assert from "node:assert/strict";
import { hashPregenInput } from "./aiPregenHash";

/** 預產輸入雜湊：鍵順序無關（排序後序列化）、內容敏感（任何變更都改變雜湊）。 */
test("hashPregenInput：欄位順序無關、內容敏感", () => {
  const a = hashPregenInput({ x: 1, nested: { b: 2, a: 3 } });
  const b = hashPregenInput({ nested: { a: 3, b: 2 }, x: 1 });
  const c = hashPregenInput({ x: 2, nested: { b: 2, a: 3 } });
  const d = hashPregenInput({ x: 1, nested: { b: 2, a: 4 } });
  assert.equal(a, b, "鍵順序不影響雜湊");
  assert.notEqual(a, c, "頂層內容變更必須改變雜湊");
  assert.notEqual(a, d, "巢狀內容變更必須改變雜湊");
  assert.match(a, /^[0-9a-f]{64}$/, "SHA-256 十六進位");
});

test("hashPregenInput：陣列保持順序敏感", () => {
  const a = hashPregenInput({ list: [1, 2, 3] });
  const b = hashPregenInput({ list: [3, 2, 1] });
  assert.notEqual(a, b, "陣列順序必須影響雜湊");
});
