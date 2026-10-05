/**
 * 防重複開戰(玩家回報:同一組「摩拉維亞→波希米亞」被開了兩場第 0 週期戰役)。
 * 只測 assertNoDuplicateActiveCampaign:同一攻擊方 + 同一組出發/目標地區,同時只能有一場 active 戰役。
 * 不需要 NPC 兵種種子,只建最小資料(2 國、2 地區、1 筆 war)。
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const { eq, like, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, diplomacyWarsTable, warCampaignsTable, mapRegionsTable } =
  await import("@workspace/db");
const { ensureParliamentTestSchema } = await import("../parliament/testSchema");
const { assertNoDuplicateActiveCampaign } = await import("./initiate");
const { WarActionError } = await import("./shared");

const MARK = "DupWar";
const run = randomBytes(3).toString("hex");
let a: string, b: string, c: string;
let warAB: number, warCB: number;
let r1: number, r2: number;

async function mkNation(tag: string) {
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: `dw-${run}-${tag}`, name: `${MARK}${run}${tag}`, leaderName: "t", government: "君主制",
  } as any).returning();
  return n!.id;
}
function insertCampaign(attacker: string, defender: string, war: number, status = "active") {
  return db.insert(warCampaignsTable).values({
    warId: war, attackerNationId: attacker, defenderNationId: defender,
    attackerRegionId: r1, defenderRegionId: r2, status, nextResolveAt: new Date(Date.now() + 3600_000),
  } as any).returning({ id: warCampaignsTable.id });
}
function check(attacker: string) {
  return db.transaction((tx) =>
    assertNoDuplicateActiveCampaign(tx as any, {
      attackerNationId: attacker, attackerRegionId: r1, defenderRegionId: r2,
      attackerRegionName: "摩拉維亞", defenderRegionName: "波希米亞",
    }),
  );
}

before(async () => {
  await ensureParliamentTestSchema();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  a = await mkNation("a"); b = await mkNation("b"); c = await mkNation("c");
  const regs = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable).limit(2);
  assert.equal(regs.length, 2, "需要至少 2 個地區");
  r1 = regs[0]!.id; r2 = regs[1]!.id;
  const [x] = await db.insert(diplomacyWarsTable).values({ nationAId: a < b ? a : b, nationBId: a < b ? b : a, declaredByNationId: a }).returning({ id: diplomacyWarsTable.id });
  warAB = x!.id;
  const [y] = await db.insert(diplomacyWarsTable).values({ nationAId: c < b ? c : b, nationBId: c < b ? b : c, declaredByNationId: c }).returning({ id: diplomacyWarsTable.id });
  warCB = y!.id;
});
after(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("沒有進行中戰役:通過", async () => {
  await check(a);
});

test("已有同一攻擊方+同一出發/目標的 active 戰役:409", async () => {
  await insertCampaign(a, b, warAB);
  await assert.rejects(() => check(a), (e: unknown) => e instanceof WarActionError && e.status === 409 && /進行中的戰役/.test(e.message));
});

test("不同攻擊方(多國混戰同一塊地):不擋", async () => {
  await check(c); // a 已有 active,但 c 是另一個攻擊方
  await insertCampaign(c, b, warCB);
  await assert.rejects(() => check(a), (e: unknown) => e instanceof WarActionError);
  await assert.rejects(() => check(c), (e: unknown) => e instanceof WarActionError);
});

test("已結束的戰役不擋:結束後可再開", async () => {
  await db.update(warCampaignsTable).set({ status: "ended" }).where(eq(warCampaignsTable.attackerNationId, a));
  await check(a);
});

test("出發/目標對調或換目標地區:不擋", async () => {
  await db.update(warCampaignsTable).set({ status: "active" }).where(eq(warCampaignsTable.attackerNationId, a));
  // 同一攻擊方但目標地區不同 → 不是重複
  await db.transaction((tx) =>
    assertNoDuplicateActiveCampaign(tx as any, {
      attackerNationId: a, attackerRegionId: r1, defenderRegionId: r1 + 100000,
      attackerRegionName: "x", defenderRegionName: "y",
    }),
  );
});

// 註:並發(雙擊同時送出)的保護靠 pg_advisory_xact_lock 序列化,與 militaryBattlefield / interior 相同慣例。
// 沙盒用的 PGlite 是單一後端,advisory lock 不互斥(獨立探針實測 B 不會等 A),所以這裡無法用測試證明
// 並發情境;這一項需在真實 Postgres(Render/Aiven)驗證。循序重複、不同攻擊方、已結束戰役等情境已在上面覆蓋。
