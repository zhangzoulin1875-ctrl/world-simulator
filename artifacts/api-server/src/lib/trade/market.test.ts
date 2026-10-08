import test from "node:test";
import assert from "node:assert/strict";
import { GOODS, GOOD_SLUGS, type GoodSlug } from "./goods";
import {
  MARKET_FEE, MARKET_DEPTH, PER_TRADE_CAP, PLAYER_TURN_CAP, REVERT_RATE,
  clampMid, executeTrade, planNpcOrders, priceBounds, quote, remainingTurnCap,
  revertMid, validateTradeQty, NPC_MAX_PER_TURN, NPC_TARGET_STOCK, tradableGoods,
} from "./market";

const TRADABLE = GOOD_SLUGS.filter((g) => g !== "food");

test("報價:ask = mid×1.3、bid = mid×0.7", () => {
  const q = quote("oil", 14);
  assert.equal(MARKET_FEE, 0.3);
  assert.ok(Math.abs(q.ask - 18.2) < 1e-9);
  assert.ok(Math.abs(q.bid - 9.8) < 1e-9);
});

test("中間價夾在基準價 0.4~3 倍;NaN 回基準價", () => {
  for (const g of GOOD_SLUGS) {
    const { min, max } = priceBounds(g);
    assert.equal(clampMid(g, 0), min);
    assert.equal(clampMid(g, 1e9), max);
    assert.equal(clampMid(g, NaN), GOODS[g].basePrice);
  }
});

test("防炒價:每種貨物、每種量,買了立刻賣一定虧(來回只剩不到 55%,即損失 > 45%)", () => {
  for (const g of GOOD_SLUGS) {
    for (const qty of [1, 5, 50, 200]) {
      const mid = GOODS[g].basePrice;
      const buy = executeTrade(g, mid, "buy", qty);
      const sell = executeTrade(g, buy.newMid, "sell", qty);
      assert.ok(sell.money < buy.money, `${g}×${qty}: 賣 ${sell.money} 應 < 買 ${buy.money}`);
      // 手續費理論來回保留率 0.7/1.3 ≈ 53.8%,再加滑價只會更低;留 1.2 個百分點給整數捨入。
      assert.ok(sell.money <= buy.money * 0.55, `${g}×${qty}: 來回應只剩約 54% 以下,實得 ${sell.money}/${buy.money}`);
    }
  }
});

test("防捨入套利:1 單位來回不會賺,買無條件進位、賣無條件捨去", () => {
  for (const g of GOOD_SLUGS) {
    const buy = executeTrade(g, GOODS[g].basePrice, "buy", 1);
    const sell = executeTrade(g, buy.newMid, "sell", 1);
    assert.ok(Number.isInteger(buy.money) && Number.isInteger(sell.money));
    assert.ok(buy.money >= Math.ceil(GOODS[g].basePrice * 1.3 * 0.999));
    assert.ok(sell.money < buy.money);
  }
});

test("買入推高價格、賣出壓低價格;量越大推得越多", () => {
  const mid = GOODS.ironcoal.basePrice;
  const b10 = executeTrade("ironcoal", mid, "buy", 10).newMid;
  const b100 = executeTrade("ironcoal", mid, "buy", 100).newMid;
  const s100 = executeTrade("ironcoal", mid, "sell", 100).newMid;
  assert.ok(b10 > mid && b100 > b10);
  assert.ok(s100 < mid);
});

test("大額買入單價高於小額(滑價):200 單位平均價 > 1 單位", () => {
  const mid = GOODS.rare.basePrice;
  const one = executeTrade("rare", mid, "buy", 1).avgPrice;
  const big = executeTrade("rare", mid, "buy", 200).avgPrice;
  assert.ok(big > one);
});

test("深度:稀有貨物比糧食更敏感(同量推價幅度更大)", () => {
  const pct = (g: GoodSlug) => {
    const m = GOODS[g].basePrice;
    return (executeTrade(g, m, "buy", 100).newMid - m) / m;
  };
  assert.ok(MARKET_DEPTH.rare < MARKET_DEPTH.food);
  assert.ok(pct("rare") > pct("food"));
});

test("價格推動不會越界:連續灌買單到頂、連續賣單到底", () => {
  for (const g of GOOD_SLUGS) {
    const { min, max } = priceBounds(g);
    let m = GOODS[g].basePrice;
    for (let i = 0; i < 200; i++) m = executeTrade(g, m, "buy", PER_TRADE_CAP).newMid;
    assert.equal(m, max);
    for (let i = 0; i < 400; i++) m = executeTrade(g, m, "sell", PER_TRADE_CAP).newMid;
    assert.equal(m, min);
  }
});

test("數量 0 / 負 / 小數:不成交、不動價格", () => {
  for (const q of [0, -5, 0.4, NaN]) {
    const r = executeTrade("oil", 14, "buy", q);
    assert.equal(r.money, 0);
    assert.equal(r.newMid, 14);
  }
});

test("回歸:偏高往下、偏低往上、在基準價不動;反覆回歸收斂到基準", () => {
  const base = GOODS.oil.basePrice;
  assert.ok(revertMid("oil", base * 2) < base * 2 && revertMid("oil", base * 2) > base);
  assert.ok(revertMid("oil", base * 0.5) > base * 0.5 && revertMid("oil", base * 0.5) < base);
  assert.equal(revertMid("oil", base), base);
  let m = base * 3;
  for (let i = 0; i < 40; i++) m = revertMid("oil", m);
  assert.ok(Math.abs(m - base) < 0.05, `40 回合後應回到基準價附近,實得 ${m}`);
  assert.equal(REVERT_RATE, 0.15);
});

test("回合額度:300 單位上限,用完為 0,負數視為 0", () => {
  assert.equal(remainingTurnCap(0), PLAYER_TURN_CAP);
  assert.equal(remainingTurnCap(120), 180);
  assert.equal(remainingTurnCap(300), 0);
  assert.equal(remainingTurnCap(9999), 0);
  assert.equal(remainingTurnCap(-5), PLAYER_TURN_CAP);
});

test("數量驗證:整數、>0、單筆 ≤200、不超過本回合剩餘額度", () => {
  assert.equal(validateTradeQty(10, 0), null);
  assert.equal(validateTradeQty(200, 0), null);
  assert.match(validateTradeQty(201, 0)!, /單筆最多 200/);
  assert.match(validateTradeQty(0, 0)!, /大於 0/);
  assert.match(validateTradeQty(-3, 0)!, /大於 0/);
  assert.match(validateTradeQty(2.5, 0)!, /整數/);
  assert.match(validateTradeQty("5" as unknown as number, 0)!, /整數/);
  assert.match(validateTradeQty(NaN, 0)!, /整數/);
  assert.match(validateTradeQty(100, 250)!, /只剩 50/);
  assert.match(validateTradeQty(1, 300)!, /額度已用完/);
});

/* ── NPC ── */

test("NPC:價格偏高且庫存多 → 賣出多餘的,最多 60", () => {
  const mids = { oil: GOODS.oil.basePrice * 1.5 };
  const o = planNpcOrders({ stock: { oil: 1000 }, money: 1_000_000 }, mids, TRADABLE);
  assert.deepEqual(o, [{ good: "oil", side: "sell", qty: NPC_MAX_PER_TURN }]);
});

test("NPC:庫存只比目標多一點 → 只賣多出的部分", () => {
  const mids = { oil: GOODS.oil.basePrice * 1.5 };
  const o = planNpcOrders({ stock: { oil: NPC_TARGET_STOCK + 7 }, money: 1_000_000 }, mids, TRADABLE);
  assert.deepEqual(o, [{ good: "oil", side: "sell", qty: 7 }]);
});

test("NPC:價格偏低且庫存少 → 買進(穩定器:壓低價格時反向托價)", () => {
  const mids = { cloth: GOODS.cloth.basePrice * 0.5 };
  const o = planNpcOrders({ stock: { cloth: 0 }, money: 1_000_000 }, mids, TRADABLE);
  assert.deepEqual(o, [{ good: "cloth", side: "buy", qty: NPC_MAX_PER_TURN }]);
});

test("NPC:價格在基準 ±10% 內不出手", () => {
  const o = planNpcOrders({ stock: { oil: 1000, cloth: 0 }, money: 1_000_000 },
    { oil: GOODS.oil.basePrice * 1.05, cloth: GOODS.cloth.basePrice * 0.95 }, TRADABLE);
  assert.deepEqual(o, []);
});

test("NPC:沒錢不買;只動用一半現金", () => {
  const mids = { cloth: GOODS.cloth.basePrice * 0.5 };
  assert.deepEqual(planNpcOrders({ stock: { cloth: 0 }, money: 0 }, mids, TRADABLE), []);
  const cost = executeTrade("cloth", mids.cloth, "buy", NPC_MAX_PER_TURN).money;
  assert.deepEqual(planNpcOrders({ stock: { cloth: 0 }, money: cost }, mids, TRADABLE), []);
  assert.equal(planNpcOrders({ stock: { cloth: 0 }, money: cost * 2 }, mids, TRADABLE).length, 1);
});

test("NPC:多種貨物買單共用同一份預算,不會超支", () => {
  const mids = { cloth: GOODS.cloth.basePrice * 0.5, spice: GOODS.spice.basePrice * 0.5, oil: GOODS.oil.basePrice * 0.5 };
  const one = executeTrade("cloth", mids.cloth, "buy", NPC_MAX_PER_TURN).money;
  const money = one * 2 + 5; // 預算 = money/2 ≈ one+2,只夠一筆
  const o = planNpcOrders({ stock: {}, money }, mids, TRADABLE);
  assert.equal(o.filter((x) => x.side === "buy").length, 1);
});

test("NPC:糧食不參與黑市", () => {
  const o = planNpcOrders({ stock: { food: 9999 }, money: 1e9 }, { food: 100 }, GOOD_SLUGS);
  assert.ok(o.every((x) => x.good !== "food"));
});

test("NPC 穩定器模擬:玩家狂買推高價格,NPC 賣出後價格下降", () => {
  const g: GoodSlug = "ironcoal";
  let mid = GOODS[g].basePrice;
  for (let i = 0; i < 6; i++) mid = executeTrade(g, mid, "buy", PER_TRADE_CAP).newMid;
  const high = mid;
  assert.ok(high > GOODS[g].basePrice * 1.1);
  const orders = planNpcOrders({ stock: { [g]: 1000 }, money: 1e6 }, { [g]: mid }, TRADABLE);
  for (const o of orders) mid = executeTrade(o.good, mid, o.side, o.qty).newMid;
  assert.ok(mid < high, "NPC 賣出應壓低價格");
});

test("時代鎖:古代只能交易無時代限制的貨物,工業時代起才有石油與稀有金屬;糧食永遠排除", () => {
  const all = GOOD_SLUGS;
  const ancient = tradableGoods(all, "ancient");
  assert.ok(!ancient.includes("oil") && !ancient.includes("rare"));
  assert.ok(!ancient.includes("food"));
  for (const g of ["wood", "ore", "ironcoal", "spice", "cloth"] as const) assert.ok(ancient.includes(g), g);
  const industrial = tradableGoods(all, "industrial");
  assert.ok(industrial.includes("oil") && industrial.includes("rare"));
  assert.ok(!industrial.includes("food"));
  assert.deepEqual(tradableGoods(all, "not-an-era").sort(), ["cloth", "ironcoal", "ore", "spice", "wood"]);
});
