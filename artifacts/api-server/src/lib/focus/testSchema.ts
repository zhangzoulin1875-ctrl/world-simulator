import { runGameMigrations, runRegionControlMigrations } from "../gameMigrations";
import { runMapRegionSync } from "../mapRegions";
import { runMilitaryMigrations } from "../militaryMigrations";
import { runWeaponMigrations } from "../weaponMigrations";
import { runDiplomacyMigrations } from "../diplomacyMigrations";
import { runResourceMigrations } from "../resourceMigrations";
import { runPoliticsMigrations } from "../politicsMigrations";
import { runWarMigrations } from "../warMigrations";
import { runEconomyMigrations } from "../economyMigrations";
import { runWorldSimMigrations } from "../worldSimMigrations";
import { runParliamentMigrations } from "../parliamentMigrations";
import { runFocusMigrations } from "../focusMigrations";
import { runGameNewsMigrations } from "../gameNewsMigrations";
import { runAccountBanMigrations } from "../accountBanMigrations";
import { runSuperEventMigrations } from "../superEventMigrations";
import { runGameBalanceMigrations } from "../gameBalanceMigrations";
import { runCabinetMigrations } from "../cabinetMigrations";
import { runAutopilotMigrations } from "../autopilotMigrations";
import { runMercenaryMigrations } from "../mercenaryMigrations";
import { runSocialTechMigrations } from "../socialTechMigrations";
import { runProductionMigrations } from "../productionMigrations";
import { runTechTreeMigrations } from "../techTreeMigrations";
import { runWallMigrations } from "../wallMigrations";
import { runAiUsageMigrations } from "../aiUsageMigrations";
import { runAiPregenMigrations } from "../aiPregenMigrations";
import { runGeneralsMigrations } from "../generalsMigrations";

/**
 * 整合測試用:在乾淨資料庫上建出 player_nations 與國策相關表所需的 schema。
 * 順序取自 index.ts 的 runStartupMigrations(player_nations 的欄位分散在這些 migration 裡)。
 * 全部 idempotent,在已經建好的資料庫上重複執行無害。
 */
export async function ensureFocusTestSchema(): Promise<void> {
  await runGameMigrations();
  await runMapRegionSync();
  await runRegionControlMigrations();
  await runMilitaryMigrations();
  await runWeaponMigrations();
  await runDiplomacyMigrations();
  await runResourceMigrations();
  await runPoliticsMigrations();
  await runWarMigrations();
  await runEconomyMigrations();
  await runWorldSimMigrations();
  await runParliamentMigrations();
  await runFocusMigrations();
  // 以下不在國策的直接依賴內,但 world_game_state 等共用表的欄位由它們補齊(getCurrentEraSlug 等會讀)
  await runGameNewsMigrations();
  await runAccountBanMigrations();
  await runSuperEventMigrations();
  await runGameBalanceMigrations();
  await runCabinetMigrations();
  await runAutopilotMigrations();
  await runMercenaryMigrations();
  await runSocialTechMigrations();
  await runProductionMigrations();
  await runTechTreeMigrations();
  await runWallMigrations();
  await runAiUsageMigrations();
  await runAiPregenMigrations();
  await runGeneralsMigrations();
}
