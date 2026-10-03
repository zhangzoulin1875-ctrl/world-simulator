/**
 * NPC 全滅自動偵測整合測試（真 DB）：
 *
 * NPC 守方在戰役中全軍歸零（該邊所有軍團兵力 0、對方尚有兵力）時，結算
 * 必須立即把該 NPC 在戰役兩地區的全部持分移轉給勝方，並以
 * endReason="annihilation" 立即結束戰役：
 *
 *  1. AI 給零移轉值（territoryShiftPct 全 0）→ 領土移轉仍全額發生，證明
 *     走的是全滅接管路徑而非 AI 推進。
 *  2. 守方城市防線尚未陷落（高耐久城牆）→ 全滅接管把防線標記為陷落
 *     （fallenCityLine），capTransferForCity 的 1% 保底與「城未陷不得清零」
 *     不變量都不得阻擋全額移轉；持久化後的 defenderCityState 全城耐久 0。
 *  3. 第三方（未參戰、在目標地區持分）持分完全不動；Σ 控制率守恆。
 *
 * 仿照 war.multiNationSettle.test.ts 的 fixture（AI 樁 + 決定性軍團 +
 * 預寫 NPC 指令）。`pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the annihilation settle tests");
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
/** LIKE 清理需避開其他套件的 "racetest"/"mnstest" 等命名空間。 */
const NATION_MARKER = "__anntest__";
const USER_MARKER = "anntest-";

const attackerUserId = `${USER_MARKER}${runId}-atk`;

let attackerId = "";
let defenderId = "";
let thirdPartyId = "";
let templateId = 0;
const OWNED_QUANTITY = 5000;
const ATTACKER_TROOPS = 600;
const DEFENDER_PCT = 70;
const THIRD_PARTY_PCT = 20;

/** 每個測試各用一組相鄰地區對，測後刪戰役釋放交戰鎖。 */
const usedRegions: number[] = [];

async function cleanup(): Promise<void> {
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
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
        leaderName: "全滅偵測測試",
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

  // 測試自建步兵模板（initiateCampaign 自動建軍需要）＋ NPC 守方專屬模板。
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
  await db.insert(playerArmiesTable).values({
    discordUserId: attackerUserId,
    templateId,
    quantity: OWNED_QUANTITY,
  });
});

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

/** 找一對「無人控制、無冷卻、未被本檔用過」的相鄰地區。 */
async function findSparePair(): Promise<{ a: number; b: number }> {
  const uncontrolled = (
    col:
      | typeof mapRegionAdjacenciesTable.regionId
      | typeof mapRegionAdjacenciesTable.adjacentRegionId,
  ) =>
    notExists(
      db
        .select({ one: sql`1` })
        .from(regionControlsTable)
        .where(eq(regionControlsTable.regionId, col)),
    );
  const notCooling = (
    col:
      | typeof mapRegionAdjacenciesTable.regionId
      | typeof mapRegionAdjacenciesTable.adjacentRegionId,
  ) =>
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
  assert.ok(pair, "need an unclaimed adjacent region pair");
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
// Task #569 鐵則 — 於模組載入即安裝基準樁（合法地形簡報文字，50–1000 字），
// 本檔絕不打真 Anthropic API。
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

/** 罐頭戰役結算結果：領土移轉全 0 → 任何移轉都必然來自全滅接管路徑。 */
function zeroShiftCycleResult(): unknown {
  const report = "NPC 全滅偵測結算測試戰報。".repeat(6); // ≥20 字
  return {
    attackerReport: report,
    defenderReport: report,
    attacker: {
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
    },
    defender: {
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
    },
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

test("NPC 守方全軍歸零 → 兩地區持分全額移轉、endReason=annihilation 立即結束", async () => {
  const { a: rA, b: rB } = await findSparePair();
  await db.insert(regionControlsTable).values([
    { regionId: rA, nationId: attackerId, percent: 100 },
    { regionId: rB, nationId: defenderId, percent: DEFENDER_PCT },
    { regionId: rB, nationId: thirdPartyId, percent: THIRD_PARTY_PCT },
  ]);

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: rA,
    defenderRegionId: rB,
  });

  // 決定性軍團：攻方 600、NPC 守方 0（全軍已於先前週期陣亡的狀態）。
  await db
    .delete(warCampaignLegionsTable)
    .where(eq(warCampaignLegionsTable.campaignId, campaign.id));
  for (const [nationId, quantity] of [
    [attackerId, ATTACKER_TROOPS],
    [defenderId, 0],
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

  // 守方城市防線「尚未陷落」（高耐久混凝土要塞）：若非全滅接管把防線標記
  // 為陷落，capTransferForCity 會保底 1%、清零不變量會擋下全額移轉。
  await db
    .update(warCampaignsTable)
    .set({
      defenderCityState: {
        cities: [
          {
            cityId: 999_999_001,
            name: "全滅測試城",
            wallTier: "concrete" as const,
            maxDurability: 100_000,
            durability: 100_000,
          },
        ],
        garrisoned: false,
      },
    })
    .where(eq(warCampaignsTable.id, campaign.id));

  // 預寫 NPC 守方本週期指令 → 跳過結算中的 NPC 指令 AI 生成。
  await db.insert(warCampaignOrdersTable).values({
    campaignId: campaign.id,
    nationId: defenderId,
    cycleNumber: campaign.cycleNumber,
    orderType: "command",
    body: "全滅偵測測試：固定防守指令",
  });

  // 收斂開戰觸發的背景地形簡報 AI 工作，避免其誤觸結算樁。
  await flushWarBackgroundWork();

  installAiStub(zeroShiftCycleResult());
  try {
    const res = await settleCampaign(campaign.id);
    assert.equal(res.settled, true, `結算應成功：${JSON.stringify(res)}`);
    assert.equal(res.ended, true, "NPC 全滅必須立即結束戰役");
  } finally {
    restoreAi();
  }

  // 戰役：annihilation 結束、勝方為攻方。
  const [endedRow] = await db
    .select()
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  assert.ok(endedRow, "戰役列必須存在");
  assert.equal(endedRow!.status, "ended");
  assert.equal(endedRow!.endReason, "annihilation");
  assert.equal(endedRow!.winnerNationId, attackerId);
  // 全滅接管必須把守方城市防線標記為陷落並持久化。
  const cities = endedRow!.defenderCityState?.cities ?? [];
  assert.ok(cities.length > 0, "守方城市防線快照必須仍在");
  assert.ok(
    cities.every((c) => c.durability === 0),
    "全滅接管後守方全部城市耐久必須為 0（視同陷落）",
  );

  // 持分：NPC 守方兩地區全部清空、勝方全額取得；第三方不動、Σ 守恆。
  assert.equal(
    await controlPct(rB, defenderId),
    0,
    "NPC 守方在目標地區的持分必須全額清空",
  );
  assert.equal(
    await controlPct(rB, attackerId),
    DEFENDER_PCT,
    "勝方必須取得 NPC 守方在目標地區的全部持分",
  );
  assert.equal(
    await controlPct(rB, thirdPartyId),
    THIRD_PARTY_PCT,
    "第三方持分不得被全滅接管動到",
  );
  assert.equal(
    await regionSumPct(rB),
    DEFENDER_PCT + THIRD_PARTY_PCT,
    "目標地區控制率總和守恆",
  );
  // 出發地區守方本無持分 → 攻方保持 100%。
  assert.equal(await controlPct(rA, attackerId), 100);
  assert.equal(await regionSumPct(rA), 100);

  // 測後清理：刪戰役（釋放交戰鎖）、清傷兵、還原常備軍、清控制列。
  await db.delete(warCampaignsTable).where(eq(warCampaignsTable.id, campaign.id));
  await db
    .delete(playerWoundedUnitsTable)
    .where(like(playerWoundedUnitsTable.discordUserId, `${USER_MARKER}%`));
  await db
    .update(playerArmiesTable)
    .set({ quantity: OWNED_QUANTITY })
    .where(eq(playerArmiesTable.discordUserId, attackerUserId));
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, [rA, rB]));
});
