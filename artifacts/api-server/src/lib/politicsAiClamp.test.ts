import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_POLICIES_PROMPT_MAX,
  clampAiModifiers,
  clampDuration,
  buildModifierDoc,
  buildUnifiedModifierDoc,
  formatActivePoliciesLine,
} from "./politicsAi";
import { DEFAULT_POLITICS_SETTINGS } from "./politics";

const S = DEFAULT_POLITICS_SETTINGS;

// ── 分項上限 ────────────────────────────────────────────────────

test("clampAiModifiers — 滿意度系列夾 ±modifierCapSatisfaction（預設 10）", () => {
  const result = clampAiModifiers(
    [
      { target: "satisfactionLaw", value: 15 },
      { target: "satisfactionCulture", value: -20 },
      { target: "satisfactionMilitary", value: 8 },
      { target: "satisfaction", value: 11 },
    ],
    S,
  );
  assert.equal(result[0].value, 10);
  assert.equal(result[1].value, -10);
  assert.equal(result[2].value, 8);
  assert.equal(result[3].value, 10);
});

test("clampAiModifiers — stability 夾 ±modifierCapStability（預設 10）", () => {
  const result = clampAiModifiers(
    [{ target: "stability", value: 25 }, { target: "stability", value: -12 }],
    S,
  );
  assert.equal(result[0].value, 10);
  assert.equal(result[1].value, -10);
});

test("clampAiModifiers — production 夾 ±modifierCapProduction（預設 5）", () => {
  const result = clampAiModifiers(
    [{ target: "production", value: 12 }, { target: "production", value: -8 }],
    S,
  );
  assert.equal(result[0].value, 5);
  assert.equal(result[1].value, -5);
});

test("clampAiModifiers — tech 夾 ±modifierCapTech（預設 5）", () => {
  const result = clampAiModifiers(
    [{ target: "tech", value: 20 }, { target: "tech", value: -6 }],
    S,
  );
  assert.equal(result[0].value, 5);
  assert.equal(result[1].value, -5);
});

test("clampAiModifiers — populationGrowth 夾 ±modifierCapPopulationGrowth（預設 3）", () => {
  const result = clampAiModifiers(
    [{ target: "populationGrowth", value: 10 }, { target: "populationGrowth", value: -5 }],
    S,
  );
  assert.equal(result[0].value, 3);
  assert.equal(result[1].value, -3);
});

test("clampAiModifiers — militaryObedience 夾 ±modifierCapMilitaryObedience（預設 10）", () => {
  const result = clampAiModifiers(
    [{ target: "militaryObedience", value: 15 }],
    S,
  );
  assert.equal(result[0].value, 10);
});

test("clampAiModifiers — 值在上限內時原樣保留（四捨五入）", () => {
  const result = clampAiModifiers(
    [
      { target: "satisfactionRights", value: 7 },
      { target: "production", value: -3 },
      { target: "populationGrowth", value: 2.4 },
    ],
    S,
  );
  assert.equal(result[0].value, 7);
  assert.equal(result[1].value, -3);
  assert.equal(result[2].value, 2);
});

test("clampAiModifiers — 分項上限可透過設定調整", () => {
  const settings = { ...S, modifierCapProduction: 15 };
  const result = clampAiModifiers(
    [{ target: "production", value: 12 }],
    settings,
  );
  assert.equal(result[0].value, 12);
});

// ── 白名單剔除 ───────────────────────────────────────────────────

test("clampAiModifiers — allowTargetProduction=0 剔除 production 目標", () => {
  const settings = { ...S, allowTargetProduction: 0 };
  const result = clampAiModifiers(
    [
      { target: "production", value: 3 },
      { target: "satisfactionLaw", value: 5 },
      { target: "tech", value: 2 },
    ],
    settings,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].target, "satisfactionLaw");
  assert.equal(result[1].target, "tech");
});

test("clampAiModifiers — allowTargetTech=0 剔除 tech 目標", () => {
  const settings = { ...S, allowTargetTech: 0 };
  const result = clampAiModifiers(
    [{ target: "tech", value: 4 }, { target: "stability", value: 3 }],
    settings,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].target, "stability");
});

test("clampAiModifiers — allowTargetSatisfaction=0 剔除全部滿意度目標", () => {
  const settings = { ...S, allowTargetSatisfaction: 0 };
  const result = clampAiModifiers(
    [
      { target: "satisfaction", value: 5 },
      { target: "satisfactionLaw", value: 5 },
      { target: "satisfactionCulture", value: 5 },
      { target: "satisfactionReligion", value: 5 },
      { target: "satisfactionRights", value: 5 },
      { target: "satisfactionMilitary", value: 5 },
      { target: "stability", value: 5 },
    ],
    settings,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].target, "stability");
});

test("clampAiModifiers — allowTargetMilitaryObedience=0 剔除 militaryObedience", () => {
  const settings = { ...S, allowTargetMilitaryObedience: 0 };
  const result = clampAiModifiers(
    [
      { target: "militaryObedience", value: 5 },
      { target: "satisfactionMilitary", value: 5 },
    ],
    settings,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].target, "satisfactionMilitary");
});

test("clampAiModifiers — allowTargetPopulationGrowth=0 剔除 populationGrowth", () => {
  const settings = { ...S, allowTargetPopulationGrowth: 0 };
  const result = clampAiModifiers(
    [{ target: "populationGrowth", value: 2 }, { target: "stability", value: 3 }],
    settings,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].target, "stability");
});

test("clampAiModifiers — allowTargetStability=0 剔除 stability", () => {
  const settings = { ...S, allowTargetStability: 0 };
  const result = clampAiModifiers(
    [{ target: "stability", value: 5 }, { target: "production", value: 2 }],
    settings,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].target, "production");
});

test("clampAiModifiers — 所有目標禁用時回空陣列", () => {
  const settings = {
    ...S,
    allowTargetSatisfaction: 0,
    allowTargetStability: 0,
    allowTargetProduction: 0,
    allowTargetTech: 0,
    allowTargetPopulationGrowth: 0,
    allowTargetMilitaryObedience: 0,
  };
  const result = clampAiModifiers(
    [
      { target: "satisfactionLaw", value: 5 },
      { target: "production", value: 3 },
      { target: "stability", value: 2 },
    ],
    settings,
  );
  assert.equal(result.length, 0);
});

// ── 永久效果（clampDuration）────────────────────────────────────

test("clampDuration — policy + null → 轉為 maxDurationTurns", () => {
  assert.equal(clampDuration(null, S, "policy"), S.maxDurationTurns);
});

test("clampDuration — reform + null → 轉為 maxDurationTurns", () => {
  assert.equal(clampDuration(null, S, "reform"), S.maxDurationTurns);
});

test("clampDuration — event + null → 轉為 maxDurationTurns", () => {
  assert.equal(clampDuration(null, S, "event"), S.maxDurationTurns);
});

test("clampDuration — tradition + null + allowPermanentTradition=1 → 保留 null（永久）", () => {
  assert.equal(clampDuration(null, { ...S, allowPermanentTradition: 1 }, "tradition"), null);
});

test("clampDuration — tradition + null + allowPermanentTradition=0 → 轉為 maxDurationTurns", () => {
  assert.equal(clampDuration(null, { ...S, allowPermanentTradition: 0 }, "tradition"), S.maxDurationTurns);
});

test("clampDuration — 有值時正常夾 1–maxDurationTurns（不受 resultType 影響）", () => {
  assert.equal(clampDuration(5, S, "policy"), 5);
  assert.equal(clampDuration(5, S, "tradition"), 5);
  assert.equal(clampDuration(5, S, "reform"), 5);
  assert.equal(clampDuration(5, S, "event"), 5);
});

test("clampDuration — 超過 maxDurationTurns 時夾到上限", () => {
  assert.equal(clampDuration(30, S, "policy"), S.maxDurationTurns);
});

test("clampDuration — 低於 1 時夾到 1", () => {
  assert.equal(clampDuration(0, S, "reform"), 1);
  assert.equal(clampDuration(-5, S, "event"), 1);
});

test("clampDuration — resultType 未傳入時 null → null（向下相容）", () => {
  assert.equal(clampDuration(null, S), null);
});

// ── 動態 prompt doc ────────────────────────────────────────────

test("buildModifierDoc — 預設設定包含所有基礎目標", () => {
  const doc = buildModifierDoc(S);
  assert.ok(doc.includes('"satisfaction"'));
  assert.ok(doc.includes('"stability"'));
  assert.ok(doc.includes('"production"'));
  assert.ok(doc.includes('"tech"'));
  assert.ok(doc.includes('"populationGrowth"'));
  assert.ok(doc.includes(`satisfaction ±${S.modifierCapSatisfaction}`));
  assert.ok(doc.includes(`stability ±${S.modifierCapStability}`));
  assert.ok(doc.includes(`production ±${S.modifierCapProduction}`));
});

test("buildModifierDoc — 禁用 production 時 target 清單不含 production", () => {
  const doc = buildModifierDoc({ ...S, allowTargetProduction: 0 });
  assert.ok(!doc.includes('"production"'), '帶引號的 "production" 不應出現在 target 清單');
  assert.ok(doc.includes('"satisfaction"'), '其他允許目標仍在');
});

test("buildModifierDoc — satisfaction 與 stability 上限不同時各自顯示正確上限", () => {
  const doc = buildModifierDoc({
    ...S,
    modifierCapSatisfaction: 8,
    modifierCapStability: 4,
  });
  assert.ok(doc.includes("satisfaction ±8"), "satisfaction 顯示其專屬上限 8");
  assert.ok(doc.includes("stability ±4"), "stability 顯示其專屬上限 4");
  assert.ok(!doc.includes("stability ±8"), "stability 不應使用 satisfaction 的上限");
});

test("buildUnifiedModifierDoc — 預設設定包含所有統一目標", () => {
  const doc = buildUnifiedModifierDoc(S);
  assert.ok(doc.includes('"satisfactionLaw"'));
  assert.ok(doc.includes('"militaryObedience"'));
  assert.ok(doc.includes('"production"'));
  assert.ok(doc.includes(`satisfactionXxx ±${S.modifierCapSatisfaction}`));
  assert.ok(doc.includes(`militaryObedience ±${S.modifierCapMilitaryObedience}`));
  assert.ok(doc.includes(`stability ±${S.modifierCapStability}`));
  assert.ok(doc.includes(`production ±${S.modifierCapProduction}`));
  assert.ok(doc.includes(`populationGrowth ±${S.modifierCapPopulationGrowth}`));
});

test("buildUnifiedModifierDoc — 各分項上限不同時提示各自使用正確上限", () => {
  const doc = buildUnifiedModifierDoc({
    ...S,
    modifierCapSatisfaction: 7,
    modifierCapMilitaryObedience: 3,
    modifierCapStability: 5,
  });
  assert.ok(doc.includes("satisfactionXxx ±7"), "satisfaction 顯示其專屬上限 7");
  assert.ok(doc.includes("militaryObedience ±3"), "militaryObedience 顯示其專屬上限 3");
  assert.ok(doc.includes("stability ±5"), "stability 顯示其專屬上限 5");
  assert.ok(!doc.includes("militaryObedience ±7"), "militaryObedience 不應使用 satisfaction 的上限");
  assert.ok(!doc.includes("stability ±7"), "stability 不應使用 satisfaction 的上限");
});

test("buildUnifiedModifierDoc — 禁用 tech 與 populationGrowth 時不包含這些目標", () => {
  const doc = buildUnifiedModifierDoc({
    ...S,
    allowTargetTech: 0,
    allowTargetPopulationGrowth: 0,
  });
  assert.ok(!doc.includes('"tech"'));
  assert.ok(!doc.includes('"populationGrowth"'));
  assert.ok(doc.includes('"satisfactionLaw"'));
});

test("buildUnifiedModifierDoc — 全部禁用時回特殊提示字串", () => {
  const settings = {
    ...S,
    allowTargetSatisfaction: 0,
    allowTargetStability: 0,
    allowTargetProduction: 0,
    allowTargetTech: 0,
    allowTargetPopulationGrowth: 0,
    allowTargetMilitaryObedience: 0,
    warWearinessModifierEnabled: 0,
    foodGrowthEnabled: 0,
  };
  const doc = buildUnifiedModifierDoc(settings);
  assert.ok(doc.includes("留空"));
});


// ── 現行制度脈絡格式化（2026-10 政策連續性） ────────────────────

test("formatActivePoliciesLine — 空清單／未提供 → 空字串", () => {
  assert.equal(formatActivePoliciesLine(undefined), "");
  assert.equal(formatActivePoliciesLine(null), "");
  assert.equal(formatActivePoliciesLine([]), "");
});

test("formatActivePoliciesLine — 標題＋類型＋剩餘回合", () => {
  const line = formatActivePoliciesLine([
    { title: "義務教育", entryType: "policy", remainingTurns: null },
    { title: "屯田制", entryType: "reform", remainingTurns: 3 },
    { title: "豐年祭", entryType: "event", remainingTurns: 2 },
  ]);
  assert.match(line, /^現行制度（既成事實）：/);
  assert.ok(line.includes("義務教育（政策）"));
  assert.ok(line.includes("屯田制（變革，剩 3 回合）"));
  assert.ok(line.includes("豐年祭（事件，剩 2 回合）"));
});

test("formatActivePoliciesLine — 超過上限截斷並標註總數", () => {
  const many = Array.from({ length: ACTIVE_POLICIES_PROMPT_MAX + 5 }, (_, i) => ({
    title: `制度${i + 1}`,
    entryType: "policy",
    remainingTurns: null,
  }));
  const line = formatActivePoliciesLine(many);
  assert.ok(line.includes(`制度${ACTIVE_POLICIES_PROMPT_MAX}`));
  assert.ok(!line.includes(`制度${ACTIVE_POLICIES_PROMPT_MAX + 1}（`));
  assert.ok(line.includes("共 17 項"));
});
