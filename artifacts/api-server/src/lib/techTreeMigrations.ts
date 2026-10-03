import { sql } from "drizzle-orm";
import { db, techTreeNodesTable, type InsertTechTreeNode } from "@workspace/db";
import { logger } from "./logger";
import { SOCIAL_TECH_TREE_SEED } from "./techTreeSeed/social";
import { PRODUCTION_TECH_TREE_SEED } from "./techTreeSeed/production";
import { MILITARY_TECH_TREE_SEED } from "./techTreeSeed/military";
import { TECH_TREE_COST_RETUNE_V1 } from "./techTreeSeed/costRetune";
import { TECH_TREE_EFFECTS_BACKFILL_V1 } from "./techTreeSeed/effectsBackfill";
import type { TechTreeSeedDomain } from "./techTreeSeed/types";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #469 — 全球統一線性科技樹的 idempotent 啟動遷移與一次性內容種子。
 * 需在 player_nations 存在後執行（FK 依賴 discord_user_id）。
 * 與其他啟動遷移一致：不包 try/catch，失敗必須讓 bootstrap 大聲失敗。
 *
 * 種子只在 tech_tree_nodes 完全為空時種入（一次性）；之後內容由管理員
 * 後台 CRUD 完全接管，重啟不會覆寫管理員的修改。
 */
export async function runTechTreeMigrations(): Promise<void> {
  await withTestMigrationStamp("tech-tree", runTechTreeMigrationsInner);
}

async function runTechTreeMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tech_tree_nodes (
      id serial PRIMARY KEY,
      domain text NOT NULL,
      era_slug text NOT NULL,
      line_key text NOT NULL,
      line_label text NOT NULL,
      line_kind text NOT NULL,
      sort_order integer NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      base_cost integer NOT NULL,
      effects jsonb NOT NULL DEFAULT '[]'::jsonb,
      key_slug text,
      branch_from_node_id integer
        REFERENCES tech_tree_nodes(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tech_tree_nodes_key_slug_uidx
      ON tech_tree_nodes (key_slug)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS tech_tree_nodes_domain_era_idx
      ON tech_tree_nodes (domain, era_slug)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS tech_tree_nodes_line_idx
      ON tech_tree_nodes (domain, era_slug, line_key, sort_order)
  `);

  // Task #481 — 兩張狀態表改鍵到 nation_id（NPC 也逐格走樹）。創建處直接用
  // 最終形狀（discord_user_id 為已停用的 nullable 舊欄，僅為相容保留），既有
  // DB 由下方 ALTER／回填步驟升級。不可 DROP discord_user_id（Publish 會在
  // 回填程式跑之前 replay DDL 到 prod，先掉欄會讓回填失敗）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS player_tech_tree_state (
      id serial PRIMARY KEY,
      nation_id uuid
        REFERENCES player_nations(id) ON DELETE CASCADE,
      discord_user_id text
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      domain text NOT NULL,
      era_slug text NOT NULL DEFAULT 'classical',
      active_node_id integer
        REFERENCES tech_tree_nodes(id) ON DELETE SET NULL,
      cost_snapshot integer,
      progress_points integer NOT NULL DEFAULT 0,
      ratio_pct integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS player_tech_tree_state_user_domain_uidx
      ON player_tech_tree_state (discord_user_id, domain)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS player_researched_tree_nodes (
      id serial PRIMARY KEY,
      nation_id uuid
        REFERENCES player_nations(id) ON DELETE CASCADE,
      discord_user_id text
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      node_id integer NOT NULL
        REFERENCES tech_tree_nodes(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS player_researched_tree_nodes_uidx
      ON player_researched_tree_nodes (discord_user_id, node_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS player_researched_tree_nodes_user_idx
      ON player_researched_tree_nodes (discord_user_id)
  `);

  await migrateTechTreeStateToNationId();

  await seedTechTreeIfEmpty();
  await retuneSeededTechTreeCosts();
  await backfillSeededTechTreeEffects();
}

/**
 * Task #477 — 種子成本重調校 v1 的條件式同步（針對「已種入」的世界）。
 *
 * 種子只在空表時種入，因此調整種子數值不會影響既有世界；此處把新成本
 * 套用到既有節點，但**只在該節點 base_cost 仍等於舊種子值**時改寫——
 * 管理員透過 /tech-tree-admin 改過成本（或改名後重建）的節點一律不動。
 * 全部套用後每次啟動皆為 0 列 no-op，可安全重複執行。
 * 進行中研發不受影響：成本快照在開始研發當下已鎖定（設計如此）。
 */
async function retuneSeededTechTreeCosts(): Promise<void> {
  const payload = JSON.stringify(
    TECH_TREE_COST_RETUNE_V1.map(
      ([domain, eraSlug, lineKey, sortOrder, oldCost, newCost]) => ({
        domain,
        era_slug: eraSlug,
        line_key: lineKey,
        sort_order: sortOrder,
        old_cost: oldCost,
        new_cost: newCost,
      }),
    ),
  );
  const result = await db.execute(sql`
    UPDATE tech_tree_nodes t
    SET base_cost = v.new_cost, updated_at = NOW()
    FROM jsonb_to_recordset(${payload}::jsonb) AS v(
      domain text, era_slug text, line_key text,
      sort_order integer, old_cost integer, new_cost integer
    )
    WHERE t.domain = v.domain
      AND t.era_slug = v.era_slug
      AND t.line_key = v.line_key
      AND t.sort_order = v.sort_order
      AND t.base_cost = v.old_cost
  `);
  const updated = result.rowCount ?? 0;
  if (updated > 0) {
    logger.info({ updated }, "tech tree seed cost retune v1 applied");
  }
}

/**
 * Task #481 — 既有 DB 升級：加 nation_id 欄、由 discord_user_id 回填、
 * 解除舊欄 NOT NULL 後全 NULL 化（討回 quit 流程；科技從此跟著國家走），
 * 最後補 nation 鍵的唯一索引。全部 idempotent，重跑安全。
 */
async function migrateTechTreeStateToNationId(): Promise<void> {
  for (const table of [
    "player_tech_tree_state",
    "player_researched_tree_nodes",
  ] as const) {
    await db.execute(sql`
      ALTER TABLE ${sql.raw(table)}
        ADD COLUMN IF NOT EXISTS nation_id uuid
          REFERENCES player_nations(id) ON DELETE CASCADE
    `);
    await db.execute(sql`
      UPDATE ${sql.raw(table)} t
      SET nation_id = pn.id
      FROM player_nations pn
      WHERE t.nation_id IS NULL
        AND t.discord_user_id IS NOT NULL
        AND pn.discord_user_id = t.discord_user_id
    `);
    await db.execute(sql`
      ALTER TABLE ${sql.raw(table)}
        ALTER COLUMN discord_user_id DROP NOT NULL
    `);
    // 回填不到國家的孤列（理論上不存在，防禦性清除）與舊鍵 NULL 化。
    await db.execute(sql`
      DELETE FROM ${sql.raw(table)} WHERE nation_id IS NULL
    `);
    await db.execute(sql`
      UPDATE ${sql.raw(table)}
      SET discord_user_id = NULL
      WHERE discord_user_id IS NOT NULL
    `);
  }
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS player_tech_tree_state_nation_domain_uidx
      ON player_tech_tree_state (nation_id, domain)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS player_tech_tree_state_nation_idx
      ON player_tech_tree_state (nation_id)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS player_researched_tree_nodes_nation_uidx
      ON player_researched_tree_nodes (nation_id, node_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS player_researched_tree_nodes_nation_idx
      ON player_researched_tree_nodes (nation_id)
  `);
}

/**
 * Task #494 — 種子效果回填 v1 的條件式同步（針對「已種入」的世界）。
 *
 * 種子只在空表時種入，因此在種子檔補上效果不會影響既有世界；此處把新
 * 效果套用到既有節點，但**只在該節點 effects 仍為空陣列**（＝舊種子值）
 * 時寫入——管理員透過 /tech-tree-admin 改過效果的節點一律不動。
 * 全部套用後每次啟動皆為 0 列 no-op，可安全重複執行。
 * 已研發玩家自動獲得回填的效果：效果聚合永遠即時讀 tech_tree_nodes.effects。
 */
async function backfillSeededTechTreeEffects(): Promise<void> {
  const payload = JSON.stringify(
    TECH_TREE_EFFECTS_BACKFILL_V1.map(
      ([domain, eraSlug, lineKey, sortOrder, effects]) => ({
        domain,
        era_slug: eraSlug,
        line_key: lineKey,
        sort_order: sortOrder,
        new_effects: effects,
      }),
    ),
  );
  const result = await db.execute(sql`
    UPDATE tech_tree_nodes t
    SET effects = v.new_effects, updated_at = NOW()
    FROM jsonb_to_recordset(${payload}::jsonb) AS v(
      domain text, era_slug text, line_key text,
      sort_order integer, new_effects jsonb
    )
    WHERE t.domain = v.domain
      AND t.era_slug = v.era_slug
      AND t.line_key = v.line_key
      AND t.sort_order = v.sort_order
      AND t.effects = '[]'::jsonb
  `);
  const updated = result.rowCount ?? 0;
  if (updated > 0) {
    logger.info({ updated }, "tech tree seed effects backfill v1 applied");
  }
}

/** 種子鎖（跨 session 防併行測試遷移重複種入）。 */
const TECH_TREE_SEED_LOCK_KEY = 469_001;

async function seedTechTreeIfEmpty(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${TECH_TREE_SEED_LOCK_KEY})`,
    );
    const existing = await tx.execute(
      sql`SELECT COUNT(*)::int AS count FROM tech_tree_nodes`,
    );
    const count = Number(
      (existing.rows[0] as { count: number } | undefined)?.count ?? 0,
    );
    if (count > 0) return;

    const domains: TechTreeSeedDomain<unknown>[] = [
      SOCIAL_TECH_TREE_SEED,
      PRODUCTION_TECH_TREE_SEED,
      MILITARY_TECH_TREE_SEED,
    ];

    // 第一輪：插入全部節點（不含支線掛點），記住 (domain|era|lineKey|order) → id。
    const idByRef = new Map<string, number>();
    const refKey = (
      domain: string,
      eraSlug: string,
      lineKey: string,
      order: number,
    ) => `${domain}|${eraSlug}|${lineKey}|${order}`;

    for (const d of domains) {
      for (const era of d.eras) {
        for (const line of era.lines) {
          const rows: InsertTechTreeNode[] = line.nodes.map((n) => ({
            domain: d.domain,
            eraSlug: era.eraSlug,
            lineKey: line.lineKey,
            lineLabel: line.lineLabel,
            lineKind: line.lineKind,
            sortOrder: n.order,
            name: n.name,
            description: n.description,
            baseCost: n.baseCost,
            effects: n.effects as InsertTechTreeNode["effects"],
            keySlug: n.keySlug ?? null,
          }));
          const inserted = await tx
            .insert(techTreeNodesTable)
            .values(rows)
            .returning({
              id: techTreeNodesTable.id,
              sortOrder: techTreeNodesTable.sortOrder,
            });
          for (const row of inserted) {
            idByRef.set(
              refKey(d.domain, era.eraSlug, line.lineKey, row.sortOrder),
              row.id,
            );
          }
        }
      }
    }

    // 第二輪：回填支線掛點（只掛支線第一個節點）。
    for (const d of domains) {
      for (const era of d.eras) {
        for (const line of era.lines) {
          if (line.lineKind !== "branch" || !line.branchFrom) continue;
          const anchorId = idByRef.get(
            refKey(
              d.domain,
              era.eraSlug,
              line.branchFrom.lineKey,
              line.branchFrom.order,
            ),
          );
          const firstId = idByRef.get(
            refKey(d.domain, era.eraSlug, line.lineKey, 1),
          );
          if (anchorId === undefined || firstId === undefined) {
            throw new Error(
              `tech tree seed: 支線掛點解析失敗 ${d.domain}/${era.eraSlug}/${line.lineKey}`,
            );
          }
          await tx.execute(sql`
            UPDATE tech_tree_nodes
            SET branch_from_node_id = ${anchorId}
            WHERE id = ${firstId}
          `);
        }
      }
    }

    logger.info({ nodeCount: idByRef.size }, "tech tree seeded");
  });
}
