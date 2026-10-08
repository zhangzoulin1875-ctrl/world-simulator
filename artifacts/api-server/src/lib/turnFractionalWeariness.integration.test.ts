import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import {
  db, pool, playerNationsTable, politicsEntriesTable, regionControlsTable,
  mapRegionEraStatsTable, worldGameStateTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";
import { runGameMigrations } from "./gameMigrations";
import { runPoliticsMigrations } from "./politicsMigrations";
import { runEconomyMigrations } from "./economyMigrations";
import { runWorldSimMigrations } from "./worldSimMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runMapRegionEraStatsSync } from "./mapRegionEraStats";
import { runTurnUpdate } from "./turnEngine";

/**
 * 回歸（線上實際發生）：政策修正值 × 淡出強度 ＝ 小數的厭戰度增量（如 -6.25），
 * 原本整條 player_nations UPDATE 因 `invalid input syntax for type integer: "-6.25"` 失敗，
 * 該國金錢/人口等當回合全不入帳，且只寫 log。修正後：同一個國家必須正常入帳、不得計入 failures。
 */
const TAG = "__frac_weariness__";
const runId = randomBytes(4).toString("hex");
const LOCK_KEY = 9_999_999_901;
let nationId = "";
let controlId = 0;
const user = `${TAG}u_${runId}`;

type MessagesCreate = typeof anthropic.messages.create;
const realCreate: MessagesCreate = anthropic.messages.create.bind(anthropic.messages);

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try { return await fn(); } finally { await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); }
  } finally { c.release(); }
}
async function cleanup() {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
}

before(async () => {
  await runGameMigrations(); await runPoliticsMigrations(); await runEconomyMigrations();
  await runWorldSimMigrations(); await runMapRegionSync(); await runMapRegionEraStatsSync();
  await cleanup();
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}${runId}`, leaderName: TAG, government: "君主制", discordUserId: user,
    money: 1000, taxRatePct: 10, warWeariness: 50,
  }).returning({ id: playerNationsTable.id });
  nationId = n!.id;
  const controlled = new Set((await db.select({ r: regionControlsTable.regionId }).from(regionControlsTable)).map((x) => x.r));
  const [free] = (await db.select({ r: mapRegionEraStatsTable.regionId, p: mapRegionEraStatsTable.population })
    .from(mapRegionEraStatsTable).where(eq(mapRegionEraStatsTable.era, "ww1"))
    .orderBy(sql`${mapRegionEraStatsTable.population} DESC`)).filter((x) => !controlled.has(x.r) && Number(x.p) > 0);
  assert.ok(free, "需要一個無人掌控、有人口的地區");
  const [rc] = await db.insert(regionControlsTable).values({ regionId: free.r, nationId, percent: 100 }).returning({ id: regionControlsTable.id });
  controlId = rc!.id;
  // 改革類條目隨剩餘回合線性淡出：remaining/duration = 3/4 = 0.75。
  // -8.333… × 0.75 = -6.25，與線上參數完全相同。
  await db.insert(politicsEntriesTable).values({
    nationId, direction: "military", entryType: "reform", title: `${TAG}reform`, description: TAG,
    modifiers: [{ target: "warWeariness", value: 25 / 3 }] as any,
    durationTurns: 4, remainingTurns: 3, status: "active",
  } as any);
});
after(async () => { anthropic.messages.create = realCreate; await cleanup(); await pool.end(); });

test("淡出中的改革產生小數厭戰度增量時，該國仍正常入帳（不得整條 UPDATE 失敗）", async () => {
  const failures: string[] = [];
  const origErr = logger.error.bind(logger);
  (logger as any).error = (a: any, b?: any) => {
    if (typeof b === "string" && b.includes("nation accrual failed") && a?.nationId === nationId) {
      failures.push(String(a?.err?.message ?? a?.err));
    }
    return origErr(a, b);
  };
  const [w] = await db.select().from(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  try {
    await withLock(async () => {
      await db.update(worldGameStateTable).set({
        currentEra: "ww1", statsEra: "ww1", gameDate: "1914-01-01", yearsPerTurn: 1, populationGrowthMultiplierPct: 100,
      }).where(eq(worldGameStateTable.id, 1));
      anthropic.messages.create = (async () => { throw new Error("模擬 AI 失敗"); }) as unknown as MessagesCreate;
      const s = await runTurnUpdate(new Date(), { force: true });
      assert.equal(s.ran, true, "強制回合應完成");
    });
  } finally {
    (logger as any).error = origErr;
    anthropic.messages.create = realCreate;
    await db.update(worldGameStateTable).set({
      currentEra: w!.currentEra, statsEra: w!.statsEra, gameDate: w!.gameDate as any, yearsPerTurn: w!.yearsPerTurn,
      lastTurnDate: w!.lastTurnDate, lastTurnAt: w!.lastTurnAt, populationGrowthMultiplierPct: w!.populationGrowthMultiplierPct,
    }).where(eq(worldGameStateTable.id, 1));
  }

  assert.deepEqual(failures, [], `不應有結算失敗：${failures.join(" | ")}`);
  const [after] = await db.select({ money: playerNationsTable.money, ww: playerNationsTable.warWeariness })
    .from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  assert.ok(Number(after!.money) > 1000, `金錢應增加，實際 ${after!.money}`);
  assert.ok(Number.isInteger(after!.ww), "厭戰度須為整數");
  const [rc] = await db.select({ b: regionControlsTable.populationBonus }).from(regionControlsTable).where(eq(regionControlsTable.id, controlId));
  assert.notEqual(Number(rc!.b), 0, "人口應有變動");
});
