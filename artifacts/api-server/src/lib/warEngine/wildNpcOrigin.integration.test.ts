/**
 * 空地 NPC 來源標記:攻打完全空地即時建國 → npc_origin='wild';
 * 攻打無主國家(升格)→ 維持 'natural',不受 5 萬出兵上限。
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const { eq, like, inArray, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, regionControlsTable, mapRegionsTable, diplomacyWarsTable } =
  await import("@workspace/db");
const { ensureParliamentTestSchema } = await import("../parliament/testSchema");
const { foundOrPromoteUnownedDefender } = await import("./initiate");

const MARK = "WildNpc";
const run = randomBytes(3).toString("hex");
let attackerId: string;
let regions: number[] = [];

async function freeRegions(n: number): Promise<number[]> {
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .where(sql`${mapRegionsTable.id} NOT IN (SELECT region_id FROM region_controls WHERE percent > 0)`)
    .limit(n);
  return rows.map((r) => r.id);
}
async function cleanup() {
  const ids = (await db.select({ id: playerNationsTable.id }).from(playerNationsTable)
    .where(like(playerNationsTable.name, `%${run}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(regionControlsTable).where(inArray(regionControlsTable.nationId, ids));
    await db.delete(diplomacyWarsTable).where(inArray(diplomacyWarsTable.nationAId, ids));
    await db.delete(diplomacyWarsTable).where(inArray(diplomacyWarsTable.nationBId, ids));
    await db.delete(playerNationsTable).where(inArray(playerNationsTable.id, ids));
  }
}

before(async () => {
  await ensureParliamentTestSchema();
  const [a] = await db.insert(playerNationsTable).values({
    discordUserId: `wn-${run}`, name: `${MARK}${run}A`, leaderName: "t", government: "君主制",
  } as any).returning();
  attackerId = a!.id;
  regions = await freeRegions(2);
  assert.equal(regions.length, 2, "測試庫需要至少 2 個無人控制的地區");
});
after(async () => { await cleanup(); await pool.end(); });

test("攻打完全空地:新建 NPC 標為 wild", async () => {
  const [attacker] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, attackerId));
  const { defender } = await foundOrPromoteUnownedDefender({
    attacker: attacker!, attackerRegionId: regions[0]!, defenderRegionId: regions[1]!,
    defenderRegionName: `空地${run}`, hasActiveWars: false,
  });
  assert.equal(defender.isNpc, true);
  assert.equal(defender.npcOrigin, "wild");
  const [row] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, defender.id));
  assert.equal(row!.npcOrigin, "wild"); // 已持久化
  await db.update(playerNationsTable).set({ name: `${MARK}${run}W` }).where(eq(playerNationsTable.id, defender.id));
});

test("新建的一般國家(含既有資料)預設為 natural", async () => {
  const [row] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, attackerId));
  assert.equal(row!.npcOrigin, "natural");
});
