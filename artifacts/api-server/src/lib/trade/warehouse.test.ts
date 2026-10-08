import test from "node:test";
import assert from "node:assert/strict";
import { buildWarehouse } from "./warehouse";
import { nationSpecialtyOutput } from "./production";

const base = { wood: 0, ore: 0, goods: {}, regions: [], statsEra: "industrial" };

test("固定回傳 7 種貨物(不含糧食),順序穩定", () => {
  const w = buildWarehouse(base);
  assert.deepEqual(
    w.map((g) => g.slug),
    ["wood", "ore", "ironcoal", "oil", "rare", "spice", "cloth"],
  );
  assert.ok(w.every((g) => g.stock === 0 && g.perTurn === 0 && g.sources.length === 0));
});

test("庫存:木材礦石來自 player_nations,其餘來自 nation_goods", () => {
  const w = buildWarehouse({ ...base, wood: 12, ore: 34, goods: { oil: 5, spice: 6 } });
  const by = Object.fromEntries(w.map((g) => [g.slug, g.stock]));
  assert.equal(by.wood, 12);
  assert.equal(by.ore, 34);
  assert.equal(by.oil, 5);
  assert.equal(by.spice, 6);
  assert.equal(by.rare, 0);
});

test("每回合產量等於回合引擎用的 nationSpecialtyOutput(顯示必然等於實際入帳)", () => {
  const regions = [
    { name: "南非德蘭", percent: 100 },
    { name: "利雅德", percent: 50 },
    { name: "蘇格蘭高地", percent: 100 },
  ];
  const w = buildWarehouse({ ...base, regions });
  const engine = nationSpecialtyOutput(regions, "industrial");
  for (const g of w) assert.equal(g.perTurn, engine[g.slug] ?? 0, g.slug);
});

test("來源明細:加總等於每回合產量,由大到小,標示主產", () => {
  const regions = [
    { name: "蘇格蘭高地", percent: 100 }, // 礦 次產 10
    { name: "南非德蘭", percent: 100 }, // 礦 主產 30
  ];
  const ore = buildWarehouse({ ...base, regions }).find((g) => g.slug === "ore")!;
  assert.equal(ore.perTurn, 40);
  assert.equal(ore.sources.reduce((a, s) => a + s.perTurn, 0), ore.perTurn);
  assert.deepEqual(ore.sources.map((s) => s.regionName), ["南非德蘭", "蘇格蘭高地"]);
  assert.deepEqual(ore.sources.map((s) => s.major), [true, false]);
});

test("主產判斷不受控制比例影響(控 20% 的主產區仍標主產)", () => {
  const ore = buildWarehouse({ ...base, regions: [{ name: "南非德蘭", percent: 40 }] }).find((g) => g.slug === "ore")!;
  assert.equal(ore.sources[0]!.major, true);
  assert.equal(ore.sources[0]!.perTurn, 12);
});

test("時代解鎖:古典時代石油/稀有金屬 unlocked=false 且 perTurn=0,但仍列出", () => {
  const w = buildWarehouse({ ...base, statsEra: "classical", regions: [{ name: "南非德蘭", percent: 100 }, { name: "利雅德", percent: 100 }] });
  const oil = w.find((g) => g.slug === "oil")!;
  const rare = w.find((g) => g.slug === "rare")!;
  assert.equal(oil.unlocked, false);
  assert.equal(oil.unlockEra, "industrial");
  assert.equal(oil.perTurn, 0);
  assert.equal(oil.sources.length, 0);
  assert.equal(rare.unlocked, false);
  assert.equal(w.find((g) => g.slug === "ore")!.unlocked, true);
});

test("壞輸入:NaN/負/小數庫存歸成非負整數", () => {
  const w = buildWarehouse({ ...base, wood: NaN, ore: -5, goods: { oil: 7.9, rare: -1 } });
  const by = Object.fromEntries(w.map((g) => [g.slug, g.stock]));
  assert.equal(by.wood, 0);
  assert.equal(by.ore, 0);
  assert.equal(by.oil, 7);
  assert.equal(by.rare, 0);
});

test("貨物沒有控制地區時不憑空生出來源", () => {
  const w = buildWarehouse({ ...base, regions: [{ name: "不存在的地區", percent: 100 }] });
  assert.ok(w.every((g) => g.sources.length === 0 && g.perTurn === 0));
});
