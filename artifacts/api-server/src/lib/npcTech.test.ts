import { strict as assert } from "node:assert";
import test from "node:test";
import {
  NPC_TECH_DOMAINS,
  clampEraSlug,
  normalizeNpcTechEra,
  effectiveNpcTechEra,
  resolveNpcTechEras,
} from "./npcTech";

// ERAS 順序（index）：classical(0) … industrial(8) … future(13)。

test("NPC_TECH_DOMAINS 為三領域", () => {
  assert.deepEqual([...NPC_TECH_DOMAINS], ["military", "social", "production"]);
});

test("clampEraSlug 夾在 [classical, max]", () => {
  // 超過上限 → 壓回上限
  assert.equal(clampEraSlug("future", "classical"), "classical");
  assert.equal(clampEraSlug("industrial", "renaissance"), "renaissance");
  // 未超過 → 原樣
  assert.equal(clampEraSlug("classical", "future"), "classical");
  assert.equal(clampEraSlug("renaissance", "industrial"), "renaissance");
  // 非法 slug → 視為 classical
  assert.equal(clampEraSlug("stone_age", "future"), "classical");
  assert.equal(clampEraSlug(null, "future"), "classical");
  // 非法上限 → 無上限（最後一個時代）
  assert.equal(clampEraSlug("future", "bogus"), "future");
});

test("normalizeNpcTechEra：null/空 → null；具體值夾到世界時代", () => {
  assert.equal(normalizeNpcTechEra(null, "industrial"), null);
  assert.equal(normalizeNpcTechEra(undefined, "industrial"), null);
  assert.equal(normalizeNpcTechEra("", "industrial"), null);
  // 非法 slug 防禦 → null（退回沿用世界時代）
  assert.equal(normalizeNpcTechEra("stone_age", "industrial"), null);
  // 未超過世界時代 → 原樣
  assert.equal(normalizeNpcTechEra("renaissance", "industrial"), "renaissance");
  // 超過世界時代 → 壓回世界時代
  assert.equal(normalizeNpcTechEra("future", "renaissance"), "renaissance");
  assert.equal(normalizeNpcTechEra("industrial", "classical"), "classical");
});

test("effectiveNpcTechEra：null → 世界時代；具體值夾取", () => {
  assert.equal(effectiveNpcTechEra(null, "renaissance"), "renaissance");
  assert.equal(effectiveNpcTechEra(undefined, "industrial"), "industrial");
  // 非法指標 → 世界時代
  assert.equal(effectiveNpcTechEra("stone_age", "renaissance"), "renaissance");
  // 具體且未超過 → 自身
  assert.equal(effectiveNpcTechEra("classical", "industrial"), "classical");
  // 具體但超過世界時代 → 夾到世界時代
  assert.equal(effectiveNpcTechEra("future", "renaissance"), "renaissance");
  // 非法世界時代 → 退回 classical 基準
  assert.equal(effectiveNpcTechEra(null, "bogus"), "classical");
});

test("resolveNpcTechEras：三領域一次解析", () => {
  const eras = resolveNpcTechEras(
    {
      techEraMilitary: "future", // 超過 → 夾到 industrial
      techEraSocial: null, // → 世界時代
      techEraProduction: "classical", // 未超過 → 自身
    },
    "industrial",
  );
  assert.deepEqual(eras, {
    military: "industrial",
    social: "industrial",
    production: "classical",
  });
});

// Task #481 — advanceNpcTechEra / computeNpcTechAdvance /
// npcGrantKeyTechEra / npcRevokeKeyTechEra 已隨「整代跳級」制移除
// （NPC 改沿全球科技樹逐格研發，見 npcTechTree.ts），對應測試一併刪除。
