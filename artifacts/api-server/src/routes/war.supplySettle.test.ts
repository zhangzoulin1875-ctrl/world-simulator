/**
 * 補給系統整合測試（真 DB、真結算、AI 樁）。
 *
 *  1. 饑荒國家的軍團補給逐週期下降、跌破門檻後崩潰（士氣暴跌）；
 *     沒饑荒的對手補給維持滿。
 *  2. 火藥時代（ww1）彈藥庫存足夠 → 庫存被扣、補給不降；庫存為 0 → 補給下降。
 *  3. NPC 同樣受補給規則約束（NPC 彈藥為 0 → NPC 軍團補給下降）。
 *  4. 冷兵器時代（classical）沒有彈藥需求，庫存為 0 也不影響補給。
 *
 * 仿 war.mopUpSettle.test.ts。模組載入即安裝 anthropic 基準樁，本檔絕不打真 AI。
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
  warCampaignReportsTable,
  warRegionCooldownsTable,
} = await import("@workspace/db");
const { initiateCampaign, settleCampaign, flushWarBackgroundWork } =
  await import("../lib/warEngine");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runWallMigrations } = await import("../lib/wallMigrations");

const runId = randomBytes(4).toString("hex");
/** LIKE 清理需避開其他套件的命名空間。 */
const NATION_MARKER = "__suptest__";
const USER_MARKER = "suptest-";

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
        leaderName: "補給系統測試",
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
  const report = "殘餘持分補給系統測試戰報：戰線僵持、雙方對峙。".repeat(6); // ≥20 字
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
        body: "補給系統測試：固定防守指令",
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

const { worldGameStateTable } = await import("@workspace/db");

/** 設定世界時代（currentEra 與 statsEra 一起），回傳還原函式。 */
async function setEra(era: string): Promise<() => Promise<void>> {
  const [prev] = await db
    .select({ cur: worldGameStateTable.currentEra, st: worldGameStateTable.statsEra })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  if (prev) {
    await db
      .update(worldGameStateTable)
      .set({ currentEra: era, statsEra: era })
      .where(eq(worldGameStateTable.id, 1));
    return async () => {
      await db
        .update(worldGameStateTable)
        .set({ currentEra: prev.cur, statsEra: prev.st })
        .where(eq(worldGameStateTable.id, 1));
    };
  }
  await db.insert(worldGameStateTable).values({ id: 1, currentEra: era, statsEra: era });
  return async () => {
    await db.delete(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  };
}

async function setNation(
  nationId: string,
  patch: { ammo?: number; consecutiveFamineTurns?: number },
): Promise<void> {
  await db.update(playerNationsTable).set(patch).where(eq(playerNationsTable.id, nationId));
}

async function nationAmmo(nationId: string): Promise<number> {
  const [r] = await db
    .select({ ammo: playerNationsTable.ammo })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  return Number(r!.ammo);
}

async function legionOf(campaignId: number, nationId: string) {
  const [r] = await db
    .select({ supply: warCampaignLegionsTable.supply, morale: warCampaignLegionsTable.morale })
    .from(warCampaignLegionsTable)
    .where(and(eq(warCampaignLegionsTable.campaignId, campaignId), eq(warCampaignLegionsTable.nationId, nationId)));
  return r!;
}

/** 結算指定週期數（不要求戰役結束）；每週期預寫 NPC 守方指令。 */
async function settleCycles(campaignId: number, n: number): Promise<void> {
  installAiStub(zeroShiftCycleResult());
  try {
    for (let i = 0; i < n; i++) {
      const [row] = await db
        .select({ cycleNumber: warCampaignsTable.cycleNumber, status: warCampaignsTable.status })
        .from(warCampaignsTable)
        .where(eq(warCampaignsTable.id, campaignId))
        .limit(1);
      if (!row || row.status !== "active") return;
      await db.insert(warCampaignOrdersTable).values({
        campaignId,
        nationId: defenderId,
        cycleNumber: row.cycleNumber,
        orderType: "command",
        body: "補給系統測試：固定防守指令",
      });
      await settleCampaign(campaignId);
    }
  } finally {
    restoreAi();
  }
}

/** 兩軍同兵力（雙方都不會很快被殲滅），控制列固定。 */
async function startEvenCampaign() {
  return setupDeadlockCampaign({
    attackerTroops: 1000,
    defenderTroops: 1000,
    deadlockControls: (a, b) => [
      { regionId: a, nationId: attackerId, percent: 60 },
      { regionId: b, nationId: defenderId, percent: 60 },
    ],
  });
}

test("饑荒國家：補給逐週期下降並崩潰（士氣暴跌）；沒饑荒的 NPC 對手補給維持滿", async () => {
  const restore = await setEra("classical"); // 冷兵器時代：只看口糧，排除彈藥干擾
  const { campaignId, rA, rB } = await startEvenCampaign();
  try {
    await setNation(attackerId, { consecutiveFamineTurns: 5 }); // 口糧滿足度 0.25
    await setNation(defenderId, { consecutiveFamineTurns: 0 });
    const before = await legionOf(campaignId, attackerId);
    await settleCycles(campaignId, 1);
    const one = await legionOf(campaignId, attackerId);
    assert.ok(one.supply < before.supply, `饑荒第一週期補給應下降 (${before.supply} → ${one.supply})`);

    await settleCycles(campaignId, 4);
    const later = await legionOf(campaignId, attackerId);
    assert.ok(later.supply < 20, `數週期後應崩潰 (<20)，實際 ${later.supply}`);
    assert.ok(later.morale < before.morale, `崩潰後士氣應低於開戰時 (${before.morale} → ${later.morale})`);

    const enemy = await legionOf(campaignId, defenderId);
    assert.equal(enemy.supply, 100, "沒饑荒的對手補給維持滿");
  } finally {
    await setNation(attackerId, { consecutiveFamineTurns: 0 });
    await teardownCampaign(campaignId, [rA, rB]);
    await restore();
  }
});

test("火藥時代：彈藥足夠 → 庫存被扣、補給不降；彈藥為 0 → 補給下降", async () => {
  const restore = await setEra("ww1");
  const { campaignId, rA, rB } = await startEvenCampaign();
  try {
    await setNation(attackerId, { ammo: 1_000_000, consecutiveFamineTurns: 0 });
    await setNation(defenderId, { ammo: 1_000_000, consecutiveFamineTurns: 0 });
    await settleCycles(campaignId, 1);
    const stocked = await legionOf(campaignId, attackerId);
    assert.equal(stocked.supply, 100, "彈藥足夠補給維持滿");
    assert.ok((await nationAmmo(attackerId)) < 1_000_000, "彈藥庫存應被扣減");
    assert.ok((await nationAmmo(attackerId)) > 0, "不應被扣光");

    await setNation(attackerId, { ammo: 0 });
    await settleCycles(campaignId, 1);
    const dry = await legionOf(campaignId, attackerId);
    assert.ok(dry.supply < 100, `彈藥為 0 補給應下降，實際 ${dry.supply}`);
    assert.equal(await nationAmmo(attackerId), 0, "庫存不得為負");
  } finally {
    await teardownCampaign(campaignId, [rA, rB]);
    await restore();
  }
});

test("NPC 同樣吃補給：NPC 彈藥為 0 → NPC 軍團補給下降", async () => {
  const restore = await setEra("ww2");
  const { campaignId, rA, rB } = await startEvenCampaign();
  try {
    await setNation(attackerId, { ammo: 1_000_000 });
    await setNation(defenderId, { ammo: 0 }); // defender 是 NPC
    await settleCycles(campaignId, 2);
    const npc = await legionOf(campaignId, defenderId);
    assert.ok(npc.supply < 100, `NPC 缺彈補給應下降，實際 ${npc.supply}`);
    const player = await legionOf(campaignId, attackerId);
    assert.equal(player.supply, 100, "彈藥充足的玩家補給維持滿");
  } finally {
    await teardownCampaign(campaignId, [rA, rB]);
    await restore();
  }
});

test("冷兵器時代：沒有彈藥需求，庫存為 0 也不影響補給、也不扣庫存", async () => {
  const restore = await setEra("classical");
  const { campaignId, rA, rB } = await startEvenCampaign();
  try {
    await setNation(attackerId, { ammo: 0, consecutiveFamineTurns: 0 });
    await setNation(defenderId, { ammo: 0, consecutiveFamineTurns: 0 });
    await settleCycles(campaignId, 2);
    assert.equal((await legionOf(campaignId, attackerId)).supply, 100);
    assert.equal((await legionOf(campaignId, defenderId)).supply, 100);
    assert.equal(await nationAmmo(attackerId), 0);
  } finally {
    await teardownCampaign(campaignId, [rA, rB]);
    await restore();
  }
});

test("戰報記下我方補給結果（缺糧旗標、最低補給、崩潰軍團數）；對手沒缺料時無缺料旗標", async () => {
  const restore = await setEra("classical");
  const { campaignId, rA, rB } = await startEvenCampaign();
  try {
    await setNation(attackerId, { consecutiveFamineTurns: 5 });
    await setNation(defenderId, { consecutiveFamineTurns: 0 });
    await settleCycles(campaignId, 1);
    const [report] = await db
      .select({ summary: warCampaignReportsTable.summary })
      .from(warCampaignReportsTable)
      .where(eq(warCampaignReportsTable.campaignId, campaignId))
      .limit(1);
    assert.ok(report, "應有一筆戰報");
    const mine = report!.summary.attacker.supply;
    assert.ok(mine, "攻方（饑荒）戰報應有補給欄");
    assert.equal(mine!.rationShort, true);
    assert.equal(mine!.ammoShort, false, "冷兵器時代沒有彈藥需求");
    assert.ok(mine!.minSupply < 100);
    const theirs = report!.summary.defender.supply;
    assert.ok(theirs, "守方也有補給欄");
    assert.equal(theirs!.rationShort, false);
    assert.equal(theirs!.minSupply, 100);
  } finally {
    await setNation(attackerId, { consecutiveFamineTurns: 0 });
    await teardownCampaign(campaignId, [rA, rB]);
    await restore();
  }
});
