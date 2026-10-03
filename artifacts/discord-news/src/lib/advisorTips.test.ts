import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_TIPS, resolveTipPool } from "./advisorTips.ts";

/**
 * Task #306 — 顧問閒置小tip 題庫選擇的守門測試。
 *
 * 首頁閒置小tip 優先用玩家自訂 advisorTips，為空時必須退回內建題庫。若有人把
 * fallback 拿掉（例如 advisorTips 為空時直接回空陣列），閒置泡泡就會消失——這裡
 * 就會亮紅燈。
 */
describe("resolveTipPool", () => {
  it("有玩家自訂 tips 時，使用自訂題庫", () => {
    const custom = ["自訂提示一", "自訂提示二"];
    assert.equal(resolveTipPool(custom), custom);
  });

  it("advisorTips 為空陣列 → 退回內建題庫", () => {
    assert.equal(resolveTipPool([]), BUILTIN_TIPS);
  });

  it("advisorTips 為 undefined／null → 退回內建題庫", () => {
    assert.equal(resolveTipPool(undefined), BUILTIN_TIPS);
    assert.equal(resolveTipPool(null), BUILTIN_TIPS);
  });

  it("內建題庫非空，閒置時一定挑得到一則", () => {
    assert.ok(BUILTIN_TIPS.length > 0);
    const pool = resolveTipPool([]);
    assert.ok(pool.length > 0);
  });

  it("可傳入自訂內建題庫（供測試／未來擴充）", () => {
    const alt = ["備用一"];
    assert.equal(resolveTipPool([], alt), alt);
    assert.equal(resolveTipPool(undefined, alt), alt);
  });
});
