/**
 * 回合引擎：NPC 主帥在戰役地區領土歸零 → 自動結束戰役整合測試。
 *
 * 驗證 endCampaignsForLocallyEliminatedNpcs()（warEngine/npcLocalCollapse.ts）：
 *   1. NPC 主帥在戰役涉及的兩地區皆無 region_controls → 戰役結束
 *      （endReason=territory、winner=對方主帥）、地區交戰鎖釋放、寫入冷卻。
 *   2. NPC 主帥仍在其中一區有領土 → 戰役不受影響。
 *   3. 真人玩家主帥即使當地零領土 → 永不自動判負。
 *   4. 不動 diplomacy_wars 列（全域除名由 runNpcExtinctionCheck 負責）。
 *
 * 測試資料自成一體（名稱前綴標記、after 清理），地區借用 offset 260
 * （避開其他整合測試 0/80/120/150/160/170/190/200/210/230/250）。
 * 跑法：test-integration workflow。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the npc-local-collapse tests");
}

const { asc, eq, inArray, like } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  mapRegionsTable,
  regionControlsTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warRegionEngagementsTable,
  warRegionCooldownsTable,
  playerNotificationsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runMilitaryMigrations } = await import("./militaryMigrations");
const { runDiplomacyMigrations } = await import("./diplomacyMigrations");
const { runWarMigrations } = await import("./warMigrations");
const { canonicalPair } = await import("./diplomacy");
const { endCampaignsForLocallyEliminatedNpcs } = await import(
  "./warEngine/npcLocalCollapse"
);

const MARKER = `npclocal_${randomBytes(4).toString("hex")}_`;
const PLAYER_DISCORD = `__${MARKER}player__`;

let playerId = ""; // 真人玩家（攻方主帥）
let npcCollapsedId = ""; // NPC、當地零領土 → 其戰役應被結束
let npcHoldingId = ""; // NPC、當地仍有領土 → 戰役保留
let playerZeroId = ""; // 真人玩家、當地零領土 → 永不自動判負
let regionIds: number[] = []; // 6 塊借用地區（r0..r5）
let campaignCollapsedId = 0;
let campaignHoldingId = 0;
let campaignPlayerZeroId = 0;
let warCollapsedId = 0;

async function seedWarAndCampaign(params: {
  attackerId: string;
  defenderId: string;
  attackerRegionId: number;
  defenderRegionId: number;
}): Promise<{ warId: number; campaignId: number }> {
  const { low, high } = canonicalPair(params.attackerId, params.defenderId);
  const [war] = await db
    .insert(diplomacyWarsTable)
    .values({
      nationAId: low,
      nationBId: high,
      declaredByNationId: params.attackerId,
    })
    .returning({ id: diplomacyWarsTable.id });
  assert.ok(war, "war insert failed");
  const [campaign] = await db
    .insert(warCampaignsTable)
    .values({
      warId: war.id,
      attackerNationId: params.attackerId,
      defenderNationId: params.defenderId,
      attackerRegionId: params.attackerRegionId,
      defenderRegionId: params.defenderRegionId,
      status: "active",
      cycleHours: 4,
      nextResolveAt: new Date(Date.now() + 3600_000),
    })
    .returning({ id: warCampaignsTable.id });
  assert.ok(campaign, "campaign insert failed");
  await db.insert(warRegionEngagementsTable).values([
    { regionId: params.attackerRegionId, campaignId: campaign.id },
    { regionId: params.defenderRegionId, campaignId: campaign.id },
  ]);
  return { warId: war.id, campaignId: campaign.id };
}

async function cleanup(): Promise<void> {
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
  const ids = nations.map((n) => n.id);
  if (ids.length > 0) {
    const campaigns = await db
      .select({ id: warCampaignsTable.id })
      .from(warCampaignsTable)
      .where(inArray(warCampaignsTable.attackerNationId, ids));
    const campaignIds = campaigns.map((c) => c.id);
    if (campaignIds.length > 0) {
      await db
        .delete(warRegionEngagementsTable)
        .where(inArray(warRegionEngagementsTable.campaignId, campaignIds));
      await db
        .delete(warCampaignsTable)
        .where(inArray(warCampaignsTable.id, campaignIds));
    }
    // diplomacy_wars 的 nation 欄位無真實 cascade（鐵則）→ 顯式刪除。
    await db
      .delete(diplomacyWarsTable)
      .where(inArray(diplomacyWarsTable.nationAId, ids));
    await db
      .delete(diplomacyWarsTable)
      .where(inArray(diplomacyWarsTable.nationBId, ids));
    await db
      .delete(regionControlsTable)
      .where(inArray(regionControlsTable.nationId, ids));
  }
  if (regionIds.length > 0) {
    await db
      .delete(warRegionCooldownsTable)
      .where(inArray(warRegionCooldownsTable.regionId, regionIds));
  }
  await db
    .delete(playerNotificationsTable)
    .where(eq(playerNotificationsTable.discordUserId, PLAYER_DISCORD));
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
}

before(async () => {
  await runGameMigrations();
  await runMilitaryMigrations();
  await runDiplomacyMigrations();
  await runWarMigrations();
  await cleanup();

  const [player] = await db
    .insert(playerNationsTable)
    .values({
      name: `${MARKER}玩家國`,
      leaderName: MARKER,
      isNpc: false,
      discordUserId: PLAYER_DISCORD,
    })
    .returning({ id: playerNationsTable.id });
  playerId = player!.id;
  const [collapsed] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}崩潰NPC`, leaderName: MARKER, isNpc: true })
    .returning({ id: playerNationsTable.id });
  npcCollapsedId = collapsed!.id;
  const [holding] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}守土NPC`, leaderName: MARKER, isNpc: true })
    .returning({ id: playerNationsTable.id });
  npcHoldingId = holding!.id;
  const [pzero] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}零土玩家`, leaderName: MARKER, isNpc: false })
    .returning({ id: playerNationsTable.id });
  playerZeroId = pzero!.id;

  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .orderBy(asc(mapRegionsTable.id))
    .offset(260)
    .limit(6);
  assert.equal(regions.length, 6, "需要 6 塊 map_regions 供戰役借用");
  regionIds = regions.map((r) => r.id);

  // 戰役 1：NPC 主帥（守方）在兩區皆無領土 → 應被結束。
  const c1 = await seedWarAndCampaign({
    attackerId: playerId,
    defenderId: npcCollapsedId,
    attackerRegionId: regionIds[0]!,
    defenderRegionId: regionIds[1]!,
  });
  campaignCollapsedId = c1.campaignId;
  warCollapsedId = c1.warId;

  // 戰役 2：NPC 主帥（守方）在守方地區仍有領土 → 保留。
  const c2 = await seedWarAndCampaign({
    attackerId: playerId,
    defenderId: npcHoldingId,
    attackerRegionId: regionIds[2]!,
    defenderRegionId: regionIds[3]!,
  });
  campaignHoldingId = c2.campaignId;
  await db.insert(regionControlsTable).values({
    regionId: regionIds[3]!,
    nationId: npcHoldingId,
    percent: 40,
  });

  // 戰役 3：真人主帥（守方）零領土 → 永不自動判負。
  const c3 = await seedWarAndCampaign({
    attackerId: playerId,
    defenderId: playerZeroId,
    attackerRegionId: regionIds[4]!,
    defenderRegionId: regionIds[5]!,
  });
  campaignPlayerZeroId = c3.campaignId;
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("當地零領土的 NPC 主帥戰役被結束；有領土 NPC 與零領土玩家不受影響", async () => {
  const summary = await endCampaignsForLocallyEliminatedNpcs();
  assert.ok(summary.endedCount >= 1, "本回合至少應結束本測試的崩潰 NPC 戰役");

  // 1. 崩潰 NPC 的戰役：ended / territory / 對方主帥獲勝；交戰鎖釋放、寫入冷卻。
  const [c1] = await db
    .select()
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignCollapsedId));
  assert.ok(c1, "戰役 1 應存在");
  assert.equal(c1.status, "ended", "崩潰 NPC 的戰役應被結束");
  assert.equal(c1.endReason, "territory");
  assert.equal(c1.winnerNationId, playerId, "獲勝方應為對方主帥");
  assert.ok(c1.endedAt, "endedAt 應被寫入");

  const engagements = await db
    .select({ regionId: warRegionEngagementsTable.regionId })
    .from(warRegionEngagementsTable)
    .where(eq(warRegionEngagementsTable.campaignId, campaignCollapsedId));
  assert.equal(engagements.length, 0, "地區交戰鎖應被釋放");

  const cooldowns = await db
    .select({ regionId: warRegionCooldownsTable.regionId })
    .from(warRegionCooldownsTable)
    .where(
      inArray(warRegionCooldownsTable.regionId, [regionIds[0]!, regionIds[1]!]),
    );
  assert.equal(cooldowns.length, 2, "兩塊戰役地區都應寫入冷卻");

  // 不動 diplomacy_wars：戰爭列仍在、endedAt 未被寫。
  const [war] = await db
    .select({ endedAt: diplomacyWarsTable.endedAt })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, warCollapsedId));
  assert.ok(war, "diplomacy_wars 列應保留");
  assert.equal(war.endedAt, null, "戰爭列 endedAt 不應被此檢查寫入");

  // 2. 有領土的 NPC 戰役保留。
  const [c2] = await db
    .select({ status: warCampaignsTable.status })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignHoldingId));
  assert.equal(c2?.status, "active", "有領土 NPC 的戰役不應被結束");

  // 3. 真人主帥零領土 → 不自動判負。
  const [c3] = await db
    .select({ status: warCampaignsTable.status })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignPlayerZeroId));
  assert.equal(c3?.status, "active", "真人玩家永不因當地零領土被自動判負");

  // 重跑冪等：已結束戰役不會重複計數。
  const again = await endCampaignsForLocallyEliminatedNpcs();
  const [c1Again] = await db
    .select({ status: warCampaignsTable.status })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignCollapsedId));
  assert.equal(c1Again?.status, "ended");
  assert.ok(again.endedCount >= 0, "重跑不應丟例外");
});
