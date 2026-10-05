import test from "node:test";
import assert from "node:assert/strict";
import { STORY_MAX_CHARS, band, buildStoryFacts, buildStoryPrompt, cleanStory, templateStory } from "./focusStory";

const def = { title: "君主專制轉軍事獨裁", description: "推動國家轉型。", track: "black" as const, turns: 10 };
const facts = buildStoryFacts({ government: "君主專制", stability: 12, politicalSupport: 55, satisfactionMilitary: 85 }, 30, "era_x");

test("band:數值分五級,邊界正確", () => {
  assert.deepEqual([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(band), ["很低", "很低", "偏低", "偏低", "普通", "普通", "偏高", "偏高", "很高", "很高"]);
});

test("facts:只有分級文字,不含任何原始數字、國名或領導人欄位", () => {
  assert.deepEqual(Object.keys(facts).sort(), ["eraSlug", "governmentLabel", "militaryMood", "parliamentMood", "politicalSupport", "stability"]);
  assert.equal(facts.stability, "很低");
  assert.equal(facts.militaryMood, "很高");
  assert.equal(facts.parliamentMood, "偏低");
});

test("prompt:帶入處境與路線,不含國名/領導人,要求泛稱與字數上限", () => {
  const p = buildStoryPrompt(def, facts);
  for (const must of ["君主專制轉軍事獨裁", "黑線", "社會穩定:很低", "軍方情緒:很高", `${STORY_MAX_CHARS} 字以內`, "不要出現任何真實國家"]) assert.ok(p.includes(must), must);
  const odd = buildStoryFacts({ government: "君主專制", stability: 13, politicalSupport: 57, satisfactionMilitary: 87 }, 31, "era_x");
  const q = buildStoryPrompt(def, odd);
  for (const raw of ["13", "57", "87", "31"]) assert.ok(!q.includes(raw), `原始數值 ${raw} 不應進 prompt`);
  assert.notEqual(buildStoryPrompt({ ...def, track: "red" }, facts), p, "路線不同 prompt 要不同");
});

test("cleanStory:去框/引號/換行;太短視為失敗;超長被裁切並加省略號", () => {
  assert.equal(cleanStory("```\n「" + "政府面對動盪的局勢,軍方要求強硬作為。".repeat(2) + "」\n```")?.startsWith("政府"), true);
  assert.equal(cleanStory("好"), null);
  assert.equal(cleanStory(""), null);
  const long = cleanStory("故".repeat(1000))!;
  assert.equal(long.length, STORY_MAX_CHARS);
  assert.ok(long.endsWith("…"));
  assert.ok(!cleanStory("第一行\n\n第二行內容足夠長足夠長足夠長足夠長")!.includes("\n"));
});

test("templateStory:依路線與穩定度產生可讀句子,包含國策名", () => {
  const t = templateStory(def, facts);
  assert.ok(t.includes("「君主專制轉軍事獨裁」") && t.includes("動盪") && t.includes("強硬派"));
  assert.ok(templateStory({ ...def, track: "red" }, facts).includes("不滿"));
  assert.ok(templateStory({ ...def, track: "reform" }, { ...facts, stability: "偏高" }).includes("安定"));
  for (const tr of ["stable", "black", "red", "reform"] as const) assert.ok(templateStory({ ...def, track: tr }, facts).length > 20);
});
