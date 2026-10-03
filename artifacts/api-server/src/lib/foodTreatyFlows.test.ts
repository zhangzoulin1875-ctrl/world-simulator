import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { sumTreatyFoodFlows, type TreatyFoodRow } from "./foodData";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";

function row(partial: Partial<TreatyFoodRow>): TreatyFoodRow {
  return {
    proposerNationId: A,
    targetNationId: B,
    perTurnFood: 0,
    requestPerTurnFood: 0,
    proposerIsPayer: true,
    ...partial,
  };
}

describe("sumTreatyFoodFlows（條約糧食輸送流量）", () => {
  it("proposerIsPayer=true：提案方 outflow、對方 inflow", () => {
    const rows = [row({ perTurnFood: 50 })];
    assert.deepEqual(sumTreatyFoodFlows(A, rows), { inflow: 0, outflow: 50 });
    assert.deepEqual(sumTreatyFoodFlows(B, rows), { inflow: 50, outflow: 0 });
  });

  it("proposerIsPayer=false：方向反轉（對方付、提案方收）", () => {
    const rows = [row({ perTurnFood: 30, proposerIsPayer: false })];
    assert.deepEqual(sumTreatyFoodFlows(A, rows), { inflow: 30, outflow: 0 });
    assert.deepEqual(sumTreatyFoodFlows(B, rows), { inflow: 0, outflow: 30 });
  });

  it("多條約累加：同國可同時輸入與輸出", () => {
    const rows = [
      row({ perTurnFood: 40 }), // A → B 40
      row({
        proposerNationId: C,
        targetNationId: A,
        perTurnFood: 25,
      }), // C → A 25
    ];
    assert.deepEqual(sumTreatyFoodFlows(A, rows), { inflow: 25, outflow: 40 });
  });

  it("與條約無關的國家流量為 0", () => {
    const rows = [row({ perTurnFood: 40 })];
    assert.deepEqual(sumTreatyFoodFlows(C, rows), { inflow: 0, outflow: 0 });
  });

  it("0／負值／小數夾成 0 或截斷（與轉移計畫同口徑）", () => {
    const rows = [
      row({ perTurnFood: 0 }),
      row({ perTurnFood: -10 }),
      row({ perTurnFood: 7.9 }),
    ];
    assert.deepEqual(sumTreatyFoodFlows(A, rows), { inflow: 0, outflow: 7 });
  });

  it("空清單回 0/0", () => {
    assert.deepEqual(sumTreatyFoodFlows(A, []), { inflow: 0, outflow: 0 });
  });

  // Task #527 — 反向每回合糧食（requestPerTurnFood）方向與 perTurnFood 相反。
  it("反向糧食：proposerIsPayer=true 時對方付、提案方收", () => {
    const rows = [row({ requestPerTurnFood: 20 })];
    assert.deepEqual(sumTreatyFoodFlows(A, rows), { inflow: 20, outflow: 0 });
    assert.deepEqual(sumTreatyFoodFlows(B, rows), { inflow: 0, outflow: 20 });
  });

  it("雙向糧食：同一條約兩方向同時計入", () => {
    const rows = [row({ perTurnFood: 50, requestPerTurnFood: 20 })];
    assert.deepEqual(sumTreatyFoodFlows(A, rows), { inflow: 20, outflow: 50 });
    assert.deepEqual(sumTreatyFoodFlows(B, rows), { inflow: 50, outflow: 20 });
  });

  it("反向糧食隨 proposerIsPayer=false 再翻轉", () => {
    const rows = [
      row({ requestPerTurnFood: 15, proposerIsPayer: false }),
    ];
    assert.deepEqual(sumTreatyFoodFlows(A, rows), { inflow: 0, outflow: 15 });
    assert.deepEqual(sumTreatyFoodFlows(B, rows), { inflow: 15, outflow: 0 });
  });

  it("反向糧食負值／小數同口徑處理", () => {
    const rows = [row({ requestPerTurnFood: -5 }), row({ requestPerTurnFood: 6.8 })];
    assert.deepEqual(sumTreatyFoodFlows(A, rows), { inflow: 6, outflow: 0 });
  });
});
