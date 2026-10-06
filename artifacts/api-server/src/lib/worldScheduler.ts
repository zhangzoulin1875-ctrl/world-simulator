import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { runWorldSimEvolution } from "./worldSimTurn";
import { runAiJudgment } from "./aiJudgment";
import { settleDueCampaigns } from "./warEngine";
import { normalizeDirective } from "./aiDirective";
import {
  isWithinBlackout,
  computeNextRunAtWithBlackout,
} from "./settlementBlackout";
import {
  blackoutFloor,
  noteGameActivity,
  registerSchedulerWake,
  sanitizeBlackoutHour,
  skipIfNotDue,
  toMs,
} from "./schedulerWake";

/**
 * Task #228 — 世界模擬排程器：兩個獨立、可在管理員頁調整頻率的背景迴圈。
 *
 * 1. NPC 自動演變（runWorldSimEvolution）：政體／領導人／領地變更、釋地成無主。
 * 2. AI 戰役判定（runAiJudgment）：NPC 開戰決策（在既有戰爭中應戰）、
 *    戰役週期推進/結算。（NPC 主動外交提案/宣戰/結盟已停用。）
 *
 * 兩者都採「持久化時間戳 + 條件式 UPDATE 認領」的競態安全模式（比照回合引擎的
 * last_turn_date 認領）：到期判定與時間戳前進在同一個原子 UPDATE 內完成，
 * 多實例／重啟都不會重跑或漏跑。程序內另以同步鎖防重入。
 */

/** 排程掃描 tick（每分鐘檢查一次是否到期）。 */
const SCHEDULER_TICK_MS = 60_000;

/**
 * 頻率安全上下限（分鐘）：1 分鐘 ～ 30 天，與 admin API 的 FREQ_MIN/MAX_MINUTES
 * 及資料庫 CHECK（>= 1）一致。這是「深度防禦」——即使某條路徑寫入了 0/負值/
 * NaN/荒謬大值，排程器仍會夾回合法區間，避免「每 tick 都到期」的緊迴圈或
 * 「下次到期在天邊」的永不執行。
 */
export const MIN_FREQUENCY_MINUTES = 1;
export const MAX_FREQUENCY_MINUTES = 43_200;

/**
 * 純函式：把任意輸入夾成合法頻率（分鐘整數）。非有限值／非正值 → 下限；
 * 超過上限 → 上限；小數 → 無條件捨去後再夾。永遠回傳 [MIN, MAX] 內的整數。
 */
export function sanitizeFrequencyMinutes(frequencyMinutes: number): number {
  if (!Number.isFinite(frequencyMinutes)) return MIN_FREQUENCY_MINUTES;
  const floored = Math.floor(frequencyMinutes);
  if (floored < MIN_FREQUENCY_MINUTES) return MIN_FREQUENCY_MINUTES;
  if (floored > MAX_FREQUENCY_MINUTES) return MAX_FREQUENCY_MINUTES;
  return floored;
}

/** 純函式：依「下次到期時間」與現在判斷是否到期（null = 從未執行過，視為到期）。 */
export function isDue(nextRunAt: Date | null, now: Date): boolean {
  return nextRunAt === null || nextRunAt.getTime() <= now.getTime();
}

/**
 * 純函式：由現在與頻率（分鐘）算出下次到期時間。頻率先經 sanitize 夾回合法
 * 區間，確保 nextRunAt 永遠嚴格大於 now（不會因 0/負值退化成緊迴圈）。
 */
export function computeNextRunAt(now: Date, frequencyMinutes: number): Date {
  const safe = sanitizeFrequencyMinutes(frequencyMinutes);
  return new Date(now.getTime() + safe * 60_000);
}

/**
 * 原子認領一次 NPC 自動演變排程：僅在「已啟用且已到期」時前進時間戳並回傳 true。
 * next_run_at 只在啟用時前進，停用時保持不變（重新啟用後可立即到期執行）。
 */
export async function claimWorldSimSchedule(): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE world_game_state
    SET world_sim_last_run_at = NOW(),
        world_sim_next_run_at = NOW() + make_interval(mins =>
          LEAST(${MAX_FREQUENCY_MINUTES},
                GREATEST(${MIN_FREQUENCY_MINUTES}, world_sim_frequency_minutes)))
    WHERE id = 1
      AND world_sim_enabled = true
      AND (world_sim_next_run_at IS NULL OR world_sim_next_run_at <= NOW())
    RETURNING id
  `);
  return res.rows.length > 0;
}

/**
 * 讀取 AI 判定排程所需設定（啟用狀態／頻率／結算靜默時段）。在原子認領之前讀取，
 * 供 tick 做「靜默時段前置檢查」與「下次到期時間（含靜默延後）」的計算。
 */
export async function readAiJudgmentScheduleConfig(): Promise<{
  enabled: boolean;
  frequencyMinutes: number;
  blackoutStartHour: number;
  blackoutEndHour: number;
} | null> {
  const res = await db.execute(sql`
    SELECT ai_judgment_enabled AS enabled,
           ai_judgment_frequency_minutes AS freq,
           settlement_blackout_start_hour AS bstart,
           settlement_blackout_end_hour AS bend
    FROM world_game_state
    WHERE id = 1
    LIMIT 1
  `);
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as {
    enabled: boolean;
    freq: number;
    bstart: number;
    bend: number;
  };
  return {
    enabled: Boolean(r.enabled),
    frequencyMinutes: Number(r.freq),
    blackoutStartHour: Number(r.bstart),
    blackoutEndHour: Number(r.bend),
  };
}

/**
 * 原子認領一次 AI 外交/戰役判定排程；回傳判定所需設定（強度／對玩家敵對）或 null。
 * 「下次到期時間」由呼叫端計算（含結算靜默時段延後）後傳入，last_run_at 記為 now；
 * 認領互斥仍由 WHERE ai_judgment_next_run_at <= NOW()（DB 時鐘）保證，多實例／
 * 重啟不重跑、不漏跑。
 */
export async function claimAiJudgmentSchedule(
  now: Date,
  nextRunAt: Date,
): Promise<{
  intensity: number;
  hostileToPlayers: boolean;
  directive: string | null;
} | null> {
  const res = await db.execute(sql`
    UPDATE world_game_state
    SET ai_judgment_last_run_at = ${now.toISOString()},
        ai_judgment_next_run_at = ${nextRunAt.toISOString()}
    WHERE id = 1
      AND ai_judgment_enabled = true
      AND (ai_judgment_next_run_at IS NULL OR ai_judgment_next_run_at <= NOW())
    RETURNING world_sim_intensity AS intensity,
              world_sim_hostile_to_players AS hostile,
              ai_judgment_directive AS directive
  `);
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as {
    intensity: number;
    hostile: boolean;
    directive: string | null;
  };
  return {
    intensity: Number(r.intensity),
    hostileToPlayers: Boolean(r.hostile),
    directive: normalizeDirective(r.directive),
  };
}

// 同步佔鎖：避免同一迴圈的上一 tick 尚未完成時重入。
let worldSimTickRunning = false;
let aiJudgmentTickRunning = false;

/**
 * 同步嘗試取得 AI 判定重入鎖：成功回傳 true 並佔鎖，已在執行中回傳 false。
 * 背景 tick 與管理員「立即判定」端點共用此鎖，確保兩者不會同時跑 runAiJudgment。
 * 呼叫端務必在 finally 內呼叫 releaseAiJudgmentLock 釋放。
 */
export function tryAcquireAiJudgmentLock(): boolean {
  if (aiJudgmentTickRunning) return false;
  aiJudgmentTickRunning = true;
  return true;
}

/** 釋放 AI 判定重入鎖。 */
export function releaseAiJudgmentLock(): void {
  aiJudgmentTickRunning = false;
}

async function tickWorldSim(): Promise<void> {
  if (worldSimTickRunning) return;
  worldSimTickRunning = true;
  try {
    // 省電喚醒快取：未到期就純記憶體返回（零 DB 查詢，Neon 可休眠）。
    if (await skipIfNotDue("worldSim")) return;
    const claimed = await claimWorldSimSchedule();
    if (!claimed) return;
    const summary = await runWorldSimEvolution();
    // 剛寫入過 DB：標記活動（快取重讀 + Neon 反正醒著）。
    noteGameActivity();
    logger.info({ summary }, "npc auto-evolution tick ran");
  } catch (err) {
    logger.error({ err }, "npc auto-evolution tick failed");
  } finally {
    worldSimTickRunning = false;
  }
}

async function tickAiJudgment(): Promise<void> {
  if (!tryAcquireAiJudgmentLock()) return;
  try {
    // 省電喚醒快取：未到期就純記憶體返回（含靜默時段整段跳過）。
    if (await skipIfNotDue("aiJudgment")) return;
    const cfg = await readAiJudgmentScheduleConfig();
    if (!cfg || !cfg.enabled) return;
    const now = new Date();
    // 結算靜默時段：此時段內不進行結算（AI 外交／戰役判定），直接跳過本 tick；
    // 下一個 tick（每分鐘）會在離開時段後才認領執行。
    if (isWithinBlackout(now, cfg.blackoutStartHour, cfg.blackoutEndHour)) {
      return;
    }
    // 下次到期時間 = now + 頻率；若落在靜默時段內則延到時段結束（end:00）。
    const nextRunAt = computeNextRunAtWithBlackout(
      now,
      sanitizeFrequencyMinutes(cfg.frequencyMinutes),
      cfg.blackoutStartHour,
      cfg.blackoutEndHour,
    );
    const claim = await claimAiJudgmentSchedule(now, nextRunAt);
    if (!claim) return;
    const summary = await runAiJudgment();
    noteGameActivity();
    logger.info({ summary }, "ai judgment tick ran");
  } catch (err) {
    logger.error({ err }, "ai judgment tick failed");
  } finally {
    releaseAiJudgmentLock();
  }
}

// 戰役到期結算迴圈的同步重入鎖（獨立於 AI 判定鎖：settleCampaign 內部已有
// 逐戰役 settling Set + cycle_number 條件式 UPDATE 雙重防護，與判定/手動結算
// 並行也不會重複結算，此鎖只避免同一迴圈自我重入）。
let warSettlementTickRunning = false;

/**
 * 戰役到期結算迴圈（每分鐘）：戰役的 next_resolve_at 一到期就立刻結算，
 * 不再等 4 小時一次的 AI 判定掃描 — 「戰役週期長度」設多久就是多久。
 * 與 AI 判定共用同一組開關與靜默時段：判定迴圈停用時不結算；
 * 靜默時段（預設 00–08 當地時間）內跳過，到期的戰役會在時段結束後的
 * 第一個 tick 結算。NPC 外交判定維持原本的頻率不受影響。
 */
async function tickWarSettlement(): Promise<void> {
  if (warSettlementTickRunning) return;
  warSettlementTickRunning = true;
  try {
    // 省電喚醒快取：沒有到期戰役（或靜默時段）就純記憶體返回。
    if (await skipIfNotDue("warSettlement")) return;
    const cfg = await readAiJudgmentScheduleConfig();
    if (!cfg || !cfg.enabled) return;
    const now = new Date();
    if (isWithinBlackout(now, cfg.blackoutStartHour, cfg.blackoutEndHour)) {
      return;
    }
    await settleDueCampaigns(now);
    noteGameActivity();
  } catch (err) {
    logger.error({ err }, "war settlement tick failed");
  } finally {
    warSettlementTickRunning = false;
  }
}

/**
 * 註冊四個迴圈的喚醒計算（快照單一 SQL 讀到的原始欄位 → 下次到期 ms）。
 * 詳情見 schedulerWake.ts；未到期時每分鐘 tick 不碰 DB（Neon 省電）。
 */
function registerWorldSchedulerWakes(): void {
  registerSchedulerWake("worldSim", (raw) =>
    raw["ws_enabled"] === true ? toMs(raw["ws_next"]) ?? 0 : null,
  );
  registerSchedulerWake("aiJudgment", (raw) => {
    if (raw["aj_enabled"] !== true) return null;
    const base = toMs(raw["aj_next"]) ?? 0;
    return blackoutFloor(
      base,
      sanitizeBlackoutHour(raw["bstart"]),
      sanitizeBlackoutHour(raw["bend"]),
    );
  });
  registerSchedulerWake("warSettlement", (raw) => {
    if (raw["aj_enabled"] !== true) return null;
    const warNext = toMs(raw["war_next"]);
    if (warNext === null) return null;
    return blackoutFloor(
      warNext,
      sanitizeBlackoutHour(raw["bstart"]),
      sanitizeBlackoutHour(raw["bend"]),
    );
  });
}

/** 啟動排程迴圈（於 bootstrap 後呼叫）。 */
export function startWorldSchedulerLoops(): void {
  registerWorldSchedulerWakes();
  setTimeout(() => {
    void tickWorldSim();
    setInterval(() => void tickWorldSim(), SCHEDULER_TICK_MS);
  }, 30_000);
  setTimeout(() => {
    void tickAiJudgment();
    setInterval(() => void tickAiJudgment(), SCHEDULER_TICK_MS);
  }, 45_000);
  setTimeout(() => {
    void tickWarSettlement();
    setInterval(() => void tickWarSettlement(), SCHEDULER_TICK_MS);
  }, 60_000);
  // 財政結算不再有獨立的現實時間迴圈：與政治一樣，只在每回合結算（turnEngine）時執行。
  logger.info(
    "world scheduler loops started (npc-evolution / ai-judgment / war-settlement / finance-settlement)",
  );
}
