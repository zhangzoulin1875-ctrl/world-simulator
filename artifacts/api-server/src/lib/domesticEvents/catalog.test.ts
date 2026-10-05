import test from "node:test";
import assert from "node:assert/strict";
import { DOMESTIC_EVENTS, choiceIntensity, INTENSITY_RANGE, validateEventCatalog } from "./core";
import { EVENT_CATEGORIES, EVENT_CATEGORY_META, isEventCategory, categoryLabel } from "./categories";
import { ev } from "./catalog/helper";
import { TITLE_MAX, BODY_MAX, LABEL_MAX, HINT_MAX } from "./text";

test("分類表：10 個分類、id 與 label 不重複、權重為正、expectedCount 合計 100", () => {
  assert.equal(EVENT_CATEGORY_META.length, 10);
  assert.equal(new Set(EVENT_CATEGORY_META.map((m) => m.id)).size, 10);
  assert.equal(new Set(EVENT_CATEGORY_META.map((m) => m.label)).size, 10);
  assert.ok(EVENT_CATEGORY_META.every((m) => m.weight > 0));
  assert.equal(EVENT_CATEGORY_META.reduce((a, m) => a + m.expectedCount, 0), 100);
  assert.deepEqual(EVENT_CATEGORY_META.map((m) => m.id), [...EVENT_CATEGORIES]);
  assert.equal(isEventCategory("economy"), true); assert.equal(isEventCategory("nope"), false); assert.equal(isEventCategory(3), false);
  assert.equal(categoryLabel("health"), "公共衛生");
});

test("目錄：id 全域唯一且格式合法、標題全域唯一", () => {
  const ids = DOMESTIC_EVENTS.map((e) => e.kind);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((k) => /^[a-z][a-z0-9_]{2,47}$/.test(k)), "id 格式");
  const titles = DOMESTIC_EVENTS.map((e) => e.title);
  assert.equal(new Set(titles).size, titles.length, "標題不重複");
});

test("目錄：每個事件的所有數值強度都在區間內（除了特例事件），且拖延比順應輕", () => {
  for (const d of DOMESTIC_EVENTS) {
    if (d.kind === "socialist_majority") continue;
    const by = Object.fromEntries(d.choices.map((c) => [c.style, choiceIntensity(c.effects)]));
    for (const st of ["comply", "crackdown", "delay"] as const) {
      const r = INTENSITY_RANGE[st];
      assert.ok(by[st]! >= r.min && by[st]! <= r.max, `${d.kind}/${st} 強度 ${by[st]}`);
    }
  }
});

test("目錄：鎮壓都有真正的代價（穩定/議會/政治支持至少一項為負），不是免費午餐", () => {
  for (const d of DOMESTIC_EVENTS) {
    const c = d.choices.find((x) => x.style === "crackdown")!.effects;
    const cost = Math.min(0, c.stability ?? 0) + Math.min(0, c.parliamentSatisfaction ?? 0) + Math.min(0, c.politicalSupport ?? 0) + Math.min(0, c.militarySatisfaction ?? 0);
    assert.ok(cost < 0, `${d.kind} 鎮壓沒有任何負面代價`);
  }
});

test("目錄：帶內戰風險的只會是鎮壓，且該選項的穩定度必須下降（否則門檻判斷沒意義）", () => {
  for (const d of DOMESTIC_EVENTS) for (const c of d.choices) {
    if (!c.effects.civilWarRisk) continue;
    assert.equal(c.style, "crackdown", `${d.kind}/${c.id}`);
    assert.ok((c.effects.stability ?? 0) < 0, `${d.kind} 內戰風險選項的穩定度應下降`);
  }
});

test("目錄：沒有任何選項把所有數值都加成正的（至少有一項代價），防止白送", () => {
  for (const d of DOMESTIC_EVENTS) for (const c of d.choices) {
    const e = c.effects;
    const vals = [e.stability, e.money, e.politicalSupport, e.militarySatisfaction, e.parliamentSatisfaction].filter((v): v is number => typeof v === "number");
    if (c.style === "crackdown" && d.kind === "economic_crisis") continue; // 緊縮：金錢回血是設計
    assert.ok(vals.some((v) => v < 0), `${d.kind}/${c.id} 全是好處`);
  }
});

test("目錄：文字品質（沒有 em dash、標題 ≤ 12 字、敘述 ≥ 15 字、選項標題與提示非空）", () => {
  for (const d of DOMESTIC_EVENTS) {
    const all = [d.title, d.body, ...d.choices.flatMap((c) => [c.label, c.hint])].join("");
    assert.ok(!/[—–]|--/.test(all), `${d.kind} 含破折號`);
    assert.ok(d.title.length <= 12, `${d.kind} 標題太長：${d.title}`);
    assert.ok(d.body.length >= 15, `${d.kind} 敘述太短`);
    for (const c of d.choices) assert.ok(c.label.length >= 3 && c.hint.length >= 3, `${d.kind}/${c.id}`);
  }
});

test("ev() 輔助：固定順序、預設拖延、風格與 id 一致", () => {
  const d = ev("economy", "demo_event", "示範", "這是一段用來測試的敘述文字內容", 5,
    ["順", "提", { stability: 5 }], ["鎮", "示", { stability: -5 }], ["拖", "延", { stability: -1 }]);
  assert.deepEqual(d.choices.map((c) => c.id), ["comply", "crackdown", "delay"]);
  assert.deepEqual(d.choices.map((c) => c.style), ["comply", "crackdown", "delay"]);
  assert.equal(d.defaultChoiceId, "delay"); assert.equal(d.category, "economy");
});

test("驗證器：分類數量不符、標題重複、id 格式錯誤都會被抓到", () => {
  const sample = DOMESTIC_EVENTS[0]!;
  const dup = [sample, { ...sample, kind: "another_one" }];
  assert.ok(validateEventCatalog(dup).some((p) => p.includes("標題與別的事件重複")));
  assert.ok(validateEventCatalog([{ ...sample, kind: "Bad-Id" }]).some((p) => p.includes("id 格式")));
  assert.ok(validateEventCatalog([{ ...sample, category: "nope" as any }]).some((p) => p.includes("分類不存在")));
});

test("目錄：模板文字不超過 AI 改寫的長度上限，且不含具體數字（模板會直接顯示給玩家）", () => {
  for (const d of DOMESTIC_EVENTS) {
    assert.ok(d.title.length <= TITLE_MAX, `${d.kind} 標題 ${d.title.length} > ${TITLE_MAX}`);
    assert.ok(d.body.length <= BODY_MAX, `${d.kind} 敘述 ${d.body.length} > ${BODY_MAX}`);
    for (const c of d.choices) {
      assert.ok(c.label.length <= LABEL_MAX, `${d.kind}/${c.id} 選項 ${c.label.length} > ${LABEL_MAX}：${c.label}`);
      assert.ok(c.hint.length <= HINT_MAX, `${d.kind}/${c.id} 提示 ${c.hint.length} > ${HINT_MAX}：${c.hint}`);
    }
    const all = [d.title, d.body, ...d.choices.flatMap((c) => [c.label, c.hint])].join(" ");
    assert.ok(!/[0-9０-９]{2,}/.test(all), `${d.kind} 文字含具體數字`);
  }
});
