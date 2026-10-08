import { strict as assert } from "node:assert";
import test from "node:test";
import { blockReason, maxQty, parseQty, pctVsBase } from "./market-logic";

const base = { side: "buy" as const, qty: 10, perTradeCap: 300, left: 300, owned: 0, affordable: true as boolean | null };

test("parseQty:只接受純數字", () => {
  assert.equal(parseQty("10"), 10);
  assert.equal(parseQty("007"), 7);
  for (const bad of ["", " ", "1.5", "-3", "1e3", "abc", "１２", "10 ", "+5"]) assert.equal(parseQty(bad), 0, JSON.stringify(bad));
});

test("blockReason:正常可送出", () => {
  assert.equal(blockReason(base), null);
  assert.equal(blockReason({ ...base, side: "sell", owned: 10 }), null);
  assert.equal(blockReason({ ...base, affordable: null }), null, "試算尚未回來時不在這裡擋(按鈕另有 !preview 條件)");
});

test("blockReason:數量無效", () => {
  for (const qty of [0, -1, 1.5, Number.NaN, 301]) {
    assert.match(String(blockReason({ ...base, qty })), /數量請輸入 1 到 300/, String(qty));
  }
  assert.equal(blockReason({ ...base, qty: 300 }), null);
  assert.equal(blockReason({ ...base, qty: 1 }), null);
});

test("blockReason:額度用完 / 超過剩餘額度,且訊息依方向用買 / 賣", () => {
  assert.equal(blockReason({ ...base, left: 0 }), "本回合此方向額度已用完");
  assert.equal(blockReason({ ...base, left: 5 }), "本回合最多還能買 5");
  assert.equal(blockReason({ ...base, side: "sell", owned: 100, left: 5 }), "本回合最多還能賣 5");
});

test("blockReason:賣出庫存不足、買進金錢不足;賣出不受 affordable 影響", () => {
  assert.equal(blockReason({ ...base, side: "sell", owned: 3 }), "庫存不足（持有 3）");
  assert.equal(blockReason({ ...base, affordable: false }), "金錢不足");
  assert.equal(blockReason({ ...base, side: "sell", owned: 50, affordable: false }), null);
});

test("blockReason:優先順序 = 數量 > 額度 > 庫存 > 金錢", () => {
  assert.match(String(blockReason({ ...base, qty: 0, left: 0, affordable: false })), /數量/);
  assert.match(String(blockReason({ ...base, left: 0, affordable: false })), /額度已用完/);
  assert.match(String(blockReason({ ...base, side: "sell", owned: 0, affordable: false })), /庫存不足/);
});

test("maxQty:買進取單筆上限與剩餘額度的小者;賣出再受持有量限制;至少 1", () => {
  assert.equal(maxQty("buy", 300, 300, 0), 300);
  assert.equal(maxQty("buy", 300, 120, 0), 120);
  assert.equal(maxQty("sell", 300, 300, 80), 80);
  assert.equal(maxQty("sell", 300, 50, 80), 50);
  assert.equal(maxQty("sell", 300, 300, 0), 1, "沒庫存也填 1,由 blockReason 說明原因");
  assert.equal(maxQty("buy", 300, 0, 0), 1);
});

test("pctVsBase:漲跌百分比,基準價無效不爆", () => {
  assert.equal(pctVsBase(150, 100), 50);
  assert.equal(pctVsBase(50, 100), -50);
  assert.equal(pctVsBase(100, 100), 0);
  assert.equal(pctVsBase(5, 0), 0);
  assert.equal(pctVsBase(Number.NaN, 100), 0);
});
