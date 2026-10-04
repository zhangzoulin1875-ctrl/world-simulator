import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  focusStatesTable,
  focusActiveTable,
  focusCompletedTable,
  focusTextOverridesTable,
} from "@workspace/db";
import { runGameMigrations } from "./gameMigrations";
import { runFocusMigrations } from "./focusMigrations";

const TAG = "focusmig-test";
let nationId = "";

before(async () => {
  await runGameMigrations();
  await runFocusMigrations();
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  const [n] = await db
    .insert(playerNationsTable)
    .values({ name: `${TAG}-國`, leaderName: TAG, discordUserId: `${TAG}-u` })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
});

after(async () => {
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  await pool.end();
});

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

test("遷移可重複執行(冪等)", async () => {
  await runFocusMigrations();
  await runFocusMigrations();
});

test("focus_states:預設值與約束(點數不可為負、傾向值 0-100)", async () => {
  await db.insert(focusStatesTable).values({ nationId });
  const [row] = await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, nationId));
  assert.equal(row!.points, 0);
  assert.equal(row!.blackLean, 0);
  assert.equal(row!.treeVersion, 1);
  assert.ok(await rejects(() => db.update(focusStatesTable).set({ points: -1 }).where(eq(focusStatesTable.nationId, nationId))));
  assert.ok(await rejects(() => db.update(focusStatesTable).set({ blackLean: 101 }).where(eq(focusStatesTable.nationId, nationId))));
  assert.ok(await rejects(() => db.update(focusStatesTable).set({ redLean: -5 }).where(eq(focusStatesTable.nationId, nationId))));
});

test("focus_active:每槽位只能一條、同國策不可重複、槽位值受限", async () => {
  await db.insert(focusActiveTable).values({ nationId, focusId: "mil.a", slot: "main", totalTurns: 4, spentPoints: 10 });
  assert.ok(await rejects(() => db.insert(focusActiveTable).values({ nationId, focusId: "mil.b", slot: "main", totalTurns: 4, spentPoints: 5 })), "同槽位第二條應被擋");
  assert.ok(await rejects(() => db.insert(focusActiveTable).values({ nationId, focusId: "mil.a", slot: "side", totalTurns: 4, spentPoints: 5 })), "同國策同時佔兩槽應被擋");
  assert.ok(await rejects(() => db.insert(focusActiveTable).values({ nationId, focusId: "mil.c", slot: "third", totalTurns: 4, spentPoints: 5 })), "非法槽位應被擋");
  await db.insert(focusActiveTable).values({ nationId, focusId: "mil.b", slot: "side", totalTurns: 3, spentPoints: 5 });
  const rows = await db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nationId));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.progress, 0);
});

test("focus_completed:同國策只能完成一次", async () => {
  await db.insert(focusCompletedTable).values({ nationId, focusId: "mil.a", eraSlug: "classical" });
  assert.ok(await rejects(() => db.insert(focusCompletedTable).values({ nationId, focusId: "mil.a" })));
});

test("focus_text_overrides:來源受限、同國策一筆", async () => {
  await db.insert(focusTextOverridesTable).values({ nationId, focusId: "mil.a", title: "T", description: "D" });
  const [row] = await db.select().from(focusTextOverridesTable).where(eq(focusTextOverridesTable.nationId, nationId));
  assert.equal(row!.source, "template");
  assert.ok(await rejects(() => db.insert(focusTextOverridesTable).values({ nationId, focusId: "mil.a", title: "T2", description: "D2" })));
  assert.ok(await rejects(() => db.insert(focusTextOverridesTable).values({ nationId, focusId: "mil.z", title: "T", description: "D", source: "hacker" })));
});

test("刪除國家會連帶清掉所有國策資料(ON DELETE CASCADE)", async () => {
  await db.delete(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  for (const t of ["focus_states", "focus_active", "focus_completed", "focus_text_overrides"]) {
    const r = await db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${t} WHERE nation_id = '${nationId}'`));
    assert.equal((r.rows[0] as { c: number }).c, 0, `${t} 應已清空`);
  }
});
