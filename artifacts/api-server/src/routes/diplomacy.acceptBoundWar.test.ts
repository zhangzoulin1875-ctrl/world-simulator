/**
 * Task #438 — 附條件停戰（boundWarId 條約）經「接受路由」成立後，
 * 該場戰爭的進行中戰役必須全部收尾（鐵則：戰爭結束的每條路徑都必須
 * endCampaignsForWar）。
 *
 * 走真實 HTTP 接受路由（treatyLifecycle router + Discord session cookie）：
 *  1. NPC↔真人玩家戰爭 + 進行中 campaign（含地區交戰鎖），玩家接受
 *     boundWarId 條約 → 200，戰爭 endedAt 已設、campaign 全數
 *     status=ended / endReason=ceasefire、warRegionEngagements 釋放、
 *     地區冷卻已寫入。
 *  2. 同一場戰爭有多場 campaign → 全部收尾，無孤兒戰役。
 *
 * 測試資料自成一體（名稱前綴 + cascade 清理）；借用無人掌控的
 * map_regions offset 260（避開 0/80/120/150/160/170/190/200/230）。
 * 跑法：test-integration workflow（真 DB，--test-concurrency=1）。
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the accept-bound-war tests");
}

const { and, eq, inArray, isNull, like, or, sql } = await import(
  "drizzle-orm"
);
const {
  db,
  pool,
  playerNationsTable,
  playerNotificationsTable,
  regionControlsTable,
  mapRegionsTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warRegionCooldownsTable,
  warRegionEngagementsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { runMilitaryMigrations } = await import("../lib/militaryMigrations");
const { runWarMigrations } = await import("../lib/warMigrations");
// player_nations 的 satisfaction_* 欄位由政治遷移補上（idempotent）。
const { runPoliticsMigrations } = await import("../lib/politicsMigrations");
const { insertNpcTreatyProposal } = await import("../lib/treatyPropose");
const { canonicalPair } = await import("../lib/diplomacy");
const { createSession, SESSION_COOKIE_NAME } = await import(
  "../lib/sessions"
);
const { default: treatyLifecycleRouter } = await import(
  "./diplomacy/treatyLifecycle"
);

const TEST_TAG = "__acceptboundwar438__";
const runId = randomBytes(4).toString("hex");
const discordUserId = `${TEST_TAG}${runId}`;

let npcId = "";
let playerId = "";
let regionIds: number[] = [];
let sessionToken = "";
let server: http.Server;
let baseUrl = "";

/** 建立一場 NPC↔玩家的進行中戰爭（canonical pair）。 */
async function createWar(): Promise<number> {
  const { low, high } = canonicalPair(npcId, playerId);
  const [row] = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: low, nationBId: high, declaredByNationId: npcId })
    .returning({ id: diplomacyWarsTable.id });
  assert.ok(row, "test war insert failed");
  return row.id;
}

/** 建立一場進行中的 campaign（NPC 攻、玩家守）＋ 地區交戰鎖。 */
async function seedCampaign(
  warId: number,
  attackerRegionId: number,
  defenderRegionId: number,
): Promise<number> {
  const [campaign] = await db
    .insert(warCampaignsTable)
    .values({
      warId,
      attackerNationId: npcId,
      defenderNationId: playerId,
      attackerRegionId,
      defenderRegionId,
      status: "active",
      cycleHours: 4,
      nextResolveAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: warCampaignsTable.id });
  assert.ok(campaign, "test campaign insert failed");
  await db.insert(warRegionEngagementsTable).values(
    [attackerRegionId, defenderRegionId].map((regionId) => ({
      regionId,
      campaignId: campaign.id,
    })),
  );
  return campaign.id;
}

function acceptViaRoute(treatyId: number): Promise<Response> {
  return fetch(`${baseUrl}/api/diplomacy/treaties/${treatyId}/accept`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
  });
}

async function clearTestState() {
  const ids = [npcId, playerId];
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        inArray(diplomacyTreatiesTable.proposerNationId, ids),
        inArray(diplomacyTreatiesTable.targetNationId, ids),
      ),
    );
  // campaigns / engagements 隨 war cascade。
  await db
    .delete(diplomacyWarsTable)
    .where(
      or(
        inArray(diplomacyWarsTable.nationAId, ids),
        inArray(diplomacyWarsTable.nationBId, ids),
      ),
    );
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.nationId, ids));
  if (regionIds.length > 0) {
    await db
      .delete(warRegionCooldownsTable)
      .where(inArray(warRegionCooldownsTable.regionId, regionIds));
  }
  await db
    .update(playerNationsTable)
    .set({ money: 1_000, techPoints: 0 })
    .where(inArray(playerNationsTable.id, ids));
}

before(async () => {
  await runGameMigrations();
  await runMilitaryMigrations();
  await runDiplomacyMigrations();
  await runWarMigrations();
  await runPoliticsMigrations();

  // 清掉先前殘留的測試資料（若上次執行中斷）。
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${TEST_TAG}%`));
  await db
    .delete(playerNotificationsTable)
    .where(like(playerNotificationsTable.discordUserId, `${TEST_TAG}%`));

  const [npcRow] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}npc-${runId}`,
      leaderName: TEST_TAG,
      money: 1_000,
      isNpc: true,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(npcRow, "npc nation insert failed");
  npcId = npcRow.id;

  const [playerRow] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}player-${runId}`,
      leaderName: TEST_TAG,
      money: 1_000,
      isNpc: false,
      discordUserId,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(playerRow, "player nation insert failed");
  playerId = playerRow.id;

  sessionToken = await createSession({
    discordUserId,
    username: TEST_TAG,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  // 借用無人掌控的地區；offset 260 避開其他整合測試。
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(260)
    .limit(4);
  regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 4, "測試需要至少 4 個無人掌控的地區");

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info() {},
      warn() {},
      error() {},
    };
    // readSessionToken 讀 req.cookies（正式 app 由 cookie-parser 填）；
    // 測試用最小 shim 解析 cookie header。
    const cookies: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) cookies[part.slice(0, idx).trim()] = part.slice(idx + 1);
    }
    (req as unknown as { cookies: Record<string, string> }).cookies = cookies;
    next();
  });
  app.use(express.json());
  app.use("/api", treatyLifecycleRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await clearTestState();
});

after(async () => {
  await clearTestState();
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${TEST_TAG}%`));
  await db
    .delete(playerNotificationsTable)
    .where(like(playerNotificationsTable.discordUserId, `${TEST_TAG}%`));
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  await pool.end();
});

test("接受 boundWarId 條約：戰爭結束且該戰爭所有進行中戰役全部收尾", async () => {
  const warId = await createWar();
  // 同一場戰爭兩場進行中戰役（不同地區對）→ 接受後必須全部收尾。
  const campaignA = await seedCampaign(warId, regionIds[0]!, regionIds[1]!);
  const campaignB = await seedCampaign(warId, regionIds[2]!, regionIds[3]!);

  // NPC 向玩家提出附條件停戰（索求金錢；proposerIsPayer:false + boundWarId）。
  const treaty = await insertNpcTreatyProposal({
    proposerNationId: npcId,
    targetNationId: playerId,
    type: "nonaggression",
    durationDays: null,
    offerMoney: 200,
    proposerIsPayer: false,
    boundWarId: warId,
  });
  assert.ok(treaty, "提案插入應成功");
  assert.equal(treaty.boundWarId, warId);

  const res = await acceptViaRoute(treaty.id);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as { treaty?: { status?: string } };
  assert.equal(body.treaty?.status, "active");

  // 戰爭已結束。
  const [war] = await db
    .select({ endedAt: diplomacyWarsTable.endedAt })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, warId));
  assert.ok(war?.endedAt, "戰爭 ended_at 必須已設值");

  // 該戰爭所有戰役均已收尾（ended / ceasefire），無孤兒戰役。
  const campaigns = await db
    .select({
      id: warCampaignsTable.id,
      status: warCampaignsTable.status,
      endReason: warCampaignsTable.endReason,
      endedAt: warCampaignsTable.endedAt,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.warId, warId));
  assert.equal(campaigns.length, 2);
  for (const c of campaigns) {
    assert.equal(c.status, "ended", `campaign ${c.id} 應已結束`);
    assert.equal(c.endReason, "ceasefire");
    assert.ok(c.endedAt, `campaign ${c.id} ended_at 應已設值`);
  }

  // 地區交戰鎖已釋放。
  const engagements = await db
    .select()
    .from(warRegionEngagementsTable)
    .where(
      inArray(warRegionEngagementsTable.campaignId, [campaignA, campaignB]),
    );
  assert.equal(engagements.length, 0, "warRegionEngagements 應全數釋放");

  // 四個地區都寫入冷卻。
  const cooldowns = await db
    .select({ regionId: warRegionCooldownsTable.regionId })
    .from(warRegionCooldownsTable)
    .where(inArray(warRegionCooldownsTable.regionId, regionIds));
  assert.equal(cooldowns.length, 4, "四個涉戰地區都應寫入冷卻");

  // 金錢方向：玩家付 200 給 NPC（附條件停戰 oneTimeFlip）。
  const money = await db
    .select({
      id: playerNationsTable.id,
      money: playerNationsTable.money,
    })
    .from(playerNationsTable)
    .where(inArray(playerNationsTable.id, [npcId, playerId]));
  const byId = new Map(money.map((m) => [m.id, m.money]));
  assert.equal(byId.get(npcId), 1_200);
  assert.equal(byId.get(playerId), 800);
});

test("戰爭已先結束：接受路由 400，既有戰役不被本路徑動到", async () => {
  const warId = await createWar();
  const campaignId = await seedCampaign(warId, regionIds[0]!, regionIds[1]!);

  const treaty = await insertNpcTreatyProposal({
    proposerNationId: npcId,
    targetNationId: playerId,
    type: "nonaggression",
    durationDays: null,
    offerMoney: 200,
    proposerIsPayer: false,
    boundWarId: warId,
  });
  assert.ok(treaty, "提案插入應成功");

  // 戰爭先由其他路徑結束。
  await db
    .update(diplomacyWarsTable)
    .set({ endedAt: new Date(Date.now() - 60_000) })
    .where(eq(diplomacyWarsTable.id, warId));

  const res = await acceptViaRoute(treaty.id);
  assert.equal(res.status, 400, await res.text());

  // 本路徑不動戰役（孤兒戰役由結算迴圈兜底，不在此測試範圍）。
  const [campaign] = await db
    .select({ status: warCampaignsTable.status })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignId));
  assert.equal(campaign?.status, "active");

  // 條約仍 proposed。
  const [fresh] = await db
    .select({ status: diplomacyTreatiesTable.status })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, treaty.id));
  assert.equal(fresh?.status, "proposed");
});
