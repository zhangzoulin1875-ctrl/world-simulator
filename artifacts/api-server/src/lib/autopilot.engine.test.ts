import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, like, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  cabinetApprovalsTable,
  cityBuildingsTable,
  regionControlsTable,
  mapCitiesTable,
  techTreeNodesTable,
  playerResearchedTreeNodesTable,
  type PlayerNation,
  type CabinetMinister,
  type CabinetDomainSettingsRow,
  type CabinetApproval,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations, runRegionControlMigrations } from "./gameMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runMapCitySync } from "./mapCities";
import { runCabinetMigrations } from "./cabinetMigrations";
import { runEconomyMigrations } from "./economyMigrations";
import { runSocialTechMigrations } from "./socialTechMigrations";
import { runProductionMigrations } from "./productionMigrations";
import { runTechTreeMigrations } from "./techTreeMigrations";
import { runWallMigrations } from "./wallMigrations";
import { getDomainModule, applyApproval } from "./cabinet";
import { buildingByType } from "./production";
import { getGameBalanceSettings, scaleConstructionCost } from "./gameBalance";
import { getEraSlugs } from "./nationStats";
import { autopilotSettingsTable } from "@workspace/db";
import { runAutopilotMigrations } from "./autopilotMigrations";
import { runAutopilotForNation, styleProfile, buildAutopilotDirective, autoApprovePending, NEVER_AUTO_APPROVE_ACTIONS } from "./autopilot";
import { loadNationScales } from "./nationScale";
import type { AgencyLevel } from "./cabinet/types";
import type { InteriorPlan } from "./cabinet/domains/interiorAi";

/**
 * Task #258 — 內政大臣領域模組 runDomain／executeApproved 的整合測試（真實 dev DB）。
 *
 * 驗證代理決策的分流與守衛：
 *   1. 已授權且非重大 → 直接代理執行並正確扣除資源（興建糧倉扣金錢、寫入建築列）。
 *   2. 已授權但重大 → 進審批佇列，不自動執行（相對國庫的重大支出）。
 *   3. 越權傾向「高」的大臣：對未授權項目只提案、絕不自動執行（即使該筆本屬非重大）。
 *   4. 同一 actionKey 已有待審 → 不重複提案。
 *   5. executeApproved 因狀態改變（金錢不足）拋錯 → 模擬審批路由回傳 502。
 *
 * 測試資料自成一體：建立專屬測試國家（cascade 清掉 approvals/controls/buildings），
 * 借用一座真實種入的城市與其地區，並以覆寫 anthropic.messages.create 提供固定 AI 規劃。
 */

const TEST_TAG = "autopilot-engine-test";
// pid 後綴：lib glob 與 test-integration 併發跑同一檔時，各行程資料互不碰撞
// （discord_user_id 有唯一約束，固定 ID 會 23505）。
const TEST_USER_ID = `${TEST_TAG}-user-${process.pid}`;
// 造價隨世界時代與管理員建設倍率變動：before() 以與正式程式相同的公式算出，
// 國庫（RICH/POOR）維持原測試比例（糧倉 800 : 富 100000 : 窮 1500）。
let GRANARY_COST = 800;
let RICH = 100000;
let POOR = 1500;

// ── 固定 AI 規劃覆寫（避免真實呼叫 Anthropic） ─────────────────────
type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);
let nextPlan: InteriorPlan = emptyPlan();

function emptyPlan(): InteriorPlan {
  return {
    researchSocialTechId: null,
    researchProductionTechId: null,
    fiscalPolicy: null,
    building: null,
    demolish: null,
    wall: null,
    foodPolicy: null,
    note: "測試規劃",
  };
}

function installPlanStub(): void {
  anthropic.messages.create = (async () => ({
    content: [{ type: "text", text: JSON.stringify(nextPlan) }],
  })) as unknown as MessagesCreate;
}

let nationId: string;
let cityId: number;
let regionId: number;

const interior = getDomainModule("interior");

/**
 * 自我修復清理：刪除本測試標記的所有殘留資料（含前次中斷執行留下的列）。
 * nationId 為 FK 的子表（審批／地區歸屬）以國家 id 刪除；其餘以 discordUserId 刪除。
 */
async function purgeForUser(userId: string): Promise<void> {
  const existing = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId));
  for (const n of existing) {
    await db
      .delete(cabinetApprovalsTable)
      .where(eq(cabinetApprovalsTable.nationId, n.id));
    await db
      .delete(regionControlsTable)
      .where(eq(regionControlsTable.nationId, n.id));
    await db
      .delete(playerResearchedTreeNodesTable)
      .where(eq(playerResearchedTreeNodesTable.nationId, n.id));
  }
  await db
    .delete(cityBuildingsTable)
    .where(eq(cityBuildingsTable.discordUserId, userId));
  await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId));
}

async function purgeTestData(): Promise<void> {
  await purgeForUser(TEST_USER_ID);
}

/**
 * 清除前次「中斷」執行殘留：同前綴、超過 30 分鐘的舊列。
 * 只清舊列（不清同前綴的新列），避免刪到併發中另一行程的活資料。
 */
async function purgeStaleTestData(): Promise<void> {
  const stale = await db
    .select({ discordUserId: playerNationsTable.discordUserId })
    .from(playerNationsTable)
    .where(
      and(
        like(playerNationsTable.discordUserId, `${TEST_TAG}-user%`),
        sql`${playerNationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`,
      ),
    );
  for (const row of stale) {
    if (row.discordUserId) await purgeForUser(row.discordUserId);
  }
}

async function reloadNation(): Promise<PlayerNation> {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "測試國家不存在");
  return row;
}

function makeMinister(overreach: number, timidity: number): CabinetMinister {
  const now = new Date();
  return {
    id: 1,
    nationId,
    domain: "interior",
    name: `${TEST_TAG}大臣`,
    origin: "測試",
    style: { overreach, timidity, description: "測試風格" },
    era: "classical",
    status: "active",
    createdAt: now,
    updatedAt: now,
  } as unknown as CabinetMinister;
}

async function runInterior(opts: {
  overreach: number;
  timidity: number;
  enabled: string[];
  agencyLevel: AgencyLevel;
}): Promise<void> {
  const nation = await reloadNation();
  await interior.runDomain({
    nation,
    minister: makeMinister(opts.overreach, opts.timidity),
    settings: {} as unknown as CabinetDomainSettingsRow,
    enabledActionKeys: opts.enabled,
    directive: "穩健發展",
    agencyLevel: opts.agencyLevel,
    era: "classical",
  });
}

async function listApprovals(actionKey?: string): Promise<CabinetApproval[]> {
  const rows = await db
    .select()
    .from(cabinetApprovalsTable)
    .where(
      and(
        eq(cabinetApprovalsTable.nationId, nationId),
        eq(cabinetApprovalsTable.domain, "interior"),
        eq(cabinetApprovalsTable.status, "pending"),
      ),
    );
  return actionKey ? rows.filter((r) => r.actionKey === actionKey) : rows;
}

/**
 * 模擬審批路由：認領 pending → approved，套用 applyApproval，失敗回 502。
 * 刻意精簡：省略真實路由的國家擁有權判定（本測試僅驗證 executeApproved 失敗→502 的映射）。
 */
async function approveLikeRoute(approvalId: number): Promise<number> {
  const claimed = await db
    .update(cabinetApprovalsTable)
    .set({ status: "approved", resolvedAt: new Date() })
    .where(
      and(
        eq(cabinetApprovalsTable.id, approvalId),
        eq(cabinetApprovalsTable.status, "pending"),
      ),
    )
    .returning();
  const approval = claimed[0];
  if (!approval) return 404;
  const nation = await reloadNation();
  try {
    await applyApproval(approval, nation);
  } catch {
    return 502;
  }
  return 200;
}

before(async () => {
  await runGameMigrations();
  await runMapRegionSync();
  await runRegionControlMigrations();
  await runMapCitySync();
  await runCabinetMigrations();
  await runEconomyMigrations();
  await runSocialTechMigrations();
  await runProductionMigrations();
  await runTechTreeMigrations();
  await runWallMigrations();
  await runAutopilotMigrations();

  installPlanStub();

  // 先清掉任何殘留的測試資料，讓 before() 對髒 DB 也能冪等執行。
  await purgeStaleTestData();
  await purgeTestData();

  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}-國`,
      leaderName: TEST_TAG,
      discordUserId: TEST_USER_ID,
      money: RICH,
      techPoints: 100000,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "測試國家建立失敗");
  nationId = nation.id;

  // 借用一座真實種入的城市與其所屬地區，並讓測試國家 100% 掌控該地區。
  const [city] = await db
    .select({ id: mapCitiesTable.id, regionId: mapCitiesTable.regionId })
    .from(mapCitiesTable)
    .orderBy(mapCitiesTable.id)
    .limit(1);
  assert.ok(city, "找不到任何種入的城市");
  cityId = city.id;
  regionId = city.regionId;
  await db
    .insert(regionControlsTable)
    .values({ nationId, regionId, percent: 100 })
    .onConflictDoNothing();

  // 造價隨該國人口的動態尺度而定（與正式程式同一來源 loadNationScales）：
  // 地區控制建立後才能算；國庫（RICH/POOR）維持原測試比例。
  {
    const def = buildingByType("granary");
    const scales = await loadNationScales(nationId, (await getEraSlugs()).statsEra);
    GRANARY_COST = scaleConstructionCost(
      (def?.buildCost ?? 800) * scales.price,
      (await getGameBalanceSettings()).constructionCosts.cityBuilding,
    );
    RICH = GRANARY_COST * 125;
    POOR = Math.ceil(GRANARY_COST * 1.875);
  }

  // 研發前置：社會科技「部落革新」開啟建築槽、生產科技「灌溉農業」解鎖糧倉。
  // Task #469 起兩者皆為全球統一科技樹節點（tech_tree_nodes.key_slug）。
  const [social] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.keySlug, "tribal_innovation"));
  assert.ok(social, "找不到社會科技 tribal_innovation");
  const [production] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.keySlug, "irrigation"));
  assert.ok(production, "找不到生產科技 irrigation");
  await db
    .insert(playerResearchedTreeNodesTable)
    .values([
      { nationId, nodeId: social.id },
      { nationId, nodeId: production.id },
    ])
    .onConflictDoNothing();
});

beforeEach(async () => {
  nextPlan = emptyPlan();
  // 每個測試前重設國家資源與預算，清空審批佇列、既有建築與抽牌暫存。
  await db
    .update(playerNationsTable)
    .set({
      money: RICH,
      techPoints: 100000,
    })
    .where(eq(playerNationsTable.id, nationId));
  await db
    .delete(cabinetApprovalsTable)
    .where(eq(cabinetApprovalsTable.nationId, nationId));
  await db
    .delete(cityBuildingsTable)
    .where(eq(cityBuildingsTable.discordUserId, TEST_USER_ID));
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await purgeTestData();
  await pool.end();
});


async function enableAutopilot(style: string, directive = ""): Promise<void> {
  await db
    .insert(autopilotSettingsTable)
    .values({ nationId, enabled: true, style, directive, enabledAt: new Date() })
    .onConflictDoUpdate({
      target: autopilotSettingsTable.nationId,
      set: { enabled: true, style, directive, turnsRun: 0, recentActions: [] },
    });
}

async function runOnce(): Promise<void> {
  const nation = await reloadNation();
  const [settings] = await db
    .select()
    .from(autopilotSettingsTable)
    .where(eq(autopilotSettingsTable.nationId, nationId));
  await runAutopilotForNation(nation, settings!, "classical");
}

test("風格對應：穩健保守、擴張積極、未知值退回均衡", () => {
  assert.equal(styleProfile("steady").agencyLevel, "conservative");
  assert.equal(styleProfile("expansion").agencyLevel, "aggressive");
  assert.equal(styleProfile("balanced").agencyLevel, "balanced");
  assert.equal(styleProfile("garbage").agencyLevel, "balanced");
  assert.ok(styleProfile("steady").cabinetStyle.timidity > styleProfile("expansion").cabinetStyle.timidity);
});

test("方針組裝：含風格目標與玩家文字，空白不加", () => {
  const d = buildAutopilotDirective("expansion", "  多蓋糧倉  ");
  assert.ok(d.includes("擴張") && d.includes("多蓋糧倉"));
  assert.ok(!buildAutopilotDirective("steady", "   ").includes("玩家方針"));
});

test("全授權：未勾選任何項目也自動興建糧倉並扣款（無虛擬大臣名額占用）", async () => {
  nextPlan = { ...emptyPlan(), building: { cityId, buildingType: "granary" } };
  await enableAutopilot("balanced");
  await runOnce();
  const nation = await reloadNation();
  assert.equal(Number(nation.money), RICH - GRANARY_COST, "託管應自動興建並扣款");
  const buildings = await db.select().from(cityBuildingsTable).where(eq(cityBuildingsTable.discordUserId, TEST_USER_ID));
  assert.equal(buildings.length, 1);
  assert.equal((await listApprovals()).length, 0, "不應留下待審批");
});

test("重大支出不再卡審批：國庫壓低使糧倉成重大支出，託管仍自動核准並執行", async () => {
  await db.update(playerNationsTable).set({ money: POOR }).where(eq(playerNationsTable.id, nationId));
  nextPlan = { ...emptyPlan(), building: { cityId, buildingType: "granary" } };
  await enableAutopilot("steady");
  await runOnce();
  const nation = await reloadNation();
  assert.equal(Number(nation.money), POOR - GRANARY_COST, "重大支出經自動核准後應已扣款");
  const buildings = await db.select().from(cityBuildingsTable).where(eq(cityBuildingsTable.discordUserId, TEST_USER_ID));
  assert.equal(buildings.length, 1, "重大支出經自動核准後應已興建");
  const pending = await listApprovals();
  assert.equal(pending.length, 0, "佇列不應殘留 pending");
});

test("行動紀錄與回合數：runOnce 後 turns_run=1 且 recent_actions 有內容", async () => {
  nextPlan = { ...emptyPlan(), building: { cityId, buildingType: "granary" } };
  await enableAutopilot("balanced");
  await runOnce();
  const [s] = await db.select().from(autopilotSettingsTable).where(eq(autopilotSettingsTable.nationId, nationId));
  assert.equal(s!.turnsRun, 1);
  assert.ok(s!.recentActions.length >= 1, "應記錄至少一筆行動");
  assert.ok(s!.recentActions[0]!.text.length > 0);
  await runOnce();
  const [s2] = await db.select().from(autopilotSettingsTable).where(eq(autopilotSettingsTable.nationId, nationId));
  assert.equal(s2!.turnsRun, 2);
});

test("autoApprovePending：手動塞一筆外交 pending（領域停用）→ 被否決清除而非批准", async () => {
  await db.insert(cabinetApprovalsTable).values({ nationId, domain: "diplomacy", actionKey: "declare_war", summary: "測試宣戰", params: {} });
  const nation = await reloadNation();
  const n = await autoApprovePending(nation);
  assert.equal(n, 0, "停用領域不可被批准");
  const rows = await db.select().from(cabinetApprovalsTable).where(and(eq(cabinetApprovalsTable.nationId, nationId), eq(cabinetApprovalsTable.domain, "diplomacy")));
  assert.equal(rows[0]!.status, "rejected");
});

test("硬性護欄：declare_war 即使出現在「未停用」的領域也絕不自動核准（獨立於外交停用開關）", async () => {
  // 用軍事領域（未停用）偽裝一筆宣戰：只有 NEVER_AUTO_APPROVE_ACTIONS 能擋住它，
  // 可見日後就算重新啟用外交領域，託管也不會替玩家宣戰。
  await db.delete(cabinetApprovalsTable).where(eq(cabinetApprovalsTable.nationId, nationId));
  await db.insert(cabinetApprovalsTable).values({ nationId, domain: "military", actionKey: "declare_war", summary: "偽裝宣戰", params: {} });
  const n = await autoApprovePending(await reloadNation());
  assert.equal(n, 0, "宣戰不可被自動核准");
  const rows = await db.select().from(cabinetApprovalsTable).where(and(eq(cabinetApprovalsTable.nationId, nationId), eq(cabinetApprovalsTable.actionKey, "declare_war")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "rejected", "被否決清除，而非 approved");
  assert.ok(NEVER_AUTO_APPROVE_ACTIONS.has("declare_war"));
});
