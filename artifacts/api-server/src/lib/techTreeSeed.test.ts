/**
 * Task #469 — 全球統一線性科技樹「種子內容」結構不變量測試（純函式，不碰 DB）。
 *
 * 鎖定 techTreeSeed/types.ts 文件化的結構約定：
 *  - 三領域各覆蓋全部 14 個時代（時代 slug 有效且不重複）；
 *  - 每個 domain × era ≥2 條主幹線（lineKind = "main"）；
 *  - 每條主幹線 ≥10 個節點；所有線內 sortOrder 皆 1..N 連號；
 *  - 支線必有 branchFrom，掛在同 domain × era 的某條主幹線的既有節點上；
 *  - keySlug 全域唯一；政體（KEY_TECH_GOVERNMENTS）、建築
 *    （KEY_TECH_BUILDINGS）、軍事類別（MILITARY_KEY_TECHS）的關鍵科技
 *    識別字全部存在於對應領域，且座落在主幹線上；
 *  - baseCost 為 ≥1 的整數；名稱非空；lineKey 於 domain × era 內唯一。
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { SOCIAL_TECH_TREE_SEED } from "./techTreeSeed/social";
import { PRODUCTION_TECH_TREE_SEED } from "./techTreeSeed/production";
import { MILITARY_TECH_TREE_SEED } from "./techTreeSeed/military";
import { TECH_TREE_COST_RETUNE_V1 } from "./techTreeSeed/costRetune";
import { TECH_TREE_EFFECTS_BACKFILL_V1 } from "./techTreeSeed/effectsBackfill";
import { validateTechTreeEffects } from "./techTreeEffectVocab";
import { isTechTreeDomain } from "./techTree";
import type { TechTreeSeedDomain, TechTreeSeedLine } from "./techTreeSeed/types";
import { ERAS, isEraSlug } from "./mapRegionEras";
import { KEY_TECH_GOVERNMENTS } from "./socialTech";
import { KEY_TECH_BUILDINGS } from "./production";
import { MILITARY_KEY_TECHS } from "./military";

const DOMAINS: readonly TechTreeSeedDomain<unknown>[] = [
  SOCIAL_TECH_TREE_SEED,
  PRODUCTION_TECH_TREE_SEED,
  MILITARY_TECH_TREE_SEED,
];

function lineTag(domain: string, eraSlug: string, line: TechTreeSeedLine<unknown>) {
  return `${domain}/${eraSlug}/${line.lineKey}`;
}

test("三領域各覆蓋全部 14 個時代，時代 slug 有效且不重複", () => {
  assert.equal(ERAS.length, 14, "全域時代定義應為 14 個");
  for (const domain of DOMAINS) {
    const slugs = domain.eras.map((e) => e.eraSlug);
    assert.equal(
      new Set(slugs).size,
      slugs.length,
      `${domain.domain}：時代不得重複`,
    );
    for (const slug of slugs) {
      assert.ok(isEraSlug(slug), `${domain.domain}：無效時代 slug ${slug}`);
    }
    assert.equal(
      slugs.length,
      ERAS.length,
      `${domain.domain}：應覆蓋全部 ${ERAS.length} 個時代（實得 ${slugs.length}）`,
    );
  }
});

test("每個 domain × era 至少 2 條主幹線；主幹線 ≥10 節點；sortOrder 1..N 連號", () => {
  for (const domain of DOMAINS) {
    for (const era of domain.eras) {
      const mains = era.lines.filter((l) => l.lineKind === "main");
      assert.ok(
        mains.length >= 2,
        `${domain.domain}/${era.eraSlug}：主幹線應 ≥2 條（實得 ${mains.length}）`,
      );
      const keys = era.lines.map((l) => l.lineKey);
      assert.equal(
        new Set(keys).size,
        keys.length,
        `${domain.domain}/${era.eraSlug}：lineKey 不得重複`,
      );
      for (const line of era.lines) {
        const tag = lineTag(domain.domain, era.eraSlug, line);
        assert.ok(line.nodes.length > 0, `${tag}：線內至少要有 1 個節點`);
        if (line.lineKind === "main") {
          assert.ok(
            line.nodes.length >= 10,
            `${tag}：主幹線應 ≥10 節點（實得 ${line.nodes.length}）`,
          );
        }
        const orders = line.nodes.map((n) => n.order);
        assert.deepEqual(
          [...orders].sort((a, b) => a - b),
          Array.from({ length: line.nodes.length }, (_, i) => i + 1),
          `${tag}：sortOrder 應為 1..${line.nodes.length} 連號`,
        );
      }
    }
  }
});

test("支線必有 branchFrom 且掛在同 domain × era 的主幹線既有節點上", () => {
  for (const domain of DOMAINS) {
    for (const era of domain.eras) {
      const mainByKey = new Map(
        era.lines
          .filter((l) => l.lineKind === "main")
          .map((l) => [l.lineKey, l] as const),
      );
      for (const line of era.lines) {
        const tag = lineTag(domain.domain, era.eraSlug, line);
        if (line.lineKind === "main") {
          assert.equal(
            line.branchFrom,
            undefined,
            `${tag}：主幹線不得有 branchFrom`,
          );
          continue;
        }
        assert.ok(line.branchFrom, `${tag}：支線必須有 branchFrom`);
        const anchor = mainByKey.get(line.branchFrom!.lineKey);
        assert.ok(
          anchor,
          `${tag}：branchFrom.lineKey ${line.branchFrom!.lineKey} 不是同時代主幹線`,
        );
        assert.ok(
          anchor!.nodes.some((n) => n.order === line.branchFrom!.order),
          `${tag}：branchFrom.order ${line.branchFrom!.order} 在主幹線上不存在`,
        );
      }
    }
  }
});

test("節點欄位健全：baseCost ≥1 整數、名稱非空、keySlug 全域唯一", () => {
  const seenKeySlugs = new Map<string, string>();
  for (const domain of DOMAINS) {
    for (const era of domain.eras) {
      for (const line of era.lines) {
        const tag = lineTag(domain.domain, era.eraSlug, line);
        for (const node of line.nodes) {
          assert.ok(
            Number.isInteger(node.baseCost) && node.baseCost >= 1,
            `${tag}#${node.order}（${node.name}）：baseCost 應為 ≥1 整數`,
          );
          assert.ok(
            node.name.trim().length > 0,
            `${tag}#${node.order}：名稱不得為空`,
          );
          if (node.keySlug) {
            const prev = seenKeySlugs.get(node.keySlug);
            assert.equal(
              prev,
              undefined,
              `keySlug ${node.keySlug} 重複：${prev} 與 ${tag}#${node.order}`,
            );
            seenKeySlugs.set(node.keySlug, `${tag}#${node.order}`);
          }
        }
      }
    }
  }
});

// ── Task #477 — 研發節奏不變量 ──────────────────────────────────────
//
// 「主幹線成本總和 ÷ 該時代 techAvg」≈ 平均國力國家在該領域約 1/3 分配
// 下走完該時代主幹線所需的回合數（成本倍率 = 國家生產力 ÷ 全球平均，
// 平均國家 ≈ 1；每回合灌點 ≈ 全國科研點 × 1/3 ≈ R_avg × techAvg / 3）。
// 頻帶設計：古典最快（新手節奏）、中古長時代較高、短歷史時代
// （ww1/ww2/cold_war）壓低以免追不上世界時代、future 為終局成本池。
const PACING_TARGETS: Readonly<Record<string, readonly [number, number]>> = {
  classical: [25, 35],
  roman: [36, 49],
  early_medieval: [38, 52],
  high_medieval: [41, 56],
  renaissance: [38, 52],
  discovery: [38, 52],
  scientific: [32, 44],
  enlightenment: [32, 44],
  industrial: [36, 49],
  ww1: [25, 35],
  ww2: [22, 31],
  cold_war: [25, 35],
  modern: [32, 44],
  future: [46, 63],
};

test("每時代主幹線成本總和 ÷ techAvg 落在節奏頻帶內（Task #477）", () => {
  for (const domain of DOMAINS) {
    for (const era of domain.eras) {
      const eraDef = ERAS.find((e) => e.slug === era.eraSlug);
      assert.ok(eraDef, `${domain.domain}/${era.eraSlug}：找不到時代定義`);
      const band = PACING_TARGETS[era.eraSlug];
      assert.ok(band, `${domain.domain}/${era.eraSlug}：缺少節奏頻帶`);
      let mainTotal = 0;
      for (const line of era.lines) {
        if (line.lineKind !== "main") continue;
        for (const n of line.nodes) mainTotal += n.baseCost;
      }
      const ratio = mainTotal / eraDef!.techAvg;
      assert.ok(
        ratio >= band![0] && ratio <= band![1],
        `${domain.domain}/${era.eraSlug}：主幹線總成本/techAvg = ${ratio.toFixed(1)}，應落在 [${band![0]}, ${band![1]}]`,
      );
    }
  }
});

test("支線每節點平均成本低於主幹線（支線略低）", () => {
  for (const domain of DOMAINS) {
    for (const era of domain.eras) {
      let mainTotal = 0;
      let mainCount = 0;
      let branchTotal = 0;
      let branchCount = 0;
      for (const line of era.lines) {
        for (const n of line.nodes) {
          if (line.lineKind === "main") {
            mainTotal += n.baseCost;
            mainCount += 1;
          } else {
            branchTotal += n.baseCost;
            branchCount += 1;
          }
        }
      }
      if (branchCount === 0) continue;
      assert.ok(
        branchTotal / branchCount < mainTotal / mainCount,
        `${domain.domain}/${era.eraSlug}：支線平均節點成本應低於主幹線`,
      );
    }
  }
});

test("成本重調校對照表與種子一致（每節點恰一列且新成本＝種子成本）", () => {
  const byRef = new Map<string, { oldCost: number; newCost: number }>();
  for (const [domain, eraSlug, lineKey, sortOrder, oldCost, newCost] of TECH_TREE_COST_RETUNE_V1) {
    const key = `${domain}|${eraSlug}|${lineKey}|${sortOrder}`;
    assert.ok(!byRef.has(key), `重調校對照表重複列：${key}`);
    assert.ok(
      Number.isInteger(oldCost) && oldCost >= 1 && Number.isInteger(newCost) && newCost >= 1,
      `重調校對照表 ${key}：成本應為 ≥1 整數`,
    );
    byRef.set(key, { oldCost, newCost });
  }
  let seedCount = 0;
  for (const domain of DOMAINS) {
    for (const era of domain.eras) {
      for (const line of era.lines) {
        for (const n of line.nodes) {
          seedCount += 1;
          const key = `${domain.domain}|${era.eraSlug}|${line.lineKey}|${n.order}`;
          const row = byRef.get(key);
          assert.ok(row, `重調校對照表缺少節點 ${key}`);
          assert.equal(
            row!.newCost,
            n.baseCost,
            `重調校對照表 ${key}：新成本 ${row!.newCost} ≠ 種子成本 ${n.baseCost}`,
          );
        }
      }
    }
  }
  assert.equal(
    TECH_TREE_COST_RETUNE_V1.length,
    seedCount,
    "重調校對照表列數應等於種子節點數",
  );
});

test("效果回填對照表與種子一致（Task #494：僅前 5 時代、非空且＝種子效果）", () => {
  const BACKFILL_ERAS = new Set([
    "classical",
    "roman",
    "early_medieval",
    "high_medieval",
    "renaissance",
  ]);

  // 對照表本身：不重複、僅涵蓋前 5 時代、每列效果非空。
  const byRef = new Map<string, readonly unknown[]>();
  for (const [domain, eraSlug, lineKey, sortOrder, effects] of TECH_TREE_EFFECTS_BACKFILL_V1) {
    const key = `${domain}|${eraSlug}|${lineKey}|${sortOrder}`;
    assert.ok(!byRef.has(key), `效果回填對照表重複列：${key}`);
    assert.ok(
      BACKFILL_ERAS.has(eraSlug),
      `效果回填對照表 ${key}：時代 ${eraSlug} 超出 Task #494 範圍（前 5 時代）`,
    );
    assert.ok(effects.length > 0, `效果回填對照表 ${key}：效果不得為空`);
    byRef.set(key, effects);
  }

  // 對照表每列必須對得上種子節點，且效果與種子完全一致（deep equal）。
  const seedEffectsByRef = new Map<string, unknown>();
  for (const domain of DOMAINS) {
    for (const era of domain.eras) {
      for (const line of era.lines) {
        for (const n of line.nodes) {
          seedEffectsByRef.set(
            `${domain.domain}|${era.eraSlug}|${line.lineKey}|${n.order}`,
            (n as { effects: unknown }).effects,
          );
        }
      }
    }
  }
  for (const [key, effects] of byRef) {
    const seedEffects = seedEffectsByRef.get(key);
    assert.ok(seedEffects !== undefined, `效果回填對照表對不上種子節點：${key}`);
    assert.deepEqual(
      effects,
      seedEffects,
      `效果回填對照表 ${key}：效果與種子不一致`,
    );
  }

  // 前 5 時代種子節點的效果必須全部非空（回填的目的即消滅空效果節點）。
  for (const domain of DOMAINS) {
    for (const era of domain.eras) {
      if (!BACKFILL_ERAS.has(era.eraSlug)) continue;
      for (const line of era.lines) {
        for (const n of line.nodes) {
          const effects = (n as { effects: unknown[] }).effects;
          assert.ok(
            Array.isArray(effects) && effects.length > 0,
            `${domain.domain}/${era.eraSlug}/${line.lineKey}#${n.order}：前 5 時代種子節點效果不得為空`,
          );
        }
      }
    }
  }
});

test("全部種子節點效果通過領域語彙白名單驗證（admin 驗證的 SSOT）", () => {
  for (const domain of DOMAINS) {
    assert.ok(isTechTreeDomain(domain.domain), `未知領域 ${domain.domain}`);
    if (!isTechTreeDomain(domain.domain)) continue;
    for (const era of domain.eras) {
      for (const line of era.lines) {
        for (const n of line.nodes) {
          const effects = (n as { effects: unknown[] }).effects;
          const error = validateTechTreeEffects(domain.domain, effects);
          assert.equal(
            error,
            null,
            `${domain.domain}/${era.eraSlug}/${line.lineKey}#${n.order}：${error}`,
          );
        }
      }
    }
  }
});

test("政體／建築／軍事類別關鍵科技全數保留於對應領域的主幹線上", () => {
  const mainKeySlugsByDomain = new Map<string, Set<string>>();
  for (const domain of DOMAINS) {
    const set = new Set<string>();
    for (const era of domain.eras) {
      for (const line of era.lines) {
        if (line.lineKind !== "main") continue;
        for (const node of line.nodes) {
          if (node.keySlug) set.add(node.keySlug);
        }
      }
    }
    mainKeySlugsByDomain.set(domain.domain, set);
  }

  const social = mainKeySlugsByDomain.get("social")!;
  for (const slug of Object.keys(KEY_TECH_GOVERNMENTS)) {
    assert.ok(social.has(slug), `政體關鍵科技 ${slug} 應在社會主幹線上`);
  }
  const production = mainKeySlugsByDomain.get("production")!;
  for (const slug of Object.keys(KEY_TECH_BUILDINGS)) {
    assert.ok(production.has(slug), `建築關鍵科技 ${slug} 應在生產主幹線上`);
  }
  const military = mainKeySlugsByDomain.get("military")!;
  for (const def of MILITARY_KEY_TECHS) {
    assert.ok(
      military.has(def.keySlug),
      `軍事關鍵科技 ${def.keySlug} 應在軍事主幹線上`,
    );
  }
});

test("軍事關鍵科技的種子時代與 MILITARY_KEY_TECHS 定義一致（NPC 時代守門依據）", () => {
  // NPC 兵種類別解鎖以已研發樹節點為主（loadNpcMilitaryKeySlugs 查樹）；
  // 無樹狀態的 NPC 退回 MILITARY_KEY_TECHS 的 eraSlug 時代近似。若種子把
  // keySlug 節點搬到別的時代，退回路徑會與樹世界觀悄悄脫鉤——在此鎖定兩者一致。
  const eraByKeySlug = new Map<string, string>();
  for (const era of MILITARY_TECH_TREE_SEED.eras) {
    for (const line of era.lines) {
      for (const node of line.nodes) {
        if (node.keySlug) eraByKeySlug.set(node.keySlug, era.eraSlug);
      }
    }
  }
  for (const def of MILITARY_KEY_TECHS) {
    assert.equal(
      eraByKeySlug.get(def.keySlug),
      def.eraSlug,
      `軍事關鍵科技 ${def.keySlug} 的種子時代（${eraByKeySlug.get(def.keySlug)}）應與 MILITARY_KEY_TECHS 定義（${def.eraSlug}）一致`,
    );
  }
});
