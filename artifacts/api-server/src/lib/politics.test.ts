import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLITICS_SETTINGS,
  acceptanceTick,
  adjustStatValue,
  clampPct,
  computeFoodGrowthRatePct,
  computePoliticsState,
  counterEventChancePct,
  coupChancePct,
  decisionSuccessChance,
  effectiveMilitaryObedience,
  enabledPoliticsDirections,
  entryStrength,
  militaryObedienceOffset,
  goodEventProbabilityPct,
  pickCoupGovernment,
  pickNextGovernment,
  policySuccessChance,
  politicsSettingsSchema,
  restrictModifiersToEnabledDirections,
  satisfactionTargetDirection,
  clampPopulationGrowthMultiplierPct,
  populationGrowthAmount,
  populationGrowthRatePct,
  scalePopulationGrowth,
  scalePopulationGrowthRatePct,
  shouldChangeGovernment,
  stabilityMultiplier,
  sumModifiers,
  supportDriftTick,
  unrestTick,
  warWearinessAttackModifier,
  warWearinessRecovery,
  scaleWarWearinessGain,
} from "./politics";
import type { PoliticsModifier } from "@workspace/db";

const S = DEFAULT_POLITICS_SETTINGS;

test("stabilityMultiplier — 線性 ±30%", () => {
  assert.equal(stabilityMultiplier(50, 30), 1);
  assert.equal(stabilityMultiplier(100, 30), 1.3);
  assert.equal(stabilityMultiplier(0, 30), 0.7);
  assert.equal(stabilityMultiplier(75, 30), 1.15);
  // 夾 0–100
  assert.equal(stabilityMultiplier(150, 30), 1.3);
  assert.equal(stabilityMultiplier(-10, 30), 0.7);
  // 加成上限可調
  assert.equal(stabilityMultiplier(100, 10), 1.1);
});

test("warWearinessAttackModifier — 每 10% 厭戰度扣 10% 攻擊", () => {
  assert.equal(warWearinessAttackModifier(0), 1);
  assert.equal(warWearinessAttackModifier(30), 0.7);
  assert.equal(warWearinessAttackModifier(100), 0);
  assert.equal(warWearinessAttackModifier(120), 0);
});

test("warWearinessRecovery — 和平／戰時分流，非負整數", () => {
  const cfg = {
    warWearinessPeacetimeRecovery: 3,
    warWearinessWartimeRecovery: 0,
  };
  // 無進行中戰爭 → peacetime；交戰中 → wartime。
  assert.equal(warWearinessRecovery(false, cfg), 3);
  assert.equal(warWearinessRecovery(true, cfg), 0);
  // 戰時也可設回復。
  assert.equal(
    warWearinessRecovery(true, {
      warWearinessPeacetimeRecovery: 5,
      warWearinessWartimeRecovery: 2,
    }),
    2,
  );
  // 壞值 → 視為 0（絕不回傳負數）。
  assert.equal(
    warWearinessRecovery(false, {
      warWearinessPeacetimeRecovery: Number.NaN,
      warWearinessWartimeRecovery: 0,
    }),
    0,
  );
});

/**
 * 驗證回合引擎套用厭戰度時「循序更新」的語義正確性。
 * 回合引擎 SQL：LEAST(100, GREATEST(0, GREATEST(0, current - recovery) - policyDelta))
 * - Step 1：回復量先套，floor ≥ 0（不讓厭戰度變負）。
 * - Step 2：政策 delta 再套，clamp 0–100。
 * 不可合併為 (current - recovery - policyDelta)：
 *   當回復量「過量」（current < recovery），過量部分不應抵消負政策 delta（增加厭戰）。
 */
function sequentialWearinessUpdate(
  current: number,
  recovery: number,
  policyDelta: number,
): number {
  const afterRecovery = Math.max(0, current - recovery);
  return Math.min(100, Math.max(0, afterRecovery - policyDelta));
}

test("warWeariness 循序更新語義 — 回復過量時負政策 delta 仍從 0 開始累加", () => {
  // 正常情況：回復 3，政策 delta 0 → 結果 max(0, 10-3) = 7。
  assert.equal(sequentialWearinessUpdate(10, 3, 0), 7);

  // 回復剛好耗盡：current=5, recovery=5, policyDelta=0 → 0（不變負）。
  assert.equal(sequentialWearinessUpdate(5, 5, 0), 0);

  // 關鍵邊界：回復過量但政策 delta 為負（增加厭戰）。
  // current=1, recovery=5 → afterRecovery=0；policy delta=-2（增加 2）→ 結果應為 2。
  // 若合併：max(0, 1-5-(-2)) = max(0,-2) = 0（錯誤：政策效果被回復過量吸收）。
  assert.equal(sequentialWearinessUpdate(1, 5, -2), 2);

  // 正政策 delta（減少厭戰）與過量回復 → 0，不會低於 0。
  assert.equal(sequentialWearinessUpdate(1, 5, 3), 0);

  // 接近上限：current=99, recovery=0, policyDelta=-3（增加 3）→ 夾到 100。
  assert.equal(sequentialWearinessUpdate(99, 0, -3), 100);
});

test("scaleWarWearinessGain — 正向增量 × 倍率%，倍率壞值退回 100", () => {
  assert.equal(scaleWarWearinessGain(4, 100), 4); // 原幅度
  assert.equal(scaleWarWearinessGain(4, 0), 0); // 完全不上升
  assert.equal(scaleWarWearinessGain(4, 200), 8); // 兩倍
  assert.equal(scaleWarWearinessGain(3, 50), 2); // 1.5 → 四捨五入 2
  // 非正增量不產生下降（回復由回合引擎負責）。
  assert.equal(scaleWarWearinessGain(0, 200), 0);
  assert.equal(scaleWarWearinessGain(-5, 200), 0);
  // 倍率壞值 → 視為 100（原幅度）。
  assert.equal(scaleWarWearinessGain(4, Number.NaN), 4);
  assert.equal(scaleWarWearinessGain(4, -10), 4);
});

test("unrestTick — 三檔位判定並加總；低檔取代中檔", () => {
  // 全部 >50：4 × (−3, +1)
  assert.deepEqual(unrestTick([60, 60, 60, 60], S), {
    unrestDelta: -12,
    stabilityDelta: 4,
  });
  // 全部 30–50（含邊界 50 與 30）：4 × (+5, 0)
  assert.deepEqual(unrestTick([50, 40, 30, 35], S), {
    unrestDelta: 20,
    stabilityDelta: 0,
  });
  // 全部 <30：4 × (+10, −5)，不疊加中檔
  assert.deepEqual(unrestTick([0, 10, 20, 29], S), {
    unrestDelta: 40,
    stabilityDelta: -20,
  });
  // 混合：60(高) + 40(中) + 20(低) + 51(高)
  assert.deepEqual(unrestTick([60, 40, 20, 51], S), {
    unrestDelta: -3 + 5 + 10 - 3,
    stabilityDelta: 1 - 5 + 1,
  });
});

test("entryStrength — 政策永久、事件線性淡化、短暫政策不淡化", () => {
  const base = { status: "active" as const };
  assert.equal(
    entryStrength({ ...base, entryType: "policy", durationTurns: null, remainingTurns: null }),
    1,
  );
  assert.equal(
    entryStrength({ ...base, entryType: "event", durationTurns: 4, remainingTurns: 2 }),
    0.5,
  );
  assert.equal(
    entryStrength({ ...base, entryType: "reform", durationTurns: 5, remainingTurns: 5 }),
    1,
  );
  assert.equal(
    entryStrength({ ...base, entryType: "reform", durationTurns: 5, remainingTurns: 0 }),
    0,
  );
  // 短暫政策：剩餘 >0 時全額
  assert.equal(
    entryStrength({ ...base, entryType: "policy", durationTurns: 5, remainingTurns: 1 }),
    1,
  );
  assert.equal(
    entryStrength({ ...base, entryType: "policy", durationTurns: 5, remainingTurns: 0 }),
    0,
  );
  // 非 active 一律 0
  assert.equal(
    entryStrength({ entryType: "policy", durationTurns: null, remainingTurns: null, status: "repealed" }),
    0,
  );
});

test("militaryObedienceOffset / effectiveMilitaryObedience — 只計 militaryObedience 目標、淡化與夾限", () => {
  const entries = [
    {
      entryType: "policy" as const,
      durationTurns: null,
      remainingTurns: null,
      status: "active" as const,
      modifiers: [
        { target: "militaryObedience" as const, value: 10 },
        { target: "satisfactionMilitary" as const, value: 5 }, // 不計入服從度
      ],
    },
    {
      entryType: "event" as const,
      durationTurns: 4,
      remainingTurns: 2, // 強度 0.5
      status: "active" as const,
      modifiers: [{ target: "militaryObedience" as const, value: -4 }],
    },
    {
      entryType: "policy" as const,
      durationTurns: null,
      remainingTurns: null,
      status: "repealed" as const, // 強度 0
      modifiers: [{ target: "militaryObedience" as const, value: 50 }],
    },
  ];
  assert.equal(militaryObedienceOffset(entries), 10 - 2);
  assert.equal(effectiveMilitaryObedience(60, entries), 68);
  // 夾限 0–100
  assert.equal(
    effectiveMilitaryObedience(95, [
      {
        entryType: "policy" as const,
        durationTurns: null,
        remainingTurns: null,
        status: "active" as const,
        modifiers: [{ target: "militaryObedience" as const, value: 20 }],
      },
    ]),
    100,
  );
  assert.equal(
    effectiveMilitaryObedience(5, [
      {
        entryType: "policy" as const,
        durationTurns: null,
        remainingTurns: null,
        status: "active" as const,
        modifiers: [{ target: "militaryObedience" as const, value: -20 }],
      },
    ]),
    0,
  );
  assert.equal(effectiveMilitaryObedience(60, []), 60);
});

test("sumModifiers — 淡化後彙整、未知 target 忽略", () => {
  const totals = sumModifiers([
    {
      entryType: "policy",
      durationTurns: null,
      remainingTurns: null,
      status: "active",
      modifiers: [
        { target: "satisfaction", value: 10 },
        { target: "production", value: 5 },
      ],
    },
    {
      entryType: "event",
      durationTurns: 4,
      remainingTurns: 2,
      status: "active",
      modifiers: [
        { target: "satisfaction", value: -8 },
        { target: "tech", value: 6 },
        // @ts-expect-error 未知 target 應被忽略
        { target: "money", value: 100 },
      ],
    },
  ]);
  assert.deepEqual(totals, {
    satisfaction: 10 - 4,
    stability: 0,
    production: 5,
    tech: 3,
    populationGrowth: 0,
    warWeariness: 0,
    foodGrowth: 0,
  });
});

test("sumModifiers — populationGrowth 加減成與淡化", () => {
  const totals = sumModifiers([
    {
      entryType: "policy",
      durationTurns: null,
      remainingTurns: null,
      status: "active",
      modifiers: [{ target: "populationGrowth", value: 3 }],
    },
    {
      entryType: "event",
      durationTurns: 4,
      remainingTurns: 2,
      status: "active",
      modifiers: [{ target: "populationGrowth", value: -4 }],
    },
  ]);
  assert.equal(totals.populationGrowth, 3 - 2);
});

test("policySuccessChance — 基礎+穩定度+契合度，夾 min–max", () => {
  assert.equal(policySuccessChance(50, 50, S), 70);
  assert.equal(policySuccessChance(100, 50, S), 70 + 50 * 0.3);
  assert.equal(policySuccessChance(50, 100, S), 70 + 50 * 0.4);
  assert.equal(policySuccessChance(0, 0, S), 70 - 15 - 20);
  assert.equal(policySuccessChance(100, 100, S), 95); // capped
});

test("goodEventProbabilityPct — 穩定度夾 min–max", () => {
  assert.equal(goodEventProbabilityPct(50, S), 50);
  assert.equal(goodEventProbabilityPct(0, S), 10);
  assert.equal(goodEventProbabilityPct(100, S), 90);
});

test("coupChancePct — 門檻以下為 0，夾 0–max", () => {
  assert.equal(coupChancePct(50, 0, S), 0);
  assert.equal(coupChancePct(30, 0, S), 0);
  // 60 暴動、50 穩定：20 + 10×1 − 50×0.4 = 10
  assert.equal(coupChancePct(60, 50, S), 10);
  // 高穩定壓到 0
  assert.equal(coupChancePct(55, 100, S), 0);
  // 極端情況夾 max 80
  assert.equal(coupChancePct(100, 0, S), 70);
  assert.equal(coupChancePct(100, 0, { ...S, coupBaseChancePct: 60 }), 80);
});

test("computePoliticsState — 有效值與方向加減成", () => {
  const nation = {
    stability: 50,
    unrest: 20,
    warWeariness: 30,
    satisfactionFarmers: 60,
    satisfactionWorkers: 60,
    satisfactionClergy: 60,
    satisfactionMilitary: 60,
    satisfactionNobles: 60,
  };
  const state = computePoliticsState(
    nation,
    [
      {
        direction: "law",
        entryType: "policy",
        durationTurns: null,
        remainingTurns: null,
        status: "active",
        modifiers: [
          { target: "satisfaction", value: 15 },
          { target: "stability", value: 10 },
          { target: "production", value: 20 },
        ],
      },
      {
        direction: "culture",
        entryType: "event",
        durationTurns: 2,
        remainingTurns: 1,
        status: "active",
        modifiers: [
          { target: "satisfaction", value: -20 },
          { target: "tech", value: 10 },
        ],
      },
    ],
    S,
  );
  assert.equal(state.stability, 60);
  assert.equal(state.satisfactions.law, 75);
  assert.equal(state.satisfactions.culture, 50);
  assert.equal(state.satisfactions.religion, 60);
  assert.equal(state.productionPct, 20);
  assert.equal(state.techPct, 5);
  assert.equal(state.populationGrowthPct, 0);
  assert.equal(state.stabilityOffset, 10);
  // 有效穩定度 60 → 乘數 1.06
  assert.ok(Math.abs(state.stabilityMult - 1.06) < 1e-9);
});

test("computePoliticsState — general 條目：指名滿意度 target 進各方向、全域效果進總和", () => {
  const nation = {
    stability: 50,
    unrest: 20,
    warWeariness: 30,
    satisfactionFarmers: 60,
    satisfactionWorkers: 60,
    satisfactionClergy: 60,
    satisfactionMilitary: 60,
    satisfactionNobles: 60,
  };
  const state = computePoliticsState(
    nation,
    [
      {
        direction: "general",
        entryType: "policy",
        durationTurns: null,
        remainingTurns: null,
        status: "active",
        modifiers: [
          { target: "satisfactionLaw", value: 10 },
          { target: "satisfactionReligion", value: -15 },
          { target: "stability", value: 5 },
          { target: "production", value: 8 },
          { target: "tech", value: 4 },
          { target: "populationGrowth", value: 0.5 },
          // 舊式不指名 satisfaction 在 general 條目上無方向，應被忽略
          { target: "satisfaction", value: 99 },
        ],
      },
    ],
    S,
  );
  assert.equal(state.satisfactions.law, 70);
  assert.equal(state.satisfactions.religion, 45);
  assert.equal(state.satisfactions.culture, 60);
  assert.equal(state.satisfactions.rights, 60);
  assert.equal(state.directionTotals.law.satisfaction, 10);
  assert.equal(state.directionTotals.religion.satisfaction, -15);
  assert.equal(state.stabilityOffset, 5);
  assert.equal(state.productionPct, 8);
  assert.equal(state.techPct, 4);
  assert.equal(state.populationGrowthPct, 0.5);
});

test("computePoliticsState — 舊制方向條目也可用指名滿意度 target（跨方向）", () => {
  const nation = {
    stability: 50,
    unrest: 20,
    warWeariness: 30,
    satisfactionFarmers: 60,
    satisfactionWorkers: 60,
    satisfactionClergy: 60,
    satisfactionMilitary: 60,
    satisfactionNobles: 60,
  };
  const state = computePoliticsState(
    nation,
    [
      {
        direction: "law",
        entryType: "policy",
        durationTurns: null,
        remainingTurns: null,
        status: "active",
        modifiers: [
          { target: "satisfaction", value: 5 }, // 舊式 → 依條目方向 law
          { target: "satisfactionCulture", value: 7 }, // 指名 → culture
        ],
      },
    ],
    S,
  );
  assert.equal(state.satisfactions.law, 65);
  assert.equal(state.satisfactions.culture, 67);
});

test("restrictModifiersToEnabledDirections — 未解鎖方向的指名滿意度歸零、其餘保留", () => {
  const input: PoliticsModifier[] = [
    { target: "satisfactionLaw", value: 10 },
    { target: "satisfactionReligion", value: -15 },
    { target: "satisfactionRights", value: 8 },
    { target: "stability", value: 5 },
    { target: "production", value: 3 },
  ];
  const out = restrictModifiersToEnabledDirections(input, ["law", "culture"]);
  assert.deepEqual(out, [
    { target: "satisfactionLaw", value: 10 },
    { target: "stability", value: 5 },
    { target: "production", value: 3 },
  ]);
  // 全部解鎖 → 原樣保留
  assert.deepEqual(
    restrictModifiersToEnabledDirections(input, [
      "law",
      "culture",
      "religion",
      "rights",
    ]),
    input,
  );
});

test("satisfactionTargetDirection — 指名滿意度 target 對應方向、其他回 null", () => {
  assert.equal(satisfactionTargetDirection("satisfactionLaw"), "law");
  assert.equal(satisfactionTargetDirection("satisfactionCulture"), "culture");
  assert.equal(satisfactionTargetDirection("satisfactionReligion"), "religion");
  assert.equal(satisfactionTargetDirection("satisfactionRights"), "rights");
  assert.equal(satisfactionTargetDirection("satisfaction"), null);
  assert.equal(satisfactionTargetDirection("stability"), null);
});

test("computePoliticsState — 管理員暫時滿意度 buff（satisfactionOffsets）逐方向加成並夾 0–100", () => {
  const nation = {
    stability: 50,
    unrest: 20,
    warWeariness: 30,
    satisfactionFarmers: 60,
    satisfactionWorkers: 60,
    satisfactionClergy: 95,
    satisfactionMilitary: 95,
    satisfactionNobles: 10,
  };
  const state = computePoliticsState(nation, [], S, {
    law: 10,
    religion: 20, // 95 + 20 → 夾 100
    rights: -30, // 10 − 30 → 夾 0
  });
  assert.equal(state.satisfactions.law, 70);
  assert.equal(state.satisfactions.culture, 60); // 未指定方向不受影響
  assert.equal(state.satisfactions.religion, 100);
  assert.equal(state.satisfactions.rights, 0);
});

test("adjustStatValue — 乘數與百分比加成、不低於 0", () => {
  assert.equal(adjustStatValue(1000, 1.3, 0), 1300);
  assert.equal(adjustStatValue(1000, 1, 20), 1200);
  assert.equal(adjustStatValue(1000, 0.7, -50), 350);
  assert.equal(adjustStatValue(100, 0, -200), 0);
});

test("politicsSettingsSchema — 預設值與部分覆寫", () => {
  assert.equal(S.stabilityMaxBonusPct, 30);
  assert.equal(S.coupUnrestThreshold, 50);
  const merged = politicsSettingsSchema.parse({ eventChancePct: 55 });
  assert.equal(merged.eventChancePct, 55);
  assert.equal(merged.policySuccessBasePct, 70);
  assert.throws(() => politicsSettingsSchema.parse({ eventChancePct: 200 }));
});

test("clampPct", () => {
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(105), 100);
  assert.equal(clampPct(42), 42);
});

test("populationGrowthRatePct — 基礎+加減成，上限夾正、下限夾 floor", () => {
  // 預設：基礎 1%、上限 100%、最小下限 0.01%
  assert.equal(S.populationBaseGrowthPct, 1);
  assert.equal(S.populationGrowthMaxAbsPct, 100);
  assert.equal(S.populationGrowthMinAbsPct, 0.01);
  assert.equal(populationGrowthRatePct(0, S), 1);
  assert.equal(populationGrowthRatePct(2.5, S), 3.5);
  // raw = 1 + (-4) = -3，floor 0.01 → 0.01
  assert.equal(populationGrowthRatePct(-4, S), 0.01);
  // 夾上限 100
  assert.equal(populationGrowthRatePct(200, S), 100);
  // raw 大幅為負 → floor 0.01
  assert.equal(populationGrowthRatePct(-200, S), 0.01);
  // 自訂 floor 更高：populationGrowthMinAbsPct = 0.5
  const customFloor = { ...S, populationGrowthMinAbsPct: 0.5 };
  assert.equal(populationGrowthRatePct(-4, customFloor), 0.5);
  // 正數情況不受 floor 影響
  assert.equal(populationGrowthRatePct(2, customFloor), 3);
});

test("populationGrowthAmount — 四捨五入、人口 ≤0 為 0", () => {
  assert.equal(populationGrowthAmount(1000, 1), 10);
  assert.equal(populationGrowthAmount(1000, -2.5), -25);
  assert.equal(populationGrowthAmount(33, 1), 0); // 0.33 → 0
  assert.equal(populationGrowthAmount(150, 1), 2); // 1.5 → 2
  assert.equal(populationGrowthAmount(0, 10), 0);
  assert.equal(populationGrowthAmount(-500, 10), 0);
});

test("clampPopulationGrowthMultiplierPct — 夾 0–100、壞值回預設 100", () => {
  assert.equal(clampPopulationGrowthMultiplierPct(100), 100);
  assert.equal(clampPopulationGrowthMultiplierPct(0), 0);
  assert.equal(clampPopulationGrowthMultiplierPct(50), 50);
  assert.equal(clampPopulationGrowthMultiplierPct(50.9), 50); // floor
  assert.equal(clampPopulationGrowthMultiplierPct(150), 100); // 超上限
  assert.equal(clampPopulationGrowthMultiplierPct(-10), 0); // 超下限
  // 壞值（防止資料庫髒值導致結算崩潰）→ 預設 100。
  assert.equal(clampPopulationGrowthMultiplierPct(undefined), 100);
  assert.equal(clampPopulationGrowthMultiplierPct(null), 100);
  assert.equal(clampPopulationGrowthMultiplierPct(Number.NaN), 100);
  assert.equal(clampPopulationGrowthMultiplierPct("abc"), 100);
});

test("scalePopulationGrowth — 依倍率縮放增長量，倍率 100 不變、保留正負號", () => {
  // 倍率 100 = 現行速度，行為完全不變（含衰退）。
  assert.equal(scalePopulationGrowth(10, 100), 10);
  assert.equal(scalePopulationGrowth(-25, 100), -25);
  // 0 = 停止增長。
  assert.equal(scalePopulationGrowth(10, 0), 0);
  // 50% / 20%（四捨五入為整數）。
  assert.equal(scalePopulationGrowth(10, 50), 5);
  assert.equal(scalePopulationGrowth(7, 50), 4); // 3.5 → 4
  assert.equal(scalePopulationGrowth(10, 20), 2);
  // 倍率超界先夾。
  assert.equal(scalePopulationGrowth(10, 150), 10);
  assert.equal(scalePopulationGrowth(10, -10), 0);
  // 非負輸入縮放後仍為非負整數；負值同樣按倍率縮小幅度（保留負號）。
  assert.equal(scalePopulationGrowth(4, 50), 2);
  assert.ok(scalePopulationGrowth(4, 50) >= 0);
  assert.equal(scalePopulationGrowth(-40, 50), -20);
  // 壞倍率回預設 100 → 不變。
  assert.equal(scalePopulationGrowth(10, Number.NaN), 10);
});

test("scalePopulationGrowthRatePct — 依倍率縮放增長率（保留小數，顯示層再取位）", () => {
  assert.equal(scalePopulationGrowthRatePct(2, 100), 2);
  assert.equal(scalePopulationGrowthRatePct(2, 50), 1);
  assert.equal(scalePopulationGrowthRatePct(2, 0), 0);
  assert.equal(scalePopulationGrowthRatePct(-3, 50), -1.5);
  assert.equal(scalePopulationGrowthRatePct(2, 150), 2); // 夾 100
  assert.equal(scalePopulationGrowthRatePct(2, Number.NaN), 2); // 壞值 → 100
});

// ── Task #127 政府治理系統純函式 ──

test("enabledPoliticsDirections — 秩序/文化/軍方恆開；宗教/人權依旗標解鎖", () => {
  assert.deepEqual(
    enabledPoliticsDirections({
      religionEnabled: false,
      rightsEnabled: false,
    }),
    ["law", "culture", "military"],
  );
  assert.deepEqual(
    enabledPoliticsDirections({
      religionEnabled: true,
      rightsEnabled: false,
    }),
    ["law", "culture", "religion", "military"],
  );
  assert.deepEqual(
    enabledPoliticsDirections({
      religionEnabled: false,
      rightsEnabled: true,
    }),
    ["law", "culture", "rights", "military"],
  );
  assert.deepEqual(
    enabledPoliticsDirections({
      religionEnabled: true,
      rightsEnabled: true,
    }),
    ["law", "culture", "religion", "rights", "military"],
  );
});

test("decisionSuccessChance — 支持度加成、政體難度扣減、契合度加成，夾 min–max", () => {
  // 全部中性（50）→ 基礎值
  assert.equal(decisionSuccessChance(50, 50, 50, S), S.decisionSuccessBasePct);
  // 高支持度 + 低難度 + 高契合度 → 高於基礎
  assert.ok(decisionSuccessChance(90, 10, 90, S) > S.decisionSuccessBasePct);
  // 低支持度 + 高難度 + 低契合度 → 低於基礎
  assert.ok(decisionSuccessChance(10, 90, 10, S) < S.decisionSuccessBasePct);
  // 高端夾在 max（raw=110 → 95）
  assert.equal(decisionSuccessChance(100, 0, 100, S), S.decisionSuccessMaxPct);
  // 最低組合 raw = 60−15−20−15 = 10，仍在 min 之上（不被夾）
  assert.equal(decisionSuccessChance(0, 100, 0, S), 10);
  assert.ok(decisionSuccessChance(0, 100, 0, S) >= S.decisionSuccessMinPct);
});

test("counterEventChancePct — 支持度 ≤ 門檻回設定機率，否則 0", () => {
  assert.equal(
    counterEventChancePct(S.counterEventSupportThreshold, S),
    S.counterEventChancePct,
  );
  assert.equal(counterEventChancePct(0, S), S.counterEventChancePct);
  assert.equal(counterEventChancePct(S.counterEventSupportThreshold + 1, S), 0);
  assert.equal(counterEventChancePct(100, S), 0);
});

test("supportDriftTick — 朝滿意度平均漂移，空陣列不動、夾 0–100", () => {
  // 空陣列 → 原值
  assert.equal(supportDriftTick(50, [], S), 50);
  // 支持度 50、滿意度平均 100 → 上升
  const up = supportDriftTick(50, [100, 100], S);
  assert.ok(up > 50 && up <= 100);
  // 支持度 50、滿意度平均 0 → 下降
  const down = supportDriftTick(50, [0, 0], S);
  assert.ok(down < 50 && down >= 0);
  // 平均等於現值 → 不動
  assert.equal(supportDriftTick(60, [60, 60], S), 60);
});

test("acceptanceTick — 低支持度累積、否則消退，夾 0–100", () => {
  // 支持度低於門檻 → 累積
  assert.equal(
    acceptanceTick(S.acceptanceSupportThreshold - 1, 50, S),
    50 + S.acceptanceGrowthDelta,
  );
  // 支持度達門檻 → 消退
  assert.equal(
    acceptanceTick(S.acceptanceSupportThreshold, 50, S),
    50 - S.acceptanceDecayDelta,
  );
  // 夾上下限
  assert.equal(acceptanceTick(0, 100, S), 100);
  assert.equal(acceptanceTick(100, 0, S), 0);
});

test("shouldChangeGovernment — 接受度 ≥ 100 才觸發", () => {
  assert.equal(shouldChangeGovernment(100), true);
  assert.equal(shouldChangeGovernment(120), true);
  assert.equal(shouldChangeGovernment(99), false);
  assert.equal(shouldChangeGovernment(0), false);
});

test("pickNextGovernment — 排除現行、空池回 null、rand 可注入", () => {
  assert.equal(pickNextGovernment("a", ["a"]), null);
  assert.equal(pickNextGovernment("a", []), null);
  // 只有一個非現行候選 → 必選它
  assert.equal(pickNextGovernment("a", ["a", "b"]), "b");
  // rand 注入：0 → 第一個非現行；接近 1 → 最後一個
  assert.equal(pickNextGovernment("a", ["b", "c", "d"], () => 0), "b");
  assert.equal(pickNextGovernment("a", ["b", "c", "d"], () => 0.99), "d");
});

test("pickCoupGovernment — 依偏好序回第一個非現行，全等現行回 null", () => {
  assert.equal(pickCoupGovernment("x", ["a", "b"]), "a");
  assert.equal(pickCoupGovernment("a", ["a", "b"]), "b");
  assert.equal(pickCoupGovernment("a", ["a"]), null);
  assert.equal(pickCoupGovernment(null, ["a", "b"]), "a");
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #626 — 厭戰度政策 delta、人口增長最小下限、糧食增長率修飾
// ─────────────────────────────────────────────────────────────────────────────

test("populationGrowthRatePct — 夾至 floor（最小下限）而非 −cap", () => {
  // 預設 floor = 0.01、cap = 5
  const floor = S.populationGrowthMinAbsPct;
  // 基礎 + 大幅負修飾 → 不低於 floor
  const clamped = populationGrowthRatePct(-999, S);
  assert.ok(clamped >= floor, `期望 ≥ floor(${floor})，實際 ${clamped}`);
  // 上限不變
  const capped = populationGrowthRatePct(999, S);
  assert.equal(capped, S.populationGrowthMaxAbsPct);
  // 基礎本身若已在 floor 之上
  const mid = populationGrowthRatePct(0, S);
  assert.ok(mid >= floor);
});

test("computeFoodGrowthRatePct — 停用時回 0，啟用後夾 0.01–10", () => {
  const disabled = { ...S, foodGrowthEnabled: 0 };
  assert.equal(computeFoodGrowthRatePct(5, disabled), 0);

  const enabled = { ...S, foodGrowthEnabled: 1, foodGrowthBaseRatePct: 2, foodGrowthModifierCapPct: 3 };
  // 正常值 = 基礎 + 政策
  const normal = computeFoodGrowthRatePct(1, enabled);
  assert.ok(normal > 0 && normal <= 10);
  // 合計 ≤ 0 → 0（不給負加成）
  assert.equal(computeFoodGrowthRatePct(-999, enabled), 0);
  // 超大正值 → 夾上限 10
  assert.equal(computeFoodGrowthRatePct(999, enabled), 10);
  // 超小正值 → 夾下限 0.01
  const tiny = computeFoodGrowthRatePct(-1.99, { ...enabled, foodGrowthBaseRatePct: 2 });
  // 2 + (−1.99) = 0.01 → 0.01
  assert.ok(tiny >= 0.01);
});

test("computePoliticsState — warWearinessPolicyDelta 與 foodGrowthPct 由 modifier 累加", () => {
  const nation = {
    stability: 50,
    unrest: 0,
    warWeariness: 30,
    satisfactionFarmers: 50,
    satisfactionWorkers: 50,
    satisfactionClergy: 50,
    satisfactionNobles: 50,
    satisfactionMilitary: 50,
  };
  // activeEntries 格式：與 computePoliticsState 其他測試一致
  const entries = [
    {
      direction: "general" as const,
      entryType: "policy" as const,
      durationTurns: null,
      remainingTurns: null,
      status: "active" as const,
      modifiers: [
        { target: "warWeariness", value: 3 },
        { target: "foodGrowth", value: 2 },
      ] as PoliticsModifier[],
    },
  ];
  const result = computePoliticsState(nation, entries, S);
  assert.equal(result.warWearinessPolicyDelta, 3);
  assert.equal(result.foodGrowthPct, 2);
});
