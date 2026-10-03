/**
 * Task #548 — 三領域科研點數分配（最大餘數法）純函式測試。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocateResearchPoints } from "./researchAllocation";

function sum(a: { social: number; production: number; military: number }) {
  return a.social + a.production + a.military;
}

describe("allocateResearchPoints", () => {
  it("33/33/34 拆 10 → 3/3/4（總和守恆）", () => {
    const a = allocateResearchPoints(10, {
      social: 33,
      production: 33,
      military: 34,
    });
    assert.deepEqual(a, { social: 3, production: 3, military: 4 });
  });

  it("比例合計 100 時總和恆等於收入（floor 餘數不丟失）", () => {
    const cases: [number, [number, number, number]][] = [
      [10, [33, 33, 34]],
      [7, [50, 25, 25]],
      [1, [33, 33, 34]],
      [99, [1, 1, 98]],
      [100, [40, 30, 30]],
      [123456, [17, 41, 42]],
    ];
    for (const [total, [s, p, m]] of cases) {
      const a = allocateResearchPoints(total, {
        social: s,
        production: p,
        military: m,
      });
      assert.equal(sum(a), total, `total=${total} ratios=${s}/${p}/${m}`);
    }
  });

  it("餘數並列時依 social → production → military 固定順序", () => {
    // 5 × 50/25/25 → 2.5/1.25/1.25：floors 2/1/1，剩 1 → social（餘數最大）。
    const a = allocateResearchPoints(5, {
      social: 50,
      production: 25,
      military: 25,
    });
    assert.deepEqual(a, { social: 3, production: 1, military: 1 });
    // 3 × 0/50/50 → production 與 military 並列 → production 先補。
    const b = allocateResearchPoints(3, {
      social: 0,
      production: 50,
      military: 50,
    });
    assert.deepEqual(b, { social: 0, production: 2, military: 1 });
  });

  it("收入 0／負值或比例全 0 → 全 0", () => {
    const zero = { social: 0, production: 0, military: 0 };
    assert.deepEqual(
      allocateResearchPoints(0, { social: 33, production: 33, military: 34 }),
      zero,
    );
    assert.deepEqual(
      allocateResearchPoints(-5, { social: 33, production: 33, military: 34 }),
      zero,
    );
    assert.deepEqual(allocateResearchPoints(10, zero), zero);
  });

  it("比例合計 < 100 → 未分配份額作廢（總和 = floor(收入 × 合計 / 100)）", () => {
    const a = allocateResearchPoints(200, {
      social: 50,
      production: 0,
      military: 0,
    });
    assert.deepEqual(a, { social: 100, production: 0, military: 0 });
    const b = allocateResearchPoints(10, {
      social: 30,
      production: 30,
      military: 0,
    });
    assert.equal(sum(b), 6, "60% 分配 → 只分 6 點");
  });

  it("比例合計 > 100（防禦）→ 正規化後總和仍 = 收入", () => {
    const a = allocateResearchPoints(3, {
      social: 50,
      production: 50,
      military: 50,
    });
    assert.equal(sum(a), 3);
    assert.deepEqual(a, { social: 1, production: 1, military: 1 });
  });

  it("非整數輸入取整；非有限比例視為 0", () => {
    const a = allocateResearchPoints(10.9, {
      social: 33,
      production: 33,
      military: 34,
    });
    assert.equal(sum(a), 10, "收入 floor 取整");
    const b = allocateResearchPoints(10, {
      social: Number.NaN,
      production: 50,
      military: 50,
    });
    assert.deepEqual(b, { social: 0, production: 5, military: 5 });
  });
});
