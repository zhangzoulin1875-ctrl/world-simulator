import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const { eq, like, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, generalsTable } = await import("@workspace/db");
const { recoverStuckGeneratingGenerals } = await import("./stuckGeneralRecovery");

const MARK = "StuckGen"; const runId = randomBytes(3).toString("hex"); let nationId: string;
async function mk(status: string, ageMin: number) {
  const [g] = await db.insert(generalsTable).values({
    ownerNationId: nationId, name: "（生成中…）", title: "", background: "", category: "infantry",
    status, skills: [], eraSlug: "classical",
  }).returning({ id: generalsTable.id });
  await db.execute(sql`UPDATE generals SET created_at = now() - (${ageMin} || ' minutes')::interval WHERE id = ${g!.id}`);
  return g!.id;
}
async function get(id: number) { const [r] = await db.select().from(generalsTable).where(eq(generalsTable.id, id)); return r!; }

before(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  const [n] = await db.insert(playerNationsTable).values({ discordUserId: `sg-${runId}`, name: `${MARK}${runId}`, leaderName: "t", government: "君主制" }).returning({ id: playerNationsTable.id });
  nationId = n!.id;
});
after(async () => { await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`)); await pool.end(); });

test("卡住超過門檻的 generating 卡被補成候選；新卡與其他狀態不動", async () => {
  const stuck = await mk("generating", 30);
  const fresh = await mk("generating", 1);   // 背景任務可能還在跑，不能搶
  const cand = await mk("candidate", 60);
  const rec = await mk("recruited", 60);
  const n = await recoverStuckGeneratingGenerals();
  assert.equal(n >= 1, true);
  const s = await get(stuck);
  assert.equal(s.status, "candidate");
  assert.notEqual(s.name, "（生成中…）");
  assert.ok(s.name.length > 0 && s.title.length > 0);
  assert.equal((await get(fresh)).status, "generating", "剛抽的卡不能被搶先補");
  assert.equal((await get(cand)).status, "candidate");
  assert.equal((await get(rec)).status, "recruited");
});

test("冪等：重跑不會再動已補好的卡，且不覆蓋玩家已解散的卡", async () => {
  const dismissed = await mk("dismissed", 60);
  const before = await get(dismissed);
  await recoverStuckGeneratingGenerals(); await recoverStuckGeneratingGenerals();
  const after = await get(dismissed);
  assert.equal(after.status, "dismissed");
  assert.equal(after.name, before.name);
});
