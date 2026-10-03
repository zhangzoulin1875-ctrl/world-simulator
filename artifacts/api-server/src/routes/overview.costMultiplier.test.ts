/**
 * Task #390／#469 — 研發成本倍率（costMultiplier）不得悄悄消失。
 *
 * Task #469 起三科技領域整併為全球統一線性科技樹：
 *
 *  1. GET /api/tech-tree/overview 回傳三領域，每個節點的 costPoints 必須等於
 *     adjustedResearchCost(baseCost, getNationResearchCostMultiplierForDomain(
 *     nation, 該領域時代))——國力倍率 × 領先時代加價的共用公式。
 *  2. 軍事總覽（GET /api/military/overview）仍須回傳 costMultiplier =
 *     researchCostMultiplier(調整後生產力, 全球平均)（取整 2 位小數）。
 *
 * 走真正的 Express 端點（掛 session cookie）。anthropic.messages.create 換成
 * 立即拋錯的替身，確保不打真 AI。
 *
 * 需要 DATABASE_URL 指向已遷移的資料庫。資料以 `__ovcmtest__` / `ovcmtest-`
 * 前綴標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the overview costMultiplier tests",
  );
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, like, sql, inArray } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionEraStatsTable,
  techTreeNodesTable,
  userSessionsTable,
} = await import("@workspace/db");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapRegionEraStatsSync } = await import("../lib/mapRegionEraStats");
const { runTechTreeMigrations } = await import("../lib/techTreeMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { computeAdjustedNationStats, getStatsEraSlug } = await import(
  "../lib/nationStats"
);
const {
  adjustedResearchCost,
  researchCostMultiplier,
  getGlobalAveragePopulation,
  getNationResearchCostMultiplierForDomain,
  invalidateGlobalAveragePopulationCache,
} = await import("../lib/researchCost");
const techTreeRouter = (await import("./techTree")).default;
const militaryRouter = (await import("./military")).default;

const NATION_MARKER = "__ovcmtest__";
const USER_MARKER = "ovcmtest-";
const runId = randomBytes(4).toString("hex");

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

let server: http.Server;
let baseUrl: string;
let ownerUserId: string;
let sessionToken: string;
let nationId: string;

async function cleanup() {
  // region_controls CASCADE 於 player_nations，刪國家即可清乾淨。
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/${path}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
  return { status: res.status, json: await res.json() };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function loadNation() {
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  assert.ok(nation, "test nation missing");
  return nation;
}

before(async () => {
  await runMapRegionSync();
  await runMapRegionEraStatsSync();
  await runTechTreeMigrations();
  await cleanup();

  // 任何意外的 AI 呼叫都立即拋錯（本測試不應觸發 AI）。
  anthropic.messages.create = (async () => {
    throw new Error("測試環境不呼叫 AI");
  }) as unknown as MessagesCreate;

  ownerUserId = `${USER_MARKER}owner-${runId}`;
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}A-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: ownerUserId,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "test nation insert failed");
  nationId = nation.id;

  // 找一個「目前無任何控制列」且該數據時代生產素質×人口 > 0 的地區，
  // 給測試國 100% 控制，確保生產力 > 0（倍率必為正）且不破壞 Σ ≤ 100。
  const statsEra = await getStatsEraSlug();
  const [region] = await db
    .select({ regionId: mapRegionEraStatsTable.regionId })
    .from(mapRegionEraStatsTable)
    .where(
      sql`${mapRegionEraStatsTable.era} = ${statsEra}
        AND ${mapRegionEraStatsTable.productivity} > 0
        AND ${mapRegionEraStatsTable.population} > 0
        AND NOT EXISTS (
          SELECT 1 FROM ${regionControlsTable}
          WHERE ${regionControlsTable.regionId} = ${mapRegionEraStatsTable.regionId}
        )`,
    )
    .limit(1);
  assert.ok(region, "找不到無主且有生產力的地區可供測試");
  await db
    .insert(regionControlsTable)
    .values({ regionId: region.regionId, nationId, percent: 100 });

  sessionToken = await createSession({
    discordUserId: ownerUserId,
    username: ownerUserId,
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
  app.use("/api", techTreeRouter);
  app.use("/api", militaryRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  // 我們剛新增控制列，清掉全球平均快取，讓 route 與期望值都用最新資料。
  invalidateGlobalAveragePopulationCache();
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  invalidateGlobalAveragePopulationCache();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

// ── 科技樹總覽：每個節點 costPoints = adjustedResearchCost(baseCost, 共用倍率) ──

test("科技樹總覽三領域節點成本符合共用倍率公式", async () => {
  const { status, json } = await getJson("tech-tree/overview");
  assert.equal(status, 200, `科技樹總覽應回 200：${JSON.stringify(json)}`);
  assert.ok(Array.isArray(json.domains), "總覽應回傳 domains 陣列");
  assert.equal(json.domains.length, 3, "應回傳三個領域");

  const nation = await loadNation();
  for (const domain of json.domains) {
    assert.equal(typeof domain.eraSlug, "string", "每個領域應有 eraSlug");
    assert.ok(
      Array.isArray(domain.nodes) && domain.nodes.length > 0,
      `領域 ${domain.domain} 應有節點（種子內容）`,
    );
    const costMult = await getNationResearchCostMultiplierForDomain(
      nation,
      domain.eraSlug,
    );
    assert.ok(
      Number.isFinite(costMult) && costMult > 0,
      `領域 ${domain.domain} 的成本倍率應為正的有限數字`,
    );

    // 抽樣前 5 個節點：costPoints 必須等於共用公式（依 DB baseCost 重算）。
    const sample = domain.nodes.slice(0, 5);
    const ids = sample.map((n: { id: number }) => n.id);
    const rows = await db
      .select({
        id: techTreeNodesTable.id,
        baseCost: techTreeNodesTable.baseCost,
      })
      .from(techTreeNodesTable)
      .where(inArray(techTreeNodesTable.id, ids));
    const baseCostById = new Map(rows.map((r) => [r.id, r.baseCost]));
    for (const node of sample) {
      const baseCost = baseCostById.get(node.id);
      assert.ok(
        typeof baseCost === "number",
        `節點 ${node.id} 應存在於 tech_tree_nodes`,
      );
      assert.equal(
        node.costPoints,
        adjustedResearchCost(baseCost!, costMult),
        `領域 ${domain.domain} 節點 ${node.name} 的 costPoints 應等於共用公式`,
      );
    }
  }
});

// ── 軍事總覽：costMultiplier = researchCostMultiplier(調整後生產力, 全球平均) ──

test("軍事總覽含 costMultiplier，為正數並符合共用公式", async () => {
  const { status, json } = await getJson("military/overview");
  assert.equal(status, 200, `軍事總覽應回 200：${JSON.stringify(json)}`);

  assert.ok(
    typeof json.costMultiplier === "number" &&
      Number.isFinite(json.costMultiplier),
    "軍事總覽的 costMultiplier 必須是有限數字（前端徽章依賴此欄位）",
  );
  assert.ok(
    json.costMultiplier > 0,
    `軍事總覽的 costMultiplier 應為正數，實得 ${json.costMultiplier}`,
  );

  const statsEra = await getStatsEraSlug();
  const stats = await computeAdjustedNationStats(await loadNation(), statsEra);
  const expected = researchCostMultiplier(
    stats.population,
    await getGlobalAveragePopulation(statsEra),
  );
  assert.equal(
    json.costMultiplier,
    round2(expected),
    "軍事總覽 costMultiplier 應等於 researchCostMultiplier(生產力, 全球平均)（取整 2 位小數）",
  );
});
