import test from "node:test";
import assert from "node:assert/strict";
import { validateCatalog, exclusiveSiblings } from "./validate";
import { SAMPLE_CATALOG } from "./catalog.sample";
import type { FocusDef } from "./types";

const mk = (over: Partial<FocusDef> & { id: string }): FocusDef => ({
  domain: "military", track: "stable", slot: "main",
  title: "t", description: "d", cost: 5, turns: 3, requires: [],
  effects: [{ kind: "modifier", stat: "taxIncome", value: -1 }],
  ...over,
});

test("範例目錄通過全部驗證規則", () => {
  assert.deepEqual(validateCatalog(SAMPLE_CATALOG), []);
});

test("範例目錄:三選一互斥分岔與黑/紅線轉型確實存在", () => {
  const doctrine = SAMPLE_CATALOG.filter((d) => d.exclusiveGroup === "mil_doctrine_1");
  assert.equal(doctrine.length, 3);
  const trans = SAMPLE_CATALOG.filter((d) => d.effects.some((e) => e.kind === "transition"));
  assert.ok(trans.length >= 3);
  assert.ok(trans.every((d) => d.milestone && (d.conditions?.length ?? 0) > 0 || d.id === "regime.to_constitutional_monarchy"));
  const sib = exclusiveSiblings(SAMPLE_CATALOG, doctrine[0]!);
  assert.equal(sib.length, 2);
});

test("驗證器:沒有代價會被抓到(反流水帳)", () => {
  const bad = mk({ id: "mil.free_lunch", effects: [{ kind: "modifier", stat: "taxIncome", value: 10 }] });
  assert.ok(validateCatalog([bad]).some((p) => p.includes("沒有任何代價")));
});

test("驗證器:armyUpkeep 負值是省錢(不算代價),正值才是代價", () => {
  const saves = mk({ id: "mil.cheap", effects: [{ kind: "modifier", stat: "armyUpkeep", value: -10 }] });
  assert.ok(validateCatalog([saves]).some((p) => p.includes("沒有任何代價")));
  const costs = mk({ id: "mil.pricey", effects: [{ kind: "modifier", stat: "armyUpkeep", value: 10 }] });
  assert.ok(!validateCatalog([costs]).some((p) => p.includes("沒有任何代價")));
});

test("驗證器:互斥群組只有一個選項、里程碑無能力、引用不存在、成環", () => {
  const lone = mk({ id: "mil.a", exclusiveGroup: "g" });
  assert.ok(validateCatalog([lone]).some((p) => p.includes("互斥群組 g 只有 1")));

  const emptyMile = mk({ id: "mil.m", milestone: true });
  assert.ok(validateCatalog([emptyMile]).some((p) => p.includes("里程碑但沒有")));

  const dangling = mk({ id: "mil.d", requires: ["mil.ghost"] });
  assert.ok(validateCatalog([dangling]).some((p) => p.includes("不存在的國策")));

  const a = mk({ id: "mil.x", requires: ["mil.y"] });
  const b = mk({ id: "mil.y", requires: ["mil.x"] });
  assert.ok(validateCatalog([a, b]).some((p) => p.includes("前置成環")));
});

test("驗證器:轉型國策限制(領域/目標政體/里程碑)與無效 slug", () => {
  const t = mk({
    id: "mil.bad_trans", milestone: false,
    effects: [{ kind: "transition", toGovernment: "no_such_gov" }, { kind: "grant", stat: "money", value: -1 }],
  });
  const p = validateCatalog([t]);
  assert.ok(p.some((x) => x.includes("只能出現在 regime")));
  assert.ok(p.some((x) => x.includes("轉型目標政體不存在")));
  assert.ok(p.some((x) => x.includes("必須是里程碑")));

  const g = mk({ id: "mil.g", governments: ["nope"], minEra: "nope_era" });
  const q = validateCatalog([g]);
  assert.ok(q.some((x) => x.includes("政體 slug 無效")));
  assert.ok(q.some((x) => x.includes("minEra 無效")));
});

test("驗證器:重複 id 與 id 格式", () => {
  const p = validateCatalog([mk({ id: "mil.dup" }), mk({ id: "mil.dup" }), mk({ id: "BadId" })]);
  assert.ok(p.some((x) => x.includes("重複 id")));
  assert.ok(p.some((x) => x.includes("id 格式")));
});
