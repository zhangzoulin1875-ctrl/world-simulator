import test from "node:test";
import assert from "node:assert/strict";
import {
  AMMO_ERA_FACTOR, ammoEraFactor, legionSupplyDemand, allocateSupplyFill, consumedFromStock,
  nextSupplyState, isSupplyCollapsed, collapseMoralePenalty, supplyPowerFactor, SUPPLY_MIN_FACTOR,
  SUPPLY_COLLAPSE_BELOW, COLLAPSE_MORALE_PENALTY, npcAmmoStipend, npcAmmoStockCap, ammoStockCap,
  SUPPLY_RECOVER_PER_CYCLE, rationFillFromFamine,
} from "./supply";
import { ERAS } from "./mapRegionEras";

test("時代彈藥係數涵蓋所有時代，且不遞減", () => {
  let prev = -1;
  for (const e of ERAS) {
    assert.ok(e.slug in AMMO_ERA_FACTOR, `缺時代 ${e.slug}`);
    assert.ok(AMMO_ERA_FACTOR[e.slug]! >= prev, `${e.slug} 係數不該比前一個時代低`);
    prev = AMMO_ERA_FACTOR[e.slug]!;
  }
});

test("冷兵器時代彈藥需求為 0，只剩口糧", () => {
  const d = legionSupplyDemand([{ quantity: 10_000, category: "infantry" }], "classical");
  assert.equal(d.ammo, 0);
  assert.equal(d.ration, 10_000);
});

test("火藥時代起有彈藥需求，火砲 > 步兵", () => {
  const inf = legionSupplyDemand([{ quantity: 1000, category: "infantry" }], "ww1");
  const art = legionSupplyDemand([{ quantity: 1000, category: "artillery" }], "ww1");
  assert.ok(inf.ammo > 0 && art.ammo > inf.ammo);
});

test("未知時代、未知兵種分類不丟錯", () => {
  assert.equal(ammoEraFactor("nope"), 0);
  assert.ok(legionSupplyDemand([{ quantity: 100, category: "mystery" }], "ww2").ammo > 0);
});

test("負數量、零兵力：需求為 0", () => {
  assert.deepEqual(legionSupplyDemand([{ quantity: -5, category: "armor" }], "ww2"), { ration: 0, ammo: 0 });
  assert.deepEqual(legionSupplyDemand([], "ww2"), { ration: 0, ammo: 0 });
});

test("分配：庫存夠 → 全 1；不夠 → 依比例；與順序無關", () => {
  assert.deepEqual(allocateSupplyFill([100, 200], 300), [1, 1]);
  assert.deepEqual(allocateSupplyFill([100, 200], 150), [0.5, 0.5]);
  assert.deepEqual(allocateSupplyFill([200, 100], 150), [0.5, 0.5]);
  assert.deepEqual(allocateSupplyFill([100, 200], 0), [0, 0]);
  assert.deepEqual(allocateSupplyFill([0, 0], 0), [1, 1], "沒需求 = 不缺");
  assert.deepEqual(allocateSupplyFill([0, 100], 0), [1, 0], "沒需求的軍團不受影響");
});

test("消耗量不超過庫存也不超過需求", () => {
  assert.equal(consumedFromStock([100, 200], 1000), 300);
  assert.equal(consumedFromStock([100, 200], 120), 120);
  assert.equal(consumedFromStock([100], -5), 0);
});

test("補給狀態：吃飽回升、缺料下降、夾在 0–100", () => {
  assert.equal(nextSupplyState(50, 1, 1), 50 + SUPPLY_RECOVER_PER_CYCLE);
  assert.equal(nextSupplyState(98, 1, 1), 100);
  assert.ok(nextSupplyState(80, 0, 1) < 80, "缺糧會降");
  assert.ok(nextSupplyState(80, 1, 0) < 80, "缺彈會降");
  assert.ok(nextSupplyState(80, 0, 0) < nextSupplyState(80, 0, 1), "兩樣都缺比單缺糧更慘");
  assert.equal(nextSupplyState(10, 0, 0), 0);
  assert.equal(nextSupplyState(50, 2, -1), 50 - 20, "超出範圍的滿足度被夾住");
});

test("連續缺糧幾個週期就崩潰", () => {
  let s = 100, n = 0;
  while (!isSupplyCollapsed(s) && n < 20) { s = nextSupplyState(s, 0, 1); n++; }
  assert.ok(n <= 4, `完全斷糧應在 4 週期內崩潰，實際 ${n}`);
});

test("崩潰：士氣額外暴跌；沒崩潰 = 0", () => {
  assert.equal(collapseMoralePenalty(SUPPLY_COLLAPSE_BELOW), 0);
  assert.equal(collapseMoralePenalty(SUPPLY_COLLAPSE_BELOW - 1), COLLAPSE_MORALE_PENALTY);
  assert.equal(collapseMoralePenalty(0), COLLAPSE_MORALE_PENALTY);
});

test("戰力乘數：單調、補給 100=1、補給 0 近 0、崩潰區有斷層", () => {
  assert.equal(supplyPowerFactor(100), 1);
  assert.ok(supplyPowerFactor(0) <= SUPPLY_MIN_FACTOR);
  let prev = -1;
  for (let s = 0; s <= 100; s += 5) {
    const f = supplyPowerFactor(s);
    // 崩潰邊界 20 → 19 有意設計成斷層，所以只檢查「不低於前一點」的單調性。
    assert.ok(f >= prev, `s=${s} 乘數不該下降`);
    prev = f;
  }
  const edge = supplyPowerFactor(SUPPLY_COLLAPSE_BELOW), under = supplyPowerFactor(SUPPLY_COLLAPSE_BELOW - 1);
  assert.ok(under < edge * 0.8, `崩潰邊界至少掉兩成(${edge.toFixed(3)} → ${under.toFixed(3)})`);
  assert.equal(supplyPowerFactor(500), 1);
  assert.ok(supplyPowerFactor(-50) <= SUPPLY_MIN_FACTOR);
});

test("NPC 配額：冷兵器時代 0；火藥時代依地區數成長；上限不為 0", () => {
  assert.equal(npcAmmoStipend(10, "classical"), 0);
  assert.ok(npcAmmoStipend(10, "ww2") > npcAmmoStipend(5, "ww2"));
  assert.equal(npcAmmoStipend(-3, "ww2"), 0);
  assert.ok(npcAmmoStockCap(5) > 0, "NPC 沒有工廠也要有倉容");
  assert.equal(ammoStockCap(0), 0);
});

test("口糧滿足度：沒饑荒=1，饑荒越久越低，單調不增", () => {
  assert.equal(rationFillFromFamine(0), 1);
  assert.equal(rationFillFromFamine(-3), 1);
  let prev = 2;
  for (let t = 0; t <= 8; t++) { const f = rationFillFromFamine(t); assert.ok(f <= prev && f > 0); prev = f; }
  assert.equal(rationFillFromFamine(1.9), 0.7, "小數捨去");
});
