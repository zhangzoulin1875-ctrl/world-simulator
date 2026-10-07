import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LEGION_SLOTS,
  MAX_UNIT_TYPES_PER_LEGION,
  WAR_ORDER_TYPES,
  WAR_ORDER_TYPE_LABELS,
  ORDER_BODY_MAX_LENGTH,
  DEFAULT_CYCLE_HOURS,
  REGION_COOLDOWN_MINUTES,
  MAX_AI_FAIL_COUNT,
  isLegionSlot,
  isWarOrderType,
  computeAvailable,
  validateLegionsInput,
  normalizeOrderBody,
  sumNationalBonusPct,
  computeRecovery,
  computeTurnRecovery,
  shiftDeathsToWounded,
  allocateProportionally,
  applyTerritoryTransfer,
  capTransferForCity,
  determineCampaignOutcome,
  reconLevelFromOrders,
  fuzzValue,
  initialCityState,
  clamp100,
  combatConditionFactor,
  coupAdjustedMorale,
  computeEffectivePower,
  computeCycleCasualties,
  computeCounterattack,
  computeForceRatioTerritoryShift,
  computeMopUpShift,
  CASUALTY_BASELINE_RATE,
  COUNTERATTACK_MAX_TERRITORY_PCT,
  areaCaptureSpeedFactor,
  scaleTerritoryShift,
  battleScaleFactor,
  clampWarIntensityPct,
  clampTerritoryCaptureBasePct,
  WAR_INTENSITY_MIN_PCT,
  WAR_INTENSITY_MAX_PCT,
  WAR_INTENSITY_DEFAULT_PCT,
  TERRITORY_CAPTURE_BASE_MIN_PCT,
  TERRITORY_CAPTURE_BASE_MAX_PCT,
  TERRITORY_CAPTURE_BASE_DEFAULT_PCT,
  normalizeSplitWeights,
  applyTacticalBonus,
  computeTerritoryShift,
  computeSiegeIntensity,
  computeLocalPopulationLossPct,
  type CycleCasualtyResult,
  type SidePowerInput,
} from "./war";
import { detectAnachronisticUnits } from "./warAi";
import { makeWarCity } from "./wall";
import type { MilitaryTechBonus, WarCity, WarCityState } from "@workspace/db";

describe("war 常數", () => {
  test("槽位／指令類型／週期常數", () => {
    assert.deepEqual([...LEGION_SLOTS], ["A", "B", "C"]);
    assert.equal(MAX_UNIT_TYPES_PER_LEGION, 5);
    assert.deepEqual([...WAR_ORDER_TYPES], ["command"]);
    for (const t of WAR_ORDER_TYPES) {
      assert.ok(WAR_ORDER_TYPE_LABELS[t].length > 0);
    }
    assert.equal(DEFAULT_CYCLE_HOURS, 24);
    assert.equal(REGION_COOLDOWN_MINUTES, 30);
    assert.ok(MAX_AI_FAIL_COUNT >= 2);
    assert.ok(isLegionSlot("A") && !isLegionSlot("D"));
    assert.ok(isWarOrderType("command") && !isWarOrderType("recon"));
  });
});

describe("computeAvailable", () => {
  test("持有 − 前線 − 傷兵，下限 0", () => {
    assert.equal(computeAvailable(100, 30, 20), 50);
    assert.equal(computeAvailable(100, 80, 40), 0);
    assert.equal(computeAvailable(0, 0, 0), 0);
  });
});

describe("validateLegionsInput", () => {
  test("合法配置通過", () => {
    assert.equal(
      validateLegionsInput([
        { slot: "A", units: [{ templateId: 1, quantity: 100 }] },
        {
          slot: "B",
          units: [
            { templateId: 2, quantity: 0 },
            { templateId: 3, quantity: 50 },
          ],
        },
      ]),
      null,
    );
  });

  test("超過 3 個軍團被拒", () => {
    const legions = ["A", "B", "C"].map((slot) => ({ slot, units: [] }));
    assert.equal(validateLegionsInput(legions), null);
    assert.match(
      validateLegionsInput([...legions, { slot: "A", units: [] }]) ?? "",
      /最多 3 個軍團/,
    );
  });

  test("非法槽位與重複槽位被拒", () => {
    assert.match(
      validateLegionsInput([{ slot: "X", units: [] }]) ?? "",
      /槽位必須是/,
    );
    assert.match(
      validateLegionsInput([
        { slot: "A", units: [] },
        { slot: "A", units: [] },
      ]) ?? "",
      /重複/,
    );
  });

  test("每團兵種數上限與重複兵種被拒", () => {
    const units = [1, 2, 3, 4, 5].map((id) => ({
      templateId: id,
      quantity: 1,
    }));
    assert.equal(validateLegionsInput([{ slot: "A", units }]), null);
    assert.match(
      validateLegionsInput([
        {
          slot: "A",
          units: [...units, { templateId: 6, quantity: 1 }],
        },
      ]) ?? "",
      /最多 5 種兵種/,
    );
    assert.match(
      validateLegionsInput([
        {
          slot: "A",
          units: [
            { templateId: 1, quantity: 1 },
            { templateId: 1, quantity: 2 },
          ],
        },
      ]) ?? "",
      /不可重複/,
    );
  });

  test("數量必須是非負整數且 ≤ 1000 萬", () => {
    assert.match(
      validateLegionsInput([
        { slot: "A", units: [{ templateId: 1, quantity: -1 }] },
      ]) ?? "",
      /非負整數/,
    );
    assert.match(
      validateLegionsInput([
        { slot: "A", units: [{ templateId: 1, quantity: 1.5 }] },
      ]) ?? "",
      /非負整數/,
    );
    assert.match(
      validateLegionsInput([
        { slot: "A", units: [{ templateId: 1, quantity: 10_000_001 }] },
      ]) ?? "",
      /1000 萬/,
    );
  });
});

describe("normalizeOrderBody", () => {
  test("trim 並通過合法內容", () => {
    const r = normalizeOrderBody("  向北推進  ");
    assert.deepEqual(r, { ok: true, body: "向北推進" });
  });

  test("空白／非字串／超長被拒", () => {
    assert.equal(normalizeOrderBody("   ").ok, false);
    assert.equal(normalizeOrderBody(42).ok, false);
    const long = "字".repeat(ORDER_BODY_MAX_LENGTH + 1);
    const r = normalizeOrderBody(long);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /150/);
  });
});

describe("sumNationalBonusPct", () => {
  test("同 target 相加（含負值），其他 target 忽略", () => {
    const techs = [
      {
        bonuses: [
          { target: "recoverySpeed", category: null, pct: 30 },
          { target: "attack", category: null, pct: 50 },
        ] as MilitaryTechBonus[],
      },
      {
        bonuses: [
          { target: "recoverySpeed", category: "infantry", pct: 20 },
          { target: "recoveryRate", category: null, pct: -10 },
        ] as MilitaryTechBonus[],
      },
    ];
    assert.equal(sumNationalBonusPct(techs, "recoverySpeed"), 50);
    assert.equal(sumNationalBonusPct(techs, "recoveryRate"), -10);
    assert.equal(sumNationalBonusPct([], "recoverySpeed"), 0);
  });
});

describe("computeRecovery（前線時間比例）", () => {
  const DAY = 86_400_000;

  test("基礎：一天復原 10%（向下取整）", () => {
    assert.equal(computeRecovery(100, DAY, 0), 10);
    assert.equal(computeRecovery(10, DAY, 0), 1);
  });

  test("小額傷兵池短期為 0，時間累積後 ≥1", () => {
    assert.equal(computeRecovery(3, DAY, 0), 0);
    assert.ok(computeRecovery(3, 4 * DAY, 0) >= 1);
  });

  test("速度加成放大復原量；封頂於 wounded", () => {
    assert.equal(computeRecovery(100, DAY, 100), 20);
    assert.equal(computeRecovery(10, 30 * DAY, 0), 10);
  });

  test("0 傷兵或 0 經過時間 → 0", () => {
    assert.equal(computeRecovery(0, DAY, 0), 0);
    assert.equal(computeRecovery(100, 0, 0), 0);
  });

  test("負加成不會讓復原變負", () => {
    assert.equal(computeRecovery(100, DAY, -200), 0);
  });
});

describe("computeTurnRecovery（全國傷兵池回合制線性）", () => {
  // 新簽名：computeTurnRecovery(initialWounded, wounded, speedBonusPct, pctPerTurn)
  // 基準預設 pctPerTurn=10（10 回合完全復原）

  test("基礎：每回合復原 initialWounded 的 10%（無條件進位）", () => {
    assert.equal(computeTurnRecovery(100, 100, 0, 10), 10);
    assert.equal(computeTurnRecovery(10, 10, 0, 10), 1);
  });

  test("小額傷兵池：有傷兵時每回合至少復原 1（不會永遠卡住）", () => {
    assert.equal(computeTurnRecovery(3, 3, 0, 10), 1);
    assert.equal(computeTurnRecovery(1, 1, 0, 10), 1);
  });

  test("速度加成放大復原量；小額池保底 1", () => {
    assert.equal(computeTurnRecovery(100, 100, 100, 10), 20);
    assert.equal(computeTurnRecovery(5, 5, 0, 10), 1);
  });

  test("0 傷兵 → 0", () => {
    assert.equal(computeTurnRecovery(0, 0, 0, 10), 0);
    assert.equal(computeTurnRecovery(0, -1, 0, 10), 0);
  });

  test("負加成不會讓復原變負：仍保底 1", () => {
    assert.equal(computeTurnRecovery(100, 100, -200, 10), 1);
  });

  test("封頂於 wounded：不超出目前剩餘傷兵（線性量可能大於剩餘）", () => {
    // initialWounded=100, wounded=5（已復原 95），每回合 ceil(100×10%)=10 > 5 → 封頂 5
    assert.equal(computeTurnRecovery(100, 5, 0, 10), 5);
    // 速度 2000%：即使計算量超大也封頂
    assert.equal(computeTurnRecovery(3, 3, 2000, 10), 3);
  });

  test("線性特性：復原量與 initialWounded 而非 wounded 成正比", () => {
    // 相同 initialWounded，不同 wounded（已復原後）→ 每回合量不變
    const perTurn = computeTurnRecovery(200, 200, 0, 10); // ceil(200×10%)=20
    assert.equal(perTurn, 20);
    const perTurnAfter = computeTurnRecovery(200, 80, 0, 10); // 仍 20（非 8）
    assert.equal(perTurnAfter, 20);
  });

  test("pctPerTurn 參數控制速率", () => {
    assert.equal(computeTurnRecovery(100, 100, 0, 20), 20); // 20% → 5 回合
    assert.equal(computeTurnRecovery(100, 100, 0, 1), 1);   // 1% → 100 回合
  });

  test("initialWounded=0（遷移前後援）：以 wounded 為基準", () => {
    // initial=0 fallback to wounded=50 → ceil(50×10%)=5
    assert.equal(computeTurnRecovery(0, 50, 0, 10), 5);
  });
});

describe("shiftDeathsToWounded", () => {
  test("按百分比把死亡轉為受傷", () => {
    assert.deepEqual(shiftDeathsToWounded(100, 30), {
      dead: 70,
      extraWounded: 30,
    });
  });

  test("夾在 0–90%", () => {
    assert.deepEqual(shiftDeathsToWounded(100, 200), {
      dead: 10,
      extraWounded: 90,
    });
    assert.deepEqual(shiftDeathsToWounded(100, -50), {
      dead: 100,
      extraWounded: 0,
    });
  });

  test("0 死亡不動", () => {
    assert.deepEqual(shiftDeathsToWounded(0, 50), { dead: 0, extraWounded: 0 });
  });
});

describe("allocateProportionally", () => {
  test("總和恰等於 total，按權重比例", () => {
    const r = allocateProportionally([100, 200, 700], 10);
    assert.equal(r.reduce((a, b) => a + b, 0), 10);
    assert.deepEqual(r, [1, 2, 7]);
  });

  test("整除不了時用 largest remainder", () => {
    const r = allocateProportionally([1, 1, 1], 10);
    assert.equal(r.reduce((a, b) => a + b, 0), 10);
    for (const v of r) assert.ok(v >= 3 && v <= 4);
  });

  test("權重全 0 → 平均分配；空陣列與 total ≤ 0", () => {
    const r = allocateProportionally([0, 0], 5);
    assert.equal(r.reduce((a, b) => a + b, 0), 5);
    assert.deepEqual(allocateProportionally([], 5), []);
    assert.deepEqual(allocateProportionally([1, 2], 0), [0, 0]);
  });
});

describe("applyTerritoryTransfer", () => {
  test("在雙方之間移轉，第三方不動", () => {
    const r = applyTerritoryTransfer(
      [
        { nationId: "atk", percent: 30 },
        { nationId: "def", percent: 50 },
        { nationId: "third", percent: 20 },
      ],
      "atk",
      "def",
      15,
    );
    assert.deepEqual(r, [
      { nationId: "atk", percent: 45 },
      { nationId: "def", percent: 35 },
      { nationId: "third", percent: 20 },
    ]);
    assert.equal(r.reduce((a, b) => a + b.percent, 0), 100);
  });

  test("移轉量以 loser 現有持分封頂；歸零列被移除", () => {
    const r = applyTerritoryTransfer(
      [
        { nationId: "atk", percent: 60 },
        { nationId: "def", percent: 10 },
      ],
      "atk",
      "def",
      40,
    );
    assert.deepEqual(r, [{ nationId: "atk", percent: 70 }]);
  });

  test("gainer 原本沒有持分時新增一列", () => {
    const r = applyTerritoryTransfer(
      [{ nationId: "def", percent: 100 }],
      "atk",
      "def",
      25,
    );
    assert.deepEqual(
      r.sort((a, b) => a.nationId.localeCompare(b.nationId)),
      [
        { nationId: "atk", percent: 25 },
        { nationId: "def", percent: 75 },
      ],
    );
  });

  test("loser 無持分或 pct ≤ 0 → 原樣（深拷貝）", () => {
    const input = [{ nationId: "atk", percent: 40 }];
    const r = applyTerritoryTransfer(input, "atk", "def", 10);
    assert.deepEqual(r, input);
    assert.notEqual(r[0], input[0]);
    assert.deepEqual(applyTerritoryTransfer(input, "atk", "def", 0), input);
  });
});

describe("capTransferForCity", () => {
  const liveCity: WarCityState = {
    cities: [makeWarCity({ cityId: 1, name: "羅馬", tier: "stone" })],
    garrisoned: false,
  };
  const fallenCity: WarCityState = {
    cities: [{ ...makeWarCity({ cityId: 1, name: "羅馬", tier: "stone" }), durability: 0 }],
    garrisoned: false,
  };

  test("無城市或城市已陷落 → 不設限（原請求量，向下取整、非負）", () => {
    assert.equal(capTransferForCity(30, 30, null), 30);
    assert.equal(capTransferForCity(30, 30, fallenCity), 30);
    assert.equal(capTransferForCity(7.9, 30, null), 7);
    assert.equal(capTransferForCity(-5, 30, null), 0);
  });

  test("城市未陷落 → 守方至少保留 1%（轉移量封頂 loserPct−1）", () => {
    assert.equal(capTransferForCity(100, 100, liveCity), 99);
    assert.equal(capTransferForCity(30, 30, liveCity), 29);
    assert.equal(capTransferForCity(10, 30, liveCity), 10);
  });

  test("城市未陷落且守方僅剩 1%（或 0）→ 完全禁止轉移", () => {
    assert.equal(capTransferForCity(50, 1, liveCity), 0);
    assert.equal(capTransferForCity(50, 0, liveCity), 0);
  });

  test("與 applyTerritoryTransfer 合用：城市未陷落時守方不會被清零", () => {
    const controls = [
      { nationId: "atk", percent: 40 },
      { nationId: "def", percent: 60 },
    ];
    const amount = capTransferForCity(60, 60, liveCity);
    const next = applyTerritoryTransfer(controls, "atk", "def", amount);
    const def = next.find((c) => c.nationId === "def");
    assert.ok(def && def.percent >= 1);
    const total = next.reduce((s, c) => s + c.percent, 0);
    assert.equal(total, 100);
  });

  test("城市當週期陷落（holdoutPct 0）→ 可全取", () => {
    const controls = [
      { nationId: "atk", percent: 40 },
      { nationId: "def", percent: 60 },
    ];
    const amount = capTransferForCity(60, 60, fallenCity);
    const next = applyTerritoryTransfer(controls, "atk", "def", amount);
    assert.equal(next.find((c) => c.nationId === "def"), undefined);
    assert.equal(next.find((c) => c.nationId === "atk")?.percent, 100);
  });
});

describe("determineCampaignOutcome", () => {
  const base = {
    attackerPctAtkRegion: 50,
    attackerPctDefRegion: 0,
    defenderPctAtkRegion: 0,
    defenderPctDefRegion: 40,
    attackerCityState: null,
    defenderCityState: null,
  };

  test("未分勝負 → null", () => {
    assert.equal(determineCampaignOutcome(base), null);
  });

  test("防守方兩區歸零且無城市 → 攻擊方勝", () => {
    assert.equal(
      determineCampaignOutcome({ ...base, defenderPctDefRegion: 0 }),
      "attacker",
    );
  });

  test("防守方歸零但城市未陷落 → 尚未結束", () => {
    const standingCity: WarCity = makeWarCity({
      cityId: 1,
      name: "某城",
      tier: "stone",
    });
    const city: WarCityState = {
      cities: [standingCity],
      garrisoned: true,
    };
    assert.equal(
      determineCampaignOutcome({
        ...base,
        defenderPctDefRegion: 0,
        defenderCityState: city,
      }),
      null,
    );
    assert.equal(
      determineCampaignOutcome({
        ...base,
        defenderPctDefRegion: 0,
        defenderCityState: {
          ...city,
          cities: [{ ...standingCity, durability: 0 }],
        },
      }),
      "attacker",
    );
  });

  test("攻擊方兩區歸零（含城市陷落）→ 防守方勝", () => {
    assert.equal(
      determineCampaignOutcome({
        ...base,
        attackerPctAtkRegion: 0,
        defenderPctDefRegion: 40,
      }),
      "defender",
    );
  });
});

describe("reconLevelFromOrders", () => {
  test("最近 3 週期內的偵查次數，封頂 3", () => {
    assert.equal(reconLevelFromOrders([], 5), 0);
    assert.equal(reconLevelFromOrders([5], 5), 1);
    assert.equal(reconLevelFromOrders([3, 4, 5], 5), 3);
    assert.equal(reconLevelFromOrders([2, 3, 4, 5], 5), 3);
    assert.equal(reconLevelFromOrders([1, 2], 5), 0);
  });
});

describe("fuzzValue", () => {
  test("同 seed 確定性；不同 seed 通常不同", () => {
    assert.equal(fuzzValue(1000, 0, "s1"), fuzzValue(1000, 0, "s1"));
  });

  test("誤差界限隨偵查等級收窄", () => {
    for (let i = 0; i < 20; i++) {
      const seed = `seed-${i}`;
      const l0 = fuzzValue(1000, 0, seed);
      const l3 = fuzzValue(1000, 3, seed);
      assert.ok(l0 >= 500 && l0 <= 1500, `l0=${l0}`);
      assert.ok(l3 >= 950 && l3 <= 1050, `l3=${l3}`);
    }
  });

  test("0 或負值 → 0；等級夾 0–3", () => {
    assert.equal(fuzzValue(0, 2, "x"), 0);
    assert.equal(fuzzValue(-5, 2, "x"), 0);
    assert.equal(fuzzValue(100, 99, "x"), fuzzValue(100, 3, "x"));
  });
});

describe("initialCityState / clamp100", () => {
  test("有城市 → 逐城滿耐久未駐守；無城市 → null", () => {
    assert.deepEqual(
      initialCityState([
        { cityId: 1, name: "甲城", tier: "wood" },
        { cityId: 2, name: "乙城", tier: "stone" },
      ]),
      {
        cities: [
          makeWarCity({ cityId: 1, name: "甲城", tier: "wood" }),
          makeWarCity({ cityId: 2, name: "乙城", tier: "stone" }),
        ],
        garrisoned: false,
      },
    );
    assert.equal(initialCityState([]), null);
  });

  test("clamp100 夾取並四捨五入", () => {
    assert.equal(clamp100(-5), 0);
    assert.equal(clamp100(150), 100);
    assert.equal(clamp100(49.6), 50);
  });
});

describe("戰力與確定性傷亡", () => {
  const mkSide = (
    quantity: number,
    attack: number,
    defense: number,
    hp: number,
    overrides: Partial<SidePowerInput> = {},
  ): SidePowerInput => ({
    legions: [
      {
        morale: 100,
        supply: 100,
        garrisoning: false,
        aggressionPct: 50,
        units: [{ quantity, attack, defense, hp }],
      },
    ],
    attackModifierPct: 0,
    wallDefenseBonusPct: 0,
    ...overrides,
  });

  test("combatConditionFactor：滿狀態=1；無補給無士氣只剩約 5%，永不為 0", () => {
    assert.equal(combatConditionFactor(100, 100), 1);
    const worst = combatConditionFactor(0, 0);
    assert.ok(worst > 0 && worst < 0.1, `最差狀態應低於 10%，實際 ${worst}`);
    assert.ok(combatConditionFactor(50, 50) > worst);
    assert.ok(combatConditionFactor(50, 50) < 1);
  });

  test("Task #584 — coupAdjustedMorale：扣減夾 ≥0，penalty ≤ 0 原值返回", () => {
    assert.equal(coupAdjustedMorale(80, 30), 50);
    assert.equal(coupAdjustedMorale(20, 30), 0);
    assert.equal(coupAdjustedMorale(80, 0), 80);
    assert.equal(coupAdjustedMorale(80, -10), 80);
  });

  test("computeEffectivePower：積極度與攻擊修正只影響進攻力", () => {
    const base = computeEffectivePower(mkSide(100, 10, 5, 5));
    assert.equal(base.troops, 100);
    // 進攻力＝100×10×(1×1×(0.5+0.5×0.5))=100×10×0.75=750
    assert.equal(Math.round(base.offense), 750);
    // 防禦力＝100×(5+5)×1=1000
    assert.equal(Math.round(base.defense), 1000);

    const aggressive = computeEffectivePower(
      mkSide(100, 10, 5, 5, {
        legions: [
          {
            morale: 100,
            supply: 100,
            garrisoning: false,
            aggressionPct: 100,
            units: [{ quantity: 100, attack: 10, defense: 5, hp: 5 }],
          },
        ],
      }),
    );
    assert.ok(aggressive.offense > base.offense);
    assert.equal(Math.round(aggressive.defense), 1000);
  });

  test("computeEffectivePower：城牆加成只惠及駐守軍團防禦", () => {
    const garrison = computeEffectivePower(
      mkSide(100, 10, 5, 5, {
        legions: [
          {
            morale: 100,
            supply: 100,
            garrisoning: true,
            aggressionPct: 50,
            units: [{ quantity: 100, attack: 10, defense: 5, hp: 5 }],
          },
        ],
        wallDefenseBonusPct: 50,
      }),
    );
    // 防禦力＝1000×1.5=1500；進攻力不受城牆影響
    assert.equal(Math.round(garrison.defense), 1500);
    assert.equal(Math.round(garrison.offense), 750);
  });

  test("勢均力敵：低傷亡消耗戰（≈基礎率）", () => {
    const side = mkSide(1000, 10, 5, 5);
    const power = computeEffectivePower(side);
    const cas = computeCycleCasualties({ attacker: power, defender: power });
    // 對稱→dominance≈0→rate≈基礎率
    assert.equal(cas.attackerCasualties, cas.defenderCasualties);
    const expected = Math.round(CASUALTY_BASELINE_RATE * 1000);
    assert.ok(Math.abs(cas.defenderCasualties - expected) <= 1);
  });

  test("弱方無法造成不成比例的傷亡（硬上限）", () => {
    const weak = computeEffectivePower(mkSide(100, 5, 3, 3));
    const strong = computeEffectivePower(mkSide(10000, 20, 10, 10));
    const cas = computeCycleCasualties({ attacker: weak, defender: strong });
    // 弱方（attacker）對強方（defender）造成的傷亡受弱方進攻力硬上限約束
    assert.ok(cas.defenderCasualties <= cas.defenderCasualtyCap);
    // 相對於強方兵力，傷亡比例應極小
    assert.ok(cas.defenderCasualties / strong.troops < 0.02);
    // 強方對弱方傷亡顯著（但不超過弱方現有兵力）
    assert.ok(cas.attackerCasualties > cas.defenderCasualties);
    assert.ok(cas.attackerCasualties <= weak.troops);
  });

  test("傷亡永不超過受害方現有兵力", () => {
    const tiny = computeEffectivePower(mkSide(5, 5, 1, 1));
    const huge = computeEffectivePower(mkSide(100000, 50, 30, 30));
    const cas = computeCycleCasualties({ attacker: huge, defender: tiny });
    assert.ok(cas.defenderCasualties <= 5);
  });

  test("空軍不承受也不造成傷亡", () => {
    const empty = computeEffectivePower(mkSide(0, 0, 0, 0));
    const army = computeEffectivePower(mkSide(1000, 10, 5, 5));
    const cas = computeCycleCasualties({ attacker: army, defender: empty });
    assert.equal(cas.defenderCasualties, 0);
    assert.equal(cas.attackerCasualties, 0);
  });

  test("防守方反攻：攻擊方越弱反攻越猛", () => {
    const weakAttacker = computeEffectivePower(mkSide(100, 5, 3, 3));
    const strongDefender = computeEffectivePower(mkSide(5000, 20, 10, 10));
    const counter = computeCounterattack({
      attacker: weakAttacker,
      defender: strongDefender,
    });
    assert.ok(counter.intensity > 0);
    assert.ok(counter.extraAttackerCasualties > 0);
    assert.ok(counter.territoryPushbackPct > 0);
    assert.ok(counter.territoryPushbackPct <= COUNTERATTACK_MAX_TERRITORY_PCT);
    // 額外傷亡不超過攻擊方現有兵力
    assert.ok(counter.extraAttackerCasualties <= weakAttacker.troops);
  });

  test("防守方反攻：攻擊方佔優時幾無反攻", () => {
    const strongAttacker = computeEffectivePower(mkSide(5000, 20, 10, 10));
    const weakDefender = computeEffectivePower(mkSide(100, 5, 3, 3));
    const counter = computeCounterattack({
      attacker: strongAttacker,
      defender: weakDefender,
    });
    assert.equal(counter.intensity, 0);
    assert.equal(counter.extraAttackerCasualties, 0);
    assert.equal(counter.territoryPushbackPct, 0);
  });

  test("反攻：任一方無兵力則無反攻", () => {
    const army = computeEffectivePower(mkSide(1000, 10, 5, 5));
    const empty = computeEffectivePower(mkSide(0, 0, 0, 0));
    assert.equal(
      computeCounterattack({ attacker: empty, defender: army })
        .extraAttackerCasualties,
      0,
    );
    assert.equal(
      computeCounterattack({ attacker: army, defender: empty })
        .territoryPushbackPct,
      0,
    );
  });

  test("勢均力敵：不強制推進（維持膠著）", () => {
    const side = computeEffectivePower(mkSide(1000, 10, 5, 5));
    assert.equal(
      computeForceRatioTerritoryShift({ attacker: side, defender: side }),
      0,
    );
  });

  test("守軍被殲滅：逼近單週期推進上限", () => {
    const army = computeEffectivePower(mkSide(10000, 20, 10, 10));
    const wiped = computeEffectivePower(mkSide(0, 0, 0, 0));
    const shift = computeForceRatioTerritoryShift({
      attacker: army,
      defender: wiped,
    });
    assert.equal(shift, TERRITORY_CAPTURE_BASE_DEFAULT_PCT);
  });

  test("攻擊方明顯佔優：正向推進且在上限內", () => {
    const strong = computeEffectivePower(mkSide(3000, 15, 8, 8));
    const weak = computeEffectivePower(mkSide(1000, 15, 8, 8));
    const shift = computeForceRatioTerritoryShift({
      attacker: strong,
      defender: weak,
    });
    assert.ok(shift > 0);
    assert.ok(shift <= TERRITORY_CAPTURE_BASE_DEFAULT_PCT);
  });

  test("攻擊方居於劣勢：不強制推進（交由 AI／反攻處理）", () => {
    const weak = computeEffectivePower(mkSide(1000, 10, 5, 5));
    const strong = computeEffectivePower(mkSide(5000, 20, 10, 10));
    assert.equal(
      computeForceRatioTerritoryShift({ attacker: weak, defender: strong }),
      0,
    );
  });

  test("攻擊方無兵力：不推進", () => {
    const empty = computeEffectivePower(mkSide(0, 0, 0, 0));
    const army = computeEffectivePower(mkSide(1000, 10, 5, 5));
    assert.equal(
      computeForceRatioTerritoryShift({ attacker: empty, defender: army }),
      0,
    );
  });

  test("越懸殊推進越大（單調遞增）", () => {
    const base = mkSide(1000, 15, 8, 8);
    const defender = computeEffectivePower(base);
    const shift2x = computeForceRatioTerritoryShift({
      attacker: computeEffectivePower(mkSide(2000, 15, 8, 8)),
      defender,
    });
    const shift8x = computeForceRatioTerritoryShift({
      attacker: computeEffectivePower(mkSide(8000, 15, 8, 8)),
      defender,
    });
    assert.ok(shift8x >= shift2x);
    assert.ok(shift8x > 0);
  });
});

describe("Task #578 — computeMopUpShift 確定性掃蕩", () => {
  const mkSide = (
    quantity: number,
    attack: number,
    defense: number,
    hp: number,
  ): SidePowerInput => ({
    legions: [
      {
        morale: 100,
        supply: 100,
        garrisoning: false,
        aggressionPct: 50,
        units: [{ quantity, attack, defense, hp }],
      },
    ],
    attackModifierPct: 0,
    wallDefenseBonusPct: 0,
  });
  const strong = () => computeEffectivePower(mkSide(10000, 20, 10, 10));
  const weak = () => computeEffectivePower(mkSide(100, 5, 3, 3));
  const baseInput = () => ({
    winner: strong(),
    loser: weak(),
    loserPctMainRegion: 0,
    loserMainRegionCityFallen: true,
    loserPctOtherRegion: 2,
  });

  test("條件全部成立：掃蕩量 > 0 且不超過 basePct 封頂", () => {
    const shift = computeMopUpShift(baseInput());
    assert.ok(shift >= 1);
    assert.ok(shift <= TERRITORY_CAPTURE_BASE_DEFAULT_PCT);
    // 與確定性推進管線一致（壓倒優勢 → 同 computeForceRatioTerritoryShift）。
    assert.equal(
      shift,
      computeForceRatioTerritoryShift({ attacker: strong(), defender: weak() }),
    );
  });

  test("敗方主戰場仍有持分：不掃蕩", () => {
    assert.equal(
      computeMopUpShift({ ...baseInput(), loserPctMainRegion: 1 }),
      0,
    );
  });

  test("敗方主戰場城市未陷落：不掃蕩（城市保底不可繞過）", () => {
    assert.equal(
      computeMopUpShift({ ...baseInput(), loserMainRegionCityFallen: false }),
      0,
    );
  });

  test("敗方另一區無殘餘持分：不掃蕩", () => {
    assert.equal(
      computeMopUpShift({ ...baseInput(), loserPctOtherRegion: 0 }),
      0,
    );
  });

  test("勝方無兵力：不掃蕩", () => {
    assert.equal(
      computeMopUpShift({
        ...baseInput(),
        winner: computeEffectivePower(mkSide(0, 0, 0, 0)),
      }),
      0,
    );
  });

  test("勢均力敵仍至少推進 1 點（保證收斂、不永久僵持）", () => {
    const even = computeEffectivePower(mkSide(1000, 10, 5, 5));
    // force-ratio 在 dominance ≤ 0.5 時為 0，掃蕩下限仍為 1。
    assert.equal(
      computeForceRatioTerritoryShift({ attacker: even, defender: even }),
      0,
    );
    assert.equal(
      computeMopUpShift({
        ...baseInput(),
        winner: even,
        loser: computeEffectivePower(mkSide(1000, 10, 5, 5)),
      }),
      1,
    );
  });

  test("basePct 封頂沿用確定性推進管線", () => {
    const shift = computeMopUpShift({
      ...baseInput(),
      winner: strong(),
      loser: computeEffectivePower(mkSide(0, 0, 0, 0)),
      basePct: 5,
    });
    assert.equal(shift, 5);
  });
});

describe("Task #412 — 全域戰爭參數", () => {
  const mkSide = (
    quantity: number,
    attack: number,
    defense: number,
    hp: number,
  ): SidePowerInput => ({
    legions: [
      {
        morale: 100,
        supply: 100,
        garrisoning: false,
        aggressionPct: 50,
        units: [{ quantity, attack, defense, hp }],
      },
    ],
    attackModifierPct: 0,
    wallDefenseBonusPct: 0,
  });

  test("clampWarIntensityPct：無效值回預設、越界收斂", () => {
    assert.equal(clampWarIntensityPct(undefined), WAR_INTENSITY_DEFAULT_PCT);
    assert.equal(clampWarIntensityPct(null), WAR_INTENSITY_DEFAULT_PCT);
    assert.equal(clampWarIntensityPct(Number.NaN), WAR_INTENSITY_DEFAULT_PCT);
    assert.equal(clampWarIntensityPct(0), WAR_INTENSITY_MIN_PCT);
    assert.equal(clampWarIntensityPct(9999), WAR_INTENSITY_MAX_PCT);
    assert.equal(clampWarIntensityPct(250), 250);
  });

  test("clampTerritoryCaptureBasePct：無效值回預設、越界收斂", () => {
    assert.equal(
      clampTerritoryCaptureBasePct(undefined),
      TERRITORY_CAPTURE_BASE_DEFAULT_PCT,
    );
    assert.equal(clampTerritoryCaptureBasePct(0), TERRITORY_CAPTURE_BASE_MIN_PCT);
    assert.equal(
      clampTerritoryCaptureBasePct(100),
      TERRITORY_CAPTURE_BASE_MAX_PCT,
    );
    assert.equal(clampTerritoryCaptureBasePct(7), 7);
  });

  test("areaCaptureSpeedFactor：大地區慢、小地區快、未知面積中性 1", () => {
    assert.equal(areaCaptureSpeedFactor(null), 1);
    assert.equal(areaCaptureSpeedFactor(undefined as unknown as null), 1);
    assert.equal(areaCaptureSpeedFactor(0), 1);
    assert.equal(areaCaptureSpeedFactor(-5), 1);
    // 基準面積 150000 → 係數 1
    assert.ok(Math.abs(areaCaptureSpeedFactor(150_000) - 1) < 1e-9);
    const big = areaCaptureSpeedFactor(2_000_000);
    const small = areaCaptureSpeedFactor(10_000);
    assert.ok(big < 1);
    assert.ok(small > 1);
    // 極端值仍收斂在 0.35–2.5
    assert.ok(areaCaptureSpeedFactor(100_000_000) >= 0.35);
    assert.ok(areaCaptureSpeedFactor(1) <= 2.5);
  });

  test("scaleTerritoryShift：0 保持 0、非零保底幅度 1、方向不變", () => {
    assert.equal(scaleTerritoryShift(0, 0.5), 0);
    assert.equal(scaleTerritoryShift(2, 0.1), 1); // 最小幅度 1
    assert.equal(scaleTerritoryShift(-2, 0.1), -1);
    assert.equal(scaleTerritoryShift(10, 0.5), 5);
    assert.equal(scaleTerritoryShift(10, 2), 20);
  });

  test("battleScaleFactor：規模越大越高、有封頂 2", () => {
    const small = battleScaleFactor(1_000);
    const ref = battleScaleFactor(100_000);
    const mid = battleScaleFactor(1_000_000);
    const huge = battleScaleFactor(100_000_000);
    assert.equal(small, 1); // 基準以下一律 1（不懲罰小規模戰鬥）
    assert.equal(ref, 1);
    assert.ok(mid > 1 && mid < huge); // 超過基準後單調遞增
    assert.ok(huge <= 2); // 封頂 2
    assert.equal(battleScaleFactor(0), 1);
  });

  test("intensityPct 放大傷亡但硬上限不變", () => {
    const power = computeEffectivePower(mkSide(1000, 10, 5, 5));
    const base = computeCycleCasualties({ attacker: power, defender: power });
    const hot = computeCycleCasualties({
      attacker: power,
      defender: power,
      intensityPct: 300,
    });
    const cold = computeCycleCasualties({
      attacker: power,
      defender: power,
      intensityPct: 10,
    });
    assert.ok(hot.defenderCasualties > base.defenderCasualties);
    assert.ok(cold.defenderCasualties < base.defenderCasualties);
    assert.ok(hot.defenderCasualties <= power.troops);
    // 硬上限（受害方傷亡上限）不隨激烈度改變定義
    assert.ok(hot.defenderCasualties <= hot.defenderCasualtyCap);
  });

  test("intensityPct 放大反攻傷亡且不超過攻擊方兵力", () => {
    const weakAttacker = computeEffectivePower(mkSide(100, 5, 3, 3));
    const strongDefender = computeEffectivePower(mkSide(5000, 20, 10, 10));
    const base = computeCounterattack({
      attacker: weakAttacker,
      defender: strongDefender,
    });
    const hot = computeCounterattack({
      attacker: weakAttacker,
      defender: strongDefender,
      intensityPct: 500,
    });
    assert.ok(hot.extraAttackerCasualties >= base.extraAttackerCasualties);
    assert.ok(hot.extraAttackerCasualties <= weakAttacker.troops);
  });

  test("computeForceRatioTerritoryShift：basePct 縮放且不超過 basePct", () => {
    const army = computeEffectivePower(mkSide(10000, 20, 10, 10));
    const wiped = computeEffectivePower(mkSide(0, 0, 0, 0));
    const low = computeForceRatioTerritoryShift({
      attacker: army,
      defender: wiped,
      basePct: 5,
    });
    const high = computeForceRatioTerritoryShift({
      attacker: army,
      defender: wiped,
      basePct: 30,
    });
    assert.ok(low <= 5);
    assert.ok(high <= 30);
    assert.ok(high > low);
  });
});

// ── Task #453 — 多國勝方領土分配比例正規化 ────────────────────

describe("normalizeSplitWeights", () => {
  const names = ["甲國", "乙國"] as const;
  const fallback = [300, 100] as const; // 戰力比 3:1

  test("AI 給合法比例 → 依名稱對應回傳權重", () => {
    const w = normalizeSplitWeights(
      [
        { nationName: "乙國", weightPct: 40 },
        { nationName: "甲國", weightPct: 60 },
      ],
      names,
      fallback,
    );
    assert.deepEqual(w, [60, 40]);
  });

  test("AI 重複列同一國 → 權重加總", () => {
    const w = normalizeSplitWeights(
      [
        { nationName: "甲國", weightPct: 30 },
        { nationName: "甲國", weightPct: 20 },
        { nationName: "乙國", weightPct: 50 },
      ],
      names,
      fallback,
    );
    assert.deepEqual(w, [50, 50]);
  });

  test("AI 缺國家 → fallback 戰力比例", () => {
    const w = normalizeSplitWeights(
      [{ nationName: "甲國", weightPct: 100 }],
      names,
      fallback,
    );
    assert.deepEqual(w, [300, 100]);
  });

  test("AI 給負值或非有限數 → fallback", () => {
    assert.deepEqual(
      normalizeSplitWeights(
        [
          { nationName: "甲國", weightPct: -10 },
          { nationName: "乙國", weightPct: 110 },
        ],
        names,
        fallback,
      ),
      [300, 100],
    );
    assert.deepEqual(
      normalizeSplitWeights(
        [
          { nationName: "甲國", weightPct: Number.NaN },
          { nationName: "乙國", weightPct: 50 },
        ],
        names,
        fallback,
      ),
      [300, 100],
    );
  });

  test("AI 全零 → fallback；未提供 aiSplit → fallback", () => {
    assert.deepEqual(
      normalizeSplitWeights(
        [
          { nationName: "甲國", weightPct: 0 },
          { nationName: "乙國", weightPct: 0 },
        ],
        names,
        fallback,
      ),
      [300, 100],
    );
    assert.deepEqual(normalizeSplitWeights(undefined, names, fallback), [
      300, 100,
    ]);
  });

  test("fallback 也全零 → 均分權重 1", () => {
    const w = normalizeSplitWeights(undefined, names, [0, 0]);
    assert.deepEqual(w, [1, 1]);
  });

  test("單一國家（非多國戰役）→ 該國拿全部", () => {
    const w = normalizeSplitWeights(undefined, ["甲國"], [123]);
    assert.deepEqual(w, [123]);
  });

  test("空名單 → 空陣列", () => {
    assert.deepEqual(normalizeSplitWeights(undefined, [], []), []);
  });

  test("與 allocateProportionally 組合：總量守恆", () => {
    const weights = normalizeSplitWeights(
      [
        { nationName: "甲國", weightPct: 70 },
        { nationName: "乙國", weightPct: 30 },
      ],
      names,
      fallback,
    );
    const alloc = allocateProportionally(weights, 10);
    assert.equal(alloc.reduce((a, b) => a + b, 0), 10);
    assert.ok(alloc[0]! >= alloc[1]!);
  });
});

// ── Task #625 — 確定性純函式（applyTacticalBonus / computeTerritoryShift / computeSiegeIntensity / computeLocalPopulationLossPct）────

describe("applyTacticalBonus", () => {
  test("中性局面（neutral、無加成、零士氣）→ 原始積極度不變", () => {
    assert.equal(applyTacticalBonus(50, "neutral", 0, 0), 50);
    assert.equal(applyTacticalBonus(80, "neutral", 0, 0), 80);
  });

  test("攻方有戰術優勢（side=attacker）→ 加分；防方視角 → 扣分", () => {
    const bonus = applyTacticalBonus(50, "attacker", 10, 0, "attacker");
    assert.equal(bonus, 60);
    const penalty = applyTacticalBonus(50, "attacker", 10, 0, "defender");
    assert.equal(penalty, 40);
  });

  test("防方有戰術優勢（side=defender）→ 對攻方扣分", () => {
    const atkView = applyTacticalBonus(50, "defender", 15, 0, "attacker");
    assert.equal(atkView, 35);
    const defView = applyTacticalBonus(50, "defender", 15, 0, "defender");
    assert.equal(defView, 65);
  });

  test("士氣加成疊加", () => {
    assert.equal(applyTacticalBonus(50, "neutral", 0, 8), 58);
    assert.equal(applyTacticalBonus(50, "neutral", 0, -8), 42);
  });

  test("結果夾限 0–100", () => {
    assert.equal(applyTacticalBonus(100, "attacker", 15, 10, "attacker"), 100);
    assert.equal(applyTacticalBonus(0, "attacker", 15, 0, "defender"), 0);
  });
});

describe("computeTerritoryShift", () => {
  test("積極度 50（中性）→ 推進量為 0（與 scaleFactor 無關）", () => {
    assert.equal(computeTerritoryShift(50, "neutral", 0, 0, 1, "attacker"), 0);
    assert.equal(computeTerritoryShift(50, "neutral", 0, 0, 2, "attacker"), 0);
  });

  test("積極度 100（全力進攻）→ scaleFactor=1 時推進 +15", () => {
    assert.equal(computeTerritoryShift(100, "neutral", 0, 0, 1, "attacker"), 15);
  });

  test("積極度 0（完全消極）→ scaleFactor=1 時推進 −15", () => {
    assert.equal(computeTerritoryShift(0, "neutral", 0, 0, 1, "attacker"), -15);
  });

  test("scaleFactor=0.5 縮小推進量（大地區）", () => {
    const full = computeTerritoryShift(100, "neutral", 0, 0, 1);
    const scaled = computeTerritoryShift(100, "neutral", 0, 0, 0.5);
    assert.ok(Math.abs(scaled) < Math.abs(full));
  });

  test("side=defender 時戰術優勢方向反轉", () => {
    // 攻方有戰術優勢，以攻方視角（side=attacker）加分
    const atkShift = computeTerritoryShift(50, "attacker", 15, 0, 1, "attacker");
    // 同樣是攻方優勢，以守方視角（side=defender）扣分
    const defShift = computeTerritoryShift(50, "attacker", 15, 0, 1, "defender");
    assert.ok(atkShift > 0, "攻方優勢下攻方視角應正向推進");
    assert.ok(defShift < 0, "攻方優勢下守方視角應負向（守方在攻方出發地無力反推）");
  });
});

describe("computeSiegeIntensity", () => {
  test("城市已陷落（holdoutPct=0）→ 強度為 0", () => {
    assert.equal(computeSiegeIntensity(100, 0, 20), 0);
    assert.equal(computeSiegeIntensity(50, 0, 0), 0);
  });

  test("城市完好（holdoutPct>0）→ 基礎強度 = aggressionPct + bonus，夾限 0–100", () => {
    assert.equal(computeSiegeIntensity(50, 100, 0), 50);
    assert.equal(computeSiegeIntensity(80, 100, 10), 90);
    assert.equal(computeSiegeIntensity(100, 100, 20), 100);
  });

  test("積極度為 0 → 強度 0（不攻城）", () => {
    assert.equal(computeSiegeIntensity(0, 100, 0), 0);
  });

  test("戰術加成使強度超過 100 時夾頂", () => {
    assert.equal(computeSiegeIntensity(90, 50, 20), 100);
  });

  test("僵持積極度（20）城市未陷落時仍回傳非零強度（applyCycleResult 必須用固定值 0 繞開而非呼叫此函式）", () => {
    // StalemateInput.aggressionPct = 20；直接代入時強度非零。
    // applyCycleResult 僵持路徑改用 result.attackerSiegeIntensityPct（= 0）繞開，
    // 確保城市在 AI 失敗回合不遭受圍城損耗——此測試為回歸保護。
    assert.ok(computeSiegeIntensity(20, 80, 0) > 0, "stalemate aggressionPct(20) with standing city yields non-zero intensity");
  });
});

describe("computeLocalPopulationLossPct", () => {
  test("積極度 50、中性、無加成 → 2.5%", () => {
    assert.equal(computeLocalPopulationLossPct(50, "neutral", 0, 0), 2.5);
  });

  test("積極度 100 → 最大 5%", () => {
    assert.equal(computeLocalPopulationLossPct(100, "neutral", 0, 0), 5);
  });

  test("積極度 0 → 0%", () => {
    assert.equal(computeLocalPopulationLossPct(0, "neutral", 0, 0), 0);
  });

  test("戰術優勢使有效積極度上升 → 損失率更高", () => {
    const base = computeLocalPopulationLossPct(50, "neutral", 0, 0);
    const boosted = computeLocalPopulationLossPct(50, "attacker", 15, 0, );
    assert.ok(boosted > base);
  });

  test("僵持積極度（20）仍回傳非零損耗（settle.ts 僵持路徑必須顯式歸零，不可代入此函式）", () => {
    // StalemateInput.aggressionPct = 20 → 若直接代入仍產生 ~1% 人口損失。
    // settle.ts 僵持路徑以 totalPopulationLoss = 0 繞開，
    // 維持 StalemateInput.localPopulationLossPct = 0 的語義——此測試為回歸保護。
    const stalemateLossPct = computeLocalPopulationLossPct(20, "neutral", 0, 0);
    assert.ok(stalemateLossPct > 0, `stalemate aggressionPct(20) yields ${stalemateLossPct}% > 0`);
  });
});

describe("detectAnachronisticUnits", () => {
  const makeUnit = (name: string, category: string, eraSlug?: string) => ({
    name,
    category,
    quantity: 100,
    wounded: 0,
    attack: 10,
    defense: 10,
    hp: 10,
    speed: 5,
    accuracy: 80,
    range: "melee" as const,
    antiCavalryPct: 0,
    antiRangedPct: 0,
    siegePct: 0,
    eraSlug,
  });

  test("eraSlug 缺失 → 不偵測（略過）", () => {
    const units = [makeUnit("古典步兵", "infantry")];
    const result = detectAnachronisticUnits("industrial", "attacker", units);
    assert.deepEqual(result, []);
  });

  test("落後 1 個時代 → 不視為過時（閾值 2）", () => {
    const units = [makeUnit("古典步兵", "infantry", "classical")];
    const result = detectAnachronisticUnits("roman", "attacker", units);
    assert.equal(result.length, 0);
  });

  test("落後 2 個時代 → 旗標過時，含正確 side 與理由", () => {
    const units = [makeUnit("古典步兵", "infantry", "classical")];
    const result = detectAnachronisticUnits("early_medieval", "defender", units);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.side, "defender");
    assert.ok(result[0]!.reason.length > 0);
    assert.equal(result[0]!.name, "古典步兵");
  });

  test("落後多個時代 → 每個兵種各自旗標", () => {
    const units = [
      makeUnit("古典弩手", "ranged", "classical"),
      makeUnit("工業步槍兵", "infantry", "industrial"),
    ];
    const result = detectAnachronisticUnits("future", "attacker", units);
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.side === "attacker"));
  });

  test("時代相同 → 不過時", () => {
    const units = [makeUnit("現代坦克", "armored", "modern")];
    const result = detectAnachronisticUnits("modern", "attacker", units);
    assert.equal(result.length, 0);
  });

  test("空兵種清單 → 空結果", () => {
    assert.deepEqual(detectAnachronisticUnits("early_medieval", "attacker", []), []);
  });
});



import { allocateLegionLosses } from "./war";

test("僱傭兵傷亡:有真實軍團時,損失全由真實軍團按兵力承擔", () => {
  const r = allocateLegionLosses(
    [
      { troops: 300, isMercenary: false },
      { troops: 5000, isMercenary: true },
      { troops: 100, isMercenary: false },
    ],
    40,
  );
  assert.equal(r[1], 0);
  assert.equal(r[0]! + r[2]!, 40);
  assert.ok(r[0]! > r[2]!);
});

test("僱傭兵傷亡:全靠僱傭兵(小國)時傷亡落空,不會被平均硬塞", () => {
  assert.deepEqual(
    allocateLegionLosses(
      [
        { troops: 800, isMercenary: true },
        { troops: 800, isMercenary: true },
      ],
      30,
    ),
    [0, 0],
  );
});

test("僱傭兵傷亡:真實軍團的損失不會超過自身兵力", () => {
  const r = allocateLegionLosses(
    [
      { troops: 10, isMercenary: false },
      { troops: 9999, isMercenary: true },
    ],
    500,
  );
  assert.deepEqual(r, [10, 0]);
});

test("僱傭兵傷亡:沒有軍團或傷亡為 0 時回全 0", () => {
  assert.deepEqual(allocateLegionLosses([], 10), []);
  assert.deepEqual(allocateLegionLosses([{ troops: 50, isMercenary: false }], 0), [0]);
});
