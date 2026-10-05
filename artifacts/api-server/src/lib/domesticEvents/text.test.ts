import test from "node:test";
import assert from "node:assert/strict";
import { parseEventText, buildEventPrompt, TITLE_MAX } from "./text";
import { getEventDef } from "./core";
import { buildStoryFacts } from "../focus/focusStory";

const def = getEventDef("socialist_majority")!;
const good = () => ({
  title: "社會黨人掌握議會",
  body: "補選落幕,社會黨人成為議會最大勢力,要求政府落實他們的施政主張。",
  choices: [
    { id: "comply", label: "順應議會意志", hint: "議會滿意,但國庫吃緊" },
    { id: "crackdown", label: "宣布戒嚴驅逐議員", hint: "軍方支持,社會動盪" },
    { id: "delay", label: "部分採納主張", hint: "各方都只滿意一半" },
  ],
});
const j = (o: unknown) => JSON.stringify(o);

test("解析:合格的 JSON 原樣通過,選項 id 與順序以目錄為準", () => {
  const r = parseEventText(j(good()), def)!;
  assert.ok(r);
  assert.deepEqual(r.choices.map((c) => c.id), def.choices.map((c) => c.id));
  assert.equal(r.title, "社會黨人掌握議會");
});

test("解析:包在 Markdown 程式碼框或前後有廢話也能取出 JSON", () => {
  assert.ok(parseEventText("```json\n" + j(good()) + "\n```", def));
  assert.ok(parseEventText("好的,以下是結果:\n" + j(good()) + "\n希望有幫助", def));
});

test("解析:選項順序被 AI 打亂,輸出仍按目錄順序", () => {
  const g = good(); g.choices.reverse();
  assert.deepEqual(parseEventText(j(g), def)!.choices.map((c) => c.id), def.choices.map((c) => c.id));
});

test("解析:各種不合格一律回 null(保留模板)", () => {
  assert.equal(parseEventText("", def), null);
  assert.equal(parseEventText("not json", def), null);
  assert.equal(parseEventText("{bad", def), null);
  const missing = good(); missing.choices.pop();
  assert.equal(parseEventText(j(missing), def), null, "少一個選項");
  const extra = good(); (extra.choices as unknown[]).push({ id: "x", label: "多出來", hint: "多出來" });
  assert.equal(parseEventText(j(extra), def), null, "多一個選項");
  const wrongId = good(); wrongId.choices[0]!.id = "hack";
  assert.equal(parseEventText(j(wrongId), def), null, "選項 id 被改");
  const dup = good(); dup.choices[1]!.id = "comply";
  assert.equal(parseEventText(j(dup), def), null, "id 重複");
  const empty = good(); empty.choices[2]!.hint = "  ";
  assert.equal(parseEventText(j(empty), def), null, "空白文字");
  const notStr = good() as any; notStr.title = 123;
  assert.equal(parseEventText(j(notStr), def), null, "型別錯誤");
  const tooLong = good(); tooLong.title = "字".repeat(TITLE_MAX + 1);
  assert.equal(parseEventText(j(tooLong), def), null, "超長");
});

test("解析:文字裡出現具體數字(例如「穩定 -30」)會被整份丟棄,避免誤導玩家", () => {
  const g1 = good(); g1.choices[1]!.hint = "穩定 -30,軍方 +15";
  assert.equal(parseEventText(j(g1), def), null);
  const g2 = good(); g2.body = "議會以 55 席取得多數,要求政府落實主張。";
  assert.equal(parseEventText(j(g2), def), null);
});

test("提示詞:包含每個選項 id;不含國名、領導人,也不含任何效果數字", () => {
  const facts = buildStoryFacts({ government: "君主專制", stability: 40, politicalSupport: 60, satisfactionMilitary: 70 }, 55, "classical");
  const p = buildEventPrompt(def, facts);
  for (const c of def.choices) assert.ok(p.includes(`- ${c.id}(`), `缺 ${c.id}`);
  for (const c of def.choices) for (const v of Object.values(c.effects)) if (typeof v === "number") assert.ok(!p.includes(`${v > 0 ? "+" : ""}${v}`) || Math.abs(v) < 10, "不應洩漏效果數字");
  assert.ok(!/stability|money|-25|-1500|\+15/.test(p));
  assert.ok(p.includes("不要出現國名"));
});
