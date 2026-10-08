import { strict as assert } from "node:assert";
import test, { before, after } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5433/postgres";
}
if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "https://stub.invalid/v1";
}
if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "x";
}

const { eq, or } = await import("drizzle-orm");
const { db, playerNationsTable, diplomacyWarsTable, regionControlsTable, mapRegionsTable } =
  await import("@workspace/db");
const { applyWorldProposal } = await import("./worldSimApply");

const runId = randomBytes(4).toString("hex");
let playerId: string;
let npcId: string;
let freeNpcId: string;
let warId: number;
let regionId: number;

before(async () => {
  const [r] = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable).limit(1);
  if (!r) throw new Error("需要地圖地區種子資料");
  regionId = r.id;
  const [p] = await db
    .insert(playerNationsTable)
    .values({ discordUserId: `wl-p-${runId}`, name: `wl-player-${runId}`, isNpc: false })
    .returning({ id: playerNationsTable.id });
  const [n] = await db
    .insert(playerNationsTable)
    .values({ name: `wl-npc-${runId}`, isNpc: true })
    .returning({ id: playerNationsTable.id });
  const [f] = await db
    .insert(playerNationsTable)
    .values({ name: `wl-free-${runId}`, isNpc: true })
    .returning({ id: playerNationsTable.id });
  playerId = p!.id;
  npcId = n!.id;
  freeNpcId = f!.id;
  // 打到一半：玩家 52%、NPC 48%
  await db.insert(regionControlsTable).values([
    { regionId, nationId: playerId, percent: 52 },
    { regionId, nationId: npcId, percent: 48 },
  ]);
  const [w] = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: playerId, nationBId: npcId, declaredByNationId: playerId })
    .returning({ id: diplomacyWarsTable.id });
  warId = w!.id;
});

after(async () => {
  await db.delete(diplomacyWarsTable).where(
    or(eq(diplomacyWarsTable.nationAId, playerId), eq(diplomacyWarsTable.nationBId, playerId)),
  );
  await db.delete(playerNationsTable).where(
    or(eq(playerNationsTable.id, playerId), eq(playerNationsTable.id, npcId), eq(playerNationsTable.id, freeNpcId)),
  );
});

test("世界模擬：交戰中的 NPC 不會被刪除或改寫領土，未交戰的 NPC 照常被刪除", async () => {
  const result = await applyWorldProposal({
    proposal: {
      summary: "戰時保護測試",
      operations: [
        { op: "deleteNation", nationId: npcId },
        { op: "deleteNation", nationId: freeNpcId },
      ],
    } as never,
    source: "manual",
    instruction: null,
  });
  assert.deepEqual(result.deletedNationIds, [freeNpcId], "只有未交戰者被刪");

  const [still] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, npcId));
  assert.ok(still, "交戰中的 NPC 必須還在");
  const [war] = await db.select().from(diplomacyWarsTable).where(eq(diplomacyWarsTable.id, warId));
  assert.ok(war && war.endedAt === null, "戰爭必須還在進行");
  const ctl = await db.select().from(regionControlsTable).where(eq(regionControlsTable.nationId, npcId));
  assert.equal(ctl[0]?.percent, 48, "NPC 的 48% 領土不可被動");
});

test("世界模擬：戰爭結束後同一個 NPC 可被刪除", async () => {
  await db.update(diplomacyWarsTable).set({ endedAt: new Date() }).where(eq(diplomacyWarsTable.id, warId));
  const result = await applyWorldProposal({
    proposal: { summary: "戰後", operations: [{ op: "deleteNation", nationId: npcId }] } as never,
    source: "manual",
    instruction: null,
  });
  assert.deepEqual(result.deletedNationIds, [npcId]);
});
