import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forecastCampaignSupply,
  maxResupplyAmount,
  resupplyCost,
  resupplyUnitPrice,
  validateResupply,
  RESUPPLY_HORIZON_CYCLES,
} from "./supplyForecast";
import { allocateSupplyFill, consumedFromStock, legionSupplyDemand } from "./supply";

// 截圖那支部隊:8000 火槍 + 400 野戰砲
const army = [
  { quantity: 8000, category: "infantry" },
  { quantity: 400, category: "artillery" },
];
const legion = (slot: string, supply = 100, mercenary = false, units = army) => ({
  slot,
  mercenary,
  supply,
  units,
});

test("預估需求 = 結算用的 legionSupplyDemand(同一套公式)", () => {
  const f = forecastCampaignSupply([legion("A")], 0, "industrial");
  assert.equal(f.totalAmmoDemand, legionSupplyDemand(army, "industrial").ammo);
  assert.equal(f.totalAmmoDemand, 3600);
});

test("預估滿足度 = 結算用的 allocateSupplyFill(不變量)", () => {
  const legions = [legion("A"), legion("B", 100, false, [{ quantity: 1000, category: "armor" }])];
  const stock = 2500;
  const f = forecastCampaignSupply(legions, stock, "industrial");
  const demands = legions.map((l) => legionSupplyDemand(l.units, "industrial").ammo);
  const fills = allocateSupplyFill(demands, stock);
  f.legions.forEach((row, i) => assert.equal(row.ammoFill, fills[i]));
  // 實際扣的量也一致
  assert.equal(consumedFromStock(demands, stock), Math.min(stock, f.totalAmmoDemand));
});

test("庫存足夠:無缺口、可撐多週期", () => {
  const f = forecastCampaignSupply([legion("A")], 10_800, "industrial");
  assert.equal(f.ammoShortfall, 0);
  assert.equal(f.ammoBalance, 7200);
  assert.equal(f.cyclesOfAmmo, 3);
  assert.equal(f.legionsShort, 0);
});

test("庫存不足:缺口與缺彈軍團數", () => {
  const f = forecastCampaignSupply([legion("A"), legion("B")], 3600, "industrial");
  assert.equal(f.totalAmmoDemand, 7200);
  assert.equal(f.ammoShortfall, 3600);
  assert.equal(f.legionsShort, 2);
  assert.equal(f.cyclesOfAmmo, 0.5);
});

test("庫存為 0:全部缺彈", () => {
  const f = forecastCampaignSupply([legion("A")], 0, "industrial");
  assert.equal(f.cyclesOfAmmo, 0);
  assert.equal(f.legionsShort, 1);
  assert.equal(f.legions[0]!.ammoFill, 0);
});

test("僱傭兵自帶補給:需求 0、滿足度 1、不計入缺彈", () => {
  const f = forecastCampaignSupply([legion("A", 100, true)], 0, "industrial");
  assert.equal(f.totalAmmoDemand, 0);
  assert.equal(f.legions[0]!.ammoFill, 1);
  assert.equal(f.legionsShort, 0);
  assert.equal(f.cyclesOfAmmo, null);
});

test("冷兵器時代:ammoRelevant=false、需求 0", () => {
  const f = forecastCampaignSupply([legion("A")], 0, "roman");
  assert.equal(f.ammoRelevant, false);
  assert.equal(f.totalAmmoDemand, 0);
});

test("補給崩潰的軍團被計數", () => {
  const f = forecastCampaignSupply([legion("A", 10), legion("B", 80)], 99999, "industrial");
  assert.equal(f.collapsedLegions, 1);
});

test("負數/小數庫存被正規化,不產生 NaN", () => {
  const f = forecastCampaignSupply([legion("A")], -50.7, "industrial");
  assert.equal(f.ammoStock, 0);
  const g = forecastCampaignSupply([legion("A")], 100.9, "industrial");
  assert.equal(g.ammoStock, 100);
});

test("單價:時代越高越貴,冷兵器 = 基礎價", () => {
  assert.equal(resupplyUnitPrice("roman"), 2);
  assert.ok(resupplyUnitPrice("modern") > resupplyUnitPrice("industrial"));
  assert.equal(resupplyUnitPrice("industrial"), 2.3);
});

test("總價進位成整數,0 或負數為 0", () => {
  assert.equal(resupplyCost(100, "industrial"), 230);
  assert.equal(resupplyCost(1, "industrial"), 3); // 2.3 進位
  assert.equal(resupplyCost(0, "industrial"), 0);
  assert.equal(resupplyCost(-5, "industrial"), 0);
});

test("單次上限 = N 週期需求 − 庫存", () => {
  assert.equal(maxResupplyAmount(3600, 0), 3600 * RESUPPLY_HORIZON_CYCLES);
  assert.equal(maxResupplyAmount(3600, 5000), 3600 * RESUPPLY_HORIZON_CYCLES - 5000);
  assert.equal(maxResupplyAmount(3600, 99999), 0);
  assert.equal(maxResupplyAmount(0, 0), 0);
});

test("驗證:正常購買", () => {
  const f = forecastCampaignSupply([legion("A")], 0, "industrial");
  const r = validateResupply(1000, f, "industrial", 100_000);
  assert.deepEqual(r, { ok: true, amount: 1000, cost: 2300, unitPrice: 2.3 });
});

test("驗證:金錢不足、超過上限、非整數、<1、冷兵器、庫存已滿都被擋", () => {
  const f = forecastCampaignSupply([legion("A")], 0, "industrial");
  const bad = (v: unknown, money = 1e9) => validateResupply(v, f, "industrial", money);
  assert.equal(bad(1000, 100).ok, false);
  assert.match((bad(1000, 100) as { error: string }).error, /金錢不足/);
  assert.equal(bad(3600 * 5 + 1).ok, false);
  assert.equal(bad(1.5).ok, false);
  assert.equal(bad(0).ok, false);
  assert.equal(bad(-3).ok, false);
  assert.equal(bad("100").ok, false);
  assert.equal(bad(NaN).ok, false);
  assert.equal(bad(Infinity).ok, false);
  const old = forecastCampaignSupply([legion("A")], 0, "roman");
  assert.equal(validateResupply(10, old, "roman", 1e9).ok, false);
  const full = forecastCampaignSupply([legion("A")], 99_999, "industrial");
  assert.match((validateResupply(1, full, "industrial", 1e9) as { error: string }).error, /已足夠/);
});

test("驗證:恰好等於上限可通過", () => {
  const f = forecastCampaignSupply([legion("A")], 0, "industrial");
  assert.equal(validateResupply(18_000, f, "industrial", 1e9).ok, true);
});
