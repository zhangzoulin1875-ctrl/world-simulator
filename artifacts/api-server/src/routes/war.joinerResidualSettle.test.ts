/**
 * Task #579 — 多國戰役「敗方側晚加入者殘餘持分」僵局整合測試（真 DB）。
 *
 * Task #578 修了 1v1 的殘餘持分僵局（確定性掃蕩），但多國變體仍會卡死：
 * 領土移轉的輸家永遠是敗方主帥（Task #453），晚加入者的持分不會被本戰役
 * 移轉；勝負判定若以「該邊合計持分」計，敗方側 joiner 只要在戰役兩區之一
 * 持有任何持分（戰前既有、或戰局逆轉前分得的 gains），戰役就永不結束、
 * 兩地區被交戰鎖永久鎖死。修法：勝負判定改以「兩位主帥各自持分」計 ——
 * 主帥兩區歸零＋城市陷落即分勝負，joiner 殘餘持分保留、交戰鎖釋放。
 *
 *  1. 守方主帥兩區歸零、守方側 joiner 在目標地區殘餘 5% → 首週期攻方勝、
 *     戰役結束、交戰鎖釋放；joiner 與第三方持分原封不動。
 *  2. 鏡像：攻方主帥兩區歸零、攻方側 joiner 在出發地區殘餘 5% → 守方勝。
 *
 * 仿 war.mopUpSettle.test.ts（AI 樁 + 決定性軍團 + 預寫 NPC 指令；無城市
 * 地區對 → 城市快照 null、cityLineFallen(null)=true）＋
 * war.multiNationSettle.test.ts 的 joinCampaign 晚加入路徑。模組載入即安裝
 * anthropic 基準樁，本檔絕不打真 AI。
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the joiner-residual settle tests",
  );
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
  warRegionEngagementsTable,
} = await import("@workspace/db");
const { initiateCampaign, settleCampaign, flushWarBackgroundWork } =
  await import("../lib/warEngine");
const { joinCampaign } = await import("../lib/warEngine/participants");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runWallMigrations } = await import("../lib/wallMigrations");

const runId = randomBytes(4).toString("hex");
/** LIKE 清理需避開其他套件的命名空間。 */
const NATION_MARKER = "__jrstest__";
const USER_MARKER = "jrstest-";

const attackerUserId = `${USER_MARKER}${runId}-atk`;
const joinerUserId = `${USER_MARKER}${runId}-join`;

let attackerId = "";
let defenderId = "";
let joinerId = "";
let thirdPartyId = "";
let templateId = 0;
const OWNED_QUANTITY = 5000;
/** 晚加入者的殘餘持分。 */
const RESIDUAL_PCT = 5;
const THIRD_PARTY_PCT = 20;
/** 修法後主帥歸零應在首週期即分勝負；留餘裕防非決定性。 */
const MAX_CYCLES = 3;

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
        leaderName: "殘餘持分僵局測試",
        government: "君主制",
        isNpc: opts.npc ?? false,
        discordUserId: opts.user ?? null,
      })
      .returning({ id: playerNationsTable.id });
    return row!.id;
  };

  attackerId = await mk("atk", { user: attackerUserId });
  defenderId = await mk("def", { npc: true });
  joinerId = await mk("join", { user: joinerUserId });
  thirdPartyId = await mk("third", { npc: true });

  // 攻方主帥與守方主帥交戰（戰役前提）；joiner 與「兩位主帥」都交戰中，
  // 才能分別以守方側（須與攻方主帥交戰）與攻方側（須與守方主帥交戰）加入。
  const insertWar = async (a: string, b: string) => {
    const [aId, bId] = [a, b].sort();
    await db.insert(diplomacyWarsTable).values({
      nationAId: aId!,
      nationBId: bId!,
      declaredByNationId: a,
    });
  };
  await insertWar(attackerId, defenderId);
  await insertWar(joinerId, attackerId);
  await insertWar(joinerId, defenderId);

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
 * 無城市 → 戰役城市快照為 null（cityLineFallen(null)=true），主帥歸零
 * 即可分勝負；有城市會觸發城市保底（本檔不測該路徑）。
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

async function engagementCount(campaignId: number): Promise<number> {
  const rows = await db
    .select({ regionId: warRegionEngagementsTable.regionId })
    .from(warRegionEngagementsTable)
    .where(eq(warRegionEngagementsTable.campaignId, campaignId));
  return rows.length;
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

/** 罐頭週期結算：AI 對兩區 shift 全 0（joiner 殘餘無法被移轉的僵局重現）。 */
function zeroShiftCycleResult(): unknown {
  const report = "晚加入者殘餘持分僵局測試戰報：戰線僵持、雙方對峙。".repeat(6); // ≥20 字
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
 * 建立兩地區戰役＋晚加入者後，把控制列改寫成「主帥歸零、joiner 殘餘」的
 * 僵局狀態：
 *  - 開戰前先鋪正常控制（攻 80% rA／守 70% rB）讓守門通過；
 *  - joinCampaign 把 joiner 加入指定側（資格：與敵方主帥交戰中）；
 *  - 決定性軍團（同模板、同士氣補給）取代自動軍團（joiner 無軍團 ——
 *    殘餘持分是領土狀態，與是否駐軍無關）；
 *  - 開戰後依情境覆寫 region_controls（deadlockControls 參數）。
 */
async function setupJoinerResidualCampaign(opts: {
  joinerSide: "attacker" | "defender";
  attackerTroops: number;
  defenderTroops: number;
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
  const [joinerNation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, joinerId))
    .limit(1);
  assert.ok(joinerNation, "joiner nation row must exist");
  await joinCampaign({
    campaign,
    nation: joinerNation!,
    side: opts.joinerSide,
  });

  // 決定性軍團取代自動軍團（只給兩位主帥；joiner 不駐軍）。
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
        body: "殘餘持分僵局測試：固定防守指令",
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
  assert.fail(
    `${MAX_CYCLES} 個週期內戰役仍未結束（joiner 殘餘持分仍卡死勝負判定）`,
  );
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

test("守方主帥兩區歸零、守方側 joiner 殘餘 5% → 攻方勝、殘餘保留、交戰鎖釋放", async () => {
  const { campaignId, rA, rB } = await setupJoinerResidualCampaign({
    joinerSide: "defender",
    attackerTroops: 1000,
    defenderTroops: 100,
    deadlockControls: (a, b) => [
      // A 區：攻方 80%（守方主帥無殘餘）。
      { regionId: a, nationId: attackerId, percent: 80 },
      // B 區：守方主帥已被清空（無列）；攻方 45%、守方側 joiner 殘餘 5%、
      // 第三方 20%（驗證兩者都不動）。
      { regionId: b, nationId: attackerId, percent: 45 },
      { regionId: b, nationId: joinerId, percent: RESIDUAL_PCT },
      { regionId: b, nationId: thirdPartyId, percent: THIRD_PARTY_PCT },
    ],
  });

  assert.equal(
    await engagementCount(campaignId),
    2,
    "戰役進行中兩地區都應被交戰鎖鎖住",
  );

  const cycles = await settleUntilEnded(campaignId);
  assert.equal(
    cycles,
    1,
    "主帥兩區歸零＋無城市 → 首週期即應分出勝負（不需掃蕩週期）",
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
  assert.equal(campaign!.winnerNationId, attackerId, "勝方應為攻方主帥");

  // 交戰鎖釋放（僵局的核心症狀）。
  assert.equal(
    await engagementCount(campaignId),
    0,
    "戰役結束後交戰鎖必須釋放",
  );

  // joiner 殘餘持分保留、第三方持分不動、攻方持分不因結束而變。
  assert.equal(
    await controlPct(rB, joinerId),
    RESIDUAL_PCT,
    "晚加入者殘餘持分應原封保留（移轉只在交戰雙方主帥之間）",
  );
  assert.equal(
    await controlPct(rB, thirdPartyId),
    THIRD_PARTY_PCT,
    "第三方持分不得被動到",
  );
  assert.equal(await controlPct(rB, attackerId), 45);
  assert.equal(await controlPct(rB, defenderId), 0);
  assert.equal(await controlPct(rA, attackerId), 80);

  await teardownCampaign(campaignId, [rA, rB]);
});

test("鏡像：攻方主帥兩區歸零、攻方側 joiner 殘餘 5% → 守方勝、殘餘保留", async () => {
  const { campaignId, rA, rB } = await setupJoinerResidualCampaign({
    joinerSide: "attacker",
    attackerTroops: 100,
    defenderTroops: 1000,
    deadlockControls: (a, b) => [
      // A 區：攻方主帥已被反攻清空（無列）；守方 60%、攻方側 joiner 殘餘 5%
      // （戰局逆轉前分得的 gains）。
      { regionId: a, nationId: defenderId, percent: 60 },
      { regionId: a, nationId: joinerId, percent: RESIDUAL_PCT },
      // B 區：守方 70%（攻方主帥無持分）。
      { regionId: b, nationId: defenderId, percent: 70 },
    ],
  });

  const cycles = await settleUntilEnded(campaignId);
  assert.equal(cycles, 1, "鏡像情境同樣應於首週期分出勝負");

  const [campaign] = await db
    .select({
      status: warCampaignsTable.status,
      winnerNationId: warCampaignsTable.winnerNationId,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignId))
    .limit(1);
  assert.equal(campaign!.status, "ended", "戰役狀態應為已結束");
  assert.equal(campaign!.winnerNationId, defenderId, "勝方應為守方主帥");

  assert.equal(
    await engagementCount(campaignId),
    0,
    "戰役結束後交戰鎖必須釋放",
  );
  assert.equal(
    await controlPct(rA, joinerId),
    RESIDUAL_PCT,
    "攻方側晚加入者的殘餘持分應原封保留",
  );
  assert.equal(await controlPct(rA, defenderId), 60);
  assert.equal(await controlPct(rA, attackerId), 0);
  assert.equal(await controlPct(rB, defenderId), 70);
  assert.equal(await controlPct(rB, attackerId), 0);

  await teardownCampaign(campaignId, [rA, rB]);
});
