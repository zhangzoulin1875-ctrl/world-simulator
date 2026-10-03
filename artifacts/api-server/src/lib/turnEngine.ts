import { and, eq, isNull, lt, sql, type AnyColumn } from "drizzle-orm";
import {
  db,
  diplomacyAiChatQuotasTable,
  diplomacyWarsTable,
  militaryUnitTemplatesTable,
  nationFinanceLedgerTable,
  playerArmiesTable,
  playerNationsTable,
  recruitProductionSpendsTable,
  regionBuildingsTable,
  worldGameStateTable,
} from "@workspace/db";
import { buildingOutput, buildingUpkeep } from "./regionBuildings";
import { UNIT_DESIGN_CHARGE_CAP } from "./military";
import { logger } from "./logger";
import {
  noteGameActivity,
  registerSchedulerWake,
  skipIfNotDue,
  toMs,
} from "./schedulerWake";
import { localDateString, localSlotInstant } from "./time";
import { ERAS, getEraIndex } from "./mapRegionEras";
import { computeAdjustedNationStats } from "./nationStats";
import { applyRegionPopulationDelta } from "./regionPopulation";
import {
  populationGrowthAmount,
  scalePopulationGrowth,
  warWearinessRecovery,
} from "./politics";
import { computeTurnFinance, effectiveTaxEfficiencyPct } from "./economy";
import { upkeepShortfallMilitaryPenalty } from "./militaryPolitics";
import {
  runPoliticsSettlement,
  type PoliticsSettlementSummary,
} from "./politicsSettlement";
import {
  runFinanceSettlement,
  type FinanceSettlementSummary,
} from "./financeSettlement";
import { aggregateSocialEffectsByUser } from "./socialTechData";
import {
  loadBuildingUpkeepByUser,
  loadProductionModifiersByUser,
  tickPopulationBuffs,
  tickSatisfactionBuffs,
} from "./productionTechData";
import {
  runTechTreeResearchTurn,
  type NationResearchEntry,
} from "./techTreeTurn";
import { runNpcMilitaryTurn } from "./npcMilitary";
import { runNpcExtinctionCheck } from "./npcExtinction";
import { endCampaignsForLocallyEliminatedNpcs } from "./warEngine/npcLocalCollapse";
import { recoveryTick } from "./warEngine/recovery";
import { recordNationMilitarySnapshots } from "./militarySnapshots";
import {
  notifyEraChanged,
  notifyTreasuryEmpty,
  notifyFamine,
  notifyTurnAdvanced,
  notifyUpkeepShortfall,
} from "./gameNotify";
import { computeNationFoodReport } from "./foodData";
import {
  applyModifierSource,
  getGameBalanceSettings,
} from "./gameBalance";
import {
  FOOD_POLICY_SATISFACTION_COST_PER_TURN,
  faminePopulationLoss,
  populationDropPenalty,
} from "./food";
import { runTurnNewsGeneration } from "./gameNews";
import { pruneAiUsageLogs } from "./gameAi";
import {
  runCustomTreatySettlement,
  type CustomTreatySettlementSummary,
} from "./customTreatySettlement";
import { runNpcCustomTreatyAnnulments } from "./npcCustomTreatyAnnul";
import { loadTreatyProductionNetByNation } from "./treatyProductionFlows";
import {
  runVassalTributeSettlement,
  type VassalTributeSummary,
} from "./vassalTribute";
import { renewCabinetForEraChange, runCabinetTurn } from "./cabinet";
import { runSuperEventSettlement } from "./superEventSettlement";
import { invalidateGlobalAveragePopulationCache } from "./researchCost";

/** 財政流水保留天數：回合結算時清除更舊的顯示紀錄。 */
export const FINANCE_LEDGER_RETENTION_DAYS = 30;

const SCHEDULE_TZ = process.env["NEWS_SCHEDULE_TZ"] ?? "Asia/Taipei";

/** 年份上下限（避免 BC 與五位數年份破壞 YYYY-MM-DD 格式）。 */
export const MIN_GAME_YEAR = 1;
export const MAX_GAME_YEAR = 9999;

/**
 * 各時代的起始年（遊戲年）。時代 = 「起始年 ≤ 當前年份」的最後一個時代。
 * 順序必須與 mapRegionEras.ts 的 ERAS 完全一致（單元測試驗證）。
 */
export const ERA_START_YEARS: readonly { slug: string; startYear: number }[] = [
  { slug: "classical", startYear: 1 },
  { slug: "roman", startYear: 200 },
  { slug: "early_medieval", startYear: 600 },
  { slug: "high_medieval", startYear: 950 },
  { slug: "renaissance", startYear: 1350 },
  { slug: "discovery", startYear: 1500 },
  { slug: "scientific", startYear: 1650 },
  { slug: "enlightenment", startYear: 1700 },
  { slug: "industrial", startYear: 1780 },
  { slug: "ww1", startYear: 1900 },
  { slug: "ww2", startYear: 1935 },
  { slug: "cold_war", startYear: 1950 },
  { slug: "modern", startYear: 1990 },
  { slug: "future", startYear: 2050 },
];

/** 依年份推導時代 slug（起始年 ≤ year 的最後一個；小於最小起始年回第一個）。 */
export function eraForYear(year: number): string {
  let result = ERA_START_YEARS[0]!.slug;
  for (const e of ERA_START_YEARS) {
    if (e.startYear <= year) result = e.slug;
    else break;
  }
  return result;
}

/** 從 YYYY-MM-DD 取出年份（正整數）。 */
export function yearOfGameDate(gameDate: string): number {
  return Number.parseInt(gameDate.slice(0, 4), 10);
}

/**
 * 遊戲日期加 N 年（保留月日；上限 9999 年；2/29 遇非閏年退回 2/28）。
 */
export function addYearsToGameDate(gameDate: string, years: number): string {
  const year = yearOfGameDate(gameDate);
  const newYear = Math.min(MAX_GAME_YEAR, Math.max(MIN_GAME_YEAR, year + years));
  return buildGameDate(newYear, gameDate.slice(4));
}

/** 用年份 + 原本的月日組出新日期字串（處理 2/29 與補零）。 */
export function buildGameDate(year: number, monthDaySuffix: string): string {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const suffix =
    monthDaySuffix === "-02-29" && !isLeap ? "-02-28" : monthDaySuffix;
  return `${String(year).padStart(4, "0")}${suffix}`;
}

/**
 * 維護費不足判定（純函式）：以「付維護費前的可用金錢」（= 回合開始金錢 +
 * 稅收 − 預算花費）為額度，維護費超過額度（金錢被扣到 0 仍有缺口）且國家
 * 有主（discordUserId 非 null）才通知。缺口剛好打平（= 0）不通知。
 */
export function evaluateUpkeepShortfall(params: {
  discordUserId: string | null;
  availableBeforeUpkeep: number;
  upkeepCharged: number;
}): { shouldNotify: boolean; shortfall: number } {
  const shortfall = params.upkeepCharged - params.availableBeforeUpkeep;
  return {
    shortfall,
    shouldNotify: params.discordUserId !== null && shortfall > 0,
  };
}

/**
 * 國庫危機懲罰（每回合）：赤字（維護費把金錢扣到 0 仍有缺口）比單純歸零
 * 更重。數值為整數增減，套用時以 SQL clamp 在 0–100（鐵則：存量欄位整數）。
 * 註：軍方滿意度／服從度欄位上線後（軍方系統），赤字懲罰應一併納入軍方數值。
 */
export const TREASURY_CRISIS_PENALTY = {
  /** 赤字：維護費付不出（缺口 > 0）。 */
  deficit: { satisfaction: -10, stability: -8, unrest: 8 },
  /** 歸零：回合結算後國庫剛好見底（無缺口）。 */
  empty: { satisfaction: -5, stability: -4, unrest: 4 },
} as const;

export type TreasuryPenaltyKind = keyof typeof TREASURY_CRISIS_PENALTY;

/**
 * 國庫危機判定（純函式）：只懲罰有主國家（NPC 經濟未完整模擬，且無主國家
 * 金錢常為 0，不應被動流失民心）。赤字（shortfall > 0）優先於歸零
 * （回合結算後金錢 = 0）；國庫有結餘 → 無懲罰。
 */
export function evaluateTreasuryPenalty(params: {
  discordUserId: string | null;
  newMoney: number;
  shortfall: number;
}): TreasuryPenaltyKind | null {
  if (params.discordUserId === null) return null;
  if (params.shortfall > 0) return "deficit";
  if (params.newMoney <= 0) return "empty";
  return null;
}

/** 以 SQL 現值套用增減並 clamp 0–100（race-safe，不讀值後回寫）。 */
function clampedStatDelta(column: AnyColumn, delta: number) {
  return sql`LEAST(100, GREATEST(0, ${column} + ${delta}))`;
}

// ── 每日多時段回合排程（Task #289） ──────────────────────────────────────

/** 單一自動回合時刻（NEWS_SCHEDULE_TZ 當地時間）。 */
export interface TurnTime {
  hour: number;
  minute: number;
}

/** 每日更新次數上限。 */
export const MAX_TURN_TIMES = 24;

/** 預設時刻清單（單一 18:00），供回填／防禦性回退使用。 */
export const DEFAULT_TURN_TIMES: readonly TurnTime[] = [{ hour: 18, minute: 0 }];

function minuteOfDay(t: TurnTime): number {
  return t.hour * 60 + t.minute;
}

/**
 * 純函式：驗證並正規化管理員送來的時刻清單。數量 1–24，每筆 時 0–23／分
 * 0–59，最後依時間排序去重。任一不合法回傳 zh-TW 錯誤訊息。
 */
export function parseTurnTimes(
  raw: unknown,
): { ok: true; times: TurnTime[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "時刻清單必須是陣列" };
  }
  if (raw.length === 0) {
    return { ok: false, error: "至少需要一個更新時刻" };
  }
  if (raw.length > MAX_TURN_TIMES) {
    return { ok: false, error: `每日更新次數最多 ${MAX_TURN_TIMES} 次` };
  }
  const parsed: TurnTime[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: "時刻格式錯誤" };
    }
    const hour = (item as Record<string, unknown>)["hour"];
    const minute = (item as Record<string, unknown>)["minute"];
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { ok: false, error: "回合時間（時）必須是 0–23 的整數" };
    }
    if (
      typeof minute !== "number" ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      return { ok: false, error: "回合時間（分）必須是 0–59 的整數" };
    }
    parsed.push({ hour, minute });
  }
  const seen = new Set<number>();
  const times: TurnTime[] = [];
  for (const t of [...parsed].sort((a, b) => minuteOfDay(a) - minuteOfDay(b))) {
    const key = minuteOfDay(t);
    if (seen.has(key)) continue;
    seen.add(key);
    times.push(t);
  }
  return { ok: true, times };
}

/**
 * 純函式：把資料庫讀到的時刻清單防禦性正規化（過濾非法值、排序去重）。
 * 空／全部非法時回退為預設單一 18:00，確保排程永遠有可用時刻。
 */
export function normalizeTurnTimes(raw: unknown): TurnTime[] {
  const parsed = parseTurnTimes(raw);
  if (parsed.ok) return parsed.times;
  if (Array.isArray(raw)) {
    const salvaged = raw.filter(
      (item): item is TurnTime =>
        typeof item === "object" &&
        item !== null &&
        Number.isInteger((item as TurnTime).hour) &&
        Number.isInteger((item as TurnTime).minute) &&
        (item as TurnTime).hour >= 0 &&
        (item as TurnTime).hour <= 23 &&
        (item as TurnTime).minute >= 0 &&
        (item as TurnTime).minute <= 59,
    );
    const reparsed = parseTurnTimes(salvaged);
    if (reparsed.ok) return reparsed.times;
  }
  return DEFAULT_TURN_TIMES.map((t) => ({ ...t }));
}

/**
 * 純函式：由今日時刻清單、目前時間、上次實際執行時刻，算出「已到期且尚未執行」
 * 中最早的一個時段（回傳其真實世界 instant）；沒有則回 null。每個 tick 只認領
 * 一個時段（逐一補跑），單日自然上限 = 時段數（last_turn_at 單調前進）。
 */
export function nextDueSlot(
  times: readonly TurnTime[],
  now: Date,
  lastTurnAt: Date | null,
  localDate: string,
): Date | null {
  const nowMs = now.getTime();
  const lastMs = lastTurnAt ? lastTurnAt.getTime() : null;
  let due: Date | null = null;
  for (const t of times) {
    const inst = localSlotInstant(localDate, t.hour, t.minute);
    const instMs = inst.getTime();
    if (instMs <= nowMs && (lastMs === null || instMs > lastMs)) {
      if (due === null || instMs < due.getTime()) due = inst;
    }
  }
  return due;
}

/**
 * 純函式：計算「今日已執行次數」與「下一個時刻」，供管理端 UI 顯示。
 * 已執行 = last_turn_at 為今日且 ≥ 該時刻 instant 的時段數（時段依時間排序，
 * last_turn_at 為門檻 → 已執行的必為最前面連續數個）。下一時刻 = 尚未執行的
 * 第一個時段；若今日全部執行完，回明日的第一個時段。
 */
export function computeTurnProgress(
  times: readonly TurnTime[],
  now: Date,
  lastTurnAt: Date | null,
  localDate: string,
): { runsToday: number; totalToday: number; nextTime: TurnTime | null } {
  const totalToday = times.length;
  if (totalToday === 0) {
    return { runsToday: 0, totalToday: 0, nextTime: null };
  }
  const lastAtIsToday =
    lastTurnAt !== null && localDateString(lastTurnAt) === localDate;
  let runsToday = 0;
  for (const t of times) {
    const inst = localSlotInstant(localDate, t.hour, t.minute);
    if (lastAtIsToday && lastTurnAt!.getTime() >= inst.getTime()) runsToday++;
  }
  const nextTime =
    runsToday < totalToday ? times[runsToday]! : times[0]!;
  return { runsToday, totalToday, nextTime };
}

export interface TurnUpdateSummary {
  ran: boolean;
  reason?: "already_ran" | "in_flight";
  dateLabel: string;
  year?: number;
  gameDate?: string;
  era?: string;
  eraLabel?: string;
  eraChanged?: boolean;
  nations?: {
    total: number;
    accrued: number;
    techAdded: number;
    taxIncome: number;
    upkeepCharged: number;
    populationAdded: number;
    treasuryPenalties: number;
    failures: number;
  };
  ledgerPruned?: number;
  // Task #469 — 回合制研發結算摘要。
  techTree?: {
    nations: number;
    pointsApplied: number;
    /** Task #524 — 本回合被研發吸收的庫存科技點數。 */
    stockConsumed: number;
    completed: number;
    erasAdvanced: number;
    failures: number;
  };
  finance?: {
    ok: boolean;
    error?: string;
    summary?: FinanceSettlementSummary;
  };
  politics?: {
    ok: boolean;
    error?: string;
    summary?: PoliticsSettlementSummary;
  };
  customTreaties?: {
    ok: boolean;
    error?: string;
    summary?: CustomTreatySettlementSummary;
  };
  vassalTribute?: {
    ok: boolean;
    error?: string;
    summary?: VassalTributeSummary;
  };
  /** 本回合被自動除名（領土歸零）的 NPC 國家數。 */
  npcExtinction?: { deletedCount: number };
  /** 本回合因 NPC 一方在戰役地區已無領土而自動結束的戰役數。 */
  npcLocalCollapse?: { endedCount: number };
}

// 同步佔鎖（先佔再 await，避免 TOCTOU）：同程序內同時只跑一個回合。
let turnInFlight = false;

/**
 * 執行一次回合更新：
 * 1. 以單一條件 UPDATE「認領今日回合 + 推進年份 + 依年份更新時代」——
 *    last_turn_date 持久化在 world_game_state，重啟不會重跑、也不怕
 *    自動排程與管理員手動觸發同日重複執行。
 *    `force: true`（管理員手動觸發）跳過「今日已執行」檢查，同一天可
 *    多次執行；程序內仍由 turnInFlight 同步鎖防止並發重複。
 * 2. 對每個國家累加資源：科技點數 += 調整後每回合科技；
 *    金錢 += 生產力收入 − 軍隊維護費（下限 0）。資源計算使用
 *    「數據時代」stats_era（時代自然變遷時同步為新時代；管理員手動改
 *    時代未勾同步時保持不變）。
 *    不動 population_spent（軍隊招募佔用的人口）。
 * 3. 執行內政結算（AI 判定政策、條目衰減、動亂/穩定 tick、隨機事件、政變）。
 *    失敗只記 log，不影響已完成的資源結算。
 */
export async function runTurnUpdate(
  now: Date = new Date(),
  opts: { force?: boolean; claimInstant?: Date } = {},
): Promise<TurnUpdateSummary> {
  const dateLabel = localDateString(now);
  if (turnInFlight) {
    return { ran: false, reason: "in_flight", dateLabel };
  }
  turnInFlight = true;
  try {
    // claimInstant = 這次要認領的「時段真實時刻」；手動 force 以 now 為準。
    const claimInstant = opts.claimInstant ?? now;
    return await doRunTurn(now, dateLabel, opts.force === true, claimInstant);
  } finally {
    turnInFlight = false;
  }
}

async function doRunTurn(
  now: Date,
  dateLabel: string,
  force: boolean,
  claimInstant: Date,
): Promise<TurnUpdateSummary> {
  const [state] = await db
    .select({
      currentEra: worldGameStateTable.currentEra,
      statsEra: worldGameStateTable.statsEra,
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      yearsPerTurn: worldGameStateTable.yearsPerTurn,
      moneyIncomePct: worldGameStateTable.moneyIncomePct,
      populationGrowthMultiplierPct:
        worldGameStateTable.populationGrowthMultiplierPct,
      productionMultiplierPct: worldGameStateTable.productionMultiplierPct,
      techMultiplierPct: worldGameStateTable.techMultiplierPct,
      lastTurnDate: worldGameStateTable.lastTurnDate,
      lastTurnAt: worldGameStateTable.lastTurnAt,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);

  if (!state) {
    logger.error("turn engine: world_game_state row missing, skipping turn");
    return { ran: false, reason: "already_ran", dateLabel };
  }
  // 前置快取檢查（最終仍由下方原子 UPDATE 認領防重）：非 force 時，若上次執行
  // 時刻已 ≥ 這次要認領的時段，代表該時段已跑過，直接略過。
  if (
    !force &&
    state.lastTurnAt !== null &&
    state.lastTurnAt.getTime() >= claimInstant.getTime()
  ) {
    return { ran: false, reason: "already_ran", dateLabel };
  }

  const newGameDate = addYearsToGameDate(state.gameDate, state.yearsPerTurn);
  const newYear = yearOfGameDate(newGameDate);
  const newEra = eraForYear(newYear);
  const eraChanged = newEra !== state.currentEra;
  // 資源計算用的「數據時代」：時代自然變遷 → 同步為新時代；否則沿用
  // 既有 stats_era（null = 尚未回填，用 current_era）。
  const statsEra = eraChanged ? newEra : (state.statsEra ?? state.currentEra);

  // 認領這個時段（多時段防重）：以 last_turn_at 為準——只有在「上次執行時刻早於
  // 本時段」時才會成功（兩個並發呼叫只有一個會贏）。同時把 last_turn_date 寫成
  // 該時段當地日期供顯示。force（管理員手動）不受限制，仍以 now 前進 last_turn_at。
  const claimIso = claimInstant.toISOString();
  const claimed = await db
    .update(worldGameStateTable)
    .set({
      lastTurnDate: localDateString(claimInstant),
      lastTurnAt: claimInstant,
      gameDate: newGameDate,
      currentEra: newEra,
      ...(eraChanged ? { statsEra: newEra } : {}),
      updatedAt: sql`NOW()`,
    })
    .where(
      force
        ? eq(worldGameStateTable.id, 1)
        : and(
            eq(worldGameStateTable.id, 1),
            sql`(${worldGameStateTable.lastTurnAt} IS NULL OR ${worldGameStateTable.lastTurnAt} < ${claimIso})`,
          ),
    )
    .returning({ id: worldGameStateTable.id });
  if (claimed.length === 0) {
    return { ran: false, reason: "already_ran", dateLabel };
  }

  logger.info(
    { dateLabel, newGameDate, newEra, eraChanged, yearsPerTurn: state.yearsPerTurn },
    "turn engine: turn claimed, advancing world",
  );

  // Task #568 — 招募「立即性花費」是純流量：新回合認領成功後，刪除上回合
  // （含以前）的花費列（created_at <= 認領時刻）。讀取端另有
  // created_at > last_turn_at 的當回合述詞兜底（刪除失敗也不會多扣）。
  try {
    await db
      .delete(recruitProductionSpendsTable)
      .where(sql`${recruitProductionSpendsTable.createdAt} <= ${claimIso}`);
  } catch (err) {
    logger.error({ err }, "turn engine: expired recruit spend cleanup failed");
  }

  const summary: TurnUpdateSummary = {
    ran: true,
    dateLabel,
    year: newYear,
    gameDate: newGameDate,
    era: newEra,
    eraLabel: ERAS[getEraIndex(newEra)]!.label,
    eraChanged,
  };

  // 各玩家的軍隊維護費（Σ 數量 × 每單位維護費）。
  const upkeepRows = await db
    .select({
      discordUserId: playerArmiesTable.discordUserId,
      upkeep: sql<string>`COALESCE(SUM(${playerArmiesTable.quantity} * ${militaryUnitTemplatesTable.upkeepPerUnit}), 0)`,
    })
    .from(playerArmiesTable)
    .innerJoin(
      militaryUnitTemplatesTable,
      eq(militaryUnitTemplatesTable.id, playerArmiesTable.templateId),
    )
    .groupBy(playerArmiesTable.discordUserId);
  const upkeepByUser = new Map(
    upkeepRows.map((r) => [r.discordUserId, Number(r.upkeep)]),
  );

  // Task #406 — 各國地區資源建築：每回合木材/礦石產出與金錢維護費
  // （產出 50×level、維護 100×level；Σ level 各國彙總）。
  const buildingRows = await db
    .select({
      nationId: regionBuildingsTable.nationId,
      buildingType: regionBuildingsTable.buildingType,
      totalLevel: sql<string>`COALESCE(SUM(${regionBuildingsTable.level}), 0)`,
    })
    .from(regionBuildingsTable)
    .groupBy(regionBuildingsTable.nationId, regionBuildingsTable.buildingType);
  const resourceByNation = new Map<
    string,
    { wood: number; ore: number; upkeep: number }
  >();
  for (const row of buildingRows) {
    const entry = resourceByNation.get(row.nationId) ?? {
      wood: 0,
      ore: 0,
      upkeep: 0,
    };
    const levels = Number(row.totalLevel);
    if (row.buildingType === "lumber_mill") {
      entry.wood += buildingOutput(levels);
    } else if (row.buildingType === "mine") {
      entry.ore += buildingOutput(levels);
    }
    entry.upkeep += buildingUpkeep(levels);
    resourceByNation.set(row.nationId, entry);
  }

  const nations = await db.select().from(playerNationsTable);

  // Task #126 — 各玩家已研發社會科技的彙總效果（含收稅效率加成）。
  const socialByUser = await aggregateSocialEffectsByUser();

  // Task #149 — 各玩家生產科技/建築的合併修正值與建築每回合維護費
  // （已套用風車技術等維護費減免）。批次預載避免每國一次查詢。
  // 條約生產力輸送（純流量）：批次預載各國淨流量，傳入
  // computeAdjustedNationStats 避免每國一次查詢。
  const [productionModsByUser, buildingUpkeepByUser, treatyProdNetByNation] =
    await Promise.all([
      loadProductionModifiersByUser(),
      loadBuildingUpkeepByUser(),
      loadTreatyProductionNetByNation(now),
    ]);

  // 時代變遷：通知所有有主國家（回合認領 UPDATE 保證同一回合只跑一次）。
  if (eraChanged) {
    for (const nation of nations) {
      if (nation.discordUserId) {
        notifyEraChanged({
          discordUserId: nation.discordUserId,
          eraLabel: summary.eraLabel!,
        });
      }
    }
    // Task #242 — 時代更替：全內閣大臣卸任、清空候選人並通知玩家重新任命。
    // 獨立 try/catch，失敗不阻斷回合。
    try {
      await renewCabinetForEraChange(summary.eraLabel!);
    } catch (err) {
      logger.error({ err }, "turn engine: cabinet era renewal failed");
    }
  }

  let accrued = 0;
  // Task #469/#481 — 本回合各國科研產出（含 NPC／無主國家），供回合制研發結算。
  const techGainEntries: NationResearchEntry[] = [];
  let taxIncomeTotal = 0;
  // 附庸貢金結算的基數：本回合各國稅收（nation id → 稅收）。
  const taxIncomeByNationId = new Map<string, number>();
  let upkeepChargedTotal = 0;
  let populationAdded = 0;
  let treasuryPenalties = 0;
  let failures = 0;
  // Task #402 — 本回合欠餉（維護費缺口且套用了軍方滿意度懲罰）的國家 id；
  // 傳入政治結算以暫停該國軍方和平回升。
  const upkeepShortfallNationIds = new Set<string>();

  // Task #451 — 修正來源閘門設定（treasuryCrisis）：本回合共用一份快照。
  const balanceSettings = await getGameBalanceSettings();

  // 厭戰度每回合回復：先查出所有仍有進行中戰爭（endedAt IS NULL）的國家 id。
  // 交戰中國家套 wartime 回復（預設 0），其餘國家套 peacetime 回復 → 修正
  // 「停戰／戰爭結束後厭戰度永不下降」。停戰接受會設 endedAt，故停戰後即歸類
  // 為和平；殘留的孤兒 endedAt=NULL 戰爭列（見 replit.md 鐵則）會讓該國停在
  // wartime 回復，屬已知孤兒列問題的既有守門範圍，此處不另處理。
  const activeWarNationIds = new Set<string>();
  {
    const activeWarRows = await db
      .select({
        a: diplomacyWarsTable.nationAId,
        b: diplomacyWarsTable.nationBId,
      })
      .from(diplomacyWarsTable)
      .where(isNull(diplomacyWarsTable.endedAt));
    for (const row of activeWarRows) {
      if (row.a) activeWarNationIds.add(row.a);
      if (row.b) activeWarNationIds.add(row.b);
    }
  }

  for (const nation of nations) {
    try {
      const productionMods = nation.discordUserId
        ? (productionModsByUser.get(nation.discordUserId) ?? {
            productionBonusPct: 0,
            techPointsBonusPct: 0,
            populationGrowthBonusPct: 0,
          })
        : {
            productionBonusPct: 0,
            techPointsBonusPct: 0,
            populationGrowthBonusPct: 0,
          };
      // 傳入倍率 100 以取得「未縮放的基礎有效增長率」；本回合實際套用的增長量
      // 於下方再用全域倍率縮放（scalePopulationGrowth），避免重複縮放並省去每國
      // 一次 world_game_state 查詢。
      const stats = await computeAdjustedNationStats(
        nation,
        statsEra,
        productionMods,
        100,
        // 回合引擎不消費滿意度數值，傳入空物件停用每國一次的滿意度 buff 載入查詢；
        // 滿意度 buff 由政治結算（settleAllNations 批次載入）套用於暴動度 tick。
        {},
        treatyProdNetByNation.get(nation.id) ?? 0,
        // 全域生產力/科技基礎倍率：顯式傳入避免每國一次 world_game_state 查詢。
        {
          productionPct: state.productionMultiplierPct,
          techPct: state.techMultiplierPct,
        },
      );
      // 軍隊維護費 + 建築每回合維護費（已含風車技術等減免）。
      const buildingUpkeep = nation.discordUserId
        ? (buildingUpkeepByUser.get(nation.discordUserId) ?? 0)
        : 0;
      // Task #406 — 地區資源建築的每回合產出與金錢維護費。
      const regionRes = resourceByNation.get(nation.id) ?? {
        wood: 0,
        ore: 0,
        upkeep: 0,
      };
      const upkeep =
        (nation.discordUserId
          ? (upkeepByUser.get(nation.discordUserId) ?? 0)
          : 0) +
        buildingUpkeep +
        regionRes.upkeep;
      // 收入完全來自稅收（生產力不再產生金錢）。稅收效率 = 時代基礎 + 國家加成
      // ＋ 社會科技加成（Task #126）。
      const socialTaxBonus = nation.discordUserId
        ? (socialByUser.get(nation.discordUserId)?.taxEfficiencyBonusPct ?? 0)
        : 0;
      const taxEfficiencyPct = effectiveTaxEfficiencyPct(
        statsEra,
        nation.taxEfficiencyBonus + socialTaxBonus,
      );
      const finance = computeTurnFinance({
        money: nation.money,
        population: stats.population,
        taxRatePct: nation.taxRatePct,
        taxEfficiencyPct,
        upkeep,
      });
      // Task #548 — 整數口徑統一：回合科研收入 = round(techPerTurn)，與總覽
      // 路由 techGainPerTurn 相同；自產科研點不入庫（tech_points 只來自
      // 條約/送禮/admin），直接依分配比例灌入研發（見 runTechTreeResearchTurn）。
      const techGain = Math.max(0, Math.round(stats.techPerTurn));
      // money = max(0, money + surplus)；surplus 與現有金錢無關（稅收 −
      // 維護費），故用 SQL 現值加法即為 race-safe。
      const moneyDelta = finance.surplus;
      // 人口增長：以「目前總人口」×有效增長率計算本回合變化量（可正可負），
      // Task #322 起改為依各掌控地區的目前實際人口權重分配到 region_controls
      // 的 population_bonus（每地區下限 0，隨領土移動）。
      const populationGrowth = scalePopulationGrowth(
        populationGrowthAmount(stats.population, stats.populationGrowthRatePct),
        state.populationGrowthMultiplierPct,
      );
      // 維護費扣款異常：付維護費前的可用金錢（金錢 + 稅收）不足以支付
      // 維護費，金錢被扣到 0 仍有缺口 → 通知。於 UPDATE 前判定，讓國庫
      // 危機懲罰與金錢更新在同一條 UPDATE 內套用。
      const { shouldNotify, shortfall } = evaluateUpkeepShortfall({
        discordUserId: nation.discordUserId,
        availableBeforeUpkeep: nation.money + finance.taxIncome,
        upkeepCharged: finance.upkeepCharged,
      });
      // 國庫歸零／赤字 → 四階級滿意度與穩定度大減、暴動度上升（只懲罰
      // 有主國家）。軍方滿意度/服從度欄位上線後應一併納入（見常數註解）。
      const treasuryPenaltyKind = evaluateTreasuryPenalty({
        discordUserId: nation.discordUserId,
        newMoney: finance.newMoney,
        shortfall,
      });
      // Task #451 — treasuryCrisis 修正來源閘門：停用 → 不罰；啟用 → 各
      // delta 夾在管理員設定的 [minDelta, maxDelta]（只在套用點夾限）。
      const rawTreasuryPenalty = treasuryPenaltyKind
        ? TREASURY_CRISIS_PENALTY[treasuryPenaltyKind]
        : null;
      const treasuryPenalty =
        rawTreasuryPenalty &&
        balanceSettings.modifierSources.treasuryCrisis.enabled
          ? {
              satisfaction: applyModifierSource(
                "treasuryCrisis",
                rawTreasuryPenalty.satisfaction,
                balanceSettings,
              ),
              stability: applyModifierSource(
                "treasuryCrisis",
                rawTreasuryPenalty.stability,
                balanceSettings,
              ),
              unrest: applyModifierSource(
                "treasuryCrisis",
                rawTreasuryPenalty.unrest,
                balanceSettings,
              ),
            }
          : null;
      // 厭戰度每回合回復：交戰中 → wartime；其餘 → peacetime（見迴圈前註解）。
      // 以 clampedStatDelta（LEAST(100, GREATEST(0, …))）race-safe 套用負增量，
      // 適用所有國家（含 NPC／無主，皆有厭戰度且供 warWearinessAttackModifier）。
      const wearinessRecovery = warWearinessRecovery(
        activeWarNationIds.has(nation.id),
        balanceSettings.war,
      );
      // Task #626 — 厭戰度政策 delta：來自 computeAdjustedNationStats（已套
      // warWearinessModifierEnabled 開關）。
      // 兩步驟循序套用：① 先回復（GREATEST(0, current - recovery)，floor ≥0）
      //                  ② 再套政策 delta（clamp 0–100）。
      // 不可合併為單一 delta：回復「過度回收」到 0 後，負政策 delta（增加厭戰）
      // 仍應從 0 開始加，而非被回復量抵消歸零。
      const wearinessPolicyDelta = stats.warWearinessPolicyDelta;
      await db
        .update(playerNationsTable)
        .set({
          money: sql`GREATEST(0, ${playerNationsTable.money} + ${moneyDelta})`,
          warWeariness: sql`LEAST(100, GREATEST(0, GREATEST(0, ${playerNationsTable.warWeariness} - ${wearinessRecovery}) - ${wearinessPolicyDelta}))`,
          // Task #406 — 建築資源產出入庫（生產力維護費自 Task #479 起
          // 不再持久化扣 productionBonus，改為可用量計算層流量扣除）。
          wood: sql`${playerNationsTable.wood} + ${regionRes.wood}`,
          ore: sql`${playerNationsTable.ore} + ${regionRes.ore}`,
          // Task #510 — 兵種設計次數每回合 +1，封頂 5（所有國家一致，含
          // 無主/NPC；NPC 設計流程本就不消耗，僅為簡化統一處理）。
          unitDesignCharges: sql`LEAST(${UNIT_DESIGN_CHARGE_CAP}, ${playerNationsTable.unitDesignCharges} + 1)`,
          // Task #584 — 政變後果倒數：政策封鎖與士氣懲罰回合數每回合 −1，夾 ≥0。
          coupPolicyLockTurns: sql`GREATEST(0, ${playerNationsTable.coupPolicyLockTurns} - 1)`,
          coupMoralePenaltyTurns: sql`GREATEST(0, ${playerNationsTable.coupMoralePenaltyTurns} - 1)`,
          ...(treasuryPenalty
            ? {
                satisfactionFarmers: clampedStatDelta(
                  playerNationsTable.satisfactionFarmers,
                  treasuryPenalty.satisfaction,
                ),
                satisfactionWorkers: clampedStatDelta(
                  playerNationsTable.satisfactionWorkers,
                  treasuryPenalty.satisfaction,
                ),
                satisfactionNobles: clampedStatDelta(
                  playerNationsTable.satisfactionNobles,
                  treasuryPenalty.satisfaction,
                ),
                satisfactionClergy: clampedStatDelta(
                  playerNationsTable.satisfactionClergy,
                  treasuryPenalty.satisfaction,
                ),
                stability: clampedStatDelta(
                  playerNationsTable.stability,
                  treasuryPenalty.stability,
                ),
                unrest: clampedStatDelta(
                  playerNationsTable.unrest,
                  treasuryPenalty.unrest,
                ),
              }
            : {}),
          updatedAt: sql`NOW()`,
        })
        .where(eq(playerNationsTable.id, nation.id));
      const appliedGrowth = await applyRegionPopulationDelta(
        db,
        nation.id,
        statsEra,
        populationGrowth,
      );
      // Task #382 — 糧食結算（非累積）：產出 < 消耗 → 飢荒，本回合人口 −20%
      // （與顯示路由同一套 computeNationFoodReport 口徑）。
      // Task #443 — 連續饑荒緩衝：以「本回合之前」的連續饑荒回合數計算
      // 遞減扣幅＋生還者保底；饑荒回合計數 +1、非饑荒回合歸零。
      let appliedFamine = 0;
      // Task #626 — 糧食增長率修飾：來自 computeAdjustedNationStats（已套
      // foodGrowthEnabled 開關；0=無加成，默認行為不變）。
      const food = await computeNationFoodReport(nation, statsEra, stats.foodGrowthRatePct);
      if (food.famine) {
        const priorFamineTurns = nation.consecutiveFamineTurns ?? 0;
        const popAfterGrowth = Math.max(0, stats.population + appliedGrowth);
        const loss = faminePopulationLoss(popAfterGrowth, priorFamineTurns);
        if (loss > 0) {
          appliedFamine = await applyRegionPopulationDelta(
            db,
            nation.id,
            statsEra,
            -loss,
          );
        }
        await db
          .update(playerNationsTable)
          .set({
            consecutiveFamineTurns: sql`${playerNationsTable.consecutiveFamineTurns} + 1`,
            updatedAt: sql`NOW()`,
          })
          .where(eq(playerNationsTable.id, nation.id));
        if (nation.discordUserId) {
          notifyFamine({
            discordUserId: nation.discordUserId,
            populationLost: Math.max(0, -appliedFamine),
            consecutiveTurns: priorFamineTurns + 1,
          });
        }
      } else if ((nation.consecutiveFamineTurns ?? 0) > 0) {
        await db
          .update(playerNationsTable)
          .set({ consecutiveFamineTurns: 0, updatedAt: sql`NOW()` })
          .where(eq(playerNationsTable.id, nation.id));
      }
      // Task #382 — 人口驟降懲罰：人口每下跌 1% → 四階級滿意度與支持度各 −2
      // （任何下跌來源皆適用：飢荒、負成長等）；糧食政策啟用期間每回合另扣
      // 四階級滿意度（每項政策各扣固定成本）。整數欄位以 SQL 夾 0–100。
      const newPopulation = Math.max(
        0,
        stats.population + appliedGrowth + appliedFamine,
      );
      const dropPenalty = populationDropPenalty(stats.population, newPopulation);
      const policyCost =
        (nation.foodPolicyMobilization
          ? FOOD_POLICY_SATISFACTION_COST_PER_TURN
          : 0) +
        (nation.foodPolicyRationing
          ? FOOD_POLICY_SATISFACTION_COST_PER_TURN
          : 0);
      const satPenalty = dropPenalty + policyCost;
      if (satPenalty > 0 || dropPenalty > 0) {
        await db
          .update(playerNationsTable)
          .set({
            satisfactionFarmers: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionFarmers} - ${satPenalty}))`,
            satisfactionWorkers: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionWorkers} - ${satPenalty}))`,
            satisfactionNobles: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionNobles} - ${satPenalty}))`,
            satisfactionClergy: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionClergy} - ${satPenalty}))`,
            politicalSupport: sql`LEAST(100, GREATEST(0, ${playerNationsTable.politicalSupport} - ${dropPenalty}))`,
            updatedAt: sql`NOW()`,
          })
          .where(eq(playerNationsTable.id, nation.id));
      }
      populationAdded += appliedFamine;
      accrued += 1;
      // Task #469/#481 — 回合制研發：收集各國本回合科研產出（含 NPC），迴圈後統一結算。
      // Task #548 — techAdded 改為研發結算後回填「實際灌入研發的點數」。
      techGainEntries.push({ nation, techGain });
      taxIncomeTotal += finance.taxIncome;
      taxIncomeByNationId.set(nation.id, finance.taxIncome);
      upkeepChargedTotal += finance.upkeepCharged;
      populationAdded += appliedGrowth;
      if (treasuryPenaltyKind) treasuryPenalties += 1;
      if (shouldNotify && nation.discordUserId) {
        // Task #402 — 維護費缺口（欠餉）→ 軍方滿意度下降（純函式決定量）。
        if (!nation.isNpc) {
          const penalty = upkeepShortfallMilitaryPenalty(
            shortfall,
            finance.upkeepCharged,
          );
          if (penalty > 0) {
            await db
              .update(playerNationsTable)
              .set({
                satisfactionMilitary: sql`GREATEST(0, ${playerNationsTable.satisfactionMilitary} - ${penalty})`,
              })
              .where(eq(playerNationsTable.id, nation.id));
            upkeepShortfallNationIds.add(nation.id);
          }
        }
        notifyUpkeepShortfall({
          discordUserId: nation.discordUserId,
          upkeep: finance.upkeepCharged,
          income: finance.taxIncome,
          shortfall,
        });
      } else if (treasuryPenaltyKind === "empty" && nation.discordUserId) {
        notifyTreasuryEmpty({ discordUserId: nation.discordUserId });
      }
    } catch (err) {
      failures += 1;
      logger.error(
        { err, nationId: nation.id },
        "turn engine: nation accrual failed",
      );
    }
  }
  // Task #387 — 回合結算改變各國人口（population_bonus 累積），全球平均
  // 人口快取立即失效，避免玩家在 TTL 內用舊平均計算研發成本倍率。
  invalidateGlobalAveragePopulationCache();

  summary.nations = {
    total: nations.length,
    accrued,
    // Task #548 — 自產科研點不再入庫；研發結算完成後回填實際灌入研發的點數。
    techAdded: 0,
    taxIncome: taxIncomeTotal,
    upkeepCharged: upkeepChargedTotal,
    populationAdded,
    treasuryPenalties,
    failures,
  };

  // Task #214 — 自訂條約每回合經常性轉移結算（金錢／科技／生產力）。
  // 在資源累加之後執行，付款方才有本回合收入可轉出；失敗只記 log。
  try {
    const custom = await runCustomTreatySettlement(now);
    summary.customTreaties = { ok: true, summary: custom };
  } catch (err) {
    summary.customTreaties = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    logger.error({ err }, "turn engine: custom treaty settlement failed");
  }

  // 附庸貢金：附庸把本回合稅收的 tributePct% 上繳宗主（條件式扣款，
  // 不足全跳過＋通知）。在資源累加之後執行，附庸才有本回合稅收可上繳。
  try {
    const tribute = await runVassalTributeSettlement(taxIncomeByNationId, now);
    summary.vassalTribute = { ok: true, summary: tribute };
  } catch (err) {
    summary.vassalTribute = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    logger.error({ err }, "turn engine: vassal tribute settlement failed");
  }

  // Task #214 — NPC 主動廢除與已惡化對象之間生效中的自訂條約（記得協議 → 毀約）。
  // 失敗只記 log，不阻斷其他結算。
  try {
    await runNpcCustomTreatyAnnulments();
  } catch (err) {
    logger.error({ err }, "turn engine: npc custom treaty annul failed");
  }

  // Task #469/#481 — 回合制研發結算：依分配比例把本回合科研產出灌入各領域
  // 進行中科技（溢出／未分配作廢）；完成 → 套用效果＋通知＋領域時代推進。
  // NPC 於結算內 lazy 初始化＋確定性自動選研。
  try {
    summary.techTree = await runTechTreeResearchTurn(techGainEntries);
    // Task #548 — techAdded 反映實際灌入研發的點數（含庫存吸收），避免誤導。
    if (summary.nations) {
      summary.nations.techAdded = summary.techTree.pointsApplied;
    }
  } catch (err) {
    logger.error({ err }, "turn engine: tech tree research settlement failed");
  }

  // 全國傷兵池回合制線性復原：每回合復原 initialWounded × pctPerTurn%（含
  // recoverySpeed 科技加成），封頂於 wounded；pctPerTurn 由 gameBalance 讀取。
  try {
    await recoveryTick();
    logger.info("turn engine: wounded recovery tick done");
  } catch (err) {
    logger.error({ err }, "turn engine: wounded recovery tick failed");
  }

  // Task #389 — NPC 常備軍：每回合確定性生產（人口封頂）＋傷兵歸隊＋
  // （節流的）AI 專屬兵種設計。獨立 try/catch，失敗不阻斷回合。
  try {
    const npcMilitary = await runNpcMilitaryTurn();
    logger.info({ npcMilitary }, "turn engine: NPC military turn done");
  } catch (err) {
    logger.error({ err }, "turn engine: NPC military turn failed");
  }

  // Task #400 — 每日全國軍力快照（NPC 生產／傷兵歸隊之後，反映本回合末狀態）。
  // 獨立 try/catch，失敗不阻斷回合。
  try {
    await recordNationMilitarySnapshots(newGameDate);
  } catch (err) {
    logger.error({ err }, "turn engine: military snapshots failed");
  }

  // NPC 主帥在戰役地區已無任何領土 → 自動結束該戰役（對方獲勝、完整收尾）。
  // 置於 NPC 除名檢查之前；每回合重跑＝自癒。獨立 try/catch，不阻斷回合。
  try {
    const collapse = await endCampaignsForLocallyEliminatedNpcs();
    summary.npcLocalCollapse = { endedCount: collapse.endedCount };
    if (collapse.endedCount > 0) {
      logger.info(
        { endedCount: collapse.endedCount },
        "turn engine: campaigns ended for locally eliminated NPCs",
      );
    }
  } catch (err) {
    logger.error({ err }, "turn engine: npc local collapse check failed");
  }

  // 領土歸零（被完全征服）的 NPC 國家自動除名：通知交戰中的真人對手戰爭結束、
  // 結束其進行中戰役，再硬刪該國家（各關聯表 ON DELETE CASCADE ＝與各國停戰）。
  // 置於軍事結算之後，讓下游政治／超事件／內閣／新聞跳過已滅亡的 NPC。
  // 獨立 try/catch，失敗只記 log，不阻斷回合。
  try {
    const extinction = await runNpcExtinctionCheck();
    summary.npcExtinction = { deletedCount: extinction.deletedCount };
    if (extinction.deletedCount > 0) {
      logger.info(
        { deleted: extinction.deletedNations },
        "turn engine: extinct NPC nations removed",
      );
    }
  } catch (err) {
    logger.error({ err }, "turn engine: NPC extinction check failed");
  }

  // Task #149 — 暫時人口增長 buff 每回合遞減；歸零者刪除（於增長套用後結算）。
  try {
    await tickPopulationBuffs();
  } catch (err) {
    logger.error({ err }, "turn engine: population buff tick failed");
  }

  // Task #355 — 管理員發放的限回合數滿意度 buff 每回合遞減；歸零者刪除。
  try {
    await tickSatisfactionBuffs();
  } catch (err) {
    logger.error({ err }, "turn engine: satisfaction buff tick failed");
  }

  // 財政流水（外交／事件金錢流動的顯示紀錄）保留期限外的舊列清除。
  try {
    const cutoff = new Date(
      now.getTime() - FINANCE_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const pruned = await db
      .delete(nationFinanceLedgerTable)
      .where(lt(nationFinanceLedgerTable.createdAt, cutoff))
      .returning({ id: nationFinanceLedgerTable.id });
    summary.ledgerPruned = pruned.length;
  } catch (err) {
    logger.error({ err }, "turn engine: finance ledger prune failed");
  }

  // Task #593 — AI 用量原始紀錄保留 30 天，期外舊列刪除（統計面板只看 30 天內）。
  try {
    const prunedAiLogs = await pruneAiUsageLogs(now);
    if (prunedAiLogs > 0) {
      logger.info({ prunedAiLogs }, "turn engine: ai usage logs pruned");
    }
  } catch (err) {
    logger.error({ err }, "turn engine: ai usage log prune failed");
  }

  // 清除非當前回合的 AI 對話額度舊列（回合已推進到 newGameDate，舊列不再需要）。
  // 保持資料表極小；冪等，失敗不影響其他結算。
  try {
    await db
      .delete(diplomacyAiChatQuotasTable)
      .where(sql`${diplomacyAiChatQuotasTable.turnDate} <> ${newGameDate}`);
  } catch (err) {
    logger.error({ err }, "turn engine: ai chat quota prune failed");
  }

  // 財政結算（AI 判定財政政策）。在內政結算之前跑；失敗不影響其他結算。
  try {
    const finance = await runFinanceSettlement();
    summary.finance = { ok: true, summary: finance };
  } catch (err) {
    summary.finance = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    logger.error({ err }, "turn engine: finance settlement failed");
  }

  // 內政結算（AI 判定）。與資源結算彼此獨立：這裡失敗不回滾資源。
  // runPoliticsSettlement 若正被管理員手動觸發會丟錯，僅記 log。
  try {
    const politics = await runPoliticsSettlement({ upkeepShortfallNationIds });
    summary.politics = { ok: true, summary: politics };
  } catch (err) {
    summary.politics = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    logger.error({ err }, "turn engine: politics settlement failed");
  }

  // Task #333 — 超事件系統：每回合自動生成／推進全球重大事件，套用跨國數值影響、
  // 賦予跨時代科技、判定玩家應對。獨立 try/catch，失敗僅記 log，不阻斷回合。
  try {
    const superEvents = await runSuperEventSettlement({
      statsEra,
      currentEra: newEra,
    });
    logger.info({ superEvents }, "turn engine: super event settlement done");
  } catch (err) {
    logger.error({ err }, "turn engine: super event settlement failed");
  }

  // Task #242 — 內閣代理：對每位在任大臣呼叫其領域模組 runDomain（地基階段
  // 為 no-op；下游任務實作實際代理行動）。獨立 try/catch，失敗不阻斷回合。
  try {
    await runCabinetTurn(statsEra);
  } catch (err) {
    logger.error({ err }, "turn engine: cabinet turn dispatch failed");
  }

  // Task #228 — NPC 自動演變已從每日回合拆出，改由 worldScheduler 的獨立
  // 背景迴圈（可調頻率）驅動；NPC 主動外交／開戰與戰役結算改由 AI 判定迴圈
  // （runAiJudgment）負責。回合引擎不再觸發世界模擬。

  // Task #184 — 每回合新聞：聚合本回合各來源重大事件（宣戰／締約／時代推進／
  // NPC 興亡／重大政治），交 bulk AI 整理成繁中新聞。獨立 try/catch，失敗僅記
  // log，絕不阻斷回合。在世界模擬之後跑，才能納入本回合 NPC 演進。
  try {
    await runTurnNewsGeneration({
      year: summary.year!,
      gameDate: summary.gameDate!,
      era: summary.era!,
      eraLabel: summary.eraLabel!,
      eraChanged: summary.eraChanged ?? false,
    });
  } catch (err) {
    logger.error({ err }, "turn engine: game news generation failed");
  }

  // Task #184 — 回合推進通知：通知所有有主國家新回合已開始（站內通知）。
  for (const nation of nations) {
    if (nation.discordUserId) {
      notifyTurnAdvanced({
        discordUserId: nation.discordUserId,
        year: summary.year!,
        eraLabel: summary.eraLabel!,
      });
    }
  }

  logger.info(
    {
      summary: {
        ...summary,
        politics: summary.politics?.ok,
      },
    },
    "turn engine: turn completed",
  );
  return summary;
}

const TICK_MS = 60 * 1000;

async function turnTick(now: Date): Promise<void> {
  // 省電喚醒快取：下一個回合時段還沒到就純記憶體返回（零 DB 查詢），
  // Neon 閒置時可休眠；到期時照常走下面的原子認領補跑邏輯。
  if (await skipIfNotDue("turnEngine")) return;
  const [state] = await db
    .select({
      turnTimes: worldGameStateTable.turnTimes,
      lastTurnAt: worldGameStateTable.lastTurnAt,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  if (!state) return;

  const today = localDateString(now);
  const times = normalizeTurnTimes(state.turnTimes);
  // 只認領「今日已到期且尚未執行」中最早的一個時段（逐一補跑）。單日自然上限 =
  // 時段數，因為 last_turn_at 每次前進到該時段、之後同日的其餘時段才輪到。
  const due = nextDueSlot(times, now, state.lastTurnAt ?? null, today);
  if (!due) return;

  const result = await runTurnUpdate(now, { claimInstant: due });
  if (result.ran) {
    noteGameActivity();
    logger.info(
      { dateLabel: today, slot: due.toISOString() },
      "turn engine: scheduled turn slot ran",
    );
  }
}

/**
 * 每分鐘檢查一次：當地時間已到某設定時刻、且該時段今日尚未執行 → 跑一次回合。
 * last_turn_at 持久化 + 原子條件式認領 → 重啟／並發都不會重複結算；重啟時若有
 * 已過但尚未執行的今日時段，會在後續 tick 逐一補跑（每 tick 一個，單日上限 =
 * 時段數）。注意：把某時刻改到比現在早、且該時段今日尚未執行時，會立即觸發。
 */
export function startTurnLoop(): void {
  registerSchedulerWake("turnEngine", (raw) => {
    const now = new Date();
    const times = normalizeTurnTimes(raw["turn_times"]);
    const lastMs = toMs(raw["last_turn_at"]);
    const today = localDateString(now);
    const nowMs = now.getTime();
    let nextUpcoming: number | null = null;
    for (const t of times) {
      const ms = localSlotInstant(today, t.hour, t.minute).getTime();
      // 已到期且尚未執行 → 立即到期（tick 會逐一補跑）。
      if (ms <= nowMs && (lastMs === null || ms > lastMs)) return 0;
      if (ms > nowMs && (nextUpcoming === null || ms < nextUpcoming)) {
        nextUpcoming = ms;
      }
    }
    if (nextUpcoming !== null) return nextUpcoming;
    if (times.length === 0) return null;
    // 今日時段全部結束 → 明日第一個時段（times 已排序）。
    const first = times[0]!;
    return localSlotInstant(today, first.hour, first.minute).getTime() + 24 * 60 * 60_000;
  });
  setInterval(() => {
    void turnTick(new Date()).catch((err) =>
      logger.error({ err }, "turn engine tick failed"),
    );
  }, TICK_MS);
  logger.info(
    { tz: SCHEDULE_TZ },
    "turn engine loop started (minute tick, daily turn)",
  );
}
