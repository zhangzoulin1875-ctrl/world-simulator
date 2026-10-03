import { strict as assert } from "node:assert";
import test from "node:test";
import {
  GOVERNMENTS,
  ERA_RECOMMENDED_GOVERNMENTS,
  DEFAULT_GOVERNMENT_SLUG,
  FOUNDING_GOVERNMENT_SLUGS,
  isFoundingGovernmentSlug,
  COUP_GOVERNMENT_SLUGS,
  isGovernmentSlug,
  governmentLabel,
  governmentSlugByLabel,
  governmentDecisionDifficulty,
  recommendedGovernmentsForEra,
  validateGovernmentTables,
} from "./governments";
import { ERAS } from "./mapRegionEras";

test("有 14 種政體且 slug 唯一", () => {
  assert.equal(GOVERNMENTS.length, 14);
  const slugs = GOVERNMENTS.map((g) => g.slug);
  assert.equal(new Set(slugs).size, 14);
});

test("政體 label 唯一且非空、description 非空", () => {
  const labels = GOVERNMENTS.map((g) => g.label);
  assert.equal(new Set(labels).size, GOVERNMENTS.length);
  for (const g of GOVERNMENTS) {
    assert.ok(g.label.trim().length > 0, `label empty for ${g.slug}`);
    assert.ok(g.description.trim().length > 0, `description empty for ${g.slug}`);
  }
});

test("isGovernmentSlug 接受所有已定義 slug、拒絕未知值", () => {
  for (const g of GOVERNMENTS) {
    assert.equal(isGovernmentSlug(g.slug), true, g.slug);
  }
  assert.equal(isGovernmentSlug("not_a_government"), false);
  assert.equal(isGovernmentSlug(""), false);
  // zh-TW label is not a slug
  assert.equal(isGovernmentSlug("君主專制"), false);
});

test("governmentLabel 回傳 zh-TW label，未知 slug 回 null", () => {
  assert.equal(governmentLabel("absolute_monarchy"), "君主專制");
  assert.equal(governmentLabel("confederation"), "邦聯制");
  assert.equal(governmentLabel("nope"), null);
});

test("14 個時代皆有推薦政體、slug 均存在且不重複", () => {
  assert.equal(ERAS.length, 14);
  const known = new Set(GOVERNMENTS.map((g) => g.slug));
  for (const era of ERAS) {
    const recs = ERA_RECOMMENDED_GOVERNMENTS[era.slug];
    assert.ok(recs && recs.length > 0, `era ${era.slug} 缺少推薦政體`);
    assert.equal(
      new Set(recs).size,
      recs.length,
      `era ${era.slug} 推薦政體重複`,
    );
    for (const slug of recs) {
      assert.ok(known.has(slug), `era ${era.slug} 引用未知政體 ${slug}`);
    }
  }
});

test("推薦表沒有多出未定義時代的鍵", () => {
  const eraSlugs = new Set(ERAS.map((e) => e.slug));
  for (const key of Object.keys(ERA_RECOMMENDED_GOVERNMENTS)) {
    assert.ok(eraSlugs.has(key), `推薦表出現未知時代 ${key}`);
  }
});

test("recommendedGovernmentsForEra 已知時代回推薦清單、未知時代回空陣列", () => {
  assert.deepEqual(recommendedGovernmentsForEra("classical"), [
    "absolute_monarchy",
    "aristocracy",
    "military_dictatorship",
  ]);
  assert.deepEqual(recommendedGovernmentsForEra("no_such_era"), []);
  assert.deepEqual(recommendedGovernmentsForEra(""), []);
});

test("validateGovernmentTables 對現行表回傳零問題", () => {
  assert.deepEqual(validateGovernmentTables(), []);
});

// ── Task #127 政府治理系統 ──

test("DEFAULT_GOVERNMENT_SLUG 為君主專制且是有效 slug", () => {
  assert.equal(DEFAULT_GOVERNMENT_SLUG, "absolute_monarchy");
  assert.equal(isGovernmentSlug(DEFAULT_GOVERNMENT_SLUG), true);
  assert.equal(governmentLabel(DEFAULT_GOVERNMENT_SLUG), "君主專制");
});

// ── Task #428 建國三選一政體 ──

test("FOUNDING_GOVERNMENT_SLUGS 恰為三選一且皆存在於 GOVERNMENTS", () => {
  assert.deepEqual(
    [...FOUNDING_GOVERNMENT_SLUGS],
    ["absolute_monarchy", "aristocracy", "parliamentary_republic"],
  );
  for (const slug of FOUNDING_GOVERNMENT_SLUGS) {
    assert.equal(isGovernmentSlug(slug), true, slug);
  }
});

test("isFoundingGovernmentSlug 接受三選一、拒絕其餘政體與未知值", () => {
  for (const slug of FOUNDING_GOVERNMENT_SLUGS) {
    assert.equal(isFoundingGovernmentSlug(slug), true, slug);
  }
  // 其餘 11 種政體不可在建國時選
  for (const g of GOVERNMENTS) {
    if (FOUNDING_GOVERNMENT_SLUGS.includes(g.slug)) continue;
    assert.equal(isFoundingGovernmentSlug(g.slug), false, g.slug);
  }
  assert.equal(isFoundingGovernmentSlug("not_a_government"), false);
  assert.equal(isFoundingGovernmentSlug(""), false);
  // zh-TW label 不是 slug
  assert.equal(isFoundingGovernmentSlug("君主專制"), false);
});

test("COUP_GOVERNMENT_SLUGS 均為有效 slug 且非空", () => {
  assert.ok(COUP_GOVERNMENT_SLUGS.length > 0);
  for (const slug of COUP_GOVERNMENT_SLUGS) {
    assert.equal(isGovernmentSlug(slug), true, slug);
  }
});

test("governmentSlugByLabel — label → slug、未知/null 回 null", () => {
  assert.equal(governmentSlugByLabel("君主專制"), "absolute_monarchy");
  assert.equal(governmentSlugByLabel("邦聯制"), "confederation");
  assert.equal(governmentSlugByLabel("not_a_label"), null);
  // slug 不是 label
  assert.equal(governmentSlugByLabel("absolute_monarchy"), null);
  assert.equal(governmentSlugByLabel(null), null);
  assert.equal(governmentSlugByLabel(""), null);
});

test("governmentDecisionDifficulty — 接受 label 或 slug，未知/null 回 50", () => {
  // slug
  assert.equal(governmentDecisionDifficulty("absolute_monarchy"), 20);
  assert.equal(governmentDecisionDifficulty("military_dictatorship"), 15);
  assert.equal(governmentDecisionDifficulty("confederation"), 70);
  // label（player_nations.government 存的是 label）
  assert.equal(governmentDecisionDifficulty("君主專制"), 20);
  assert.equal(governmentDecisionDifficulty("邦聯制"), 70);
  // 未知/null → 50
  assert.equal(governmentDecisionDifficulty("nope"), 50);
  assert.equal(governmentDecisionDifficulty(null), 50);
  assert.equal(governmentDecisionDifficulty(""), 50);
});
