import test from "node:test";
import assert from "node:assert/strict";
import { penaltyScaleFor, scaleMoney, scaleEffectsMoney, scaleFocusMoneyEffects } from "./penaltyScale";
import { standardNationPopulation, STANDARD_TAX_RATE_PCT } from "./nationCostScale";
import { ERA_COST_SCALE } from "./eraCostScale";
import { computeTaxIncome, taxEfficiencyPctForEra } from "./economy";
import { submitCostFor, SUBMIT_COST_MONEY } from "./constitution/core";
import { reportCostFor, REPORT_COST_MONEY } from "./parliament/reportCore";

const stdTax = (era: string) =>
  computeTaxIncome({ population: Math.round(standardNationPopulation(era)), taxRatePct: STANDARD_TAX_RATE_PCT, taxEfficiencyPct: taxEfficiencyPctForEra(era) });
const stdScale = (era: string) => penaltyScaleFor(Math.round(standardNationPopulation(era)), era);

test("古典標準國倍率 = 1:基準價原值不變", () => {
  assert.equal(stdScale("classical"), 1);
  assert.equal(scaleMoney(-1250, stdScale("classical")), -1250);
});

test("跨時代痛感一致:標準國同一筆基準價,占「每回合標準稅收」的比例各時代相差 < 3%(解決中後期毫無感覺)", () => {
  const ratios = Object.keys(ERA_COST_SCALE).map((era) => Math.abs(scaleMoney(-1250, stdScale(era))) / stdTax(era));
  const lo = Math.min(...ratios), hi = Math.max(...ratios);
  assert.ok((hi - lo) / lo < 0.03, `ratios ${lo.toFixed(3)} ~ ${hi.toFixed(3)}`);
  assert.ok(lo > 4 && hi < 5, "約 4.5 回合的標準稅收");
});

test("時代越後面金額越大(單調遞增),未來比古典大三個數量級以上", () => {
  const eras = Object.keys(ERA_COST_SCALE);
  const v = eras.map((e) => Math.abs(scaleMoney(-1250, stdScale(e))));
  for (let i = 1; i < v.length; i++) assert.ok(v[i]! > v[i - 1]!, `${eras[i]} 應大於 ${eras[i - 1]}`);
  assert.ok(v.at(-1)! / v[0]! > 1000);
});

test("國力倍率:小國較便宜、大國較貴但貴得比國力慢(沿用造價曲線)", () => {
  const era = "industrial", std = Math.round(standardNationPopulation(era));
  const small = penaltyScaleFor(std / 4, era), mid = penaltyScaleFor(std, era), big = penaltyScaleFor(std * 4, era);
  assert.ok(small < mid && mid < big);
  assert.ok(big / mid < 4, "大國價格漲幅小於國力漲幅");
  assert.ok(mid / small < 4, "小國有補貼:價格降得比國力慢");
});

test("scaleMoney:保留正負號;獎勵與代價用同一倍率;非零不會縮成 0;0 還是 0", () => {
  assert.equal(scaleMoney(-100, 10), -1000);
  assert.equal(scaleMoney(100, 10), 1000);
  assert.equal(scaleMoney(0, 10), 0);
  assert.equal(scaleMoney(-1, 0.05), -1, "最小代價至少 1,方向不變");
  assert.equal(scaleMoney(5, 0.01), 1);
  assert.ok(Number.isNaN(scaleMoney(NaN, 3)));
});

test("scaleEffectsMoney:只動 money,其他欄位(穩定度/支持/滿意度)原樣;沒有 money 時回傳同一物件", () => {
  const e = { stability: 5, money: -800, politicalSupport: -3 };
  assert.deepEqual(scaleEffectsMoney(e, 100), { stability: 5, money: -80000, politicalSupport: -3 });
  const noMoney = { stability: 5 };
  assert.equal(scaleEffectsMoney(noMoney, 100), noMoney);
});

test("scaleFocusMoneyEffects:只縮金錢 grant(獎勵與代價),其他 grant/效果原樣", () => {
  const list = [
    { kind: "grant", stat: "money", value: -1200 },
    { kind: "grant", stat: "money", value: 2500 },
    { kind: "grant", stat: "stability", value: -10 },
    { kind: "lean", side: "red", value: 5 },
  ] as any[];
  const out = scaleFocusMoneyEffects(list, 100);
  assert.equal(out[0].value, -120000);
  assert.equal(out[1].value, 250000);
  assert.equal(out[2].value, -10, "穩定度是百分點,不隨時代變");
  assert.equal(out[3], list[3]);
  assert.equal(list[0].value, -1200, "不改動原目錄物件");
});

test("無效倍率:憲法/國情報告費退回基準價,不會變 NaN 或 0", () => {
  for (const bad of [NaN, 0, -3, Infinity]) {
    assert.equal(submitCostFor(bad), SUBMIT_COST_MONEY, `倍率 ${bad} 應退回基準價`);
    assert.equal(reportCostFor(bad), REPORT_COST_MONEY);
  }
  assert.equal(submitCostFor(148), 148_000);
  assert.equal(reportCostFor(148), 74_000);
  assert.equal(reportCostFor(1), REPORT_COST_MONEY);
});
