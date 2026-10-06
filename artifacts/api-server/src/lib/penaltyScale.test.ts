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

test("高中世紀(含)之後:標準國的事件/國策/主動行為占『每回合標準稅收』的比例各時代幾乎相同(約 1 回合),解決中後期毫無感覺", () => {
  const late = Object.keys(ERA_COST_SCALE).filter((e) => (ERA_COST_SCALE[e] ?? 0) >= 14.9); // 文藝復興以後
  const ratios = late.map((era) => Math.abs(scaleMoney(-1800, stdScale(era))) / stdTax(era));
  const lo = Math.min(...ratios), hi = Math.max(...ratios);
  assert.ok((hi - lo) / lo < 0.05, `事件平均占稅收 ${lo.toFixed(3)} ~ ${hi.toFixed(3)} 回合`);
  assert.ok(lo > 0.9 && hi < 1.15, "事件平均約 1 回合稅收");
});

test("回合預算:標準國同一回合最壞情況(事件最大+國策+憲法+報告同時)不超過 3 回合稅收", () => {
  for (const era of Object.keys(ERA_COST_SCALE).filter((e) => (ERA_COST_SCALE[e] ?? 0) >= 14.9)) {
    const k = stdScale(era);
    const worst = Math.abs(scaleMoney(-2500, k)) + Math.abs(scaleMoney(-1200, k)) + submitCostFor(k) + reportCostFor(k);
    assert.ok(worst / stdTax(era) < 3, `${era} 最壞 ${(worst / stdTax(era)).toFixed(2)} 回合稅收`);
  }
});

test("下限 1:任何時代、任何國力都不會比原本寫死的基準價更便宜(古典/小國不被縮放補貼到免費)", () => {
  for (const era of Object.keys(ERA_COST_SCALE)) {
    assert.ok(penaltyScaleFor(0, era) >= 1 && penaltyScaleFor(1, era) >= 1 && stdScale(era) >= 1, era);
  }
  assert.equal(stdScale("classical"), 1);
});

test("時代越後面金額越大(單調不減),未來比古典大兩個數量級以上", () => {
  const eras = Object.keys(ERA_COST_SCALE);
  const v = eras.map((e) => Math.abs(scaleMoney(-1250, stdScale(e))));
  for (let i = 1; i < v.length; i++) assert.ok(v[i]! >= v[i - 1]!, `${eras[i]} 不應小於 ${eras[i - 1]}`);
  assert.ok(v.at(-1)! / v[0]! > 100);
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
  assert.equal(submitCostFor(148), 74_000);
  assert.equal(reportCostFor(148), 37_000);
  assert.equal(reportCostFor(1), REPORT_COST_MONEY);
  assert.equal(submitCostFor(1.2), SUBMIT_COST_MONEY, "低倍率不低於古典基準價");
});

// ── 回合預算守門員:之後新增事件/國策,單筆金錢代價不得超過預算 ──
import { DOMESTIC_EVENTS } from "./domesticEvents/core";
import { FOCUS_CATALOG } from "./focus/catalog";

/** 單筆金錢代價的基準價上限(古典量級)。超過代表那一筆在中後期會吃掉超過 ~1.5 回合稅收。 */
const MAX_EVENT_MONEY_COST = 2500;
const MAX_FOCUS_MONEY_COST = 2500;

test("守門:所有事件選項的金錢代價基準價 <= 2500(新增事件不得悄悄加重負擔)", () => {
  const bad = DOMESTIC_EVENTS.flatMap((d) => d.choices.filter((c) => (c.effects.money ?? 0) < -MAX_EVENT_MONEY_COST).map((c) => `${d.kind}/${c.id}:${c.effects.money}`));
  assert.deepEqual(bad, [], `超過上限:${bad.join(", ")}`);
});

test("守門:所有國策的金錢代價基準價 <= 2500", () => {
  const bad: string[] = [];
  for (const f of Object.values(FOCUS_CATALOG as Record<string, any>)) {
    for (const e of f.effects ?? []) if (e.kind === "grant" && e.stat === "money" && e.value < -MAX_FOCUS_MONEY_COST) bad.push(`${f.id}:${e.value}`);
  }
  assert.deepEqual(bad, [], `超過上限:${bad.join(", ")}`);
});

test("守門:標準國單筆最大代價(事件 2500)在文藝復興以後不超過 1.5 回合稅收", () => {
  for (const era of Object.keys(ERA_COST_SCALE).filter((e) => (ERA_COST_SCALE[e] ?? 0) >= 14.9)) {
    const r = Math.abs(scaleMoney(-MAX_EVENT_MONEY_COST, stdScale(era))) / stdTax(era);
    assert.ok(r < 1.5, `${era}: ${r.toFixed(2)} 回合稅收`);
  }
});
