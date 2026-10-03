/**
 * Task #463 — 多國戰役結算在真實 AI 回應路徑下的領土分配整合測試（真 DB）。
 *
 * 補上 normalizeSplitWeights 單元測試沒涵蓋的完整 settleCampaign 路徑：
 * 以 anthropic.messages.create 樁回傳含 attackerGainSplit 的戰役結算 JSON，
 * 驗證 applyCycleResult 的 transferForRegion：
 *
 *  1. AI 給定合法 attackerGainSplit → 勝方（攻方聯軍）依 AI 比例把伺服器
 *     決定的總移轉量拆給各參戰國；敗方主帥失地等量；第三方（未參戰、在
 *     目標地區持分的國家）持分完全不動；Σ 控制率守恆。
 *  2. AI 給的分配名單對不上參戰國名 → fallback 依各國投入戰力比例分配，
 *     第三方持分同樣不動。
 *
 * 仿照 war.race.test.ts 的同區結算測試（AI 樁 + 決定性軍團 + 預寫 NPC 指令），
 * 但走「兩地區」戰役＋ joinCampaign 晚加入者的多國路徑。
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the multi-nation settle tests");
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
  mapRegionsTable,
  mapRegionAdjacenciesTable,
  militaryUnitTemplatesTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignOrdersTable,
  warRegionCooldownsTable,
  worldGameStateTable,
} = await import("@workspace/db");
const { initiateCampaign, settleCampaign, flushWarBackgroundWork } =
  await import("../lib/warEngine");
const { joinCampaign } = await import("../lib/warEngine/participants");
const { allocateProportionally } = await import("../lib/war");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runWallMigrations } = await import("../lib/wallMigrations");

const runId = randomBytes(4).toString("hex");
/** LIKE 清理需避開其他套件的 "racetest"/"miltest"/"wartest" 命名空間。 */
const NATION_MARKER = "__mnstest__";
const USER_MARKER = "mnstest-";

const leadUserId = `${USER_MARKER}${runId}-lead`;
const joinerUserId = `${USER_MARKER}${runId}-join`;

let leadId = "";
let joinerId = "";
let defenderId = "";
let thirdPartyId = "";
let leadName = "";
let joinerName = "";
let templateId = 0;
const OWNED_QUANTITY = 5000;
const LEAD_TROOPS = 600;
const JOINER_TROOPS = 400;
const DEFENDER_TROOPS = 300; // 攻方（1000）大幅領先守方（300）→ 確定性推進為正
const DEFENDER_PCT = 70;
const THIRD_PARTY_PCT = 20;

/** 每個測試各用一組相鄰地區對，測後刪戰役釋放交戰鎖。 */
const usedRegions: number[] = [];

async function cleanup(): Promise<void> {
  // 刪國家會級聯 region_controls / diplomacy_wars / war_campaigns（再級聯
  // 軍團、參戰列、交戰鎖、指令、戰報）。傷兵池與通知以 discordUserId 為鍵，
  // 不級聯，需另刪。
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
  ): Promise<{ id: string; name: string }> => {
    const name = `${NATION_MARKER}${runId}-${suffix}`;
    const [row] = await db
      .insert(playerNationsTable)
      .values({
        name,
        leaderName: "多國結算測試",
        government: "君主制",
        isNpc: opts.npc ?? false,
        discordUserId: opts.user ?? null,
      })
      .returning({ id: playerNationsTable.id });
    return { id: row!.id, name };
  };

  const lead = await mk("lead", { user: leadUserId });
  leadId = lead.id;
  leadName = lead.name;
  const joiner = await mk("joiner", { user: joinerUserId });
  joinerId = joiner.id;
  joinerName = joiner.name;
  defenderId = (await mk("def", { npc: true })).id;
  thirdPartyId = (await mk("third", { npc: true })).id;

  // 攻方主帥、晚加入者各自與守方主帥交戰中（joinCampaign 資格）。
  const insertWar = async (a: string, b: string) => {
    const [aId, bId] = [a, b].sort();
    await db.insert(diplomacyWarsTable).values({
      nationAId: aId!,
      nationBId: bId!,
      declaredByNationId: a,
    });
  };
  await insertWar(leadId, defenderId);
  await insertWar(joinerId, defenderId);

  // Task #549 — 預設兵種已移除：測試自建步兵模板（initiateCampaign 自動建軍需要），
  // 並為 NPC 守方建立專屬模板（開戰守門要求 NPC 有可用兵種）。
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
      ownerDiscordUserId: leadUserId,
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
    { discordUserId: leadUserId, templateId, quantity: OWNED_QUANTITY },
    { discordUserId: joinerUserId, templateId, quantity: OWNED_QUANTITY },
  ]);
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
// Task #569 — 開戰時的背景地形簡報（generateTerrainBrief）原本會打真 Anthropic
// API，setupMultiNationCampaign 的 flushWarBackgroundWork 會等它落地，每場戰役
// 多耗 10–30 秒。本檔不驗證地形簡報內容，於模組載入即安裝「基準樁」（回傳合法
// 簡報文字，50–1000 字）；restoreAi() 也回到基準樁——本檔絕不打真 Anthropic API。
const TERRAIN_BRIEF_STUB_TEXT =
  "測試樁地形簡報：兩地區以丘陵與河谷相接，攻守要點在渡口與城郊高地，補給線沿河而行，雨季氾濫時僅高地可通行。".repeat(2);
const UNIT_ANALYSIS_STUB_TEXT = JSON.stringify({
  counterSummary: "無顯著兵種克制關係。",
  tacticalEdge: "neutral",
  tacticalBonus: 0,
});
const baselineAiStub = (async (params: { system?: unknown }) => {
  const system = typeof params?.system === "string" ? params.system : "";
  if (system.includes("兵種分析 AI")) {
    return { content: [{ type: "text", text: UNIT_ANALYSIS_STUB_TEXT }] };
  }
  return { content: [{ type: "text", text: TERRAIN_BRIEF_STUB_TEXT }] };
}) as unknown as typeof anthropic.messages.create;
anthropic.messages.create = baselineAiStub;

/** 罐頭多國戰役結算結果；欄位與 warCycleResultSchema 對齊。 */
function multiNationCycleResult(): unknown {
  const report = "多國聯軍領土分配結算測試戰報。".repeat(6); // ≥20 字
  return {
    attackerReport: report,
    defenderReport: report,
    attacker: {
      // 攻方為兩國聯軍：每軍團帶 nationName（與輸入的國家名一致）。
      legions: [
        {
          slot: "A",
          nationName: leadName,
          aggressionPct: 50,
        },
        {
          slot: "A",
          nationName: joinerName,
          aggressionPct: 50,
        },
      ],
      warWearinessDelta: 0,
    },
    defender: {
      legions: [
        {
          slot: "A",
          aggressionPct: 50,
        },
      ],
      warWearinessDelta: 0,
    },
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
 * 建立一場「兩地區、攻方兩國聯軍、目標地區有第三方持分」的戰役：
 * 主帥 100% 控出發地；守方 70% + 第三方 20% 控目標地；joinCampaign 晚加入
 * 攻方；決定性軍團（同模板、同士氣補給、兵力對等）取代自動軍團；預寫 NPC
 * 守方指令跳過指令生成 AI。
 */
async function setupMultiNationCampaign(): Promise<{
  campaignId: number;
  attackerRegionId: number;
  defenderRegionId: number;
}> {
  const { a: rA, b: rB } = await findSparePair();
  await db.insert(regionControlsTable).values([
    { regionId: rA, nationId: leadId, percent: 100 },
    { regionId: rB, nationId: defenderId, percent: DEFENDER_PCT },
    { regionId: rB, nationId: thirdPartyId, percent: THIRD_PARTY_PCT },
  ]);

  const campaign = await initiateCampaign({
    attackerNationId: leadId,
    attackerRegionId: rA,
    defenderRegionId: rB,
  });
  await joinCampaign({
    campaign,
    nation: (await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, joinerId))
      .limit(1))[0]!,
    side: "attacker",
  });

  // 決定性軍團：三國各一團（lead 600 / joiner 400 / defender 1000）。
  await db
    .delete(warCampaignLegionsTable)
    .where(eq(warCampaignLegionsTable.campaignId, campaign.id));
  for (const [nationId, quantity] of [
    [leadId, LEAD_TROOPS],
    [joinerId, JOINER_TROOPS],
    [defenderId, DEFENDER_TROOPS],
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

  // 預寫 NPC 守方本週期指令 → 跳過結算中的 NPC 指令 AI 生成。
  await db.insert(warCampaignOrdersTable).values({
    campaignId: campaign.id,
    nationId: defenderId,
    cycleNumber: campaign.cycleNumber,
    orderType: "command",
    body: "多國結算測試：固定防守指令",
  });

  // 收斂開戰觸發的背景地形簡報 AI 工作，避免其誤觸結算樁。
  await flushWarBackgroundWork();

  return {
    campaignId: campaign.id,
    attackerRegionId: rA,
    defenderRegionId: rB,
  };
}

/** 測後清理：刪戰役（釋放交戰鎖）、清傷兵池、常備軍還原滿編、清此輪控制列。 */
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
    .where(inArray(playerArmiesTable.discordUserId, [leadUserId, joinerUserId]));
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, regionIds));
}

test("多國結算：依兵力比例分配、第三方持分不動", async () => {
  const { campaignId, attackerRegionId, defenderRegionId } =
    await setupMultiNationCampaign();

  // 攻方兵力（1000）大幅領先守方（300）→ 確定性推進為正，無需 AI 領土移轉。
  installAiStub(multiNationCycleResult());
  try {
    const res = await settleCampaign(campaignId);
    assert.equal(res.settled, true, `結算應成功：${JSON.stringify(res)}`);
    assert.equal(res.ended, false, "小幅推進不應分出勝負");
  } finally {
    restoreAi();
  }

  // 從 DB 讀取確定性推進量，驗證比例分配正確性。
  const defPctAfter1 = await controlPct(defenderRegionId, defenderId);
  const expected = DEFENDER_PCT - defPctAfter1;
  assert.ok(expected > 0, "攻方兵力大幅領先 → 確定性推進量應為正");
  const [expLeadGain, expJoinerGain] = allocateProportionally(
    [LEAD_TROOPS, JOINER_TROOPS],
    expected,
  ) as [number, number];

  // 攻方兩國依兵力比例（600:400）分得目標地區持分；敗方主帥等量失地。
  assert.equal(
    await controlPct(defenderRegionId, leadId),
    expLeadGain,
    "主帥應依兵力比例（600）獲得份額",
  );
  assert.equal(
    await controlPct(defenderRegionId, joinerId),
    expJoinerGain,
    "晚加入者應依兵力比例（400）獲得份額",
  );
  assert.equal(
    await controlPct(defenderRegionId, defenderId),
    defPctAfter1,
    "敗方主帥失地須等於伺服器決定的總移轉量",
  );
  // 第三方（未參戰）持分完全不動；Σ 守恆（70+20 → 仍為 90）。
  assert.equal(
    await controlPct(defenderRegionId, thirdPartyId),
    THIRD_PARTY_PCT,
    "第三方持分不得被戰役結算動到",
  );
  assert.equal(
    await regionSumPct(defenderRegionId),
    DEFENDER_PCT + THIRD_PARTY_PCT,
    "目標地區控制率總和守恆",
  );
  // 攻方出發地區：確定性攻勢在目標地區（非出發地）→ 主帥保持 100%。
  assert.equal(await controlPct(attackerRegionId, leadId), 100);

  await teardownCampaign(campaignId, [attackerRegionId, defenderRegionId]);
});

test("多國結算：AI 分配名單對不上參戰國 → fallback 依投入戰力比例分配", async () => {
  const { campaignId, attackerRegionId, defenderRegionId } =
    await setupMultiNationCampaign();

  installAiStub(multiNationCycleResult());
  try {
    const res = await settleCampaign(campaignId);
    assert.equal(res.settled, true, `結算應成功：${JSON.stringify(res)}`);
  } finally {
    restoreAi();
  }

  // 從 DB 讀取確定性推進量。
  const defPctAfter2 = await controlPct(defenderRegionId, defenderId);
  const expected2 = DEFENDER_PCT - defPctAfter2;
  assert.ok(expected2 > 0, "攻方兵力大幅領先 → 確定性推進量應為正");
  const [expLeadGain2, expJoinerGain2] = allocateProportionally(
    [LEAD_TROOPS, JOINER_TROOPS],
    expected2,
  ) as [number, number];

  assert.equal(
    await controlPct(defenderRegionId, leadId),
    expLeadGain2,
    "fallback 應依主帥投入戰力（600）分配",
  );
  assert.equal(
    await controlPct(defenderRegionId, joinerId),
    expJoinerGain2,
    "fallback 應依晚加入者投入戰力（400）分配",
  );
  assert.equal(
    await controlPct(defenderRegionId, defenderId),
    DEFENDER_PCT - expected2,
  );
  assert.equal(
    await controlPct(defenderRegionId, thirdPartyId),
    THIRD_PARTY_PCT,
    "fallback 路徑下第三方持分同樣不得變動",
  );
  assert.equal(
    await regionSumPct(defenderRegionId),
    DEFENDER_PCT + THIRD_PARTY_PCT,
  );

  await teardownCampaign(campaignId, [attackerRegionId, defenderRegionId]);
});
