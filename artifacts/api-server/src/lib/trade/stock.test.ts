import test from "node:test";
import assert from "node:assert/strict";
import {
  FOOD_INITIAL_STOCK_TURNS, FOOD_SPOIL_PCT, FOOD_STOCK_CAP_TURNS,
  foodStockCap, initialFoodStock, isGoodUnlocked, settleFoodStock,
} from "./stock";
import { GOODS, GOOD_SLUGS, TABLE_GOOD_SLUGS, isGoodSlug } from "./goods";
import { ERAS } from "../mapRegionEras";

test("定案數值:期初 6 回合、上限 12 回合、腐敗 3%", () => {
  assert.equal(FOOD_INITIAL_STOCK_TURNS, 6);
  assert.equal(FOOD_STOCK_CAP_TURNS, 12);
  assert.equal(FOOD_SPOIL_PCT, 3);
});

test("期初庫存與上限 = 消耗 × 回合數;消耗 <= 0 或非有限值歸 0", () => {
  assert.equal(initialFoodStock(1000), 6000);
  assert.equal(foodStockCap(1000), 12000);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(initialFoodStock(bad), 0, `initial ${bad}`);
    assert.equal(foodStockCap(bad), 0, `cap ${bad}`);
  }
  assert.ok(Number.isInteger(initialFoodStock(333.7)));
});

test("盈餘:先吃再腐敗 3%,向下取整", () => {
  // 庫存 1000 + 供給 1100 − 消耗 1000 = 1100;腐敗 floor(33)=33 → 1067
  const r = settleFoodStock({ stock: 1000, supply: 1100, consumption: 1000 });
  assert.equal(r.famine, false);
  assert.equal(r.spoiled, 33);
  assert.equal(r.stock, 1067);
  assert.equal(r.shortfall, 0);
});

test("腐敗向下取整:餘量太少時不腐敗(玩家不吃虧)", () => {
  const r = settleFoodStock({ stock: 0, supply: 1030, consumption: 1000 });
  // 餘 30 × 3% = 0.9 → 0
  assert.equal(r.spoiled, 0);
  assert.equal(r.stock, 30);
});

test("赤字但庫存夠:不饑荒,庫存下降", () => {
  const r = settleFoodStock({ stock: 6000, supply: 500, consumption: 1000 });
  assert.equal(r.famine, false);
  assert.equal(r.shortfall, 0);
  // 6000+500−1000 = 5500;腐敗 165 → 5335
  assert.equal(r.stock, 5335);
});

test("庫存用完仍不夠:饑荒,缺口 = 差額,庫存歸 0 且不為負", () => {
  const r = settleFoodStock({ stock: 200, supply: 300, consumption: 1000 });
  assert.equal(r.famine, true);
  assert.equal(r.shortfall, 500);
  assert.equal(r.stock, 0);
  assert.equal(r.spoiled, 0);
});

test("恰好吃完:不饑荒", () => {
  const r = settleFoodStock({ stock: 0, supply: 1000, consumption: 1000 });
  assert.equal(r.famine, false);
  assert.equal(r.stock, 0);
});

test("超過上限(12 回合消耗)的部分被捨棄", () => {
  const r = settleFoodStock({ stock: 12000, supply: 5000, consumption: 1000 });
  // 12000+5000−1000=16000;腐敗 480 → 15520;上限 12000 → 溢出 3520
  assert.equal(r.stock, 12000);
  assert.equal(r.overflow, 3520);
  assert.equal(r.cap, 12000);
});

test("供給為負(條約輸出大於產出)會吃庫存,庫存不足才饑荒", () => {
  const ok = settleFoodStock({ stock: 5000, supply: -2000, consumption: 1000 });
  assert.equal(ok.famine, false);
  assert.equal(ok.stock, Math.floor(2000 * 0.97)); // 5000−2000−1000=2000,腐敗 60 → 1940
  const bad = settleFoodStock({ stock: 500, supply: -2000, consumption: 1000 });
  assert.equal(bad.famine, true);
  assert.equal(bad.shortfall, 2500);
});

test("消耗為 0:上限為 0,庫存全部溢出,不饑荒", () => {
  const r = settleFoodStock({ stock: 100, supply: 50, consumption: 0 });
  assert.equal(r.famine, false);
  assert.equal(r.cap, 0);
  assert.equal(r.stock, 0);
});

test("壞輸入(NaN/Infinity/負庫存)不產生 NaN、庫存永遠是 0 以上整數", () => {
  const inputs = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -50, 12.7];
  for (const s of inputs) for (const p of inputs) for (const c of inputs) {
    const r = settleFoodStock({ stock: s, supply: p, consumption: c });
    for (const v of [r.stock, r.shortfall, r.spoiled, r.overflow, r.cap]) {
      assert.ok(Number.isInteger(v) && v >= 0, `${s}/${p}/${c} → ${JSON.stringify(r)}`);
    }
    assert.ok(r.stock <= r.cap, "庫存不得超過上限");
  }
});

test("守恆:可用量 = 吃掉 + 腐敗 + 溢出 + 結算後庫存(非饑荒時)", () => {
  for (const [stock, supply, consumption] of [[1000, 1100, 1000], [12000, 5000, 1000], [0, 1030, 1000], [777, 123, 400]]) {
    const r = settleFoodStock({ stock, supply, consumption });
    if (r.famine) continue;
    assert.equal(stock + supply, consumption + r.spoiled + r.overflow + r.stock);
  }
});

// ── 貨物定義 ──────────────────────────────────────────────────

test("貨物共 8 種,slug 與 GOODS 表一致", () => {
  assert.equal(GOOD_SLUGS.length, 8);
  for (const g of GOOD_SLUGS) assert.equal(GOODS[g].slug, g);
  assert.ok(isGoodSlug("food") && !isGoodSlug("gold") && !isGoodSlug(3));
});

test("木材與礦石沿用 player_nations 欄位,不進 nation_goods(避免雙帳)", () => {
  assert.ok(!TABLE_GOOD_SLUGS.includes("wood"));
  assert.ok(!TABLE_GOOD_SLUGS.includes("ore"));
  assert.equal(TABLE_GOOD_SLUGS.length, 6);
});

test("基準價為正整數;解鎖時代都是真實時代 slug", () => {
  const eraSlugs = new Set(ERAS.map((e) => e.slug));
  for (const g of GOOD_SLUGS) {
    const d = GOODS[g];
    assert.ok(Number.isInteger(d.basePrice) && d.basePrice > 0, g);
    if (d.unlockEra !== null) assert.ok(eraSlugs.has(d.unlockEra), `${g} → ${d.unlockEra}`);
  }
});

test("石油與稀有金屬:工業時代前未解鎖,之後解鎖;其餘貨物始終可用", () => {
  assert.equal(isGoodUnlocked("oil", "enlightenment"), false);
  assert.equal(isGoodUnlocked("oil", "industrial"), true);
  assert.equal(isGoodUnlocked("rare", "classical"), false);
  assert.equal(isGoodUnlocked("rare", "modern"), true);
  for (const g of ["food", "ironcoal", "spice", "cloth", "wood", "ore"] as const) {
    assert.equal(isGoodUnlocked(g, "classical"), true, g);
  }
  assert.equal(isGoodUnlocked("oil", "not_an_era"), false);
});
