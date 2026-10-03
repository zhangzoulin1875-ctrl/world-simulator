/**
 * Task #578 — 兩地區戰役殘餘持分僵局的確定性掃蕩整合測試（真 DB）。
 *
 * 玩家回報情境：甲國（A 區）進攻乙國（B 區），甲已把乙在 B 區持分清空，
 * 但乙先前反攻取得 A 區 2% 殘餘持分。勝負判定要求乙在兩區持分都歸零，
 * 而確定性推進下限原本只套目標地區 B——AI 不給正向 attackerRegion shift
 * 就永久僵持、A 區被交戰鎖鎖死。修法：敗方主戰場歸零（且該區城市已陷落
 * 或無城市）時，確定性掃蕩（computeMopUpShift）把推進下限導向另一區，
 * 逐週期清除殘餘，讓戰役自然分出勝負。
 *
 *  1. 攻方掃蕩：守方在 B 區 0%、在 A 區殘餘 2%、AI 兩區 shift 全 0 →
 *     數個週期內殘餘被清空、攻方勝、戰役結束；第三方持分不動。
 *  2. 鏡像（守方掃蕩）：攻方在 A 區 0%、在 B 區殘餘 2% → 守方勝。
 *
 * 仿 war.defenderPushbackSettle.test.ts（AI 樁 + 決定性軍團 + 預寫 NPC
 * 指令）；掃蕩條件需要「無城市」地區（城市保底不可繞過），故配對時排除
 * 有城市的地區。模組載入即安裝 anthropic 基準樁，本檔絕不打真 AI。
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the mop-up settle tests");
}

const { and, eq, gt, inArray, like, notExists, sql } = await import(
  "drizzle-orm"
);
const {
  db,
  pool,
  playerNationsTable,
  playerArmiesTable,
  playerWoundedUnitsTable,
  playerNotificationsTable,
  regionControlsTable,
  mapCitiesTable,
  mapRegionAdjacenciesTable,
  militaryUnitTemplatesTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignOrdersTable,
  warRegionCooldownsTable,
} = await import("@workspace/db");
const { initiateCampaign, settleCampaign, flushWarBackgroundWork } =
  await import("../lib/warEngine");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runWallMigrations } = await import("../lib/wallMigrations");

const runId = randomBytes(4).toString("hex");
/** LIKE 清理需避開其他套件的命名空間。 */
const NATION_MARKER = "__mustest__";
const USER_MARKER = "mustest-";

const attackerUserId = `${USER_MARKER}${runId}-atk`;

let attackerId = "";
let defenderId = "";
let thirdPartyId = "";
let templateId = 0;
const OWNED_QUANTITY = 5000;
/** 殘餘持分（回報情境的 2%）。 */
const RESIDUAL_PCT = 2;
const THIRD_PARTY_PCT = 20;
/** 掃蕩至多需要的結算週期數（每週期至少清 1 點 → 2% 殘餘 ≤ 2 週期，留餘裕）。 */
const MAX_CYCLES = 6;

async function cleanup(): Promise<void> {
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(militaryUnitTemplatesTable)
    .where(like(militaryUnitTemplatesTable.name, `${NATION_MARKER}%`));
  await db
    .delete(playerArmiesTable)
    .where(like(playerArmiesTable.discordUserId, `${USER_MARKER}%`));
  await db
    .delete(playerWoundedUnitsTable)
    .where(like(playerWoundedUnitsTable.discordUserId, `${USER_MARKER}%`));
  await db
    .delete(playerNotificationsTable)
    .where(like(playerNotificationsTable.discordUserId, `${USER_MARKER}%`));
}

before(async () => {
  await runWallMigrations();
  await cleanup();

  const mk = async (
    suffix: string,
    opts: { npc?: boolean; user?: string },
  ): Promise<string> => {
    const [row] = await db
      .insert(playerNationsTable)
      .values({
        name: `${NATION_MARKER}${runId}-${suffix}`,
        leaderName: "掃蕩僵局測試",
        government: "君主制",
        isNpc: opts.npc ?? false,
        discordUserId: opts.user ?? null,
      })
      .returning({ id: playerNationsTable.id });
    return row!.id;
  };

  attackerId = await mk("atk", { user: attackerUserId });
  defenderId = await mk("def", { npc: true });
  thirdPartyId = await mk("third", { npc: true });

  const [aId, bId] = [attackerId, defenderId].sort();
  await db.insert(diplomacyWarsTable).values({
    nationAId: aId!,
    nationBId: bId!,
    declaredByNationId: attackerId,
  });

  // Task #549 — 預設兵種已移除：玩家與 NPC 各建專屬步兵模板。
  const unitBase = {
    category: "infantry",
    hp: 100,
    attack: 100,
    defense: 10,
    speed: 1,
    accuracy: 80,
    range: "melee",
    prodCostPer100: 1,
    popCostPerUnit: 1,
    moneyCostPerUnit: 10,
  } as const;
  const [tpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ...unitBase,
      ownerDiscordUserId: attackerUserId,
      name: `${NATION_MARKER}${runId}-步兵`,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  assert.ok(tpl, "player infantry template must be inserted");
  templateId = tpl!.id;
  await db.insert(militaryUnitTemplatesTable).values({
    ...unitBase,
    ownerNationId: defenderId,
    name: `${NATION_MARKER}${runId}-NPC步兵`,
  });
  await db.insert(playerArmiesTable).values([
    { discordUserId: attackerUserId, templateId, quantity: OWNED_QUANTITY },
  ]);
});

const usedRegions: number[] = [];

after(async () => {
  await cleanup();
  if (usedRegions.length > 0) {
    await db
      .delete(warRegionCooldownsTable)
      .where(inArray(warRegionCooldownsTable.regionId, usedRegions));
  }
  await flushWarBackgroundWork();
  await pool.end();
});

/**
 * 找一對「無人控制、無冷卻、兩區皆無城市、未被本檔用過」的相鄰地區。
 * 無城市 → 戰役城市快照為 null（cityLineFallen(null)=true），掃蕩條件
 * 可在殘餘清空時成立；有城市會觸發城市保底（本檔不測該路徑）。
 */
async function findSparePair(): Promise<{ a: number; b: number }> {
  type AdjCol =
    | typeof mapRegionAdjacenciesTable.regionId
    | typeof mapRegionAdjacenciesTable.adjacentRegionId;
  const uncontrolled = (col: AdjCol) =>
    notExists(
      db
        .select({ one: sql`1` })
        .from(regionControlsTable)
        .where(eq(regionControlsTable.regionId, col)),
    );
  const notCooling = (col: AdjCol) =>
    notExists(
      db
        .select({ one: sql`1` })
        .from(warRegionCooldownsTable)
        .where(
          and(
            eq(warRegionCooldownsTable.regionId, col),
            gt(warRegionCooldownsTable.expiresAt, new Date()),
          ),
        ),
    );
  const noCities = (col: AdjCol) =>
    notExists(
      db
        .select({ one: sql`1` })
        .from(mapCitiesTable)
        .where(eq(mapCitiesTable.regionId, col)),
    );
  const pairs = await db
    .select({
      a: mapRegionAdjacenciesTable.regionId,
      b: mapRegionAdjacenciesTable.adjacentRegionId,
    })
    .from(mapRegionAdjacenciesTable)
    .where(
      and(
        sql`${mapRegionAdjacenciesTable.regionId} < ${mapRegionAdjacenciesTable.adjacentRegionId}`,
        uncontrolled(mapRegionAdjacenciesTable.regionId),
        uncontrolled(mapRegionAdjacenciesTable.adjacentRegionId),
        notCooling(mapRegionAdjacenciesTable.regionId),
        notCooling(mapRegionAdjacenciesTable.adjacentRegionId),
        noCities(mapRegionAdjacenciesTable.regionId),
        noCities(mapRegionAdjacenciesTable.adjacentRegionId),
      ),
    )
    .orderBy(
      mapRegionAdjacenciesTable.regionId,
      mapRegionAdjacenciesTable.adjacentRegionId,
    )
    .limit(100);
  const pair = pairs.find(
    (p) => !usedRegions.includes(p.a) && !usedRegions.includes(p.b),
  );
  assert.ok(pair, "need an unclaimed, city-free adjacent region pair");
  usedRegions.push(pair.a, pair.b);
  return pair;
}

async function controlPct(regionId: number, nationId: string): Promise<number> {
  const [row] = await db
    .select({ percent: regionControlsTable.percent })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, regionId),
        eq(regionControlsTable.nationId, nationId),
      ),
    );
  return row?.percent ?? 0;
}

async function regionSumPct(regionId: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${regionControlsTable.percent}), 0)`,
    })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, regionId));
  return Number(row!.total);
}

// ── AI 樁 ──
// Task #569 — 開戰背景地形簡報不打真 API：模組載入即安裝基準樁（合法
// 簡報文字，50–1000 字）；restoreAi() 也回到基準樁。
const TERRAIN_BRIEF_STUB_TEXT =
  "測試樁地形簡報：兩地區以丘陵與河谷相接，攻守要點在渡口與城郊高地，補給線沿河而行，雨季氾濫時僅高地可通行。".repeat(2);
const UNIT_ANALYSIS_STUB_TEXT = JSON.stringify({
  counterSummary: "無顯著兵種克制關係。",
  anachronisticUnits: [],
});
const baselineAiStub = (async (params: { system?: unknown }) => {
  const system = typeof params?.system === "string" ? params.system : "";
  if (system.includes("兵種分析 AI")) {
    return { content: [{ type: "text", text: UNIT_ANALYSIS_STUB_TEXT }] };
  }
  return { content: [{ type: "text", text: TERRAIN_BRIEF_STUB_TEXT }] };
}) as unknown as typeof anthropic.messages.create;
anthropic.messages.create = baselineAiStub;

/** 罐頭週期結算：AI 對兩區 shift 全 0（重現「AI 不給 shift」僵局）。 */
function zeroShiftCycleResult(): unknown {
  const report = "殘餘持分掃蕩僵局測試戰報：戰線僵持、雙方對峙。".repeat(6); // ≥20 字
  const side = {
    legions: [
      {
        slot: "A",
        aggressionPct: 50,
        woundedSharePct: 0,
        moraleDelta: 0,
        supplyDelta: 0,
      },
    ],
    warWearinessDelta: 0,
  };
  return {
    attackerReport: report,
    defenderReport: report,
    attacker: side,
    defender: side,
    territoryShiftPct: { attackerRegion: 0, defenderRegion: 0 },
    attackerSiegeIntensityPct: null,
    defenderSiegeIntensityPct: null,
    localPopulationLossPct: 0,
  };
}

function installAiStub(result: unknown): void {
  anthropic.messages.create = (async (params: { system?: unknown }) => {
    const system = typeof params?.system === "string" ? params.system : "";
    if (system.includes("兵種分析 AI")) {
      return { content: [{ type: "text", text: UNIT_ANALYSIS_STUB_TEXT }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }) as unknown as typeof anthropic.messages.create;
}
function restoreAi(): void {
  anthropic.messages.create = baselineAiStub;
}

/**
 * 建立兩地區戰役後，把控制列改寫成「僵局狀態」：
 *  - 開戰前先鋪正常控制（攻 80% rA／守 70% rB）讓守門通過；
 *  - 開戰後依情境覆寫 region_controls（deadlock 參數）；
 *  - 決定性軍團（同模板、同士氣補給）取代自動軍團；
 *  - 掃蕩方壓倒優勢（1000 vs 100）→ 每週期掃蕩量足以數週期內清空殘餘。
 */
async function setupDeadlockCampaign(opts: {
  attackerTroops: number;
  defenderTroops: number;
  /** 開戰後覆寫的控制列（regionId/nationId/percent；先清空兩區再寫入）。 */
  deadlockControls: (rA: number, rB: number) => {
    regionId: number;
    nationId: string;
    percent: number;
  }[];
}): Promise<{ campaignId: number; rA: number; rB: number }> {
  const { a: rA, b: rB } = await findSparePair();
  await db.insert(regionControlsTable).values([
    { regionId: rA, nationId: attackerId, percent: 80 },
    { regionId: rB, nationId: defenderId, percent: 70 },
  ]);

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: rA,
    defenderRegionId: rB,
  });

  // 決定性軍團取代自動軍團。
  await db
    .delete(warCampaignLegionsTable)
    .where(eq(warCampaignLegionsTable.campaignId, campaign.id));
  for (const [nationId, quantity] of [
    [attackerId, opts.attackerTroops],
    [defenderId, opts.defenderTroops],
  ] as const) {
    const [legion] = await db
      .insert(warCampaignLegionsTable)
      .values({
        campaignId: campaign.id,
        nationId,
        slot: "A",
        morale: 80,
        supply: 100,
        garrisoningCity: false,
      })
      .returning({ id: warCampaignLegionsTable.id });
    await db.insert(warCampaignLegionUnitsTable).values({
      legionId: legion!.id,
      templateId,
      quantity,
      wounded: 0,
    });
  }

  // 覆寫成僵局狀態的控制列。
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, [rA, rB]));
  const rows = opts.deadlockControls(rA, rB);
  if (rows.length > 0) {
    await db.insert(regionControlsTable).values(rows);
  }

  // 收斂開戰觸發的背景地形簡報 AI 工作，避免其誤觸結算樁。
  await flushWarBackgroundWork();

  return { campaignId: campaign.id, rA, rB };
}

/**
 * 逐週期結算直到戰役結束（每週期預寫 NPC 守方指令跳過指令生成 AI）。
 * 回傳實際用掉的週期數。
 */
async function settleUntilEnded(campaignId: number): Promise<number> {
  installAiStub(zeroShiftCycleResult());
  try {
    for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
      const [row] = await db
        .select({ cycleNumber: warCampaignsTable.cycleNumber })
        .from(warCampaignsTable)
        .where(eq(warCampaignsTable.id, campaignId))
        .limit(1);
      assert.ok(row, "campaign row must exist during settle loop");
      await db.insert(warCampaignOrdersTable).values({
        campaignId,
        nationId: defenderId,
        cycleNumber: row!.cycleNumber,
        orderType: "command",
        body: "掃蕩僵局測試：固定防守指令",
      });
      const res = await settleCampaign(campaignId);
      assert.equal(
        res.settled || res.ended,
        true,
        `第 ${cycle} 週期結算應成功：${JSON.stringify(res)}`,
      );
      if (res.ended) return cycle;
    }
  } finally {
    restoreAi();
  }
  assert.fail(`${MAX_CYCLES} 個週期內戰役仍未結束（掃蕩未生效、僵局未解）`);
}

/** 測後清理：刪戰役（釋放交戰鎖）、清傷兵池、常備軍還原、清此輪控制列。 */
async function teardownCampaign(
  campaignId: number,
  regionIds: number[],
): Promise<void> {
  await db.delete(warCampaignsTable).where(eq(warCampaignsTable.id, campaignId));
  await db
    .delete(playerWoundedUnitsTable)
    .where(like(playerWoundedUnitsTable.discordUserId, `${USER_MARKER}%`));
  await db
    .update(playerArmiesTable)
    .set({ quantity: OWNED_QUANTITY })
    .where(eq(playerArmiesTable.discordUserId, attackerUserId));
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, regionIds));
}

test("攻方掃蕩：守方 B 區歸零、A 區殘餘 2%、AI shift 全 0 → 數週期內清空、攻方勝", async () => {
  const { campaignId, rA, rB } = await setupDeadlockCampaign({
    attackerTroops: 1000,
    defenderTroops: 100,
    deadlockControls: (a, b) => [
      // A 區：攻方 58% + 守方殘餘 2% + 第三方 20%（驗證第三方不動）。
      { regionId: a, nationId: attackerId, percent: 58 },
      { regionId: a, nationId: defenderId, percent: RESIDUAL_PCT },
      { regionId: a, nationId: thirdPartyId, percent: THIRD_PARTY_PCT },
      // B 區：守方已被清空（無列），攻方已佔 70%。
      { regionId: b, nationId: attackerId, percent: 70 },
    ],
  });

  const cycles = await settleUntilEnded(campaignId);
  assert.ok(
    cycles <= MAX_CYCLES,
    `掃蕩應在 ${MAX_CYCLES} 週期內終結戰役（實際 ${cycles}）`,
  );

  // 戰役以攻方獲勝收場。
  const [campaign] = await db
    .select({
      status: warCampaignsTable.status,
      winnerNationId: warCampaignsTable.winnerNationId,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignId))
    .limit(1);
  assert.equal(campaign!.status, "ended", "戰役狀態應為已結束");
  assert.equal(campaign!.winnerNationId, attackerId, "勝方應為攻方");

  // 守方在 A 區的殘餘持分被掃蕩清空；移轉只在交戰雙方之間（第三方不動）。
  assert.equal(await controlPct(rA, defenderId), 0, "守方 A 區殘餘應被清空");
  assert.equal(
    await controlPct(rA, thirdPartyId),
    THIRD_PARTY_PCT,
    "第三方持分不得被掃蕩動到",
  );
  assert.equal(
    await controlPct(rA, attackerId),
    58 + RESIDUAL_PCT,
    "殘餘持分應移轉給攻方",
  );
  assert.equal(await regionSumPct(rA), 80, "A 區控制率總和守恆");
  // B 區不受掃蕩影響（守方本就 0%）。
  assert.equal(await controlPct(rB, attackerId), 70);
  assert.equal(await controlPct(rB, defenderId), 0);

  await teardownCampaign(campaignId, [rA, rB]);
});

test("鏡像（守方掃蕩）：攻方 A 區歸零、B 區殘餘 2% → 守方終結戰役獲勝", async () => {
  const { campaignId, rA, rB } = await setupDeadlockCampaign({
    attackerTroops: 100,
    defenderTroops: 1000,
    deadlockControls: (a, b) => [
      // A 區：攻方已被守方反攻清空（無列），守方佔 80%。
      { regionId: a, nationId: defenderId, percent: 80 },
      // B 區：守方 68% + 攻方殘餘 2%。
      { regionId: b, nationId: defenderId, percent: 68 },
      { regionId: b, nationId: attackerId, percent: RESIDUAL_PCT },
    ],
  });

  const cycles = await settleUntilEnded(campaignId);
  assert.ok(
    cycles <= MAX_CYCLES,
    `鏡像掃蕩應在 ${MAX_CYCLES} 週期內終結戰役（實際 ${cycles}）`,
  );

  const [campaign] = await db
    .select({
      status: warCampaignsTable.status,
      winnerNationId: warCampaignsTable.winnerNationId,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignId))
    .limit(1);
  assert.equal(campaign!.status, "ended", "戰役狀態應為已結束");
  assert.equal(campaign!.winnerNationId, defenderId, "勝方應為守方");

  // 攻方在 B 區的殘餘持分被守方掃蕩清空。
  assert.equal(await controlPct(rB, attackerId), 0, "攻方 B 區殘餘應被清空");
  assert.equal(
    await controlPct(rB, defenderId),
    68 + RESIDUAL_PCT,
    "殘餘持分應移轉給守方",
  );
  assert.equal(await regionSumPct(rB), 70, "B 區控制率總和守恆");
  // A 區不受掃蕩影響（攻方本就 0%；守方反攻 pushback 對 0% 無效）。
  assert.equal(await controlPct(rA, defenderId), 80);
  assert.equal(await controlPct(rA, attackerId), 0);

  await teardownCampaign(campaignId, [rA, rB]);
});
