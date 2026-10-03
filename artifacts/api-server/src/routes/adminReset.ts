import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionControlsTable,
  playerArmiesTable,
  militaryPurchaseQuotasTable,
  militaryUnitTemplatesTable,
  playerUnitCustomizationsTable,
  playerWoundedUnitsTable,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
  cityBuildingsTable,
  nationPopulationBuffsTable,
  financePendingIdeasTable,
  financeEntriesTable,
  nationFinanceLedgerTable,
  politicsHistoryTable,
  politicsPendingDecisionsTable,
  politicsPendingIdeasTable,
  politicsEntriesTable,
  diplomacyMessagesTable,
  diplomacyLobbyMessagesTable,
  diplomacyRelationEventsTable,
  diplomacyInsultQuotasTable,
  diplomacyAiChatQuotasTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  diplomacyRelationsTable,
  allianceInvitesTable,
  allianceMembersTable,
  alliancesTable,
  warCampaignReportsTable,
  warCampaignOrdersTable,
  warCampaignLegionUnitsTable,
  warCampaignLegionsTable,
  warRegionEngagementsTable,
  warRegionCooldownsTable,
  warCampaignsTable,
  cityWallsTable,
  playerNotificationsTable,
} from "@workspace/db";
import type { PgTable } from "drizzle-orm/pg-core";
import { requireAdmin } from "../middlewares/requireAdmin";
import { runMapRegionEraStatsSync } from "../lib/mapRegionEraStats";

// ── 管理員資料重置面板（requireAdmin raw-fetch，不進 OpenAPI spec） ─────────
//
// 每個動作皆為破壞性操作，前端以「輸入確認字串」的二次確認把關。所有清除都在
// 單一 db.transaction 內、依外鍵順序（子表先於父表）執行。刻意不動：世界時代
// ／遊戲日期（world_game_state）、地圖與時代基準數據、遊戲外觀／圖片／音樂，
// 以及 game_flags（NPC 種子旗標——因此清空後 NPC 不會自動重生，屬預期行為）。

const router: IRouter = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 依序 DELETE（無 where = 全表清空）。順序須為子表先於父表。 */
async function clearTables(tx: Tx, tables: PgTable[]): Promise<void> {
  for (const table of tables) {
    await tx.delete(table);
  }
}

// 戰爭戰役相關表（子表 → 父表；再加獨立表）。
const WAR_TABLES: PgTable[] = [
  warCampaignReportsTable,
  warCampaignOrdersTable,
  warCampaignLegionUnitsTable,
  warCampaignLegionsTable,
  warRegionEngagementsTable,
  warCampaignsTable,
  warRegionCooldownsTable,
  cityWallsTable,
  playerWoundedUnitsTable,
];

// 外交相關表（含聯盟；子表先於父表）。刻意不含 game_flags（NPC 種子旗標）。
const DIPLOMACY_TABLES: PgTable[] = [
  diplomacyMessagesTable,
  diplomacyLobbyMessagesTable,
  diplomacyRelationEventsTable,
  diplomacyInsultQuotasTable,
  diplomacyAiChatQuotasTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  diplomacyRelationsTable,
  allianceInvitesTable,
  allianceMembersTable,
  alliancesTable,
];

// 內政相關表（子表先於父表）。
const POLITICS_TABLES: PgTable[] = [
  politicsHistoryTable,
  politicsPendingDecisionsTable,
  politicsPendingIdeasTable,
  politicsEntriesTable,
];

// 經濟相關表。
const ECONOMY_TABLES: PgTable[] = [
  financePendingIdeasTable,
  financeEntriesTable,
  nationFinanceLedgerTable,
];

// 玩家科技進度（科技樹已研發節點＋各領域研發狀態）與自訂／改名兵種。
const TECH_MILITARY_TABLES: PgTable[] = [
  playerArmiesTable,
  militaryPurchaseQuotasTable,
  militaryUnitTemplatesTable,
  playerUnitCustomizationsTable,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
];

/** 清空所有外交＋戰爭（保留國家）：供「清空全部外交」與「一鍵全部重置」共用。 */
async function resetDiplomacyInTx(tx: Tx): Promise<void> {
  await clearTables(tx, WAR_TABLES);
  await clearTables(tx, DIPLOMACY_TABLES);
  // 外交／軍事類站內通知（戰爭一併清除，軍事通知多與戰役相關）已失去意義。
  await tx
    .delete(playerNotificationsTable)
    .where(sql`type IN ('diplomacy', 'military')`);
}

/**
 * 各地數據回歸「目前時代」基準：重跑冪等的地圖時代數據同步（還原任何漂移的
 * 地區人口／生產／科技基準），並清除會讓每國數據偏離基準的累積修正——各地區
 * 人口成長累積量（region_controls.population_bonus，Task #322）、生產力條約
 * 偏移（production_bonus）與人口增長 buff（nation_population_buffs）。
 * 不更動世界時代／遊戲日期。
 */
async function resetEraStatsDrift(): Promise<void> {
  await runMapRegionEraStatsSync();
  await db.transaction(async (tx) => {
    await tx.delete(nationPopulationBuffsTable);
    await tx.update(regionControlsTable).set({ populationBonus: 0 });
    await tx.update(playerNationsTable).set({ productionBonus: 0 });
  });
}

/** 1. 刪除所有國家（NPC＋玩家）及其一切附屬資料。 */
router.post("/admin/reset/nations", requireAdmin, async (req, res) => {
  try {
    await db.transaction(async (tx) => {
      await clearTables(tx, WAR_TABLES);
      await clearTables(tx, DIPLOMACY_TABLES);
      await clearTables(tx, POLITICS_TABLES);
      await clearTables(tx, ECONOMY_TABLES);
      await clearTables(tx, [cityBuildingsTable, nationPopulationBuffsTable]);
      await clearTables(tx, TECH_MILITARY_TABLES);
      await tx.delete(playerNotificationsTable);
      await tx.delete(regionControlsTable);
      await tx.delete(playerNationsTable);
    });
    req.log.info("admin reset: all nations deleted");
    res.json({
      ok: true,
      message: "已刪除所有國家（NPC 與玩家）及其地區歸屬、軍事、外交、戰爭、內政、經濟資料。",
    });
  } catch (err) {
    req.log.error({ err }, "admin reset nations failed");
    res.status(500).json({ error: "刪除所有國家失敗，請查看伺服器記錄" });
  }
});

/** 2. 各地數據回歸當前時代（保留國家）。 */
router.post("/admin/reset/era-stats", requireAdmin, async (req, res) => {
  try {
    await resetEraStatsDrift();
    req.log.info("admin reset: era stats drift cleared");
    res.json({
      ok: true,
      message: "各地數據已回歸目前時代的基準值，並清除各國人口／生產力的累積偏移與人口增長加成。",
    });
  } catch (err) {
    req.log.error({ err }, "admin reset era stats failed");
    res.status(500).json({ error: "各地數據回歸失敗，請查看伺服器記錄" });
  }
});

/** 3. 清空地區建築（僅 city_buildings）。 */
router.post("/admin/reset/buildings", requireAdmin, async (req, res) => {
  try {
    await db.delete(cityBuildingsTable);
    req.log.info("admin reset: city buildings cleared");
    res.json({ ok: true, message: "已清空所有地區建築。" });
  } catch (err) {
    req.log.error({ err }, "admin reset buildings failed");
    res.status(500).json({ error: "清空地區建築失敗，請查看伺服器記錄" });
  }
});

/** 4. 清空全部外交（含戰爭，保留國家）。 */
router.post("/admin/reset/diplomacy", requireAdmin, async (req, res) => {
  try {
    await db.transaction(async (tx) => {
      await resetDiplomacyInTx(tx);
    });
    req.log.info("admin reset: diplomacy & wars cleared");
    res.json({
      ok: true,
      message: "已清空所有外交關係、訊息、條約、聯盟與進行中的戰爭戰役。",
    });
  } catch (err) {
    req.log.error({ err }, "admin reset diplomacy failed");
    res.status(500).json({ error: "清空外交失敗，請查看伺服器記錄" });
  }
});

/** 5. 一鍵全部重置：依序執行上述 1–4（刪除國家已涵蓋外交／戰爭與建築）。 */
router.post("/admin/reset/all", requireAdmin, async (req, res) => {
  try {
    // 刪除所有國家已連帶清除外交／戰爭／建築／內政／經濟等一切附屬資料，
    // 因此「全部重置」= 刪除所有國家 + 各地數據回歸基準。
    await db.transaction(async (tx) => {
      await clearTables(tx, WAR_TABLES);
      await clearTables(tx, DIPLOMACY_TABLES);
      await clearTables(tx, POLITICS_TABLES);
      await clearTables(tx, ECONOMY_TABLES);
      await clearTables(tx, [cityBuildingsTable, nationPopulationBuffsTable]);
      await clearTables(tx, TECH_MILITARY_TABLES);
      await tx.delete(playerNotificationsTable);
      await tx.delete(regionControlsTable);
      await tx.delete(playerNationsTable);
    });
    // 國家已全數刪除，再把各地數據還原成目前時代的基準值。
    await runMapRegionEraStatsSync();
    req.log.info("admin reset: full reset complete");
    res.json({
      ok: true,
      message: "已完成一鍵全部重置：刪除所有國家與其附屬資料、清空建築與外交戰爭，並將各地數據還原成目前時代的基準值。",
    });
  } catch (err) {
    req.log.error({ err }, "admin reset all failed");
    res.status(500).json({ error: "一鍵全部重置失敗，請查看伺服器記錄" });
  }
});

export default router;
