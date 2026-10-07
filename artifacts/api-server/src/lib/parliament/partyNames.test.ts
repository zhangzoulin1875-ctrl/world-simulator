import test from "node:test";
import assert from "node:assert/strict";
import { validatePartyNames, isTemplateName } from "./partyNames";

const REQ = [
  { id: "1", stance: "pacifist" as const, seats: 30 },
  { id: "2", stance: "militarist" as const, seats: 25 },
];
const ok = (a: string, b: string) => ({
  parties: [{ id: "1", name: a, description: "黨綱一" }, { id: "2", name: b, description: "黨綱二" }],
});

test("合格輸出通過", () => {
  const r = validatePartyNames(ok("白鷺同盟", "赤鷹議事團"), REQ);
  assert.deepEqual(r.map((x) => x.name), ["白鷺同盟", "赤鷹議事團"]);
});

test("模板名(立場標籤+黨/聯盟/陣線)被擋", () => {
  assert.throws(() => validatePartyNames(ok("和平黨", "赤鷹議事團"), REQ), /template/);
  assert.throws(() => validatePartyNames(ok("白鷺同盟", "擴軍陣線"), REQ), /template/);
  assert.equal(isTemplateName("和平聯盟", "pacifist"), true);
  assert.equal(isTemplateName("和平之友社", "pacifist"), false);
  assert.equal(isTemplateName("節流減稅黨", "fiscal_hawk"), true);
});

test("缺黨、重名、太短、太長、怪字元都被擋", () => {
  assert.throws(() => validatePartyNames({ parties: [{ id: "1", name: "白鷺同盟", description: "" }] }, REQ), /missing/);
  assert.throws(() => validatePartyNames(ok("白鷺同盟", "白鷺同盟"), REQ), /duplicate/);
  assert.throws(() => validatePartyNames(ok("白", "赤鷹議事團"), REQ), /length/);
  assert.throws(() => validatePartyNames(ok("這是一個非常非常非常長的黨名稱啊", "赤鷹議事團"), REQ), /length/);
  assert.throws(() => validatePartyNames(ok("白鷺<同盟>", "赤鷹議事團"), REQ), /chars/);
});

test("黨綱過長會截斷，含怪字元則清空；多給的黨被忽略", () => {
  const long = "字".repeat(120);
  const r = validatePartyNames({
    parties: [
      { id: "1", name: "白鷺同盟", description: long },
      { id: "2", name: "赤鷹議事團", description: "有{怪}字" },
      { id: "9", name: "多餘的黨", description: "" },
    ],
  }, REQ);
  assert.equal([...r[0]!.description].length, 60);
  assert.equal(r[1]!.description, "");
  assert.equal(r.length, 2);
});
