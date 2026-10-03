/**
 * Task #447 — 糧食報告畫面與回合結算口徑一致性整合測試。
 *
 * 糧食報告路由（GET /api/economy/food）與回合引擎的饑荒段都呼叫
 * computeNationFoodReport，但 statsEra 的解析（stats_era null → fallback
 * current_era）分別在各自的呼叫端完成（路由走 getEraSlugs、引擎走
 * doRunTurn 的 `state.statsEra ?? state.currentEra`）。若任一端的時代解析
 * 被改動，玩家會在畫面上看到「不饑荒」，回合卻仍扣人口（或反之）。
 *
 * 本測試把 world_game_state 固定在兩種情境：
 *  1. stats_era = NULL（fallback → current_era）
 *  2. stats_era ≠ current_era（statsEra 應優先於 currentEra）
 * 每種情境都：走真正的 Express 路由取得糧食報告（eraSlug / famine /
 * population）→ 強制回合 → 再走路由，斷言實際扣的人口 = 用「路由回報的
 * 人口與時代」以同一套純函式 faminePopulationLoss 推導的損失。兩個時代的
 * 受控人口刻意選成不同值——引擎若用了跟路由不同的時代口徑，人口基數不同、
 * 扣量斷言必失敗。
 *
 * 沿用 famineTurn.integration.test.ts 的鐵則：快照/還原 world_game_state
 * 全部時鐘欄位；yearsPerTurn=1 + roman 中段（year 400）不跨時代；人口增長
 * 倍率 0 → 人口變化只剩饑荒損失；anthropic.messages.create 覆寫為拋錯讓
 * AI 結算 graceful degrade。資料以名稱前綴標記、self-cleaning。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the food era consistency tests",
  );
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const {
  db,
  pool,
  playerNationsTable,
  playerNotificationsTable,
  regionControlsTable,
  mapRegionEraStatsTable,
  worldGameStateTable,
} = await import("@workspace/db");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runPoliticsMigrations } = await import("../lib/politicsMigrations");
const { runEconomyMigrations } = await import("../lib/economyMigrations");
const { runWorldSimMigrations } = await import("../lib/worldSimMigrations");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapRegionEraStatsSync } = await import("../lib/mapRegionEraStats");
const { runTurnUpdate } = await import("../lib/turnEngine");
const { faminePopulationLoss } = await import("../lib/food");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const economyRouter = (await import("./economy")).default;

const TEST_TAG = "__food_era_test__";
const runId = randomBytes(4).toString("hex");
const CURRENT_ERA = "roman"; // 200–600 年；year 400 + 1 年不跨時代。
const OTHER_ERA = "early_medieval"; // stats_era ≠ current_era 的情境用。

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

let server: http.Server;
let baseUrl: string;
let nationId: string;
let sessionToken: string;
const discordUserId = `${TEST_TAG}${runId}`;

interface FoodResponse {
  eraSlug: string;
  population: number;
  famine: boolean;
  production: { total: number };
  consumption: { total: number };
}

async function fetchFood(): Promise<{ status: number; json: FoodResponse }> {
  const res = await fetch(`${baseUrl}/api/economy/food`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
  return { status: res.status, json: (await res.json()) as FoodResponse };
}

async function cleanup() {
  await db
    .delete(playerNotificationsTable)
    .where(like(playerNotificationsTable.discordUserId, `${TEST_TAG}%`));
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${TEST_TAG}%`));
}

interface WorldSnapshot {
  currentEra: string;
  statsEra: string | null;
  gameDate: string;
  lastTurnDate: string | null;
  lastTurnAt: Date | null;
  yearsPerTurn: number;
  populationGrowthMultiplierPct: number;
}

async function snapshotWorld(): Promise<WorldSnapshot> {
  const [row] = await db
    .select({
      currentEra: worldGameStateTable.currentEra,
      statsEra: worldGameStateTable.statsEra,
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      lastTurnDate: worldGameStateTable.lastTurnDate,
      lastTurnAt: worldGameStateTable.lastTurnAt,
      yearsPerTurn: worldGameStateTable.yearsPerTurn,
      populationGrowthMultiplierPct:
        worldGameStateTable.populationGrowthMultiplierPct,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  assert.ok(row, "world_game_state 應存在");
  return row;
}

async function restoreWorld(snap: WorldSnapshot) {
  await db
    .update(worldGameStateTable)
    .set({
      currentEra: snap.currentEra,
      statsEra: snap.statsEra,
      gameDate: snap.gameDate,
      lastTurnDate: snap.lastTurnDate,
      lastTurnAt: snap.lastTurnAt,
      yearsPerTurn: snap.yearsPerTurn,
      populationGrowthMultiplierPct: snap.populationGrowthMultiplierPct,
    })
    .where(eq(worldGameStateTable.id, 1));
}

/** 固定世界狀態：roman 中段、每回合 1 年、增長倍率 0、指定 stats_era。 */
async function pinWorld(statsEra: string | null) {
  await db
    .update(worldGameStateTable)
    .set({
      currentEra: CURRENT_ERA,
      statsEra,
      gameDate: "0400-01-01",
      yearsPerTurn: 1,
      populationGrowthMultiplierPct: 0,
    })
    .where(eq(worldGameStateTable.id, 1));
}

/**
 * 共用情境：釘住世界 → 路由取得報告（斷言 eraSlug 解析、famine=true）→
 * 強制回合（AI 拋錯）→ 再走路由，斷言扣的人口 = 用路由回報的人口推導的
 * 饑荒損失（同一套純函式、同一個時代口徑）。
 */
async function assertRouteMatchesTurn(
  statsEraSetting: string | null,
  expectedEra: string,
) {
  const snap = await snapshotWorld();
  try {
    await pinWorld(statsEraSetting);
    // 每個情境從零連續饑荒起算，讓損失可精確推導。
    await db
      .update(playerNationsTable)
      .set({ consecutiveFamineTurns: 0 })
      .where(eq(playerNationsTable.id, nationId));

    const before = await fetchFood();
    assert.equal(before.status, 200, `路由應成功：${JSON.stringify(before.json)}`);
    assert.equal(
      before.json.eraSlug,
      expectedEra,
      `路由 eraSlug 應解析為 ${expectedEra}`,
    );
    assert.ok(before.json.population > 0, "路由回報人口應 > 0");
    assert.equal(before.json.production.total, 0, "農民比例 0 → 產出應為 0");
    assert.ok(before.json.consumption.total > 0, "有人口 → 消耗應 > 0");
    assert.equal(before.json.famine, true, "路由應判定饑荒");

    const popBefore = before.json.population;
    const expectedLoss = faminePopulationLoss(popBefore, 0);
    assert.ok(expectedLoss > 0, "饑荒損失應 > 0");

    anthropic.messages.create = (async () => {
      throw new Error("模擬 AI 失敗");
    }) as unknown as MessagesCreate;
    let summary: Awaited<ReturnType<typeof runTurnUpdate>>;
    try {
      summary = await runTurnUpdate(new Date(), { force: true });
    } finally {
      anthropic.messages.create = realMessagesCreate;
    }
    assert.equal(summary.ran, true, "強制回合應完成");
    // summary.era 是世界「當前時代」（非數據時代）：不應跨時代。
    assert.equal(summary.era, CURRENT_ERA, "不應跨時代");

    // 回合後（時鐘尚未還原）：路由與引擎同口徑 → 扣量必須完全吻合。
    // 若引擎用了不同的時代，兩時代人口基數不同（前置條件已鎖），此斷言必敗。
    const after = await fetchFood();
    assert.equal(after.status, 200, `路由應成功：${JSON.stringify(after.json)}`);
    assert.equal(after.json.eraSlug, expectedEra, "回合後路由時代口徑不變");
    assert.equal(
      after.json.population,
      popBefore - expectedLoss,
      `回合實際扣的人口應 = 路由口徑推導的損失（${popBefore} − ${expectedLoss}）`,
    );
    // 饑荒國扣完人口仍無產出 → 路由回合後仍應判定饑荒（畫面與結算一致）。
    assert.equal(after.json.famine, true, "回合後路由仍應判定饑荒");

    const [nationAfter] = await db
      .select({
        consecutiveFamineTurns: playerNationsTable.consecutiveFamineTurns,
      })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .limit(1);
    assert.equal(
      nationAfter?.consecutiveFamineTurns,
      1,
      "引擎確實走了饑荒分支（連續饑荒回合 +1）",
    );
  } finally {
    await restoreWorld(snap);
  }
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runEconomyMigrations();
  await runWorldSimMigrations();
  await runMapRegionSync();
  await runMapRegionEraStatsSync();
  await cleanup();

  // 建立測試國家：農民比例 0 → 產出 0 → 任何時代都必定饑荒；國庫充足避免
  // 國庫危機干擾。
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}${runId}`,
      leaderName: TEST_TAG,
      government: "君主制",
      discordUserId,
      isNpc: false,
      money: 1_000_000,
      farmerPopulationPct: 0,
      foodPolicyMobilization: false,
      foodPolicyRationing: false,
      stability: 50,
      unrest: 0,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "測試國家建立失敗");
  nationId = nation.id;

  // 挑兩個「無人掌控」且在 roman 與 early_medieval 兩時代人口皆 > 0、且
  // 兩時代人口不同的地區——兩時代基數不同，才能證明引擎與路由用同一個時代。
  const controlled = await db
    .select({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable);
  const controlledSet = new Set(controlled.map((r) => r.regionId));
  const romanRows = await db
    .select({
      regionId: mapRegionEraStatsTable.regionId,
      population: mapRegionEraStatsTable.population,
    })
    .from(mapRegionEraStatsTable)
    .where(eq(mapRegionEraStatsTable.era, CURRENT_ERA))
    .orderBy(sql`${mapRegionEraStatsTable.population} DESC`);
  const otherRows = await db
    .select({
      regionId: mapRegionEraStatsTable.regionId,
      population: mapRegionEraStatsTable.population,
    })
    .from(mapRegionEraStatsTable)
    .where(eq(mapRegionEraStatsTable.era, OTHER_ERA));
  const otherPopByRegion = new Map(
    otherRows.map((r) => [r.regionId, Number(r.population)]),
  );
  const free = romanRows
    .filter((r) => {
      const romanPop = Number(r.population);
      const otherPop = otherPopByRegion.get(r.regionId) ?? 0;
      return (
        !controlledSet.has(r.regionId) &&
        romanPop > 0 &&
        otherPop > 0 &&
        romanPop !== otherPop
      );
    })
    .slice(0, 2);
  assert.equal(
    free.length,
    2,
    "需要兩個無人掌控、兩時代人口皆 > 0 且不同的地區",
  );
  await db
    .insert(regionControlsTable)
    .values(free.map((r) => ({ regionId: r.regionId, nationId, percent: 100 })));

  sessionToken = await createSession({
    discordUserId,
    username: discordUserId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info() {},
      warn() {},
      error() {},
    };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", economyRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

test("stats_era = NULL（fallback current_era）：路由 famine 判定與回合扣人口口徑一致", async () => {
  await assertRouteMatchesTurn(null, CURRENT_ERA);
});

test("stats_era ≠ current_era：兩端都以 stats_era 為準，扣量與畫面一致", async () => {
  await assertRouteMatchesTurn(OTHER_ERA, OTHER_ERA);
});
