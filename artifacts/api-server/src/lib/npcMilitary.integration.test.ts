/**
 * Integration test（真實開發 DB，透過 test-integration workflow 執行）：
 * Task #389 — NPC 常備軍：drawNpcTroopsInTx 抽調（committed 累加、防超抽）、
 * returnNpcTroopsInTx 戰後結算（損失扣除、傷兵回恢復池、committed 歸零）、
 * npcAvailableTroops 可用量計算。
 * Task #398 — 端到端驗證「所有戰役結束路徑」都會歸還 NPC 常備軍：
 * 走完整 endCampaign 流程（勝負 endCampaignById、停火 endCampaignsForWar），
 * 驗證 npc_armies committed 歸零、quantity/wounded 符合 npc_drawn 快照結算。
 *
 * 樣式沿用其他整合測試：before() 跑啟動遷移、以名稱前綴標記測試列、
 * after() 清理 + pool.end()。npc_armies FK REFERENCES player_nations(id)
 * ON DELETE CASCADE，故只需刪 player_nations 前綴列即連帶清除（戰爭／
 * 戰役／軍團亦 cascade）；測試專用兵種模板與借用地區的冷卻列另行刪除。
 * 地區借用 offset 190（避開其他整合測試的 offset 0/80/120/150/160/170）。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

const { eq, like, and, asc, inArray } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  npcArmiesTable,
  militaryUnitTemplatesTable,
  mapRegionsTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warRegionCooldownsTable,
  warRegionEngagementsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runMilitaryMigrations } = await import("../lib/militaryMigrations");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { runWarMigrations } = await import("../lib/warMigrations");
const {
  drawNpcTroopsInTx,
  returnNpcTroopsInTx,
  npcAvailableTroops,
} = await import("../lib/npcMilitary");
const { endCampaignById, endCampaignsForWar } = await import(
  "../lib/warEngine/endCampaign"
);

const MARKER = `npcmil_${randomBytes(4).toString("hex")}_`;

let nationId = "";
let attackerNationId = "";
let templateId = 0;
let regionIds: number[] = [];

async function cleanup(): Promise<void> {
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
  await db
    .delete(militaryUnitTemplatesTable)
    .where(like(militaryUnitTemplatesTable.name, `${MARKER}%`));
  if (regionIds.length > 0) {
    await db
      .delete(warRegionCooldownsTable)
      .where(inArray(warRegionCooldownsTable.regionId, regionIds));
  }
}

before(async () => {
  await runGameMigrations();
  await runMilitaryMigrations();
  await runDiplomacyMigrations();
  await runWarMigrations();
  await cleanup();
  const [nation] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}NPC國`, isNpc: true })
    .returning({ id: playerNationsTable.id });
  nationId = nation!.id;
  // 攻擊方：真人國家但 discord_user_id 為 null（避免通知寫入依賴）。
  const [attacker] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}攻擊國`, isNpc: false })
    .returning({ id: playerNationsTable.id });
  attackerNationId = attacker!.id;
  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .orderBy(asc(mapRegionsTable.id))
    .offset(190)
    .limit(2);
  assert.equal(regions.length, 2, "需要兩塊 map_regions 供戰役借用");
  regionIds = regions.map((r) => r.id);
  const [tpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      name: `${MARKER}步兵`,
      category: "infantry",
      eraSlug: "classical",
      hp: 10,
      attack: 5,
      defense: 5,
      speed: 5,
      accuracy: 50,
      range: "melee",
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 1,
      upkeepPerUnit: 1,
      isDefault: false,
      ownerNationId: nationId,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  templateId = tpl!.id;
  await db.insert(npcArmiesTable).values({
    nationId,
    templateId,
    quantity: 1000,
    committed: 0,
    wounded: 0,
  });
});

after(async () => {
  await cleanup();
  await pool.end();
});

async function armyRow() {
  const [row] = await db
    .select()
    .from(npcArmiesTable)
    .where(
      and(
        eq(npcArmiesTable.nationId, nationId),
        eq(npcArmiesTable.templateId, templateId),
      ),
    );
  assert.ok(row);
  return row;
}

test("drawNpcTroopsInTx 抽調 committed 累加且不超抽", async () => {
  assert.equal(await npcAvailableTroops(nationId), 1000);

  const draws = await db.transaction((tx) => drawNpcTroopsInTx(tx, nationId, 600));
  assert.equal(draws.length, 1);
  assert.equal(draws[0]!.drawn, 600);

  let row = await armyRow();
  assert.equal(row.quantity, 1000); // 抽調不動 quantity
  assert.equal(row.committed, 600);
  assert.equal(await npcAvailableTroops(nationId), 400);

  // 目標超過可用量 → 只抽到可用量。
  const draws2 = await db.transaction((tx) =>
    drawNpcTroopsInTx(tx, nationId, 9999),
  );
  assert.equal(draws2[0]!.drawn, 400);
  row = await armyRow();
  assert.equal(row.committed, 1000);
  assert.equal(await npcAvailableTroops(nationId), 0);

  // 無可用量 → 空。
  const draws3 = await db.transaction((tx) => drawNpcTroopsInTx(tx, nationId, 10));
  assert.equal(draws3.length, 0);
});

test("returnNpcTroopsInTx 依 npc_drawn 快照結算損失與傷兵", async () => {
  // 快照：抽調 1000，戰後存活 quantity 550 + wounded 150 → returned 700、
  // 損失 300、傷兵 150 回恢復池：quantity = 1000 − (300 + 150) = 550。
  await db.transaction((tx) =>
    returnNpcTroopsInTx(tx, [
      { nationId, templateId, npcDrawn: 1000, quantity: 550, wounded: 150 },
    ]),
  );
  const row = await armyRow();
  assert.equal(row.committed, 0);
  assert.equal(row.quantity, 550);
  assert.equal(row.wounded, 150);
  assert.equal(await npcAvailableTroops(nationId), 550);
});

// ── Task #398 — 完整 endCampaign 路徑的端到端歸還驗證 ──────────

/** 把 NPC 常備軍列重設為已知狀態（模擬戰役開打時已抽調 committed）。 */
async function resetArmy(params: {
  quantity: number;
  committed: number;
  wounded: number;
}): Promise<void> {
  await db
    .update(npcArmiesTable)
    .set(params)
    .where(
      and(
        eq(npcArmiesTable.nationId, nationId),
        eq(npcArmiesTable.templateId, templateId),
      ),
    );
}

/** 建立戰爭＋NPC 防守戰役＋NPC 軍團（含 npc_drawn 快照列），回傳 id。 */
async function seedCampaign(unit: {
  npcDrawn: number;
  quantity: number;
  wounded: number;
}): Promise<{ warId: number; campaignId: number }> {
  const [aId, bId] =
    attackerNationId < nationId
      ? [attackerNationId, nationId]
      : [nationId, attackerNationId];
  const [war] = await db
    .insert(diplomacyWarsTable)
    .values({
      nationAId: aId,
      nationBId: bId,
      declaredByNationId: attackerNationId,
    })
    .returning({ id: diplomacyWarsTable.id });
  const [campaign] = await db
    .insert(warCampaignsTable)
    .values({
      warId: war!.id,
      attackerNationId,
      defenderNationId: nationId,
      attackerRegionId: regionIds[0]!,
      defenderRegionId: regionIds[1]!,
      status: "active",
      cycleHours: 4,
      nextResolveAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: warCampaignsTable.id });
  const campaignId = campaign!.id;
  await db.insert(warRegionEngagementsTable).values(
    regionIds.map((regionId) => ({ regionId, campaignId })),
  );
  const [legion] = await db
    .insert(warCampaignLegionsTable)
    .values({ campaignId, nationId, slot: "A" })
    .returning({ id: warCampaignLegionsTable.id });
  await db.insert(warCampaignLegionUnitsTable).values({
    legionId: legion!.id,
    templateId,
    npcDrawn: unit.npcDrawn,
    quantity: unit.quantity,
    wounded: unit.wounded,
  });
  return { warId: war!.id, campaignId };
}

test("endCampaignById（勝負路徑）歸還 NPC 常備軍：committed 歸零、損失扣除、傷兵入池", async () => {
  // 開打時抽調 400（committed=400），戰後前線存活 250 + 傷兵 100 → 損失 50。
  await resetArmy({ quantity: 1000, committed: 400, wounded: 0 });
  const { warId, campaignId } = await seedCampaign({
    npcDrawn: 400,
    quantity: 250,
    wounded: 100,
  });

  const ended = await endCampaignById(campaignId, {
    reason: "territory",
    winnerNationId: attackerNationId,
    now: new Date(),
  });
  assert.ok(ended, "戰役應成功結束");
  assert.equal(ended.endReason, "territory");

  const row = await armyRow();
  assert.equal(row.committed, 0, "committed 必須歸零");
  // quantity = 1000 − (損失 50 + 傷兵 100) = 850。
  assert.equal(row.quantity, 850);
  assert.equal(row.wounded, 100, "傷兵應回到恢復池");
  assert.equal(await npcAvailableTroops(nationId), 850);

  // 地區交戰鎖應釋放。
  const engagements = await db
    .select()
    .from(warRegionEngagementsTable)
    .where(inArray(warRegionEngagementsTable.regionId, regionIds));
  assert.equal(engagements.length, 0);

  // 重複結束（已 ended）→ null，且不得重複歸還。
  const again = await endCampaignById(campaignId, {
    reason: "territory",
    winnerNationId: attackerNationId,
    now: new Date(),
  });
  assert.equal(again, null);
  const rowAfter = await armyRow();
  assert.equal(rowAfter.quantity, 850);
  assert.equal(rowAfter.committed, 0);
  assert.equal(rowAfter.wounded, 100);

  // 關閉戰爭，讓下一個測試可為同一對國家再開新戰爭（partial unique index）。
  await db
    .update(diplomacyWarsTable)
    .set({ endedAt: new Date() })
    .where(eq(diplomacyWarsTable.id, warId));
});

test("endCampaignsForWar（停火路徑）歸還 NPC 常備軍：無損失時全數歸建", async () => {
  await resetArmy({ quantity: 1000, committed: 300, wounded: 0 });
  const { warId, campaignId } = await seedCampaign({
    npcDrawn: 300,
    quantity: 300,
    wounded: 0,
  });

  // 停戰成立（外交路由先關戰爭，再收拾戰役）。
  await db
    .update(diplomacyWarsTable)
    .set({ endedAt: new Date() })
    .where(eq(diplomacyWarsTable.id, warId));
  await endCampaignsForWar(warId, "ceasefire");

  const [campaign] = await db
    .select()
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignId));
  assert.equal(campaign?.status, "ended");
  assert.equal(campaign?.endReason, "ceasefire");

  const row = await armyRow();
  assert.equal(row.committed, 0, "停火也必須歸零 committed");
  assert.equal(row.quantity, 1000, "無損失 → 全數歸建");
  assert.equal(row.wounded, 0);
  assert.equal(await npcAvailableTroops(nationId), 1000, "NPC 可用兵力應完全恢復");
});
