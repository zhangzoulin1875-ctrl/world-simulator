/**
 * 招募佇列的回合推進與 NPC（真實 DB）：
 *  1. 開關關閉：runRecruitQueueTurn 不動佇列（訂單保留，重新開啟後繼續）。
 *  2. 開關開啟：依產能推進，玩家完成的單位併入軍隊。
 *  3. NPC：入列不受 3 種限制、同兵種合併訂單；推進併入 npc_armies。
 *  4. 單國失敗不影響其他國。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const { eq, like } = await import("drizzle-orm");
const {
  db, pool, playerNationsTable, militaryUnitTemplatesTable, playerArmiesTable,
  npcArmiesTable, recruitQueueTable,
} = await import("@workspace/db");
const {
  enqueueInTx, enqueueNpcOrderInTx, runRecruitQueueTurn, listNationQueue, setRecruitQueueEnabled,
} = await import("./recruitQueue");

const MARK = "__rqturn__";
const runId = randomBytes(4).toString("hex");
const userId = `rqturn-${runId}-${process.pid}`;
let playerId: string, npcId: string;
const ptpl: number[] = [];
const ntpl: number[] = [];

async function mkT(owner: { u?: string; n?: string }, name: string) {
  const [t] = await db.insert(militaryUnitTemplatesTable).values({
    ownerDiscordUserId: owner.u ?? null, ownerNationId: owner.n ?? null, isDefault: false,
    category: "infantry", name: `${MARK}${name}-${runId}`, eraSlug: "x", hp: 1, attack: 1, defense: 1,
    speed: 1, accuracy: 1, range: "melee", prodCostPer100: 1, popCostPerUnit: 1, moneyCostPerUnit: 1,
    prodUpkeepPerUnit: 0.1,
  }).returning({ id: militaryUnitTemplatesTable.id });
  return t!.id;
}

before(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  const [p] = await db.insert(playerNationsTable)
    .values({ discordUserId: userId, name: `${MARK}p-${runId}`, leaderName: "t", government: "君主制" })
    .returning({ id: playerNationsTable.id });
  playerId = p!.id;
  const [n] = await db.insert(playerNationsTable)
    .values({ name: `${MARK}n-${runId}`, leaderName: "t", government: "君主制", isNpc: true })
    .returning({ id: playerNationsTable.id });
  npcId = n!.id;
  for (const nm of ["A", "B"]) ptpl.push(await mkT({ u: userId }, nm));
  for (const nm of ["N1", "N2", "N3", "N4"]) ntpl.push(await mkT({ n: npcId }, nm));
});

after(async () => {
  await setRecruitQueueEnabled(false);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

const pop = (big: number) => async () => big;

test("開關關閉：回合推進不動佇列，訂單保留", async () => {
  await setRecruitQueueEnabled(false);
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, playerId));
  await db.transaction((tx) => enqueueInTx(tx, { nationId: playerId, templateId: ptpl[0]!, quantity: 40, tpPerUnit: 2 }));
  const s = await runRecruitQueueTurn("x", pop(1_000_000));
  assert.deepEqual(s, { nations: 0, completedUnits: 0, failed: 0 });
  assert.equal((await listNationQueue(playerId))[0]!.remaining, 40, "訂單原封不動");
});

test("開關開啟：依產能推進，玩家完成的單位併入軍隊", async () => {
  await setRecruitQueueEnabled(true);
  await db.delete(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  // 人口 10,000 → 產能 20 TP；tp=2 → 每回合 10 單位。訂單 40 → 第 1 回合完成 10。
  const s = await runRecruitQueueTurn("x", pop(10_000));
  assert.ok(s.nations >= 1);
  const [a] = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  assert.equal(a!.quantity, 10);
  assert.equal((await listNationQueue(playerId))[0]!.remaining, 30);
  // 再 3 回合全部完成。
  for (let i = 0; i < 3; i++) await runRecruitQueueTurn("x", pop(10_000));
  const [b] = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  assert.equal(b!.quantity, 40);
  assert.equal((await listNationQueue(playerId)).length, 0);
});

test("NPC：一次入 4 個兵種不受 3 種上限；同兵種合併成單一訂單", async () => {
  await setRecruitQueueEnabled(true);
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, npcId));
  for (const t of ntpl) {
    await db.transaction((tx) => enqueueNpcOrderInTx(tx, { nationId: npcId, templateId: t, quantity: 100, tpPerUnit: 2 }));
  }
  assert.equal((await listNationQueue(npcId)).length, 4, "NPC 不受 3 種限制");
  // 下一回合再入同兵種 → 合併，不新增列。
  await db.transaction((tx) => enqueueNpcOrderInTx(tx, { nationId: npcId, templateId: ntpl[0]!, quantity: 50, tpPerUnit: 2 }));
  const q = await listNationQueue(npcId);
  assert.equal(q.length, 4, "同兵種合併，列數不膨脹");
  assert.equal(q.find((r) => r.templateId === ntpl[0])!.remaining, 150);
});

test("NPC 推進：併入 npc_armies（不經玩家軍隊表）", async () => {
  await setRecruitQueueEnabled(true);
  await db.delete(npcArmiesTable).where(eq(npcArmiesTable.nationId, npcId));
  // 產能 = 10000*0.002 = 20… 用大人口確保有量：人口 1,000,000 → 2000 TP → 1000 單位。
  await runRecruitQueueTurn("x", pop(1_000_000));
  const armies = await db.select().from(npcArmiesTable).where(eq(npcArmiesTable.nationId, npcId));
  const total = armies.reduce((a, x) => a + x.quantity, 0);
  assert.equal(total, 450, "4 筆訂單共 450 單位，產能足夠一回合全部完成");
  assert.equal((await listNationQueue(npcId)).length, 0);
});

test("單國失敗不影響其他國", async () => {
  await setRecruitQueueEnabled(true);
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, playerId));
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, npcId));
  await db.transaction((tx) => enqueueInTx(tx, { nationId: playerId, templateId: ptpl[0]!, quantity: 10, tpPerUnit: 2 }));
  await db.transaction((tx) => enqueueNpcOrderInTx(tx, { nationId: npcId, templateId: ntpl[0]!, quantity: 10, tpPerUnit: 2 }));
  const s = await runRecruitQueueTurn("x", async (id) => {
    if (id === playerId) throw new Error("boom");
    return 1_000_000;
  });
  assert.equal(s.failed, 1);
  assert.equal((await listNationQueue(npcId)).length, 0, "NPC 仍正常完成");
  assert.equal((await listNationQueue(playerId)).length, 1, "失敗的國家訂單保留，下回合重試");
});
