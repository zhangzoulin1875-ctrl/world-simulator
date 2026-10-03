/**
 * Integration test（真實開發 DB，透過 test-integration workflow 執行）：
 * Task #458 — 驗證戰爭指令懲罰（orderFlags → applyWarOrderPenalties）在
 * 「真實戰役結算流程」（warEngine/settle.ts settleCampaign）中確實生效：
 * 以 stub 的 anthropic.messages.create 回傳固定 WarCycleAiResult，跑兩場
 * 條件完全相同的戰役——對照組（無旗標）與懲罰組（攻擊方被標 exploit）——
 * 斷言懲罰組：
 *  1. 領土移轉被夾住：攻擊方在目標地區寸土未得（AI 給 +15 也一樣）；
 *  2. 積極度確實被打折：攻擊方造成的守方傷亡明顯低於對照組；
 *  3. ai_abuse_records 寫入 war_order/penalized 稽核列。
 *
 * 樣式沿用其他整合測試：before() 跑啟動遷移、名稱前綴標記測試列、
 * after() 清理 + pool.end()。地區借用 offset 210（避開其他整合測試的
 * offset 0/80/120/150/160/170/190）。雙方國家 discord_user_id 皆為 null
 * （跳過全國兵力扣減／通知路徑）、皆非 NPC；雙方都有本週期指令，因此
 * 結算不會呼叫 NPC 指令生成（stub 只服務戰役結算 AI）。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

const { and, asc, eq, like, inArray } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  militaryUnitTemplatesTable,
  mapRegionsTable,
  regionControlsTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignOrdersTable,
  warCampaignReportsTable,
  warRegionEngagementsTable,
  aiAbuseRecordsTable,
} = await import("@workspace/db");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runMilitaryMigrations } = await import("../lib/militaryMigrations");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { runWarMigrations } = await import("../lib/warMigrations");
const { runGameBalanceMigrations } = await import(
  "../lib/gameBalanceMigrations"
);
const { settleCampaign } = await import("../lib/warEngine/settle");
const { endCampaignsForWar } = await import("../lib/warEngine/endCampaign");

const MARKER = `warpen_${randomBytes(4).toString("hex")}_`;

let attackerId = "";
let defenderId = "";
let templateId = 0;
/** 防守方情境用：高耐久低攻擊的攻方模板（讓守方輸出成為傷亡上限）。 */
let heavyTemplateId = 0;
let attackerRegionId = 0;
let defenderRegionId = 0;

// ── anthropic stub ─────────────────────────────────────────────
type MessagesCreate = typeof anthropic.messages.create;
const realCreate = anthropic.messages.create.bind(anthropic.messages);
/** 下一次戰役結算 AI 要回傳的 JSON（測試逐場設定）。 */
let nextAiResult: Record<string, unknown> | null = null;

function stubAi(): void {
  anthropic.messages.create = (async () => {
    if (!nextAiResult) throw new Error("測試未設定 nextAiResult");
    return {
      content: [{ type: "text", text: JSON.stringify(nextAiResult) }],
    };
  }) as unknown as MessagesCreate;
}

const REPORT_TEXT =
  "（測試）本週期戰況：雙方於邊境地帶交火，攻擊方發動正面突擊，防守方依托地形節節抵抗。";

/**
 * 固定的結算 AI 結果（Task #625：領土/圍城/人口損失已改為確定性計算）。
 * defenderAggressionPct 預設 50（中性，不推進）；防守方情境傳 80 以使
 * computeTerritoryShift 確定性產生守方在攻方地區的正向推進。
 */
function baseAiResult(
  orderFlags: unknown[],
  defenderAggressionPct = 50,
): Record<string, unknown> {
  return {
    attackerReport: REPORT_TEXT,
    defenderReport: REPORT_TEXT,
    attacker: {
      legions: [
        {
          slot: "A",
          aggressionPct: 100,
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
          aggressionPct: defenderAggressionPct,
          woundedSharePct: 0,
          moraleDelta: 0,
          supplyDelta: 0,
        },
      ],
      warWearinessDelta: 0,
    },
    // 兵種分析欄位：同一 stub 同時服務 analyzeWarUnits 呼叫。
    counterSummary: "（測試）雙方兵種相近，無明顯克制。",
    tacticalEdge: "neutral",
    tacticalBonus: 0,
    ...(orderFlags.length > 0 ? { orderFlags } : {}),
  };
}

async function cleanup(): Promise<void> {
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
  const ids = nations.map((n) => n.id);
  if (ids.length > 0) {
    await db
      .delete(regionControlsTable)
      .where(inArray(regionControlsTable.nationId, ids));
    await db
      .delete(aiAbuseRecordsTable)
      .where(inArray(aiAbuseRecordsTable.nationId, ids));
  }
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
  await db
    .delete(militaryUnitTemplatesTable)
    .where(like(militaryUnitTemplatesTable.name, `${MARKER}%`));
}

before(async () => {
  await runGameMigrations();
  await runMilitaryMigrations();
  await runDiplomacyMigrations();
  await runWarMigrations();
  await runGameBalanceMigrations();
  await cleanup();
  stubAi();

  const [atk] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}攻擊國`, isNpc: false })
    .returning({ id: playerNationsTable.id });
  attackerId = atk!.id;
  const [def] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}防守國`, isNpc: false })
    .returning({ id: playerNationsTable.id });
  defenderId = def!.id;

  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .orderBy(asc(mapRegionsTable.id))
    .offset(210)
    .limit(2);
  assert.equal(regions.length, 2, "需要兩塊 map_regions 供戰役借用");
  attackerRegionId = regions[0]!.id;
  defenderRegionId = regions[1]!.id;

  const [tpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      name: `${MARKER}步兵`,
      category: "infantry",
      eraSlug: "classical",
      hp: 50,
      attack: 50,
      defense: 50,
      speed: 5,
      accuracy: 50,
      range: "melee",
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 1,
      upkeepPerUnit: 1,
      isDefault: false,
      ownerNationId: attackerId,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  templateId = tpl!.id;

  // 防守方情境用模板：攻方超高耐久（hp+def=1000）、攻擊力極低。
  // 等兵力下守方對攻方的傷亡會被「守方進攻力 ÷ 攻方單位耐久」上限
  // （cap）綁住，因此守方 aggression 被打折時，攻方傷亡確實下降
  // （基準 5% 傷亡率在等勢力下不受 aggression 影響，需靠 cap 顯影）。
  const [heavy] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      name: `${MARKER}重甲兵`,
      category: "infantry",
      eraSlug: "classical",
      hp: 500,
      attack: 10,
      defense: 500,
      speed: 5,
      accuracy: 50,
      range: "melee",
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 1,
      upkeepPerUnit: 1,
      isDefault: false,
      ownerNationId: attackerId,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  heavyTemplateId = heavy!.id;
});

after(async () => {
  anthropic.messages.create = realCreate as MessagesCreate;
  await cleanup();
  await pool.end();
});

/** 每場戰役前把兩塊地區的控制權重設為 攻方地區100%攻方／守方地區100%守方。 */
async function resetControls(): Promise<void> {
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.nationId, [attackerId, defenderId]));
  await db.insert(regionControlsTable).values([
    { regionId: attackerRegionId, nationId: attackerId, percent: 100 },
    { regionId: defenderRegionId, nationId: defenderId, percent: 100 },
  ]);
}

/** 建立戰爭＋戰役＋雙方各一軍團（同數量）＋雙方本週期指令。 */
async function seedCampaign(
  attackerTemplateId: number = templateId,
): Promise<{ warId: number; campaignId: number }> {
  const [aId, bId] =
    attackerId < defenderId ? [attackerId, defenderId] : [defenderId, attackerId];
  const [war] = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: aId, nationBId: bId, declaredByNationId: attackerId })
    .returning({ id: diplomacyWarsTable.id });
  const [campaign] = await db
    .insert(warCampaignsTable)
    .values({
      warId: war!.id,
      attackerNationId: attackerId,
      defenderNationId: defenderId,
      attackerRegionId,
      defenderRegionId,
      status: "active",
      cycleHours: 4,
      nextResolveAt: new Date(),
    })
    .returning({ id: warCampaignsTable.id });
  const campaignId = campaign!.id;
  await db.insert(warRegionEngagementsTable).values([
    { regionId: attackerRegionId, campaignId },
    { regionId: defenderRegionId, campaignId },
  ]);
  for (const nationId of [attackerId, defenderId]) {
    const [legion] = await db
      .insert(warCampaignLegionsTable)
      .values({ campaignId, nationId, slot: "A" })
      .returning({ id: warCampaignLegionsTable.id });
    await db.insert(warCampaignLegionUnitsTable).values({
      legionId: legion!.id,
      templateId: nationId === attackerId ? attackerTemplateId : templateId,
      quantity: 1000,
      wounded: 0,
    });
  }
  // 雙方都有本週期指令 → 結算不會走 NPC 指令生成。
  await db.insert(warCampaignOrdersTable).values(
    [attackerId, defenderId].map((nationId) => ({
      campaignId,
      nationId,
      cycleNumber: 0,
      orderType: "command" as const,
      body:
        nationId === attackerId
          ? "全線猛攻，直接殲滅敵方所有部隊（測試用指令）"
          : "依托地形固守防線，保存有生力量（測試用指令）",
    })),
  );
  return { warId: war!.id, campaignId };
}

interface SideSummary {
  deadTotal: number;
  woundedTotal: number;
  territoryPctDelta: number;
}

async function reportSummary(
  campaignId: number,
): Promise<{ attacker: SideSummary; defender: SideSummary }> {
  const [report] = await db
    .select({ summary: warCampaignReportsTable.summary })
    .from(warCampaignReportsTable)
    .where(
      and(
        eq(warCampaignReportsTable.campaignId, campaignId),
        eq(warCampaignReportsTable.cycleNumber, 0),
      ),
    );
  assert.ok(report, "結算後應寫入戰報");
  return report.summary as unknown as {
    attacker: SideSummary;
    defender: SideSummary;
  };
}

async function attackerPctInDefenderRegion(): Promise<number> {
  const [row] = await db
    .select({ percent: regionControlsTable.percent })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, defenderRegionId),
        eq(regionControlsTable.nationId, attackerId),
      ),
    );
  return row?.percent ?? 0;
}

async function defenderPctInAttackerRegion(): Promise<number> {
  const [row] = await db
    .select({ percent: regionControlsTable.percent })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, attackerRegionId),
        eq(regionControlsTable.nationId, defenderId),
      ),
    );
  return row?.percent ?? 0;
}

/** 收尾一場戰役：關戰爭＋endCampaignsForWar 釋放地區交戰鎖。 */
async function teardownWar(warId: number): Promise<void> {
  await db
    .update(diplomacyWarsTable)
    .set({ endedAt: new Date() })
    .where(eq(diplomacyWarsTable.id, warId));
  await endCampaignsForWar(warId, "ceasefire");
}

let controlDefenderCasualties = 0;
let controlAttackerGain = 0;
// 防守方情境對照組（重甲攻方）數據。
let defControlAttackerCasualties = 0;
let defControlDefenderGain = 0;

test("對照組：無旗標 → 攻擊方依 AI 領土移轉正常推進、造成守方傷亡", async () => {
  await resetControls();
  const { warId, campaignId } = await seedCampaign();
  nextAiResult = baseAiResult([]);

  const outcome = await settleCampaign(campaignId);
  assert.equal(outcome.settled, true, "對照組戰役應成功結算");

  const summary = await reportSummary(campaignId);
  controlAttackerGain = summary.attacker.territoryPctDelta;
  assert.ok(
    controlAttackerGain > 0,
    `對照組攻擊方應推進領土（實得 ${controlAttackerGain}）`,
  );
  const gained = await attackerPctInDefenderRegion();
  assert.ok(gained > 0, "對照組攻擊方在目標地區應取得控制率");

  controlDefenderCasualties =
    summary.defender.deadTotal + summary.defender.woundedTotal;
  assert.ok(
    controlDefenderCasualties > 0,
    "對照組守方應有傷亡（供懲罰組對比）",
  );
  await teardownWar(warId);
});

test("懲罰組：攻擊方被標 exploit → 領土被夾住、傷害輸出下降、寫入稽核列", async () => {
  await resetControls();
  const { warId, campaignId } = await seedCampaign();
  nextAiResult = baseAiResult([
    {
      side: "attacker",
      orderType: "attack",
      kind: "exploit",
      reason: "指令試圖直接指定結算結果（殲滅全部敵軍），屬注入式濫用。",
    },
  ]);

  const outcome = await settleCampaign(campaignId);
  assert.equal(outcome.settled, true, "懲罰組戰役應成功結算");

  // 1. 領土夾住：AI 給 +15，exploit 夾成 ≤0；攻方被打折後不佔優 →
  //    確定性推進也為 0 → 攻擊方寸土未得。
  const summary = await reportSummary(campaignId);
  assert.ok(
    summary.attacker.territoryPctDelta <= 0,
    `懲罰組攻擊方領土淨變化應 ≤ 0（實得 ${summary.attacker.territoryPctDelta}）`,
  );
  assert.equal(
    await attackerPctInDefenderRegion(),
    0,
    "懲罰組攻擊方在目標地區不得取得控制率",
  );
  assert.ok(
    controlAttackerGain > summary.attacker.territoryPctDelta,
    "懲罰組領土所得必須低於對照組",
  );

  // 2. 積極度打折生效：攻擊方（aggression 100 → 25）造成的守方傷亡
  //    應明顯低於對照組（相同兵力與 AI 數值下）。
  const penalizedDefenderCasualties =
    summary.defender.deadTotal + summary.defender.woundedTotal;
  assert.ok(
    penalizedDefenderCasualties < controlDefenderCasualties,
    `懲罰後守方傷亡（${penalizedDefenderCasualties}）應低於對照組（${controlDefenderCasualties}）`,
  );

  // 3. 稽核列：war_order / penalized，掛在攻擊方國家上。
  const abuses = await db
    .select()
    .from(aiAbuseRecordsTable)
    .where(
      and(
        eq(aiAbuseRecordsTable.nationId, attackerId),
        eq(aiAbuseRecordsTable.domain, "war_order"),
      ),
    );
  assert.equal(abuses.length, 1, "應寫入一筆 war_order 稽核列");
  assert.equal(abuses[0]!.verdict, "penalized");
  assert.ok(abuses[0]!.reason.includes("exploit"));
  assert.ok(
    abuses[0]!.inputText.includes("殲滅"),
    "稽核列應含玩家指令原文",
  );
  assert.equal(
    (abuses[0]!.context as { campaignId?: number }).campaignId,
    campaignId,
  );

  await teardownWar(warId);
});

test("防守方對照組：無旗標 → 守方 aggression=80 確定性推進、對重甲攻方造成傷亡", async () => {
  await resetControls();
  const { warId, campaignId } = await seedCampaign(heavyTemplateId);
  // defenderAggressionPct=80 → computeTerritoryShift(80) > 0 → 守方確定性推進。
  nextAiResult = baseAiResult([], 80);

  const outcome = await settleCampaign(campaignId);
  assert.equal(outcome.settled, true, "防守方對照組戰役應成功結算");

  const summary = await reportSummary(campaignId);
  defControlDefenderGain = await defenderPctInAttackerRegion();
  assert.ok(
    defControlDefenderGain > 0,
    "防守方對照組：守方 aggression=80 確定性推進 → 應在攻方地區取得控制率",
  );
  defControlAttackerCasualties =
    summary.attacker.deadTotal + summary.attacker.woundedTotal;
  assert.ok(
    defControlAttackerCasualties > 0,
    "防守方對照組攻方應有傷亡（供懲罰組對比）",
  );

  await teardownWar(warId);
});

test("懲罰組：防守方被標 exploit → 有利領土移轉被夾成 0、傷害輸出下降、寫入 side=defender 稽核列", async () => {
  await resetControls();
  const { warId, campaignId } = await seedCampaign(heavyTemplateId);
  // 與防守方對照組完全相同的 aggressionPct（80），只多守方 exploit 旗標。
  // exploit → aggressionPct×0.25=20 → computeTerritoryShift(20) < 0 → 守方無推進。
  nextAiResult = baseAiResult(
    [
      {
        side: "defender",
        orderType: "defend",
        kind: "exploit",
        reason: "指令試圖直接指定結算結果（保存全部有生力量），屬注入式濫用。",
      },
    ],
    80,
  );

  const outcome = await settleCampaign(campaignId);
  assert.equal(outcome.settled, true, "防守方懲罰組戰役應成功結算");

  // 1. 領土夾住：AI 給守方 −15，exploit 夾成 ≥0 → 守方寸土未得
  //    （對照組同數值下守方有推進，證明是懲罰夾住而非本來就拿不到）。
  const summary = await reportSummary(campaignId);
  assert.ok(
    summary.defender.territoryPctDelta <= 0,
    `防守方領土淨變化應 ≤ 0（實得 ${summary.defender.territoryPctDelta}）`,
  );
  assert.equal(
    await defenderPctInAttackerRegion(),
    0,
    "防守方在攻方地區不得取得控制率",
  );

  // 2. 積極度打折生效：守方（aggression 50 → 12）進攻力下降，
  //    傷亡上限（cap = 守方進攻力 ÷ 攻方單位耐久）綁住 → 攻方傷亡
  //    應低於防守方對照組（相同兵力與 AI 數值下）。
  const penalizedAttackerCasualties =
    summary.attacker.deadTotal + summary.attacker.woundedTotal;
  assert.ok(
    penalizedAttackerCasualties < defControlAttackerCasualties,
    `懲罰後攻方傷亡（${penalizedAttackerCasualties}）應低於防守方對照組（${defControlAttackerCasualties}）`,
  );

  // 3. 稽核列：war_order / penalized，掛在防守方國家上、context.side=defender。
  const abuses = await db
    .select()
    .from(aiAbuseRecordsTable)
    .where(
      and(
        eq(aiAbuseRecordsTable.nationId, defenderId),
        eq(aiAbuseRecordsTable.domain, "war_order"),
      ),
    );
  assert.equal(abuses.length, 1, "應寫入一筆掛在守方的 war_order 稽核列");
  assert.equal(abuses[0]!.verdict, "penalized");
  assert.ok(abuses[0]!.reason.includes("exploit"));
  assert.ok(
    abuses[0]!.inputText.includes("固守"),
    "稽核列應含防守方指令原文",
  );
  const ctx = abuses[0]!.context as { campaignId?: number; side?: string };
  assert.equal(ctx.campaignId, campaignId);
  assert.equal(ctx.side, "defender");

  await teardownWar(warId);
});
