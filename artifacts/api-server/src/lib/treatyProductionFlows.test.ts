import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  sumTreatyProductionFlows,
  type TreatyProductionRow,
} from "./treatyProductionFlows";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";

function row(partial: Partial<TreatyProductionRow>): TreatyProductionRow {
  return {
    proposerNationId: A,
    targetNationId: B,
    perTurnProduction: 0,
    requestPerTurnProduction: 0,
    proposerIsPayer: true,
    ...partial,
  };
}

describe("sumTreatyProductionFlows（條約生產力輸送流量）", () => {
  it("proposerIsPayer=true：提案方 outflow、對方 inflow", () => {
    const rows = [row({ perTurnProduction: 50 })];
    assert.deepEqual(sumTreatyProductionFlows(A, rows), {
      inflow: 0,
      outflow: 50,
    });
    assert.deepEqual(sumTreatyProductionFlows(B, rows), {
      inflow: 50,
      outflow: 0,
    });
  });

  it("proposerIsPayer=false：方向反轉（對方付、提案方收）", () => {
    const rows = [row({ perTurnProduction: 30, proposerIsPayer: false })];
    assert.deepEqual(sumTreatyProductionFlows(A, rows), {
      inflow: 30,
      outflow: 0,
    });
    assert.deepEqual(sumTreatyProductionFlows(B, rows), {
      inflow: 0,
      outflow: 30,
    });
  });

  it("多筆條約：inflow/outflow 各自加總", () => {
    const rows = [
      row({ perTurnProduction: 40 }), // A → B 40
      row({
        proposerNationId: C,
        targetNationId: A,
        perTurnProduction: 25,
      }), // C → A 25
    ];
    assert.deepEqual(sumTreatyProductionFlows(A, rows), {
      inflow: 25,
      outflow: 40,
    });
  });

  it("與條約無關的國家：全 0", () => {
    const rows = [row({ perTurnProduction: 40 })];
    assert.deepEqual(sumTreatyProductionFlows(C, rows), {
      inflow: 0,
      outflow: 0,
    });
  });

  it("0／負值／小數：夾成 0 或截斷（同 planCustomTreatyTransfers 口徑）", () => {
    const rows = [
      row({ perTurnProduction: 0 }),
      row({ perTurnProduction: -10 }),
      row({ perTurnProduction: 7.9 }),
    ];
    assert.deepEqual(sumTreatyProductionFlows(A, rows), {
      inflow: 0,
      outflow: 7,
    });
  });

  // Task #527 — 反向每回合生產力（requestPerTurnProduction）方向與 perTurn 相反。
  it("反向輸送：受益方 outflow、付款方 inflow", () => {
    const rows = [row({ requestPerTurnProduction: 20 })];
    assert.deepEqual(sumTreatyProductionFlows(A, rows), {
      inflow: 20,
      outflow: 0,
    });
    assert.deepEqual(sumTreatyProductionFlows(B, rows), {
      inflow: 0,
      outflow: 20,
    });
  });

  it("雙向同時存在：兩方向各自計入", () => {
    const rows = [
      row({ perTurnProduction: 50, requestPerTurnProduction: 20 }),
    ];
    assert.deepEqual(sumTreatyProductionFlows(A, rows), {
      inflow: 20,
      outflow: 50,
    });
    assert.deepEqual(sumTreatyProductionFlows(B, rows), {
      inflow: 50,
      outflow: 20,
    });
  });

  it("反向 + proposerIsPayer=false：提案方 outflow", () => {
    const rows = [
      row({ requestPerTurnProduction: 15, proposerIsPayer: false }),
    ];
    assert.deepEqual(sumTreatyProductionFlows(A, rows), {
      inflow: 0,
      outflow: 15,
    });
    assert.deepEqual(sumTreatyProductionFlows(B, rows), {
      inflow: 15,
      outflow: 0,
    });
  });

  it("反向負值/小數：夾 0／截斷", () => {
    const rows = [
      row({ requestPerTurnProduction: -5 }),
      row({ requestPerTurnProduction: 6.8 }),
    ];
    assert.deepEqual(sumTreatyProductionFlows(A, rows), {
      inflow: 6,
      outflow: 0,
    });
  });
});
