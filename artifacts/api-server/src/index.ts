import app from "./app";
import { logger } from "./lib/logger";
import { startDiscordBot, getStoredToken, startBotWatchdog } from "./lib/discordBot";
import {
  runGameMigrations,
  runRegionControlMigrations,
} from "./lib/gameMigrations";
import { runMapRegionSync } from "./lib/mapRegions";
import { validateSeaAdjacency } from "./lib/navalLanding";
import { runMapRegionEraStatsSync } from "./lib/mapRegionEraStats";
import { runMapCitySync, validateMapCitySeed } from "./lib/mapCities";
import { runMapV2RegionReset } from "./lib/mapV2Reset";
import { runMilitaryMigrations } from "./lib/militaryMigrations";
import { runWeaponMigrations } from "./lib/weaponMigrations";
import { runDiplomacyMigrations } from "./lib/diplomacyMigrations";
import { runResourceMigrations } from "./lib/resourceMigrations";
import {
  startTreatyExpiryLoop,
  startRelationEventPruneLoop,
} from "./lib/diplomacy";
import { runPoliticsMigrations } from "./lib/politicsMigrations";
import { runCabinetMigrations } from "./lib/cabinetMigrations";
import { runWarMigrations } from "./lib/warMigrations";
import {
  runEconomyMigrations,
  repairNegativeProductionBonus,
  repairTreatyProductionBonusAccrual,
} from "./lib/economyMigrations";
import { runSocialTechMigrations } from "./lib/socialTechMigrations";
import { runProductionMigrations } from "./lib/productionMigrations";
import { runTechTreeMigrations } from "./lib/techTreeMigrations";
import { recalcArmyProductionReservations } from "./lib/armyReservationRecalc";
import { runWallMigrations } from "./lib/wallMigrations";
import { runWorldSimMigrations } from "./lib/worldSimMigrations";
import { runGameNewsMigrations } from "./lib/gameNewsMigrations";
import { runAccountBanMigrations } from "./lib/accountBanMigrations";
import { runSuperEventMigrations } from "./lib/superEventMigrations";
import { runGameBalanceMigrations } from "./lib/gameBalanceMigrations";
import { runAiUsageMigrations } from "./lib/aiUsageMigrations";
import { runAiPregenMigrations } from "./lib/aiPregenMigrations";
import { runNationNameSanitizeMigration } from "./lib/nationNameSanitizeMigration";
import { startRegionControlHealthLoop } from "./lib/regionControlHealth";
import { startProductionSpentHealthLoop } from "./lib/productionSpentHealth";
import { startSessionCleanupLoop } from "./lib/sessions";
import { startTurnLoop } from "./lib/turnEngine";
import { startWarEngineLoops } from "./lib/warEngine";
import { startWorldSchedulerLoops } from "./lib/worldScheduler";
import { startAiPregenWorker } from "./lib/aiPregenWorker";
import { bootstrapAiFallback } from "./lib/aiFallback";

// Open the HTTP port (health-check endpoint /api/healthz is DB-free).
function openPort(): void {
  const rawPort = process.env["PORT"];

  if (!rawPort) {
    logger.fatal("PORT environment variable is required but was not provided.");
    process.exit(1);
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    logger.fatal(`Invalid PORT value: "${rawPort}"`);
    process.exit(1);
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

// Guarded, idempotent startup migrations + data seeding/sync. Every statement
// is safe to re-run; in a deployed environment the production schema is already
// applied by Replit's Publish flow, so these are effectively redundant there.
async function runStartupMigrations(): Promise<void> {
  await runGameMigrations();
  await runMapRegionSync();
  // Task #277 海上航路一致性：地圖種子同步後立即驗證近海相鄰資料
  // （navalLanding 的 SEA_ADJACENCY_PAIRS／COMPASS_ONLY_ISLANDS 以地區「名稱」為鍵，
  // 不在地圖種子驗證器範圍內）。日後任何改名／重劃地圖若讓孤島失去登陸點，
  // 就會像其他地圖驗證器一樣在啟動時大聲失敗，而非只在單元測試中被發現。
  validateSeaAdjacency();
  // Task #279 歷史城市一致性：地圖種子同步後立即驗證城市種子
  // （mapCities 的 MAP_CITY_SEED 以地區「名稱」為鍵，不在地圖種子驗證器範圍內）。
  // 日後任何改名／重劃地圖若讓城市指向已移除的地區，就會像其他地圖驗證器一樣
  // 在啟動時大聲失敗，而非只在單元測試中被發現。
  validateMapCitySeed();
  await runRegionControlMigrations();
  await runMapRegionEraStatsSync();
  await runMapCitySync();
  // Task #270 地圖二代（343 區）：地圖同步後、軍事／外交遷移前，一次性重置
  // 所有地區綁定的遊戲資料（掌控/戰爭/戰役/傷兵…）；國家/外觀/音樂保留。
  await runMapV2RegionReset();
  await runMilitaryMigrations();
  // 武器系統（兵種設計的姊妹系統：武器藍圖/裝備/設計次數）。
  await runWeaponMigrations();
  await runDiplomacyMigrations();
  // Task #406 — 資源系統（木材/礦石庫存、地區建築、條約資源欄位）。
  await runResourceMigrations();
  await runPoliticsMigrations();
  await runCabinetMigrations();
  await runWarMigrations();
  await runEconomyMigrations();
  // Task #479 — 一次性歸零負值 production_bonus（舊生產力維護費死亡螺旋
  // 的歷史欠債；game_flags 原子認領，只跑一次）。
  await repairNegativeProductionBonus();
  // 條約生產力輸送改純流量：一次性歸零曾參與含生產力項自訂條約國家的
  // production_bonus 歷史累積（game_flags 原子認領，只跑一次；需在
  // diplomacy／economy 遷移之後）。
  await repairTreatyProductionBonusAccrual();
  await runSocialTechMigrations();
  await runProductionMigrations();
  await runTechTreeMigrations();
  // Task #557 — 一次性重算軍隊生產力預留（改用維護費口徑）＋ spent 全量對齊。
  // 需在軍事/資源（建築預留）/外交（game_flags）/科技樹遷移之後。
  await recalcArmyProductionReservations();
  await runWallMigrations();
  await runWorldSimMigrations();
  await runGameNewsMigrations();
  await runAccountBanMigrations();
  await runSuperEventMigrations();
  // Task #451 — 遊戲平衡設定＋AI 濫用紀錄（無 FK，可放最後）。
  await runGameBalanceMigrations();
  // Task #593 — AI 用量紀錄＋各功能 token 上限（無 FK，可放最後）。
  await runAiUsageMigrations();
  // v3 — AI 閒時預產快取表（FK 依賴 player_nations，放遷移鏈尾端）。
  await runAiPregenMigrations();
  // Task #604 — 清理存量違規國名（超過 25 字或含空白/標點）。
  await runNationNameSanitizeMigration();
}

// Bot watchdog + background loops. Started only after the migration chain
// resolves so they never read/write a table before its schema/seed exists.
function startBackgroundWork(): void {
  getStoredToken()
    .then((token) => {
      if (token) {
        startDiscordBot(token);
      } else {
        logger.warn("No Discord bot token configured — set one via dashboard");
      }
    })
    .catch((err) => logger.error({ err }, "Failed to load bot token"))
    .finally(() => startBotWatchdog());

  startSessionCleanupLoop();
  startTreatyExpiryLoop();
  startRelationEventPruneLoop();
  startTurnLoop();
  startRegionControlHealthLoop();
  startProductionSpentHealthLoop();
  startWarEngineLoops();
  startWorldSchedulerLoops();
  startAiPregenWorker();
  // 備援供應商註冊（主 AI 呼叫失敗時自動改用後台設定的備援 API 重試一次）。
  bootstrapAiFallback();
}

async function bootstrap() {
  // Open the port FIRST so the deploy health-check passes immediately. During
  // an autoscale promote the previous revision keeps serving (running the
  // turn/war loops) and holds ACCESS SHARE locks on the hot game tables; the
  // idempotent startup DDL below (e.g. `ALTER TABLE …`) needs ACCESS EXCLUSIVE
  // and would otherwise block behind it indefinitely, so the new process never
  // opened its port and the promote timed out. Replit's Publish flow already
  // applies the production schema diff, so serving before these
  // (redundant-in-prod) migrations finish is safe.
  openPort();

  try {
    await runStartupMigrations();
  } catch (err) {
    if (process.env["NODE_ENV"] === "production") {
      // Deployed: schema is owned by Replit's Publish flow, not the app. The
      // server is already listening, so a failed/blocked migration must not
      // crash-loop it — log and keep serving against the Publish-applied schema.
      logger.error(
        { err },
        "Startup migrations failed in deployment; continuing to serve (schema managed by Publish)",
      );
    } else {
      // Dev/test: schema IS the app's responsibility here — fail loudly so the
      // operator fixes it rather than hitting later runtime "column does not
      // exist" errors from the game routes / turn engine.
      logger.fatal(
        { err },
        "Startup migrations/seed sync failed; refusing to start",
      );
      process.exit(1);
    }
  }

  startBackgroundWork();
}

void bootstrap();
