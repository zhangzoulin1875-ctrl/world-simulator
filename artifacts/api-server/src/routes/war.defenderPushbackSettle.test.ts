/**
 * Task #466 — 守方多國聯軍勝利時反攻領土分配的整合測試（真 DB）。
 *
 * 守方多國（joinCampaign side="defender"）把「攻方出發地區」的反攻（pushback）
 * 份額分給各守方國家。分配恆依各守方國投入兵力比例（troop-weight）決定：
 *
 *  1. 正常結算：守方聯軍依兵力比例（600:400）分得伺服器決定的反攻總量；
 *     攻方主帥在出發地區等量失地；第三方（未參戰）持分完全不動；Σ 控制率守恆。
 *  2. AI 回傳名單對不上守方參戰國名 → 同樣依投入戰力比例分配（驗證 fallback
 *     路徑第三方持分亦不變）。
 *
 * 仿照 war.multiNationSettle.test.ts（AI 樁 + 決定性軍團 + 預寫 NPC 指令），
 * 但改為守方兩國（NPC 主帥 + 真人晚加入者）、AI 回傳負向
 * territoryShiftPct.attackerRegion（負值＝攻方在出發地區的控制減少＝守方反攻）。
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the defender pushback settle tests",
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
/** LIKE 清理需避開其他套件的命名空間（含 __mnstest__）。 */
const NATION_MARKER = "__dpstest__";
const USER_MARKER = "dpstest-";

const attackerUserId = `${USER_MARKER}${runId}-atk`;
const joinerUserId = `${USER_MARKER}${runId}-join`;

let attackerId = "";
let defenderId = "";
let joinerId = "";
let thirdPartyId = "";
let defenderName = "";
let joinerName = "";
let templateId = 0;
const OWNED_QUANTITY = 5000;
const ATTACKER_TROOPS = 300; // 守方聯軍（1000）大幅領先攻方（300）→ 確定性反攻為正
const DEFENDER_TROOPS = 600;
const JOINER_TROOPS = 400; // 守方合計 1000 vs 攻方 300 → 確定性反攻為正
const ATTACKER_PCT = 80;
const THIRD_PARTY_PCT = 20;
const DEFENDER_PCT = 70;

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
  ): Promise<{ id: string; name: string }> => {
    const name = `${NATION_MARKER}${runId}-${suffix}`;
    const [row] = await db
      .insert(playerNationsTable)
      .values({
        name,
        leaderName: "守方反攻分配測試",
        government: "君主制",
        isNpc: opts.npc ?? false,
        discordUserId: opts.user ?? null,
      })
      .returning({ id: playerNationsTable.id });
    return { id: row!.id, name };
  };

  attackerId = (await mk("atk", { user: attackerUserId })).id;
  const def = await mk("def", { npc: true });
  defenderId = def.id;
  defenderName = def.name;
  const joiner = await mk("join", { user: joinerUserId });
  joinerId = joiner.id;
  joinerName = joiner.name;
  thirdPartyId = (await mk("third", { npc: true })).id;

  // 攻方主帥與守方主帥交戰；晚加入守方者需與「攻方主帥」交戰（join 資格）。
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

  // Task #549 — 預設兵種已移除：測試自建步兵模板（玩家常備軍用），
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
// API，setup 的 flushWarBackgroundWork 會等它落地，每場戰役多耗 10–30 秒。
// 本檔不驗證地形簡報內容，於模組載入即安裝「基準樁」（回傳合法簡報文字，
// 50–1000 字）；restoreAi() 也回到基準樁——本檔絕不打真 Anthropic API。
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

/** 罐頭守方反攻結算結果；欄位與 warCycleResultSchema 對齊。 */
function defenderPushbackCycleResult(): unknown {
  const report = "守方多國聯軍反攻領土分配結算測試戰報。".repeat(6); // ≥20 字
  return {
    attackerReport: report,
    defenderReport: report,
    attacker: {
      legions: [
        {
          slot: "A",
          aggressionPct: 50,
        },
      ],
      warWearinessDelta: 0,
    },
    defender: {
      // 守方為兩國聯軍：每軍團帶 nationName（與輸入的國家名一致）。
      legions: [
        {
          slot: "A",
          nationName: defenderName,
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
 * 建立一場「兩地區、守方兩國聯軍、攻方出發地區有第三方持分」的戰役：
 * 攻方主帥 80% + 第三方 20% 控出發地；守方 NPC 主帥 70% 控目標地；
 * joinCampaign 晚加入守方；決定性軍團（同模板、同士氣補給、兵力對等
 * 1000 vs 600+400）取代自動軍團；預寫 NPC 守方指令跳過指令生成 AI。
 */
async function setupDefenderCoalitionCampaign(): Promise<{
  campaignId: number;
  attackerRegionId: number;
  defenderRegionId: number;
}> {
  const { a: rA, b: rB } = await findSparePair();
  await db.insert(regionControlsTable).values([
    { regionId: rA, nationId: attackerId, percent: ATTACKER_PCT },
    { regionId: rA, nationId: thirdPartyId, percent: THIRD_PARTY_PCT },
    { regionId: rB, nationId: defenderId, percent: DEFENDER_PCT },
  ]);

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
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
    side: "defender",
  });

  // 決定性軍團：攻方 1000／守方主帥 600／守方晚加入者 400。
  await db
    .delete(warCampaignLegionsTable)
    .where(eq(warCampaignLegionsTable.campaignId, campaign.id));
  for (const [nationId, quantity] of [
    [attackerId, ATTACKER_TROOPS],
    [defenderId, DEFENDER_TROOPS],
    [joinerId, JOINER_TROOPS],
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

  // 預寫 NPC 守方主帥本週期指令 → 跳過結算中的 NPC 指令 AI 生成。
  await db.insert(warCampaignOrdersTable).values({
    campaignId: campaign.id,
    nationId: defenderId,
    cycleNumber: campaign.cycleNumber,
    orderType: "command",
    body: "守方反攻分配測試：固定防守指令",
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
    .where(
      inArray(playerArmiesTable.discordUserId, [attackerUserId, joinerUserId]),
    );
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, regionIds));
}

test("守方多國結算：AI defenderGainSplit 依比例分配反攻份額、第三方持分不動", async () => {
  const { campaignId, attackerRegionId, defenderRegionId } =
    await setupDefenderCoalitionCampaign();

  // 守方聯軍兵力（1000）大幅領先攻方（300）→ 確定性反攻為正，無需 AI 領土移轉。
  installAiStub(defenderPushbackCycleResult());
  try {
    const res = await settleCampaign(campaignId);
    assert.equal(res.settled, true, `結算應成功：${JSON.stringify(res)}`);
    assert.equal(res.ended, false, "小幅反攻不應分出勝負");
  } finally {
    restoreAi();
  }

  // 從 DB 讀取確定性反攻量，驗證比例分配正確性。
  const atkPctAfter1 = await controlPct(attackerRegionId, attackerId);
  const expected = ATTACKER_PCT - atkPctAfter1;
  assert.ok(expected > 0, "守方兵力大幅領先 → 確定性反攻量應為正");
  const [expDefGain, expJoinerGain] = allocateProportionally(
    [DEFENDER_TROOPS, JOINER_TROOPS],
    expected,
  ) as [number, number];

  // 守方兩國依兵力比例（600:400）分得攻方出發地區持分；攻方主帥等量失地。
  assert.equal(
    await controlPct(attackerRegionId, defenderId),
    expDefGain,
    "守方主帥應依兵力比例（600）獲得反攻份額",
  );
  assert.equal(
    await controlPct(attackerRegionId, joinerId),
    expJoinerGain,
    "守方晚加入者應依兵力比例（400）獲得反攻份額",
  );
  assert.equal(
    await controlPct(attackerRegionId, attackerId),
    atkPctAfter1,
    "攻方主帥在出發地區的失地須等於伺服器決定的反攻總量",
  );
  // 第三方（未參戰）持分完全不動；Σ 守恆。
  assert.equal(
    await controlPct(attackerRegionId, thirdPartyId),
    THIRD_PARTY_PCT,
    "第三方在攻方出發地區的持分不得被戰役結算動到",
  );
  assert.equal(
    await regionSumPct(attackerRegionId),
    ATTACKER_PCT + THIRD_PARTY_PCT,
    "攻方出發地區控制率總和守恆",
  );
  // 目標地區無推進（守方在目標地區反攻）→ 守方主帥保持 70%。
  assert.equal(await controlPct(defenderRegionId, defenderId), DEFENDER_PCT);
  assert.equal(await controlPct(defenderRegionId, joinerId), 0);

  await teardownCampaign(campaignId, [attackerRegionId, defenderRegionId]);
});

test("守方多國結算：AI 分配名單對不上守方參戰國 → fallback 依投入戰力比例分配", async () => {
  const { campaignId, attackerRegionId, defenderRegionId } =
    await setupDefenderCoalitionCampaign();

  installAiStub(defenderPushbackCycleResult());
  try {
    const res = await settleCampaign(campaignId);
    assert.equal(res.settled, true, `結算應成功：${JSON.stringify(res)}`);
  } finally {
    restoreAi();
  }

  // 從 DB 讀取確定性反攻量。
  const atkPctAfter2 = await controlPct(attackerRegionId, attackerId);
  const expected2 = ATTACKER_PCT - atkPctAfter2;
  assert.ok(expected2 > 0, "守方兵力大幅領先 → 確定性反攻量應為正");
  const [expDefGain2, expJoinerGain2] = allocateProportionally(
    [DEFENDER_TROOPS, JOINER_TROOPS],
    expected2,
  ) as [number, number];

  assert.equal(
    await controlPct(attackerRegionId, defenderId),
    expDefGain2,
    "fallback 應依守方主帥投入戰力（600）分配",
  );
  assert.equal(
    await controlPct(attackerRegionId, joinerId),
    expJoinerGain2,
    "fallback 應依守方晚加入者投入戰力（400）分配",
  );
  assert.equal(
    await controlPct(attackerRegionId, attackerId),
    ATTACKER_PCT - expected2,
  );
  assert.equal(
    await controlPct(attackerRegionId, thirdPartyId),
    THIRD_PARTY_PCT,
    "fallback 路徑下第三方持分同樣不得變動",
  );
  assert.equal(
    await regionSumPct(attackerRegionId),
    ATTACKER_PCT + THIRD_PARTY_PCT,
  );
  assert.equal(await controlPct(defenderRegionId, defenderId), DEFENDER_PCT);

  await teardownCampaign(campaignId, [attackerRegionId, defenderRegionId]);
});
