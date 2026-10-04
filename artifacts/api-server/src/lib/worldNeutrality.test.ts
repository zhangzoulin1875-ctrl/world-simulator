import test from "node:test";
import assert from "node:assert/strict";
import {
  stripChineseDynasty,
  eraLabelForAi,
  withWorldNeutrality,
  WORLD_NEUTRALITY_PREAMBLE,
} from "./worldNeutrality";
import { ERAS } from "./mapRegionEras";

test("時代標籤去掉中國朝代括號", () => {
  assert.equal(eraLabelForAi("古典時代(秦朝)"), "古典時代");
  assert.equal(eraLabelForAi("羅馬帝國時期(漢朝)"), "羅馬帝國時期");
  assert.equal(eraLabelForAi("文藝復興時期（明朝）"), "文藝復興時期");
  assert.equal(eraLabelForAi("大航海時代(清朝)"), "大航海時代");
  assert.equal(eraLabelForAi("工業革命"), "工業革命");
});

test("所有時代標籤中立化後都不含朝代名", () => {
  for (const e of ERAS) {
    assert.doesNotMatch(eraLabelForAi(e.label), /秦朝|漢朝|唐朝|宋朝|明朝|清朝/);
  }
});

test("prompt 內文整段也能去除", () => {
  const p = "當前時代：古典時代(秦朝)（遊戲年份：-221 年）\n玩家需求：x";
  assert.doesNotMatch(stripChineseDynasty(p), /秦朝/);
  assert.match(stripChineseDynasty(p), /遊戲年份：-221 年/);
});

test("withWorldNeutrality：加前言且不重複", () => {
  const once = withWorldNeutrality("你是設計 AI");
  assert.ok(once.startsWith(WORLD_NEUTRALITY_PREAMBLE));
  assert.equal(withWorldNeutrality(once), once);
  assert.equal(withWorldNeutrality(undefined), WORLD_NEUTRALITY_PREAMBLE);
});
