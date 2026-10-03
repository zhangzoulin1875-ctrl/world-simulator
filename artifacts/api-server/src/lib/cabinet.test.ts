import { test } from "node:test";
import assert from "node:assert/strict";
import {
  styleBand,
  clamp0to100,
  normalizeStyle,
  styleToPromptFragment,
} from "./cabinet/style";
import {
  isCabinetDomain,
  isAgencyLevel,
  CABINET_DOMAINS,
  AGENCY_LEVELS,
} from "./cabinet/types";
import { filterKnownActionKeys, domainActionKeySet } from "./cabinet/registry";

// Task #242 — 內閣地基純函式單元測試（不觸 DB／IO）。

test("clamp0to100 夾住範圍並四捨五入、非有限值退回 0", () => {
  assert.equal(clamp0to100(-10), 0);
  assert.equal(clamp0to100(0), 0);
  assert.equal(clamp0to100(50.4), 50);
  assert.equal(clamp0to100(50.6), 51);
  assert.equal(clamp0to100(100), 100);
  assert.equal(clamp0to100(150), 100);
  assert.equal(clamp0to100(Number.NaN), 0);
  assert.equal(clamp0to100(Number.POSITIVE_INFINITY), 0);
});

test("styleBand 依邊界分成 低/中/高", () => {
  assert.equal(styleBand(0), "低");
  assert.equal(styleBand(33), "低");
  assert.equal(styleBand(34), "中");
  assert.equal(styleBand(66), "中");
  assert.equal(styleBand(67), "高");
  assert.equal(styleBand(100), "高");
  // 夾住後再判帶
  assert.equal(styleBand(-5), "低");
  assert.equal(styleBand(120), "高");
});

test("normalizeStyle 夾住數值並去除敘述頭尾空白", () => {
  const out = normalizeStyle({
    overreach: 130,
    timidity: -20,
    description: "  果斷進取  ",
  });
  assert.deepEqual(out, {
    overreach: 100,
    timidity: 0,
    description: "果斷進取",
  });
});

test("styleToPromptFragment 反映風格帶且含性格敘述", () => {
  const frag = styleToPromptFragment({
    overreach: 90,
    timidity: 10,
    description: "野心勃勃",
  });
  assert.match(frag, /越權傾向高/);
  assert.match(frag, /膽小程度低/);
  assert.match(frag, /性格：野心勃勃/);
});

test("styleToPromptFragment 無敘述時省略性格段", () => {
  const frag = styleToPromptFragment({
    overreach: 50,
    timidity: 50,
    description: "",
  });
  assert.match(frag, /越權傾向中/);
  assert.ok(!frag.includes("性格："));
});

test("isCabinetDomain 僅接受三個已知領域", () => {
  for (const d of CABINET_DOMAINS) {
    assert.equal(isCabinetDomain(d), true);
  }
  assert.equal(isCabinetDomain("economy"), false);
  assert.equal(isCabinetDomain(""), false);
  assert.equal(isCabinetDomain("Interior"), false);
});

test("isAgencyLevel 僅接受三個代理程度", () => {
  for (const l of AGENCY_LEVELS) {
    assert.equal(isAgencyLevel(l), true);
  }
  assert.equal(isAgencyLevel("balanced"), true);
  assert.equal(isAgencyLevel("reckless"), false);
  assert.equal(isAgencyLevel(""), false);
});

test("filterKnownActionKeys 僅保留該領域已宣告的 key、忽略未知", () => {
  for (const domain of CABINET_DOMAINS) {
    const known = [...domainActionKeySet(domain)];
    const mixed = [...known, "totally-unknown-key", ""];
    const filtered = filterKnownActionKeys(domain, mixed);
    assert.deepEqual(filtered.sort(), [...known].sort());
    // 純未知輸入應得空陣列
    assert.deepEqual(filterKnownActionKeys(domain, ["nope"]), []);
  }
});
