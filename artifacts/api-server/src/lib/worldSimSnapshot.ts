import { asc, eq, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
  worldGameStateTable,
} from "@workspace/db";
import { ERAS, getEraIndex, DEFAULT_ERA_SLUG } from "./mapRegionEras";
import { GOVERNMENTS } from "./governments";
import type {
  GenerateWorldProposalInput,
  WorldSimNationSummary,
  WorldSimRegionSummary,
} from "./worldSimAi";

/**
 * Task #176 — 世界模擬「世界快照」建構（管理員隨選生成與回合自動模擬共用）。
 *
 * 讀取世界目前時代／年份、所有國家（分成可編輯的 NPC／無主與受保護的玩家）、
 * 各地區與其目前時代數據及剩餘可分配空間，組成 AI 生成所需的輸入（不含
 * instruction）。抽成獨立 lib 以便 route 與 turnEngine 掛勾共用同一份邏輯。
 *
 * **不 import turnEngine**（年份直接由 gameDate 前四碼解析），避免
 * turnEngine → worldSimTurn → worldSimSnapshot 的循環相依。
 */

/** 從 YYYY-MM-DD 取出年份（正整數；解析失敗回 0）。 */
function yearFromGameDate(gameDate: string | null | undefined): number {
  if (!gameDate) return 0;
  const y = Number.parseInt(gameDate.slice(0, 4), 10);
  return Number.isFinite(y) ? y : 0;
}

/**
 * 讀取世界快照，組成 AI 生成所需的輸入（不含 instruction）。
 * editableNations = NPC 或無主國家；protected = 玩家國家（僅供 AI 感知，絕不可指向）。
 * 每個地區的 freePercent = 100 − 目前所有掌控總和（含玩家），AI 只能填入這個空間。
 */
export async function buildWorldSimSnapshot(): Promise<
  Omit<GenerateWorldProposalInput, "instruction">
> {
  const [state] = await db
    .select({
      currentEra: worldGameStateTable.currentEra,
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);

  const eraSlug = state?.currentEra ?? DEFAULT_ERA_SLUG;
  const eraIndex = getEraIndex(eraSlug);
  const eraLabel = ERAS[eraIndex]?.label ?? eraSlug;
  const year = yearFromGameDate(state?.gameDate);

  const nations = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
      government: playerNationsTable.government,
      techEraMilitary: playerNationsTable.techEraMilitary,
      techEraSocial: playerNationsTable.techEraSocial,
      techEraProduction: playerNationsTable.techEraProduction,
      stability: playerNationsTable.stability,
      unrest: playerNationsTable.unrest,
    })
    .from(playerNationsTable)
    .orderBy(asc(playerNationsTable.createdAt));

  const controls = await db
    .select({
      regionId: regionControlsTable.regionId,
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable);

  const regions = await db
    .select({
      id: mapRegionsTable.id,
      name: mapRegionsTable.name,
      macroRegion: mapRegionsTable.macroRegion,
    })
    .from(mapRegionsTable)
    .orderBy(asc(mapRegionsTable.id));

  const eraStats = await db
    .select({
      regionId: mapRegionEraStatsTable.regionId,
      population: mapRegionEraStatsTable.population,
      productivity: mapRegionEraStatsTable.productivity,
      techPoints: mapRegionEraStatsTable.techPoints,
    })
    .from(mapRegionEraStatsTable)
    .where(eq(mapRegionEraStatsTable.era, eraSlug));

  // 每地區：各國掌控名稱清單、掌控總和。
  const regionNamesByNation = new Map<string, string[]>();
  const usedByRegion = new Map<number, number>();
  const regionNameById = new Map<number, string>();
  for (const r of regions) regionNameById.set(r.id, r.name);
  for (const c of controls) {
    usedByRegion.set(c.regionId, (usedByRegion.get(c.regionId) ?? 0) + c.percent);
    const list = regionNamesByNation.get(c.nationId) ?? [];
    const label = regionNameById.get(c.regionId) ?? `#${c.regionId}`;
    list.push(`${label}(${c.percent}%)`);
    regionNamesByNation.set(c.nationId, list);
  }

  const statsByRegion = new Map<
    number,
    { population: number; productivity: number; techPoints: number }
  >();
  for (const s of eraStats) statsByRegion.set(s.regionId, s);

  const editableNations: WorldSimNationSummary[] = [];
  const protectedNationNames: string[] = [];
  for (const n of nations) {
    // 玩家國家 = 有擁有者且非 NPC；其餘（NPC 或無主）皆可編輯。
    if (!n.isNpc && n.discordUserId !== null) {
      protectedNationNames.push(n.name ?? "(未命名玩家國家)");
      continue;
    }
    editableNations.push({
      id: n.id,
      name: n.name,
      isNpc: n.isNpc,
      government: n.government,
      techEraMilitary: n.techEraMilitary,
      techEraSocial: n.techEraSocial,
      techEraProduction: n.techEraProduction,
      stability: n.stability,
      unrest: n.unrest,
      regionNames: regionNamesByNation.get(n.id) ?? [],
    });
  }

  const regionSummaries: WorldSimRegionSummary[] = regions.map((r) => {
    const stats = statsByRegion.get(r.id);
    return {
      id: r.id,
      name: r.name,
      macroRegion: r.macroRegion,
      freePercent: Math.max(0, 100 - (usedByRegion.get(r.id) ?? 0)),
      population: stats?.population,
      production: stats?.productivity,
      techPoints: stats?.techPoints,
    };
  });

  // 可用時代 slug 只到目前世代（勿超前）；套用層另有 maxTechEraSlug 硬夾。
  const eraSlugs = ERAS.slice(0, eraIndex + 1).map((e) => e.slug);

  return {
    year,
    eraSlug,
    eraLabel,
    editableNations,
    protectedNationNames,
    regions: regionSummaries,
    governments: GOVERNMENTS.map((g) => g.label),
    eraSlugs,
  };
}
