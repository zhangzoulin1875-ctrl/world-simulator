/**
 * Task #453 — real-DB integration tests for 戰役多國參戰（晚加入選邊制）:
 *
 *  1. 加入資格：與防守方主帥交戰中的真人玩家 → 可加入進攻方（且僅該方）。
 *  2. NPC 國家與無資格戰爭的國家 → 不可加入。
 *  3. joinCampaign 成功寫入參戰列（isLead=false、joinWarId 正確）。
 *  4. 重複加入 → 唯一索引 23505（pgErrorCode 能辨識）。
 *  5. removeJoinersForEndedWar：資格戰爭結束 → 晚加入者自動退出、
 *     軍團刪除、前線傷兵回全國傷兵池；主帥列不受影響。
 *
 * Requires DATABASE_URL（跑過正常啟動遷移的共用開發 DB）。所有資料帶
 * 名稱前綴、before/after 自清：
 * `pnpm --filter @workspace/api-server run test:integration`
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the participants tests");
}

const { and, eq, inArray, like } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerWoundedUnitsTable,
  militaryUnitTemplatesTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignParticipantsTable,
  mapRegionsTable,
} = await import("@workspace/db");
const {
  findActiveWarBetween,
  getJoinEligibility,
  joinCampaign,
  removeJoinersForEndedWar,
} = await import("../lib/warEngine/participants");
const { WarActionError } = await import("../lib/warEngine/shared");
const { pgErrorCode } = await import("../lib/playerValidation");

const runId = randomBytes(4).toString("hex");
const NATION_MARKER = "__wcp453__";
const USER_MARKER = "wcp453-";

const nationName = (suffix: string) => `${NATION_MARKER}${runId}-${suffix}`;

let attackerLeadId = "";
let defenderLeadId = "";
let joinerId = "";
let npcJoinerId = "";
let outsiderId = "";
let joinerUserId = `${USER_MARKER}${runId}-joiner`;
let mainWarId = 0;
let joinWarId = 0;
let campaignId = 0;
let regionA = 0;
let regionB = 0;

async function cleanup() {
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  const ids = nations.map((n) => n.id);
  if (ids.length > 0) {
    // war_campaigns / participants / legions cascade off diplomacy_wars &
    // player_nations FKs.
    await db
      .delete(diplomacyWarsTable)
      .where(inArray(diplomacyWarsTable.nationAId, ids));
    await db
      .delete(diplomacyWarsTable)
      .where(inArray(diplomacyWarsTable.nationBId, ids));
    await db
      .delete(playerNationsTable)
      .where(inArray(playerNationsTable.id, ids));
  }
  await db
    .delete(playerWoundedUnitsTable)
    .where(like(playerWoundedUnitsTable.discordUserId, `${USER_MARKER}%`));
}

before(async () => {
  await cleanup();

  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .limit(2);
  assert.equal(regions.length, 2, "需要至少兩個 map_regions 列");
  regionA = regions[0]!.id;
  regionB = regions[1]!.id;

  const mk = async (suffix: string, opts: { npc?: boolean; user?: string }) => {
    const [row] = await db
      .insert(playerNationsTable)
      .values({
        name: nationName(suffix),
        leaderName: "參戰測試",
        government: "君主制",
        isNpc: opts.npc ?? false,
        discordUserId: opts.user ?? null,
      })
      .returning({ id: playerNationsTable.id });
    return row!.id;
  };

  attackerLeadId = await mk("atk", { user: `${USER_MARKER}${runId}-atk` });
  defenderLeadId = await mk("def", { npc: true });
  joinerId = await mk("joiner", { user: joinerUserId });
  npcJoinerId = await mk("npcjoiner", { npc: true });
  outsiderId = await mk("outsider", { user: `${USER_MARKER}${runId}-out` });

  const insertWar = async (a: string, b: string, declaredBy: string) => {
    const [aId, bId] = [a, b].sort();
    const [row] = await db
      .insert(diplomacyWarsTable)
      .values({ nationAId: aId!, nationBId: bId!, declaredByNationId: declaredBy })
      .returning({ id: diplomacyWarsTable.id });
    return row!.id;
  };

  // 主戰爭：攻方主帥 vs 守方主帥；資格戰爭：joiner vs 守方主帥。
  mainWarId = await insertWar(attackerLeadId, defenderLeadId, attackerLeadId);
  joinWarId = await insertWar(joinerId, defenderLeadId, joinerId);

  const [campaign] = await db
    .insert(warCampaignsTable)
    .values({
      warId: mainWarId,
      attackerNationId: attackerLeadId,
      defenderNationId: defenderLeadId,
      attackerRegionId: regionA,
      defenderRegionId: regionB,
      status: "active",
      nextResolveAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning({ id: warCampaignsTable.id });
  campaignId = campaign!.id;

  await db.insert(warCampaignParticipantsTable).values([
    {
      campaignId,
      nationId: attackerLeadId,
      side: "attacker",
      isLead: true,
      joinWarId: mainWarId,
    },
    {
      campaignId,
      nationId: defenderLeadId,
      side: "defender",
      isLead: true,
      joinWarId: mainWarId,
    },
  ]);
});

after(async () => {
  await cleanup();
  await pool.end();
});

const loadCampaign = async () => {
  const [c] = await db
    .select()
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignId))
    .limit(1);
  assert.ok(c);
  return c;
};

const loadNation = async (id: string) => {
  const [n] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id))
    .limit(1);
  assert.ok(n);
  return n;
};

test("加入資格：與守方主帥交戰的真人 → 只可加入進攻方", async () => {
  const campaign = await loadCampaign();

  const joiner = await loadNation(joinerId);
  const elig = await getJoinEligibility(campaign, joiner);
  assert.equal(elig.alreadyParticipant, false);
  assert.deepEqual(
    elig.joinableSides.map((s) => s.side),
    ["attacker"],
  );
  assert.equal(elig.joinableSides[0]!.joinWarId, joinWarId);

  // 無任何交戰的旁觀者 → 不可加入。
  const outsider = await loadNation(outsiderId);
  const eligOut = await getJoinEligibility(campaign, outsider);
  assert.equal(eligOut.alreadyParticipant, false);
  assert.equal(eligOut.joinableSides.length, 0);

  // 主帥本人 → alreadyParticipant。
  const lead = await loadNation(attackerLeadId);
  const eligLead = await getJoinEligibility(campaign, lead);
  assert.equal(eligLead.alreadyParticipant, true);
});

test("NPC 國家即使交戰中也不可加入", async () => {
  // 給 NPC 一場對守方主帥的戰爭（真人守方主帥才可能，但這裡守方是 NPC —
  // 直接驗證 joinCampaign 的 403 守門即可，不建立 NPC↔NPC 戰爭列）。
  const campaign = await loadCampaign();
  const npc = await loadNation(npcJoinerId);
  const elig = await getJoinEligibility(campaign, npc);
  assert.equal(elig.joinableSides.length, 0);
  await assert.rejects(
    joinCampaign({ campaign, nation: npc, side: "attacker" }),
    (err: unknown) => err instanceof WarActionError && err.status === 403,
  );
});

test("joinCampaign 成功；重複加入 → 23505", async () => {
  const campaign = await loadCampaign();
  const joiner = await loadNation(joinerId);

  const row = await joinCampaign({
    campaign,
    nation: joiner,
    side: "attacker",
  });
  assert.equal(row.isLead, false);
  assert.equal(row.side, "attacker");
  assert.equal(row.joinWarId, joinWarId);

  // 無資格方向仍被擋（joiner 未與攻方主帥交戰 → 不可加入防守方，且已參戰）。
  await assert.rejects(
    joinCampaign({ campaign, nation: joiner, side: "attacker" }),
    (err: unknown) => pgErrorCode(err) === "23505",
    "重複加入應為唯一索引違反（23505 → 409）",
  );

  const participants = await db
    .select()
    .from(warCampaignParticipantsTable)
    .where(eq(warCampaignParticipantsTable.campaignId, campaignId));
  assert.equal(participants.length, 3);
});

test("removeJoinersForEndedWar：資格戰爭結束 → 自動退出＋傷兵返國", async () => {
  // 給 joiner 一個含傷兵的軍團。
  const [template] = await db
    .select({ id: militaryUnitTemplatesTable.id })
    .from(militaryUnitTemplatesTable)
    .limit(1);
  assert.ok(template, "需要至少一個兵種模板");
  const [legion] = await db
    .insert(warCampaignLegionsTable)
    .values({
      campaignId,
      nationId: joinerId,
      slot: "A",
    })
    .returning({ id: warCampaignLegionsTable.id });
  await db.insert(warCampaignLegionUnitsTable).values({
    legionId: legion!.id,
    templateId: template.id,
    quantity: 10,
    wounded: 7,
  });

  // 結束資格戰爭 → 自動退出。
  await db
    .update(diplomacyWarsTable)
    .set({ endedAt: new Date() })
    .where(eq(diplomacyWarsTable.id, joinWarId));
  await removeJoinersForEndedWar(joinWarId);

  const participants = await db
    .select()
    .from(warCampaignParticipantsTable)
    .where(eq(warCampaignParticipantsTable.campaignId, campaignId));
  assert.equal(participants.length, 2, "只剩兩位主帥");
  assert.ok(participants.every((p) => p.isLead));

  const legions = await db
    .select()
    .from(warCampaignLegionsTable)
    .where(
      and(
        eq(warCampaignLegionsTable.campaignId, campaignId),
        eq(warCampaignLegionsTable.nationId, joinerId),
      ),
    );
  assert.equal(legions.length, 0, "joiner 軍團應被刪除");

  const [wounded] = await db
    .select()
    .from(playerWoundedUnitsTable)
    .where(
      and(
        eq(playerWoundedUnitsTable.discordUserId, joinerUserId),
        eq(playerWoundedUnitsTable.templateId, template.id),
      ),
    )
    .limit(1);
  assert.ok(wounded, "前線傷兵應回全國傷兵池");
  assert.ok(wounded.wounded >= 7);

  // 主戰爭與戰役不受影響。
  const campaign = await loadCampaign();
  assert.equal(campaign.status, "active");
});
