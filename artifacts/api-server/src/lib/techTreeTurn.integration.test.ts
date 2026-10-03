/**
 * Task #469 — 回合制研發結算整合測試（真 DB）。
 *
 * 鎖定 settleNationResearch 的核心規則：
 *  - 多回合累積：每回合把 techGain 依 ratio_pct 以最大餘數法拆分灌入進行中
 *    節點（Task #548：三領域份額總和恰好等於整數收入）；
 *  - 成本快照：完成判定以 cost_snapshot 為準（非重算的 baseCost）；
 *  - 完成溢出（Task #548）：玩家國家退回庫存 tech_points；NPC 作廢；
 *    完成後 progress 歸零、active 清空；
 *  - 無進行中節點／比例 0 的份額直接作廢；techGain ≤ 0 為 no-op；
 *  - 主幹線全完成 → 領域時代推進（classical → roman）；
 *  - 生產節點完成時 tempPopulationGrowth 效果寫入暫時人口 buff。
 *
 * 需要 DATABASE_URL 指向已遷移的資料庫。資料以 `ttturntest-` 前綴標記、
 * 自清，可重複執行：`pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the tech tree turn tests");
}

import type { TechTreeNode } from "@workspace/db";

const { and, eq, like, ne } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerTechTreeStateTable,
  playerResearchedTreeNodesTable,
  techTreeNodesTable,
  nationPopulationBuffsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runPoliticsMigrations } = await import("./politicsMigrations");
const { runTechTreeMigrations } = await import("./techTreeMigrations");
const { ensureTechTreeStates, grantNodes } = await import("./techTreeData");
const { settleNationResearch, applyNodeCompletionEffects } = await import(
  "./techTreeTurn"
);
const { ERAS } = await import("./mapRegionEras");

const USER_MARKER = "ttturntest-";
const NATION_MARKER = "__ttturntest__";
const runId = randomBytes(4).toString("hex");
const uid = `${USER_MARKER}${runId}`;

async function cleanup() {
  await db
    .delete(nationPopulationBuffsTable)
    .where(like(nationPopulationBuffsTable.discordUserId, `${USER_MARKER}%`));
  // state／researched 皆 CASCADE 於 player_nations.id（Task #481 改鍵 nation_id）。
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
}

let nationId: string;

async function loadState(domain: string) {
  const [row] = await db
    .select()
    .from(playerTechTreeStateTable)
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, domain),
      ),
    )
    .limit(1);
  assert.ok(row, `missing ${domain} state row`);
  return row;
}

async function setActive(
  domain: string,
  nodeId: number | null,
  costSnapshot: number | null,
  ratioPct: number,
) {
  await db
    .update(playerTechTreeStateTable)
    .set({ activeNodeId: nodeId, costSnapshot, progressPoints: 0, ratioPct })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, domain),
      ),
    );
}

async function isResearched(nodeId: number): Promise<boolean> {
  const rows = await db
    .select({ id: playerResearchedTreeNodesTable.id })
    .from(playerResearchedTreeNodesTable)
    .where(
      and(
        eq(playerResearchedTreeNodesTable.nationId, nationId),
        eq(playerResearchedTreeNodesTable.nodeId, nodeId),
      ),
    );
  return rows.length > 0;
}

let socialNode: { id: number; baseCost: number };

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runTechTreeMigrations();
  await cleanup();

  const [created] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: uid,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(created, "failed to create test nation");
  nationId = created.id;
  await ensureTechTreeStates(db, nationId);

  const [node] = await db
    .select({ id: techTreeNodesTable.id, baseCost: techTreeNodesTable.baseCost })
    .from(techTreeNodesTable)
    .where(
      and(
        eq(techTreeNodesTable.domain, "social"),
        eq(techTreeNodesTable.eraSlug, "classical"),
        eq(techTreeNodesTable.lineKind, "main"),
        eq(techTreeNodesTable.sortOrder, 1),
      ),
    )
    .limit(1);
  assert.ok(node, "seeded classical social main-line node missing");
  socialNode = node;
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("多回合累積＋成本快照＋完成後溢出退庫存（Task #548）", async () => {
  // 成本快照故意設成 100（與 baseCost 無關），證明完成判定以快照為準。
  const snapshot = 100;
  assert.notEqual(socialNode.baseCost, snapshot - 1, "sanity");
  await setActive("social", socialNode.id, snapshot, 50);
  await setActive("production", null, null, 25);
  await setActive("military", null, null, 25);
  await setStock(nationId, 0);

  // 第一回合：100 × 50% = 50 點，未達 100 → 累積。
  const r1 = await settleNationResearch({ nationId, discordUserId: uid, techGain: 100 });
  assert.equal(r1.pointsApplied, 50);
  assert.equal(r1.completed, 0);
  let state = await loadState("social");
  assert.equal(state.progressPoints, 50);
  assert.equal(state.activeNodeId, socialNode.id);

  // 第二回合：130 依 50/25/25 最大餘數法 → social 65 點 → 50 + 65 = 115 ≥ 100
  // → 完成；溢出 15 點退回庫存 tech_points（Task #548，不再作廢）。
  const r2 = await settleNationResearch({ nationId, discordUserId: uid, techGain: 130 });
  assert.equal(r2.completed, 1);
  assert.equal(r2.pointsApplied, 65, "social 份額 65 點（其餘領域無進行中作廢）");
  state = await loadState("social");
  assert.equal(state.activeNodeId, null, "完成後應清空進行中節點");
  assert.equal(state.costSnapshot, null, "完成後應清空成本快照");
  assert.equal(state.progressPoints, 0, "完成後 progress 歸零");
  assert.ok(await isResearched(socialNode.id), "完成後應寫入已研發");
  assert.equal(await loadStock(nationId), 15, "溢出 15 點必須退回庫存");
  await setStock(nationId, 0);
});

test("比例 0／無進行中節點的份額作廢；最大餘數法；techGain ≤ 0 為 no-op", async () => {
  const [prodNode] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.domain, "production"))
    .limit(1);
  assert.ok(prodNode, "seeded production node missing");

  // production 有進行中節點但 ratio 0 → 不灌點；social 無進行中 → 作廢。
  await setActive("production", prodNode.id, 500, 0);
  await setActive("social", null, null, 50);
  await setActive("military", null, null, 50);

  const r0 = await settleNationResearch({ nationId, discordUserId: uid, techGain: 1000 });
  assert.equal(r0.pointsApplied, 0, "比例 0／無進行中節點都不得灌點");
  assert.equal((await loadState("production")).progressPoints, 0);

  // 最大餘數法：3 依 50/50/0 → 2/1/0（social 餘數並列時序位優先），
  // social 無進行中 → 2 點作廢，production 灌 1 點。
  await setActive("production", prodNode.id, 500, 50);
  await setActive("military", null, null, 0);
  const r1 = await settleNationResearch({ nationId, discordUserId: uid, techGain: 3 });
  assert.equal(r1.pointsApplied, 1, "production 份額 1 點");
  assert.equal((await loadState("production")).progressPoints, 1);

  // techGain ≤ 0 且無庫存 → no-op。
  const r2 = await settleNationResearch({ nationId, discordUserId: uid, techGain: 0 });
  assert.deepEqual(r2, {
    pointsApplied: 0,
    stockConsumed: 0,
    completed: 0,
    erasAdvanced: 0,
  });
  assert.equal((await loadState("production")).progressPoints, 1);

  await setActive("production", null, null, 0);
});

// ── Task #524 — 庫存科技點自動消化 ──────────────────────────────────────

async function setStock(id: string, points: number) {
  await db
    .update(playerNationsTable)
    .set({ techPoints: points })
    .where(eq(playerNationsTable.id, id));
}

async function loadStock(id: string): Promise<number> {
  const [row] = await db
    .select({ techPoints: playerNationsTable.techPoints })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id))
    .limit(1);
  assert.ok(row, "nation row missing");
  return row.techPoints;
}

test("庫存吸收：依比例拆分投入、只扣實際吸收量", async () => {
  // cost 100、ratio 50%、庫存 60 → 份額 floor(60×50%) = 30 全數吸收。
  await setActive("social", socialNode.id, 100, 50);
  await setActive("production", null, null, 25);
  await setActive("military", null, null, 25);
  await setStock(nationId, 60);

  const r = await settleNationResearch({ nationId, discordUserId: uid, techGain: 0 });
  assert.equal(r.stockConsumed, 30, "應吸收社會領域份額 30 點");
  assert.equal(r.pointsApplied, 30);
  assert.equal((await loadState("social")).progressPoints, 30);
  // production/military 無進行中節點 → 其份額留庫存（不作廢）。
  assert.equal(await loadStock(nationId), 30, "未被吸收的份額必須留在庫存");
});

test("庫存吸收上限＝剩餘所需：溢出留庫存、完成節點", async () => {
  // 進度 30/100（前一測試），ratio 100%、庫存 30＋補到 500 → 需求 70。
  await db
    .update(playerTechTreeStateTable)
    .set({ ratioPct: 100 })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, "social"),
      ),
    );
  await db
    .update(playerTechTreeStateTable)
    .set({ ratioPct: 0 })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, "production"),
      ),
    );
  await db
    .update(playerTechTreeStateTable)
    .set({ ratioPct: 0 })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, "military"),
      ),
    );
  await setStock(nationId, 500);

  const r = await settleNationResearch({ nationId, discordUserId: uid, techGain: 0 });
  assert.equal(r.stockConsumed, 70, "只吸收剩餘所需 70 點");
  assert.equal(r.completed, 1, "吸收後應完成節點");
  assert.equal(await loadStock(nationId), 430, "溢出 430 點必須留庫存");
  const state = await loadState("social");
  assert.equal(state.activeNodeId, null);
  assert.equal(state.progressPoints, 0);
  assert.ok(await isResearched(socialNode.id));

  // 清理：移除已研發節點與庫存，恢復預設視角。
  await db
    .delete(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));
  await setStock(nationId, 0);
});

test("自產點完成節點後，庫存不再被吸收；溢出退庫存（Task #548）", async () => {
  // cost 50、ratio 50/0/0 → techGain 200 分到 social 100 點 → 自產點就完成；
  // 溢出 50 點退回庫存（40 + 50 = 90），不得再吸收庫存。
  await setActive("social", socialNode.id, 50, 50);
  await setStock(nationId, 40);

  const r = await settleNationResearch({ nationId, discordUserId: uid, techGain: 200 });
  assert.equal(r.completed, 1);
  assert.equal(r.stockConsumed, 0, "自產點已完成節點時不得動用庫存");
  assert.equal(await loadStock(nationId), 90, "庫存 = 原 40 + 溢出退回 50");

  await db
    .delete(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));
  await setStock(nationId, 0);
  await setActive("social", null, null, 50);
});

test("並發結算：庫存條件式扣款不會扣成負值或重複消化", async () => {
  await setActive("social", socialNode.id, 1000, 100);
  await setStock(nationId, 50);

  const [r1, r2] = await Promise.all([
    settleNationResearch({ nationId, discordUserId: uid, techGain: 0 }),
    settleNationResearch({ nationId, discordUserId: uid, techGain: 0 }),
  ]);
  const totalConsumed = r1.stockConsumed + r2.stockConsumed;
  assert.equal(totalConsumed, 50, "兩次並發合計只能吸收一次庫存");
  assert.equal(await loadStock(nationId), 0, "庫存不得為負");
  assert.equal((await loadState("social")).progressPoints, 50);

  await setActive("social", null, null, 50);
});

test("NPC／無主國家不消化庫存", async () => {
  const [npc] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}npc-${runId}`,
      leaderName: NATION_MARKER,
      isNpc: true,
      techPoints: 100,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(npc, "failed to create npc nation");
  await ensureTechTreeStates(db, npc.id);
  await db
    .update(playerTechTreeStateTable)
    .set({ activeNodeId: socialNode.id, costSnapshot: 100, ratioPct: 100 })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, npc.id),
        eq(playerTechTreeStateTable.domain, "social"),
      ),
    );

  const r = await settleNationResearch({
    nationId: npc.id,
    discordUserId: null,
    techGain: 0,
  });
  assert.equal(r.stockConsumed, 0, "NPC 不得消化庫存");
  assert.equal(await loadStock(npc.id), 100, "NPC 庫存必須原封不動");

  // Task #548 — NPC 完成節點的溢出點數維持作廢（不退庫存）。
  await db
    .update(playerTechTreeStateTable)
    .set({ ratioPct: 0 })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, npc.id),
        ne(playerTechTreeStateTable.domain, "social"),
      ),
    );
  const r2 = await settleNationResearch({
    nationId: npc.id,
    discordUserId: null,
    techGain: 250,
  });
  assert.equal(r2.completed, 1, "NPC 自產點應完成節點（cost 100、灌 250）");
  assert.equal(await loadStock(npc.id), 100, "NPC 溢出 150 點必須作廢，不得退庫存");
  const npcState = await db
    .select({ progressPoints: playerTechTreeStateTable.progressPoints })
    .from(playerTechTreeStateTable)
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, npc.id),
        eq(playerTechTreeStateTable.domain, "social"),
      ),
    );
  assert.equal(npcState[0]!.progressPoints, 0, "NPC 完成後 progress 歸零");
  await db
    .delete(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, npc.id));
});

test("古典主幹線全完成 → 軍事領域時代推進至下一時代", async () => {
  assert.equal(ERAS[0]!.slug, "classical");
  const nextEra = ERAS[1]!.slug;

  const classicalMains = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(
      and(
        eq(techTreeNodesTable.domain, "military"),
        eq(techTreeNodesTable.eraSlug, "classical"),
        eq(techTreeNodesTable.lineKind, "main"),
      ),
    );
  assert.ok(classicalMains.length >= 20, "古典軍事主幹線節點數 sanity");

  // 直接授予除了最後一個目標節點以外的所有古典主幹線節點。
  const target = classicalMains[classicalMains.length - 1]!;
  await grantNodes(
    db,
    nationId,
    classicalMains.slice(0, -1).map((n) => n.id),
  );
  await setActive("military", target.id, 10, 20);

  // 50 × 20% = 10 點 → 完成最後一個主幹線節點 → 時代推進。
  const r = await settleNationResearch({ nationId, discordUserId: uid, techGain: 50 });
  assert.equal(r.completed, 1);
  assert.equal(r.erasAdvanced, 1, "主幹線全完成應推進時代");
  const state = await loadState("military");
  assert.equal(state.eraSlug, nextEra, `軍事時代應推進至 ${nextEra}`);

  // 其他領域時代不受影響。
  assert.equal((await loadState("social")).eraSlug, "classical");

  // 清掉大量授予，避免影響同檔後續測試的視角（自清原則）。
  await db
    .delete(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));
});

test("生產節點完成效果：tempPopulationGrowth 寫入暫時人口 buff", async () => {
  const fakeNode = {
    id: 0,
    domain: "production",
    name: `${NATION_MARKER}buff-${runId}`,
    effects: [{ target: "tempPopulationGrowth", value: 7 }],
  } as unknown as TechTreeNode;
  await applyNodeCompletionEffects(db, uid, fakeNode);

  const buffs = await db
    .select({
      growthPct: nationPopulationBuffsTable.growthPct,
      source: nationPopulationBuffsTable.source,
    })
    .from(nationPopulationBuffsTable)
    .where(eq(nationPopulationBuffsTable.discordUserId, uid));
  assert.equal(buffs.length, 1);
  assert.equal(buffs[0]!.growthPct, 7);
  assert.equal(buffs[0]!.source, fakeNode.name);

  // 非生產領域不寫 buff。
  await applyNodeCompletionEffects(db, uid, {
    ...fakeNode,
    domain: "social",
  } as TechTreeNode);
  const buffs2 = await db
    .select({ id: nationPopulationBuffsTable.id })
    .from(nationPopulationBuffsTable)
    .where(eq(nationPopulationBuffsTable.discordUserId, uid));
  assert.equal(buffs2.length, 1, "社會節點不得寫入人口 buff");
});
