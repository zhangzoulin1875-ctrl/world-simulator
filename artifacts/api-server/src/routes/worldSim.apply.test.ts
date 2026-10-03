/**
 * Task #176 — integration tests (real DB) for the safe world-write layer
 * lib/worldSimApply.ts. The hard rule under test: AI world changes may add/
 * edit/delete only NPC & unowned nations and move THEIR region_controls, and
 * must NEVER touch a player nation (is_npc=false AND discord_user_id NOT NULL)
 * or its region_controls.
 *
 * Coverage:
 *  1. A valid "redraw" (shrink one NPC + create a new NPC filling the freed
 *     space) applies fully; the player's row (AI-writable columns) and its
 *     region_controls are byte-identical afterwards; an audit row is written.
 *  2. Any op targeting the player (update OR delete) throws WorldProposalError
 *     and the whole transaction rolls back — nothing changes, no audit.
 *  3. Σ>100 including the player's existing control is rejected (AI cannot
 *     squeeze a player's held territory).
 *  4. Two concurrent applies claiming the same empty region are serialized by
 *     the advisory lock: exactly one succeeds, region total stays ≤100, and the
 *     player is never touched.
 *
 * Requires DATABASE_URL pointing at a DB migrated by a normal server start
 * (map_regions seeded, player_nations/region_controls/world_sim_audits exist).
 * All rows carry a run marker and are cleaned up before AND after the run:
 * `pnpm --filter @workspace/api-server run test:integration`.
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the world-sim apply tests");
}

const { asc, eq, like, notExists, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  worldSimAuditsTable,
} = await import("@workspace/db");
const { runWorldSimMigrations } = await import("../lib/worldSimMigrations");
const { applyWorldProposal } = await import("../lib/worldSimApply");
const { parseWorldProposal, WorldProposalError } = await import(
  "../lib/worldSim"
);

const runId = randomBytes(4).toString("hex");
const NATION_MARKER = "__wsapply__";
const PLAYER_USER_MARKER = `wsapply-player-${runId}`;
const nationName = (label: string) => `${NATION_MARKER}${label}-${runId}`;
/** Embedded in every proposal summary so audits are cleanable by run. */
const auditTag = `[wsapply-test ${runId}]`;

/** AI-writable columns — the exact surface the write layer may touch. */
function aiWritableSnapshot(n: typeof playerNationsTable.$inferSelect) {
  return {
    name: n.name,
    leaderName: n.leaderName,
    government: n.government,
    isNpc: n.isNpc,
    discordUserId: n.discordUserId,
    techEraMilitary: n.techEraMilitary,
    techEraSocial: n.techEraSocial,
    techEraProduction: n.techEraProduction,
    stability: n.stability,
    unrest: n.unrest,
  };
}

async function nationById(id: string) {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id))
    .limit(1);
  return row ?? null;
}

async function controlsFor(nationId: string) {
  return db
    .select({
      regionId: regionControlsTable.regionId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.nationId, nationId))
    .orderBy(asc(regionControlsTable.regionId));
}

async function regionTotal(regionId: number): Promise<number> {
  const rows = await db
    .select({ percent: regionControlsTable.percent })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, regionId));
  return rows.reduce((s, r) => s + r.percent, 0);
}

async function createNation(opts: {
  name: string;
  isNpc: boolean;
  discordUserId?: string | null;
  controls?: { regionId: number; percent: number }[];
}): Promise<string> {
  return db.transaction(async (tx) => {
    const [n] = await tx
      .insert(playerNationsTable)
      .values({
        name: opts.name,
        isNpc: opts.isNpc,
        discordUserId: opts.discordUserId ?? null,
      })
      .returning({ id: playerNationsTable.id });
    if (!n) throw new Error("test nation insert failed");
    if (opts.controls && opts.controls.length > 0) {
      await tx.insert(regionControlsTable).values(
        opts.controls.map((c) => ({
          regionId: c.regionId,
          nationId: n.id,
          percent: c.percent,
        })),
      );
    }
    return n.id;
  });
}

async function cleanup() {
  // region_controls cascade on nation delete.
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.discordUserId, `wsapply-player-%`));
  // audits carry the run tag inside summary; delete only test rows.
  await db.execute(
    sql`DELETE FROM world_sim_audits WHERE summary LIKE ${"%wsapply-test%"}`,
  );
}

/** Empty regions (no existing control) so the tests never collide with seed data. */
let R: number[] = [];

before(async () => {
  await runWorldSimMigrations();
  await cleanup();
  const free = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .where(
      notExists(
        db
          .select({ x: regionControlsTable.id })
          .from(regionControlsTable)
          .where(eq(regionControlsTable.regionId, mapRegionsTable.id)),
      ),
    )
    .orderBy(asc(mapRegionsTable.id))
    .limit(8);
  R = free.map((r) => r.id);
  assert.ok(R.length >= 6, `需要至少 6 個空地區，實際 ${R.length}`);
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("有效重畫：縮減一個 NPC + 新增一個 NPC 填入空間；玩家列與領土零變動", async () => {
  const [R1, R2] = R;
  const playerId = await createNation({
    name: nationName("player"),
    isNpc: false,
    discordUserId: `${PLAYER_USER_MARKER}-a`,
    controls: [{ regionId: R1, percent: 60 }],
  });
  const npcId = await createNation({
    name: nationName("npcA"),
    isNpc: true,
    controls: [
      { regionId: R1, percent: 40 },
      { regionId: R2, percent: 100 },
    ],
  });

  const playerBefore = aiWritableSnapshot((await nationById(playerId))!);
  const playerControlsBefore = await controlsFor(playerId);

  const proposal = parseWorldProposal({
    summary: `${auditTag} 縮減 npcA、新增新國`,
    operations: [
      // npcA 釋出 R1、R2 縮到 50%
      { op: "updateNation", nationId: npcId, regions: [{ regionId: R2, percent: 50 }] },
      // 新國填入 R1 剩 40% + R2 剩 50%
      {
        op: "createNpc",
        tempId: "new1",
        name: nationName("new"),
        techEraMilitary: "classical",
        regions: [
          { regionId: R1, percent: 40 },
          { regionId: R2, percent: 50 },
        ],
      },
    ],
  });

  const result = await applyWorldProposal({
    proposal,
    source: "manual",
    instruction: "測試指令",
  });

  // 玩家列（AI 可寫欄位）與領土 byte-identical。
  assert.deepEqual(aiWritableSnapshot((await nationById(playerId))!), playerBefore);
  assert.deepEqual(await controlsFor(playerId), playerControlsBefore);

  // npcA 只剩 R2 50%。
  assert.deepEqual(await controlsFor(npcId), [{ regionId: R2, percent: 50 }]);

  // 新 NPC 建立且掌控 R1 40% + R2 50%。
  assert.equal(result.createdNationIds.length, 1);
  const newControls = await controlsFor(result.createdNationIds[0]!);
  assert.deepEqual(newControls, [
    { regionId: R1, percent: 40 },
    { regionId: R2, percent: 50 },
  ]);

  // 地區總和守恆 ≤ 100。
  assert.equal(await regionTotal(R1), 100);
  assert.equal(await regionTotal(R2), 100);

  // 稽核紀錄寫入（source=manual、2 筆變更）。
  assert.equal(result.changes.length, 2);
  assert.ok(result.auditId);
  const [audit] = await db
    .select({
      source: worldSimAuditsTable.source,
      changes: worldSimAuditsTable.changes,
    })
    .from(worldSimAuditsTable)
    .where(eq(worldSimAuditsTable.id, result.auditId))
    .limit(1);
  assert.equal(audit?.source, "manual");
  assert.equal(audit?.changes.length, 2);
});

test("提案指向玩家（更新或刪除）→ 整體拒絕、零變動、無稽核", async () => {
  const playerId = await createNation({
    name: nationName("player2"),
    isNpc: false,
    discordUserId: `${PLAYER_USER_MARKER}-b`,
    controls: [{ regionId: R[2], percent: 70 }],
  });

  const playerBefore = aiWritableSnapshot((await nationById(playerId))!);
  const playerControlsBefore = await controlsFor(playerId);

  // 更新玩家 → 拒絕
  await assert.rejects(
    applyWorldProposal({
      proposal: parseWorldProposal({
        summary: `${auditTag} 試圖改玩家`,
        operations: [
          { op: "updateNation", nationId: playerId, name: nationName("hijack") },
        ],
      }),
      source: "manual",
      instruction: null,
    }),
    (e: unknown) => e instanceof WorldProposalError,
  );

  // 刪除玩家 → 拒絕
  await assert.rejects(
    applyWorldProposal({
      proposal: parseWorldProposal({
        summary: `${auditTag} 試圖刪玩家`,
        operations: [{ op: "deleteNation", nationId: playerId }],
      }),
      source: "manual",
      instruction: null,
    }),
    (e: unknown) => e instanceof WorldProposalError,
  );

  // 玩家完全未變。
  assert.deepEqual(aiWritableSnapshot((await nationById(playerId))!), playerBefore);
  assert.deepEqual(await controlsFor(playerId), playerControlsBefore);
});

test("Σ>100（含玩家既有掌控）→ 拒絕，AI 無法擠壓玩家地盤", async () => {
  const R3 = R[3];
  const playerId = await createNation({
    name: nationName("player3"),
    isNpc: false,
    discordUserId: `${PLAYER_USER_MARKER}-c`,
    controls: [{ regionId: R3, percent: 60 }],
  });

  await assert.rejects(
    applyWorldProposal({
      proposal: parseWorldProposal({
        summary: `${auditTag} 擠壓玩家`,
        operations: [
          {
            op: "createNpc",
            tempId: "squeeze",
            name: nationName("squeeze"),
            regions: [{ regionId: R3, percent: 50 }],
          },
        ],
      }),
      source: "manual",
      instruction: null,
    }),
    (e: unknown) => e instanceof WorldProposalError,
  );

  // 玩家地盤不變，該地區僅玩家 60%。
  assert.deepEqual(await controlsFor(playerId), [{ regionId: R3, percent: 60 }]);
  assert.equal(await regionTotal(R3), 60);
});

test("兩個並發套用搶同一空地區 → advisory lock 序列化：恰一個成功，總和 ≤100，玩家不受影響", async () => {
  const R4 = R[4];
  const playerId = await createNation({
    name: nationName("player4"),
    isNpc: false,
    discordUserId: `${PLAYER_USER_MARKER}-d`,
    controls: [{ regionId: R[5], percent: 100 }],
  });
  const playerBefore = aiWritableSnapshot((await nationById(playerId))!);
  const playerControlsBefore = await controlsFor(playerId);

  const makeProposal = (label: string) =>
    parseWorldProposal({
      summary: `${auditTag} 並發搶地 ${label}`,
      operations: [
        {
          op: "createNpc",
          tempId: `conc-${label}`,
          name: nationName(`conc-${label}`),
          regions: [{ regionId: R4, percent: 60 }],
        },
      ],
    });

  const results = await Promise.allSettled([
    applyWorldProposal({
      proposal: makeProposal("x"),
      source: "manual",
      instruction: null,
    }),
    applyWorldProposal({
      proposal: makeProposal("y"),
      source: "manual",
      instruction: null,
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "應恰有一個成功");
  assert.equal(rejected.length, 1, "另一個應因 Σ>100 被拒");
  assert.ok(
    (rejected[0] as PromiseRejectedResult).reason instanceof WorldProposalError,
  );

  // 地區總和恰 60（僅一個成功），玩家零變動。
  assert.equal(await regionTotal(R4), 60);
  assert.deepEqual(aiWritableSnapshot((await nationById(playerId))!), playerBefore);
  assert.deepEqual(await controlsFor(playerId), playerControlsBefore);
});
