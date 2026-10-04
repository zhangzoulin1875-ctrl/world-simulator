/**
 * 科技樹下線後的契約:關鍵技術依世界時代自動解鎖(純函式,無 DB)。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  allKeyTechsOf,
  keySlugsUnlockedByEra,
  keyTechsUnlockedByEra,
  normalizeEra,
  virtualNodesUnlockedByEra,
} from "./eraUnlockedTech";
import { ERAS } from "./mapRegionEras";
import {
  categoryRequiredKeyTech,
  MILITARY_CATEGORIES,
  isCategoryUnlocked,
  MILITARY_KEY_TECHS,
  MUSKETEER_KEY_SLUG,
  SEA_LANDING_KEY_SLUG,
} from "./military";
import { KEY_TECH_BUILDINGS, PRODUCTION_KEY_TECHS } from "./production";
import { KEY_TECHS, KEY_TECH_GOVERNMENTS } from "./socialTech";
import { TECH_TREE_RESEARCH_ENABLED } from "./techTreeFlags";

const DOMAINS = ["military", "production", "social"] as const;

test("總開關預設為下線", () => {
  assert.equal(TECH_TREE_RESEARCH_ENABLED, false);
});

test("世界時代進到該年代(含當代)即解鎖,之前不解鎖", () => {
  assert.deepEqual(keySlugsUnlockedByEra("military", "classical"), ["marksmanship"]);
  assert.ok(keySlugsUnlockedByEra("military", "roman").includes("naval_warfare"));
  // 高中世紀才有火藥:羅馬時代還沒有
  assert.ok(!keySlugsUnlockedByEra("military", "roman").includes("gunpowder"));
  assert.ok(keySlugsUnlockedByEra("military", "high_medieval").includes("gunpowder"));
});

test("解鎖隨時代單調遞增:後面的時代一定包含前面所有關鍵技術", () => {
  for (const d of DOMAINS) {
    let prev = new Set<string>();
    for (const era of ERAS) {
      const cur = new Set(keySlugsUnlockedByEra(d, era.slug));
      for (const slug of prev) assert.ok(cur.has(slug), `${d}:${era.slug} 丟失 ${slug}`);
      prev = cur;
    }
  }
});

test("最後一個時代解鎖全部關鍵技術", () => {
  const last = ERAS[ERAS.length - 1]!.slug;
  for (const d of DOMAINS) {
    assert.equal(keyTechsUnlockedByEra(d, last).length, allKeyTechsOf(d).length);
  }
});

test("非法或空的世界時代退回古典,不會全開也不會全關", () => {
  assert.equal(normalizeEra("nope"), "classical");
  assert.equal(normalizeEra(null), "classical");
  assert.equal(normalizeEra(undefined), "classical");
  assert.deepEqual(
    keySlugsUnlockedByEra("military", "nope"),
    keySlugsUnlockedByEra("military", "classical"),
  );
});

test("虛擬節點:id 為負數且唯一、帶 keySlug 與既有效果,可直接餵給彙總函式", () => {
  for (const d of DOMAINS) {
    const nodes = virtualNodesUnlockedByEra(d, "ww2");
    assert.equal(nodes.length, allKeyTechsOf(d).length);
    const ids = new Set(nodes.map((n) => n.id));
    assert.equal(ids.size, nodes.length);
    for (const n of nodes) {
      assert.ok(n.id < 0, "虛擬節點 id 必須為負,避免與舊表真實節點混淆");
      assert.ok(n.keySlug);
      assert.equal(n.domain, d);
      assert.ok(Array.isArray(n.effects));
    }
  }
});

test("虛擬節點保留關鍵技術原本的數值加成(灌溉農業仍 +5% 生產力)", () => {
  const irrigation = virtualNodesUnlockedByEra("production", "classical").find(
    (n) => n.keySlug === "irrigation",
  );
  assert.ok(irrigation);
  assert.ok(
    (irrigation!.effects as { target: string; value: number }[]).some(
      (e) => e.target === "productivity" && e.value === 5,
    ),
  );
});

test("兵種類別解鎖:火槍兵年代起射手反鎖,火炮於高中世紀解鎖", () => {
  const med = keySlugsUnlockedByEra("military", "high_medieval");
  assert.equal(isCategoryUnlocked("ranged", med), true);
  assert.equal(isCategoryUnlocked("artillery", med), true);
  assert.equal(isCategoryUnlocked("ship", med), true);
  assert.equal(isCategoryUnlocked("air", med), false);

  const ren = keySlugsUnlockedByEra("military", "renaissance");
  assert.ok(ren.includes(MUSKETEER_KEY_SLUG));
  assert.equal(isCategoryUnlocked("ranged", ren), false);

  const ww1 = keySlugsUnlockedByEra("military", "ww1");
  assert.equal(isCategoryUnlocked("air", ww1), true);
});

test("跨海登陸旗標(指南針)於大航海時代解鎖", () => {
  assert.ok(!keySlugsUnlockedByEra("military", "renaissance").includes(SEA_LANDING_KEY_SLUG));
  assert.ok(keySlugsUnlockedByEra("military", "discovery").includes(SEA_LANDING_KEY_SLUG));
});

test("完整性:解鎖對照引用的 keySlug 全都存在於目錄(防改名斷線)", () => {
  const social = new Set(KEY_TECHS.map((k) => k.keySlug));
  for (const slug of Object.keys(KEY_TECH_GOVERNMENTS)) {
    assert.ok(social.has(slug), `政體解鎖引用了不存在的社會關鍵技術 ${slug}`);
  }
  const production = new Set(PRODUCTION_KEY_TECHS.map((k) => k.keySlug));
  for (const slug of Object.keys(KEY_TECH_BUILDINGS)) {
    assert.ok(production.has(slug), `建築解鎖引用了不存在的生產關鍵技術 ${slug}`);
  }
  const military = new Set(MILITARY_KEY_TECHS.map((k) => k.keySlug));
  for (const cat of MILITARY_CATEGORIES) {
    const slug = categoryRequiredKeyTech(cat);
    if (slug === null) continue;
    assert.ok(military.has(slug), `兵種類別 ${cat} 引用了不存在的軍事關鍵技術 ${slug}`);
  }
});

test("完整性:每個關鍵技術的年代都是合法時代", () => {
  const eras = new Set(ERAS.map((e) => e.slug));
  for (const d of DOMAINS) {
    for (const k of allKeyTechsOf(d)) {
      assert.ok(eras.has(k.eraSlug), `${d}:${k.keySlug} 年代 ${k.eraSlug} 不合法`);
    }
  }
});
