import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
const { eq, like, and, isNull } = await import("drizzle-orm");
const { db, pool, playerNationsTable, diplomacyWarsTable } = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { runWarMigrations } = await import("../lib/warMigrations");
const { createSession } = await import("../lib/sessions");
const { default: app } = await import("../app");
const { canonicalPair } = await import("../lib/diplomacy");
const { civilWarBetween, isActiveCivilWar, CIVIL_WAR_NO_CEASEFIRE_MESSAGE } = await import("../lib/civilWar");

const MARK = "CivW"; const run = randomBytes(3).toString("hex");
let server: import("node:http").Server; let base = "";
let n = 0;
async function nation(label: string, isNpc = false) {
  const uid = isNpc ? null : `cw-${run}-${n}`;
  const [row] = await db.insert(playerNationsTable).values({
    discordUserId: uid, name: `${MARK}${run}${n++}${label}`, leaderName: "t", government: "君主專制", isNpc,
  } as any).returning();
  const cookie = uid ? `dn_session=${await createSession({ discordUserId: uid, username: "t", avatar: null } as any)}` : "";
  return { id: row!.id, cookie };
}
async function war(a: string, b: string, civil: boolean, proposedBy: string | null = null) {
  const { low, high } = canonicalPair(a, b);
  const [w] = await db.insert(diplomacyWarsTable).values({
    nationAId: low, nationBId: high, declaredByNationId: a, isCivilWar: civil,
    rebelNationId: civil ? a : null, rebelIdeology: civil ? "red" : null, ceasefireProposedBy: proposedBy,
  } as any).returning();
  return w!;
}
const reload = async (id: number) => (await db.select().from(diplomacyWarsTable).where(eq(diplomacyWarsTable.id, id)))[0]!;
const post = (path: string, cookie: string, body: unknown = {}) =>
  fetch(`${base}/api${path}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body: JSON.stringify(body) });
const adminEnd = (id: number) =>
  fetch(`${base}/api/war/admin/wars/${id}/end`, { method: "POST", headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "content-type": "application/json" } });

before(async () => {
  await runGameMigrations(); await runDiplomacyMigrations(); await runWarMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("遷移:diplomacy_wars 有內戰欄位,預設為 false", async () => {
  const a = await nation("a"), b = await nation("b");
  const w = await war(a.id, b.id, false);
  assert.equal(w.isCivilWar, false); assert.equal(w.rebelNationId, null); assert.equal(w.rebelIdeology, null);
  const c = await nation("c"), d = await nation("d");
  const cw = await war(c.id, d.id, true);
  assert.equal(cw.isCivilWar, true); assert.equal(cw.rebelNationId, c.id); assert.equal(cw.rebelIdeology, "red");
});

test("內戰:玩家不能提出停戰(409 + 明確原因),戰爭仍在進行", async () => {
  const a = await nation("a"), b = await nation("b");
  const w = await war(a.id, b.id, true);
  for (const who of [a, b]) {
    const r = await post(`/diplomacy/wars/${w.id}/ceasefire`, who.cookie);
    assert.equal(r.status, 409, await r.clone().text());
    assert.equal(((await r.json()) as any).error, CIVIL_WAR_NO_CEASEFIRE_MESSAGE);
  }
  const after = await reload(w.id);
  assert.equal(after.endedAt, null); assert.equal(after.ceasefireProposedBy, null);
});

test("內戰:即使資料庫裡已有停戰提案,對方也無法接受(戰爭不會結束)", async () => {
  const a = await nation("a"), b = await nation("b");
  const w = await war(a.id, b.id, true, a.id); // 強行塞一筆提案,模擬舊資料/競態
  const r = await post(`/diplomacy/wars/${w.id}/ceasefire/accept`, b.cookie);
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as any).error, CIVIL_WAR_NO_CEASEFIRE_MESSAGE);
  assert.equal((await reload(w.id)).endedAt, null);
});

test("內戰:管理員強制結束戰爭也被擋(不留後門)", async () => {
  const a = await nation("a"), b = await nation("b");
  const w = await war(a.id, b.id, true);
  const r = await adminEnd(w.id);
  assert.equal(r.status, 409);
  assert.equal((await reload(w.id)).endedAt, null);
});

test("普通戰爭完全不受影響:提出停戰、對方接受、戰爭結束(守衛沒有過度攔截)", async () => {
  const a = await nation("a"), b = await nation("b");
  const w = await war(a.id, b.id, false);
  assert.equal((await post(`/diplomacy/wars/${w.id}/ceasefire`, a.cookie)).status, 200);
  assert.equal((await reload(w.id)).ceasefireProposedBy, a.id);
  const acc = await post(`/diplomacy/wars/${w.id}/ceasefire/accept`, b.cookie);
  assert.equal(acc.status, 200, await acc.clone().text());
  assert.notEqual((await reload(w.id)).endedAt, null);
});

test("普通戰爭:管理員仍可強制結束", async () => {
  const a = await nation("a"), b = await nation("b");
  const w = await war(a.id, b.id, false);
  const r = await adminEnd(w.id); assert.equal(r.status, 200, await r.clone().text());
  assert.notEqual((await reload(w.id)).endedAt, null);
});

test("civilWar 輔助函式:civilWarBetween / isActiveCivilWar 只在進行中的內戰為真", async () => {
  const a = await nation("a"), b = await nation("b"), c = await nation("c");
  const w = await war(a.id, b.id, true);
  assert.equal(await isActiveCivilWar(w.id), true);
  assert.equal(await civilWarBetween(a.id, b.id), true);
  assert.equal(await civilWarBetween(b.id, a.id), true, "與順序無關");
  assert.equal(await civilWarBetween(a.id, c.id), false);
  await db.update(diplomacyWarsTable).set({ endedAt: new Date() }).where(eq(diplomacyWarsTable.id, w.id));
  assert.equal(await isActiveCivilWar(w.id), false, "結束後不再算內戰進行中");
  assert.equal(await civilWarBetween(a.id, b.id), false);
});

test("原子性:內戰的 UPDATE 不會因競態而結束(直接對 DB 下條件式更新)", async () => {
  const a = await nation("a"), b = await nation("b");
  const w = await war(a.id, b.id, true);
  const { notCivilWar } = await import("../lib/civilWar");
  const res = await db.update(diplomacyWarsTable).set({ endedAt: new Date() })
    .where(and(eq(diplomacyWarsTable.id, w.id), isNull(diplomacyWarsTable.endedAt), notCivilWar())).returning();
  assert.equal(res.length, 0);
  assert.equal((await reload(w.id)).endedAt, null);
});
