import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  COST_TUNING_DEFAULT, COST_LINEAR_RANGE, COST_CURVE_RANGE, getCostTuning, setCostTuning, sanitizeCostTuning,
  priceFactor, upkeepFactor, effectivePriceScale, effectiveUpkeepScale, standardNationPopulation, powerRatio,
} from "./nationCostScale";
import { penaltyScaleFor, scaleMoney } from "./penaltyScale";
import { submitCostFor } from "./constitution/core";
import { reportCostFor } from "./parliament/reportCore";

afterEach(() => setCostTuning(COST_TUNING_DEFAULT));
const stdPop = (era: string) => Math.round(standardNationPopulation(era));

test("預設 100/100:所有價格與調整前逐位相同(不破壞現狀)", () => {
  // 用「未設定過旋鈕」與「明確設 100/100」比對一組代表值,必須完全一致
  const sample = () => [
    effectivePriceScale(148, stdPop("industrial"), "industrial"),
    effectivePriceScale(148, stdPop("industrial") / 4, "industrial"),
    effectivePriceScale(148, stdPop("industrial") * 4, "industrial"),
    effectiveUpkeepScale(148, stdPop("industrial") * 4, "industrial"),
    penaltyScaleFor(stdPop("renaissance"), "renaissance"),
    penaltyScaleFor(stdPop("modern") / 3, "modern"),
    priceFactor(0.3), priceFactor(5), upkeepFactor(0.3), upkeepFactor(9),
  ];
  const before = sample();
  setCostTuning({ linearPct: 100, curvePct: 100 });
  assert.deepEqual(sample(), before);
  assert.deepEqual(getCostTuning(), { linearPct: 100, curvePct: 100 });
  // 已知的歷史值(第一版驗證過):工業時代標準國 priceFactor=1,penalty 倍率約 22.79
  assert.equal(priceFactor(1), 1);
  assert.equal(penaltyScaleFor(stdPop("industrial"), "industrial"), 22.792);
});

test("線性滑竿:所有價格等比例縮放,各時代比例與國力曲線形狀不變", () => {
  const eras = ["classical", "renaissance", "industrial", "modern"];
  const at = (lin: number) => { setCostTuning({ linearPct: lin, curvePct: 100 }); return eras.map((e) => [effectivePriceScale(1, stdPop(e), e), effectiveUpkeepScale(1, stdPop(e), e)]); };
  const base = at(100), half = at(50), dbl = at(200);
  base.forEach((row, i) => row.forEach((v, j) => {
    assert.ok(Math.abs(half[i]![j]! - v * 0.5) <= 0.0002, `50% era#${i} col${j}`);
    assert.ok(Math.abs(dbl[i]![j]! - v * 2) <= 0.0002, `200% era#${i} col${j}`);
  }));
  // 大小國的價差比不變:純線性不改曲線形狀
  const ratio = (lin: number) => { setCostTuning({ linearPct: lin, curvePct: 100 }); return effectivePriceScale(1, stdPop("modern") * 4, "modern") / effectivePriceScale(1, stdPop("modern") / 4, "modern"); };
  assert.ok(Math.abs(ratio(100) - ratio(300)) < 0.01);
});

test("線性滑竿同樣作用在事件/國策/憲法/國情報告(penaltyScaleFor 與主動費用)", () => {
  const k100 = penaltyScaleFor(stdPop("industrial"), "industrial");
  setCostTuning({ linearPct: 300, curvePct: 100 });
  const k300 = penaltyScaleFor(stdPop("industrial"), "industrial");
  assert.ok(Math.abs(k300 / k100 - 3) < 0.01, `${k300 / k100}`);
  assert.equal(scaleMoney(-1800, k300) / scaleMoney(-1800, k100) > 2.99, true);
  assert.ok(submitCostFor(k300) > submitCostFor(k100) * 2.9);
  assert.ok(reportCostFor(k300) > reportCostFor(k100) * 2.9);
});

test("函數滑竿 0%:不分大小國,一律標準價(f=1)", () => {
  setCostTuning({ linearPct: 100, curvePct: 0 });
  for (const r of [0.05, 0.3, 1, 4, 30]) assert.equal(priceFactor(r), 1, `r=${r}`);
  for (const r of [0.05, 0.3, 1, 4, 30]) assert.equal(upkeepFactor(r), 1, `r=${r}`);
  const small = penaltyScaleFor(stdPop("modern") / 8, "modern"), big = penaltyScaleFor(stdPop("modern") * 8, "modern"), std = penaltyScaleFor(stdPop("modern"), "modern");
  assert.equal(small, std); assert.equal(big, std);
});

test("函數滑竿:標準國(r=1)永遠不受影響;200% 讓大小國價差拉大,50% 縮小", () => {
  const spread = (c: number) => { setCostTuning({ linearPct: 100, curvePct: c }); return priceFactor(6) / priceFactor(0.2); };
  for (const c of [0, 50, 100, 150, 200]) { setCostTuning({ linearPct: 100, curvePct: c }); assert.equal(priceFactor(1), 1, `curve ${c}`); }
  assert.ok(spread(50) < spread(100) && spread(100) < spread(200), `${spread(50)} ${spread(100)} ${spread(200)}`);
  assert.ok(spread(0) === 1);
  // 大國(r>1)越陡越貴、小國(r<1)越陡越便宜
  setCostTuning({ curvePct: 50 }); const big50 = priceFactor(6), small50 = priceFactor(0.2);
  setCostTuning({ curvePct: 200 }); const big200 = priceFactor(6), small200 = priceFactor(0.2);
  assert.ok(big200 > big50 && small200 < small50);
});

test("夾限仍有效:極端旋鈕與極端國力都不會出現 0、NaN、Infinity", () => {
  for (const [lin, cur] of [[10, 0], [10, 200], [500, 0], [500, 200]] as const) {
    setCostTuning({ linearPct: lin, curvePct: cur });
    for (const r of [0, 1e-9, 0.001, 1, 1e3, 1e9]) {
      const p = priceFactor(r), u = upkeepFactor(r);
      assert.ok(Number.isFinite(p) && p > 0 && p <= 20, `price r=${r} ${lin}/${cur}: ${p}`);
      assert.ok(Number.isFinite(u) && u >= 0.25 && u <= 4, `upkeep r=${r}: ${u}`);
    }
    for (const era of ["classical", "modern", "future"]) {
      const k = penaltyScaleFor(stdPop(era) * 50, era);
      assert.ok(Number.isFinite(k) && k > 0 && k >= lin / 100, `${era} ${lin}/${cur}: ${k}(下限 = 線性旋鈕本身)`);
    }
  }
});

test("滑竿在『每個時代、每種國力』都有感:拉高變貴、拉低變便宜,不會被下限吃掉(含古典與人口 0)", () => {
  const eras = ["classical", "roman", "early_medieval", "renaissance", "industrial", "modern", "future"];
  for (const era of eras) for (const mult of [0, 0.05, 0.25, 1, 4]) {
    const at = (lin: number) => { setCostTuning({ linearPct: lin, curvePct: 100 }); return penaltyScaleFor(Math.round(stdPop(era) * mult), era); };
    const lo = at(50), mid = at(100), hi = at(300), max = at(500);
    assert.ok(lo < mid && mid < hi && hi < max, `${era} ×${mult}: ${lo} ${mid} ${hi} ${max}`);
  }
});

test("預設 100% 時下限仍是 1:古典/小國不會比原本寫死的基準價更便宜;拉到 10% 才允許更便宜", () => {
  for (const era of ["classical", "roman", "future"]) assert.ok(penaltyScaleFor(0, era) >= 1, era);
  assert.equal(submitCostFor(1), 1000);
  assert.equal(reportCostFor(1), 500);
  setCostTuning({ linearPct: COST_LINEAR_RANGE.min, curvePct: 100 });
  assert.equal(penaltyScaleFor(0, "classical"), 0.1, "管理員明確調低時,下限同步降低");
  assert.ok(submitCostFor(0.1) < 1000 && submitCostFor(0.1) >= 1, "憲法費也跟著變便宜,但不為 0");
  assert.ok(reportCostFor(0.1) >= 1);
});

test("憲法/國情報告費也隨線性旋鈕變動(古典與現代都有感)", () => {
  for (const era of ["classical", "modern"]) {
    const cost = (lin: number) => { setCostTuning({ linearPct: lin, curvePct: 100 }); const k = penaltyScaleFor(stdPop(era), era); return [submitCostFor(k), reportCostFor(k)]; };
    const [s50, r50] = cost(50), [s100, r100] = cost(100), [s300, r300] = cost(300);
    assert.ok(s50 < s100 && s100 < s300, `${era} 憲法 ${s50} ${s100} ${s300}`);
    assert.ok(r50 < r100 && r100 < r300, `${era} 報告 ${r50} ${r100} ${r300}`);
  }
});

test("sanitize:非法值夾回範圍、取整,NaN/字串/null/undefined 用預設", () => {
  assert.deepEqual(sanitizeCostTuning({ linearPct: 0, curvePct: -50 }), { linearPct: COST_LINEAR_RANGE.min, curvePct: COST_CURVE_RANGE.min });
  assert.deepEqual(sanitizeCostTuning({ linearPct: 9999, curvePct: 9999 }), { linearPct: COST_LINEAR_RANGE.max, curvePct: COST_CURVE_RANGE.max });
  assert.deepEqual(sanitizeCostTuning({ linearPct: 150.6, curvePct: 33.4 }), { linearPct: 151, curvePct: 33 });
  assert.deepEqual(sanitizeCostTuning({ linearPct: NaN, curvePct: Infinity } as any), { linearPct: 100, curvePct: 100 });
  assert.deepEqual(sanitizeCostTuning({ linearPct: "200" as any, curvePct: null as any }), { linearPct: 100, curvePct: 100 });
  assert.deepEqual(sanitizeCostTuning(null), { linearPct: 100, curvePct: 100 });
  assert.deepEqual(sanitizeCostTuning(undefined), { linearPct: 100, curvePct: 100 });
  setCostTuning({ linearPct: 777777, curvePct: -1 });
  assert.deepEqual(getCostTuning(), { linearPct: 500, curvePct: 0 }, "setCostTuning 也會夾限");
});

test("getCostTuning 回傳副本:外部改動不會影響內部狀態", () => {
  const t = getCostTuning(); t.linearPct = 999;
  assert.equal(getCostTuning().linearPct, 100);
});

test("兩個滑竿互相獨立:同時調整時效果可疊加(線性乘在曲線之上)", () => {
  setCostTuning({ linearPct: 100, curvePct: 150 });
  const onlyCurve = effectivePriceScale(1, stdPop("modern") * 4, "modern");
  setCostTuning({ linearPct: 200, curvePct: 150 });
  const both = effectivePriceScale(1, stdPop("modern") * 4, "modern");
  assert.ok(Math.abs(both / onlyCurve - 2) < 0.001);
  assert.ok(powerRatio(stdPop("modern") * 4, "modern") > 3.9);
});
