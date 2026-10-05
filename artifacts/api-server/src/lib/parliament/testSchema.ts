/**
 * 議會整合測試專用:在「全新空庫」上建齊所有依賴表(順序與正式啟動 index.ts 一致)。
 * 不使用 focus/testSchema 的 ensureFocusTestSchema,因為它在空庫上缺 mapRegionEraStats / mapCities 等步驟,
 * 會讓測試在乾淨資料庫上無法執行。這份清單與 mercenaryService.integration.test.ts 相同。
 */
const MIGS = [
  ["gameMigrations", "runGameMigrations"],
  ["mapRegions", "runMapRegionSync"],
  ["gameMigrations", "runRegionControlMigrations"],
  ["mapRegionEraStats", "runMapRegionEraStatsSync"],
  ["mapCities", "runMapCitySync"],
  ["mapV2Reset", "runMapV2RegionReset"],
  ["militaryMigrations", "runMilitaryMigrations"],
  ["weaponMigrations", "runWeaponMigrations"],
  ["diplomacyMigrations", "runDiplomacyMigrations"],
  ["resourceMigrations", "runResourceMigrations"],
  ["politicsMigrations", "runPoliticsMigrations"],
  ["cabinetMigrations", "runCabinetMigrations"],
  ["autopilotMigrations", "runAutopilotMigrations"],
  ["warMigrations", "runWarMigrations"],
  ["mercenaryMigrations", "runMercenaryMigrations"],
  ["economyMigrations", "runEconomyMigrations"],
  ["socialTechMigrations", "runSocialTechMigrations"],
  ["productionMigrations", "runProductionMigrations"],
  ["techTreeMigrations", "runTechTreeMigrations"],
  ["wallMigrations", "runWallMigrations"],
  ["worldSimMigrations", "runWorldSimMigrations"],
  ["gameNewsMigrations", "runGameNewsMigrations"],
  ["accountBanMigrations", "runAccountBanMigrations"],
  ["superEventMigrations", "runSuperEventMigrations"],
  ["gameBalanceMigrations", "runGameBalanceMigrations"],
  ["aiUsageMigrations", "runAiUsageMigrations"],
  ["aiPregenMigrations", "runAiPregenMigrations"],
  ["generalsMigrations", "runGeneralsMigrations"],
  ["parliamentMigrations", "runParliamentMigrations"],
  ["nationNameSanitizeMigration", "runNationNameSanitizeMigration"],
] as const;

export async function ensureParliamentTestSchema(): Promise<void> {
  for (const [f, fn] of MIGS) {
    await ((await import(`../${f}`)) as Record<string, () => Promise<void>>)[fn]!();
  }
}
