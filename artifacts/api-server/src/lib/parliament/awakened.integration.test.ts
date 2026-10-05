import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, parliamentStateTable, parliamentPartiesTable } = await import("@workspace/db");
const { ensureParliamentTestSchema } = await import("./testSchema");
const { settleNationParliament } = await import("./service");

const MARK = "ParlAw"; const run = randomBytes(3).toString("hex");
let seq = 0;
async function mkNation(gov: string) {
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: `pa-${run}-${seq}`, name: `${MARK}${run}${seq++}`, leaderName: "t", government: gov,
  } as any).returning();
  return n!;
}
async function st(id: string) { const [s] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, id)); return s!; }
async function fresh(id: string) { const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id)); return n!; }

before(async () => {
  await ensureParliamentTestSchema();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
});
after(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("專制國社會黨過半(事件後):橡皮圖章失效,議會提出要求且滿意度不再鎖 80", async () => {
  const n = await mkNation("軍事獨裁");
  await settleNationParliament(n, null, 0); // 先建成單一忠誠黨議會
  // 模擬「社會黨取得多數」事件改動席次(福利派 55、忠誠黨 45)
  await db.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, n.id));
  await db.insert(parliamentPartiesTable).values([
    { nationId: n.id, name: "社會黨", stance: "welfare", weight: 55, seats: 55, color: "#c0392b", isRuling: true, description: "" },
    { nationId: n.id, name: "愛國黨", stance: "loyalist", weight: 45, seats: 45, color: "#2980b9", isRuling: false, description: "" },
  ] as any);
  await db.update(parliamentStateTable).set({ lastDemandTick: null, activeDemand: null }).where(eq(parliamentStateTable.nationId, n.id));
  await settleNationParliament(await fresh(n.id), null, 0);
  const s = await st(n.id);
  assert.ok(s.activeDemand && (s.activeDemand as any).stance === "welfare", "社會黨議會應提出福利派要求");
  assert.notEqual(s.protestText, "議會一致擁護領袖,無異議。");
  const ps = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, n.id));
  assert.equal(ps.length, 2, "事件造成的議會結構不能被定期重建洗掉");
});

test("專制國社會黨被逐出後:恢復橡皮圖章、滿意度鎖回 80", async () => {
  const n = await mkNation("軍事獨裁");
  await settleNationParliament(n, null, 0);
  await db.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, n.id));
  await db.insert(parliamentPartiesTable).values([
    { nationId: n.id, name: `${n.name}愛國黨`, stance: "loyalist", weight: 100, seats: 100, color: "#2980b9", isRuling: true, description: "" },
  ] as any);
  await settleNationParliament(await fresh(n.id), null, 0);
  const s = await st(n.id);
  assert.equal(s.satisfaction, 80); assert.equal(s.activeDemand, null);
});
