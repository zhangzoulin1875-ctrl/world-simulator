import test from "node:test";
import assert from "node:assert/strict";
import {
  clampNpcOfferToCaps,
  computeNpcTreatyCaps,
  DEFAULT_NPC_TREATY_CAP_SETTINGS,
  findNpcTreatyCapViolations,
  npcPaidFields,
  regionTransferCapPct,
  type NpcTreatyCaps,
  type NpcTreatyCapSnapshot,
} from "./npcTreatyCaps";

/**
 * Task #570 — NPC 締約資源上限純函式單元測試（不碰 DB）。
 * 涵蓋：存量為 0／比例為 0 的邊界、違規訊息（zh-TW 列出上限）、
 * NPC 主動提案 offer 側夾限（去重、超區截斷、掌控 0 剔除、百分比夾限）。
 */

const SNAPSHOT: NpcTreatyCapSnapshot = {
  money: 10_000,
  techPoints: 500,
  wood: 1_000,
  ore: 999,
  taxIncomePerTurn: 2_000,
  techPerTurn: 55,
  productionPerTurn: 12_345,
  foodPerTurn: 800,
  woodPerTurn: 120,
  orePerTurn: 60,
};

function capsOf(overrides: Partial<NpcTreatyCaps> = {}): NpcTreatyCaps {
  return {
    ...computeNpcTreatyCaps(SNAPSHOT, DEFAULT_NPC_TREATY_CAP_SETTINGS),
    ...overrides,
  };
}

test("computeNpcTreatyCaps：預設值下各上限 = floor(基準 × %)", () => {
  const caps = computeNpcTreatyCaps(SNAPSHOT, DEFAULT_NPC_TREATY_CAP_SETTINGS);
  assert.equal(caps.money, 2_000); // 10000 × 20%
  assert.equal(caps.techPoints, 100); // 500 × 20%
  assert.equal(caps.wood, 200); // 1000 × 20%
  assert.equal(caps.ore, 199); // floor(999 × 20%)
  assert.equal(caps.maxRegions, 3);
  assert.equal(caps.regionMaxPct, 50);
  assert.equal(caps.perTurnMoney, 200); // 2000 × 10%
  assert.equal(caps.perTurnTech, 5); // floor(55 × 10%)
  assert.equal(caps.perTurnProduction, 1_234); // floor(12345 × 10%)
  assert.equal(caps.perTurnFood, 80);
  assert.equal(caps.perTurnWood, 12);
  assert.equal(caps.perTurnOre, 6);
});

test("computeNpcTreatyCaps：存量 0 → 上限 0；比例 0 → 全部 0", () => {
  const zeroStock = computeNpcTreatyCaps(
    { ...SNAPSHOT, money: 0, techPoints: 0, wood: 0, ore: 0 },
    DEFAULT_NPC_TREATY_CAP_SETTINGS,
  );
  assert.equal(zeroStock.money, 0);
  assert.equal(zeroStock.techPoints, 0);
  assert.equal(zeroStock.wood, 0);
  assert.equal(zeroStock.ore, 0);

  const zeroPct = computeNpcTreatyCaps(SNAPSHOT, {
    stockCapPct: 0,
    maxRegions: 0,
    regionMaxPct: 0,
    perTurnCapPct: 0,
  });
  assert.equal(zeroPct.money, 0);
  assert.equal(zeroPct.maxRegions, 0);
  assert.equal(zeroPct.regionMaxPct, 0);
  assert.equal(zeroPct.perTurnMoney, 0);
  assert.equal(zeroPct.perTurnOre, 0);
});

test("computeNpcTreatyCaps：異常輸入（負值／NaN／>100%）夾回合法範圍", () => {
  const caps = computeNpcTreatyCaps(
    { ...SNAPSHOT, money: -500, techPoints: Number.NaN },
    { stockCapPct: 250, maxRegions: 5.9, regionMaxPct: -10, perTurnCapPct: Number.NaN },
  );
  assert.equal(caps.money, 0); // 負庫存視為 0
  assert.equal(caps.techPoints, 0); // NaN 視為 0
  assert.equal(caps.wood, 1_000); // 250% 夾成 100%
  assert.equal(caps.maxRegions, 5); // trunc
  assert.equal(caps.regionMaxPct, 0); // 負值夾 0
  assert.equal(caps.perTurnMoney, 0); // NaN% → 0
});

test("regionTransferCapPct：掌控 0 或比例 0 → 0；一般情況 floor(掌控 × %)", () => {
  assert.equal(regionTransferCapPct(0, 50), 0);
  assert.equal(regionTransferCapPct(80, 0), 0);
  assert.equal(regionTransferCapPct(80, 50), 40);
  assert.equal(regionTransferCapPct(33, 50), 16); // floor(16.5)
  assert.equal(regionTransferCapPct(150, 50), 50); // 掌控超過 100 先夾 100
});

test("findNpcTreatyCapViolations：全部在上限內 → 空陣列", () => {
  const caps = capsOf();
  const violations = findNpcTreatyCapViolations(
    npcPaidFields({
      money: caps.money,
      techPoints: caps.techPoints,
      regions: [
        { regionId: 1, transferPercent: 40, heldPercent: 80 },
        { regionId: 2, transferPercent: 10, heldPercent: 20 },
      ],
      perTurnMoney: caps.perTurnMoney,
    }),
    caps,
  );
  assert.deepEqual(violations, []);
});

test("findNpcTreatyCapViolations：各類超限都回報 zh-TW 訊息並列出上限", () => {
  const caps = capsOf();
  const violations = findNpcTreatyCapViolations(
    npcPaidFields({
      money: caps.money + 1,
      wood: caps.wood + 100,
      regions: [
        { regionId: 1, regionName: "測試區", transferPercent: 41, heldPercent: 80 },
        { regionId: 2, transferPercent: 5, heldPercent: 10 },
        { regionId: 3, transferPercent: 5, heldPercent: 10 },
        { regionId: 4, transferPercent: 5, heldPercent: 10 },
      ],
      perTurnFood: caps.perTurnFood + 1,
    }),
    caps,
  );
  assert.equal(violations.length, 5);
  assert.ok(violations.some((v) => v.includes("金錢") && v.includes(`上限 ${caps.money}`)));
  assert.ok(violations.some((v) => v.includes("木材") && v.includes(`上限 ${caps.wood}`)));
  assert.ok(
    violations.some((v) => v.includes("4 個地區") && v.includes(`上限 ${caps.maxRegions} 區`)),
  );
  assert.ok(violations.some((v) => v.includes("「測試區」") && v.includes("41%")));
  assert.ok(violations.some((v) => v.includes("每回合糧食")));
});

test("findNpcTreatyCapViolations：掌控 0 的地區要求任何轉移都是違規", () => {
  const caps = capsOf();
  const violations = findNpcTreatyCapViolations(
    npcPaidFields({
      regions: [{ regionId: 9, transferPercent: 1, heldPercent: 0 }],
    }),
    caps,
  );
  assert.equal(violations.length, 1);
  assert.ok(violations[0]!.includes("#9"));
  assert.ok(violations[0]!.includes("上限 0%"));
});

test("clampNpcOfferToCaps：金錢／科技點夾到上限、負值夾 0", () => {
  const caps = capsOf();
  const held = new Map<number, number>();
  const clamped = clampNpcOfferToCaps(
    {
      offerMoney: caps.money + 999,
      offerTechPoints: -5,
      offerRegionIds: [],
      offerRegionPercents: {},
    },
    held,
    caps,
  );
  assert.equal(clamped.offerMoney, caps.money);
  assert.equal(clamped.offerTechPoints, 0);
  assert.equal(clamped.clamped, true);
});

test("clampNpcOfferToCaps：完全在上限內 → 原樣保留、clamped=false", () => {
  const caps = capsOf();
  const held = new Map<number, number>([[7, 60]]);
  const clamped = clampNpcOfferToCaps(
    {
      offerMoney: 100,
      offerTechPoints: 10,
      offerRegionIds: [7],
      offerRegionPercents: { "7": 20 },
    },
    held,
    caps,
  );
  assert.equal(clamped.offerMoney, 100);
  assert.equal(clamped.offerTechPoints, 10);
  assert.deepEqual(clamped.offerRegionIds, [7]);
  assert.deepEqual(clamped.offerRegionPercents, { "7": 20 });
  assert.equal(clamped.clamped, false);
});

test("clampNpcOfferToCaps：地區去重、掌控 0 剔除、超過 maxRegions 截斷", () => {
  const caps = capsOf({ maxRegions: 2 });
  const held = new Map<number, number>([
    [1, 80],
    [2, 0],
    [3, 40],
    [4, 40],
  ]);
  const clamped = clampNpcOfferToCaps(
    {
      offerMoney: 0,
      offerTechPoints: 0,
      offerRegionIds: [1, 1, 2, 3, 4],
      offerRegionPercents: {},
    },
    held,
    caps,
  );
  // 1 去重、2 掌控 0 剔除、1 與 3 保留、4 超過 maxRegions=2 截斷。
  assert.deepEqual(clamped.offerRegionIds, [1, 3]);
  // 缺項百分比＝整份掌控 → 夾到 regionTransferCapPct（80×50%=40、40×50%=20）。
  assert.deepEqual(clamped.offerRegionPercents, { "1": 40, "3": 20 });
  assert.equal(clamped.clamped, true);
});

test("clampNpcOfferToCaps：百分比夾限（trunc、最低 1、上限 regionTransferCapPct）", () => {
  const caps = capsOf();
  const held = new Map<number, number>([
    [1, 80],
    [2, 10],
  ]);
  const clamped = clampNpcOfferToCaps(
    {
      offerMoney: 0,
      offerTechPoints: 0,
      offerRegionIds: [1, 2],
      offerRegionPercents: { "1": 55.9, "2": 0.4 },
    },
    held,
    caps,
  );
  // 區1：trunc(55.9)=55 > cap 40 → 40；區2：trunc(0.4)=0 → 最低 1（cap=5）。
  assert.deepEqual(clamped.offerRegionPercents, { "1": 40, "2": 1 });
  assert.equal(clamped.clamped, true);
});

test("clampNpcOfferToCaps：regionMaxPct=0 → 所有地區剔除", () => {
  const caps = capsOf({ regionMaxPct: 0 });
  const held = new Map<number, number>([[1, 80]]);
  const clamped = clampNpcOfferToCaps(
    {
      offerMoney: 0,
      offerTechPoints: 0,
      offerRegionIds: [1],
      offerRegionPercents: { "1": 10 },
    },
    held,
    caps,
  );
  assert.deepEqual(clamped.offerRegionIds, []);
  assert.equal(clamped.clamped, true);
});
