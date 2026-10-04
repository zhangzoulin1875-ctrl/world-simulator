import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db, pool, playerNationsTable } from "@workspace/db";
import { runGameMigrations } from "./gameMigrations";
import { runAutopilotMigrations } from "./autopilotMigrations";
import {
  getAutopilotSettings,
  isAutopilotLocked,
  isMissingTableError,
} from "./autopilotState";

/** 啟動遷移沒建成 autopilot_settings 時，第一次讀取應自建而不是 500。 */
const TAG = "autopilot-selfheal-test";
let nationId = "";
const userId = `${TAG}-${process.pid}`;

before(async () => {
  await runGameMigrations();
  await runAutopilotMigrations();
  await db.delete(playerNationsTable).where(eq(playerNationsTable.discordUserId, userId));
  const [n] = await db
    .insert(playerNationsTable)
    .values({ name: TAG, leaderName: TAG, discordUserId: userId })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
});

after(async () => {
  await db.delete(playerNationsTable).where(eq(playerNationsTable.discordUserId, userId));
  await pool.end();
});

test("isMissingTableError：辨識 drizzle 包裝的 42P01", () => {
  assert.equal(isMissingTableError({ cause: { code: "42P01" } }), true);
  assert.equal(isMissingTableError({ code: "23505" }), false);
  assert.equal(isMissingTableError(new Error("x")), false);
});

test("表被刪掉後 getAutopilotSettings 自建並回 null，而非丟錯", async () => {
  await db.execute(sql`DROP TABLE IF EXISTS autopilot_settings`);
  const r = await getAutopilotSettings(nationId);
  assert.equal(r, null);
  const t = await db.execute(sql`SELECT to_regclass('public.autopilot_settings') AS t`);
  assert.ok((t.rows[0] as { t: string | null }).t, "表應已被補建");
});

test("表被刪掉後 isAutopilotLocked 同樣自建並回 false（不擋玩家）", async () => {
  await db.execute(sql`DROP TABLE IF EXISTS autopilot_settings`);
  // 自愈有 30 秒冷卻旗標；此測試同進程第二次，表仍需可用。
  const locked = await isAutopilotLocked(userId);
  assert.equal(locked, false);
});
