/**
 * Task #248 — 背景排程「省電喚醒快取」：讓 Neon 閒置時能真正自動休眠。
 *
 * 問題：免費層 Neon 只有大約 190 小時／月的 compute 時數，且「閒置 5 分鐘」
 * 才會自動休眠。原本的背景迴圈（世界模擬／AI 判定／戰役結算／財政結算／
 * 回合引擎每分鐘一查、條約到期每 10 分鐘一查、預產 worker 每 30 秒一查）
 * 每分鐘都在碰 DB → Neon 全月 720 小時常醒，月中額度就會燒完。
 *
 * 解法：所有「何時該做事」的資訊其實都存在 DB 的時間戳欄位裡
 * （world_sim_next_run_at、ai_judgment_next_run_at、
 * war_campaigns.next_resolve_at、條約 expires_at、回合時段表…）。
 * 快取一次「下次到期時間」到記憶體，每分鐘的 tick 只做純記憶體比對：
 * 還沒到期就直接返回（零 DB 查詢）；到期才去 DB 做原本的原子認領
 * （認領語意完全不變：多實例／重啟安全）。
 *
 * 快取失效（重讀一次快照，單一 SQL）的時機：
 *   1. 啟動後第一次 tick。
 *   2. noteGameActivity()：任何遊戲寫入（HTTP 請求、Discord 互動、
 *      各結算迴圈跑完）都會標記 — 玩家活動本來就會喚醒 Neon，順便
 *      重讀快取是免費的。
 *   3. 安全網：距上次快取超過 SCHEDULER_WAKE_SAFETY_MS（預設 6 小時）
 *      強制重讀一次。快照讀取「不會 keep-alive」安排好的到期時間被
 *      改掉時的漏網情況。
 *
 * 靜默時段（blackout）內的到期時間會被推到時段結束，避免整夜每分鐘
 * 空轉一次 DB 認領查詢。
 *
 * 各子系統用 registerSchedulerWake() 註冊「從快照列算出到期時間」的
 * 純函式（避免本模組反向 import 各子系統造成循環依賴）；未註冊的
 * key 一律視為到期（fail-open，退回原本每分鐘查詢的行為）。
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { isWithinBlackout } from "./settlementBlackout";
import { localDateString, localSlotInstant } from "./time";

/** 快照安全重讀間隔（毫秒）。可用環境變數覆寫（測試用）。 */
const SAFETY_REFRESH_MS = (() => {
  const v = Number(process.env["SCHEDULER_WAKE_SAFETY_MS"]);
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60_000;
})();

/** 「最近有活動」窗口（毫秒）：供 shouldRunPeriodicWhenActive 判斷。 */
const ACTIVITY_WINDOW_MS = 10 * 60_000;

export type SchedulerWakeKey = string;

/** 各子系統註冊的「快照列 → 下次到期時間」計算（null = 沒有排程中事件）。 */
type WakeComputer = (row: Record<string, unknown>) => number | null;

const computers = new Map<SchedulerWakeKey, WakeComputer>();

interface Snapshot {
  at: number;
  values: Map<SchedulerWakeKey, number | null>;
}

let snapshot: Snapshot | null = null;
let dirty = true;
let refreshInFlight: Promise<void> | null = null;
let lastActivityAt: number | null = null;

/** 註冊子系統的到期時間計算（冪等；重複註冊覆寫）。 */
export function registerSchedulerWake(
  key: SchedulerWakeKey,
  compute: WakeComputer,
): void {
  computers.set(key, compute);
}

/**
 * 記錄「遊戲有活動」：任何 HTTP 請求、Discord 互動、或背景結算寫入後
 * 呼叫。標記快取重讀（DB 狀態可能變了）並更新活動時間戳（供
 * shouldRunPeriodicWhenActive 判斷 Neon 目前是醒著的）。
 */
export function noteGameActivity(): void {
  dirty = true;
  lastActivityAt = Date.now();
}

/** 現在（或未來不久）是否有遊戲活動 → Neon 目前是醒著的。 */
export function isNeonLikelyActive(now: number = Date.now()): boolean {
  return lastActivityAt !== null && now - lastActivityAt <= ACTIVITY_WINDOW_MS;
}

/**
 * 某子系統的 tick 是否該碰 DB？true = 該做原本的工作（含快取未備妥時的
 * 重讀）；false = 純記憶體判斷「還沒到期」，直接返回（零 DB 查詢）。
 */
export function schedulerWakeDue(key: SchedulerWakeKey): boolean {
  if (snapshot === null || dirty) return true;
  if (Date.now() - snapshot.at >= SAFETY_REFRESH_MS) return true;
  if (!computers.has(key)) return true; // fail-open：未註冊就退回每 tick 都跑
  const v = snapshot.values.get(key);
  return v !== undefined && v !== null && v <= Date.now();
}

/** 確保快照可用（過期／髒／缺 → 重讀一次；併發共用同一個請求）。 */
export async function ensureSchedulerWakeSnapshot(): Promise<void> {
  const s = snapshot;
  if (s !== null && !dirty && Date.now() - s.at < SAFETY_REFRESH_MS) return;
  if (refreshInFlight === null) {
    refreshInFlight = readSnapshot()
      .then((fresh) => {
        snapshot = fresh;
        dirty = false;
      })
      .catch((err) => {
        // 快照讀失敗：保留舊快照並標髒（下一 tick 再試）；子系統的
        // tick 會照常執行（fail-open），行為等同沒有快取。
        dirty = true;
        logger.error({ err }, "scheduler wake snapshot refresh failed");
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  await refreshInFlight;
}

/** tick 標準開場：沒到期就什麼都不做。 */
export async function skipIfNotDue(key: SchedulerWakeKey): Promise<boolean> {
  if (!schedulerWakeDue(key)) return true;
  await ensureSchedulerWakeSnapshot();
  return !schedulerWakeDue(key);
}

/**
 * 週期性維護工作（每小時一致性健檢等）的省電版本：
 *   - 到期（距上次執行 ≥ intervalMs）且「Neon 目前是醒的」→ 跑。
 *   - 到期但 Neon 在睡 → 延後，除非已拖過 maxDeferMs（保底必跑）。
 * 理由：這類健檢修正的是「寫入造成的漂移」；寫入只會發生在遊戲有
 * 活動、或背景結算剛跑過的時候——那時 Neon 本來就是醒的。純閒置時
 * 沒有寫入、不會有新漂移，把健檢拖到下次喚醒不會放過任何問題。
 */
export function shouldRunPeriodicWhenActive(
  lastRunAt: number,
  intervalMs: number,
  maxDeferMs: number,
): boolean {
  const now = Date.now();
  if (now - lastRunAt < intervalMs) return false;
  if (now - lastRunAt >= maxDeferMs) return true;
  return isNeonLikelyActive(now);
}

// ── 快照讀取 ───────────────────────────────────────────────────────────────

export function toMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 靜默時段地板：t 若落在靜默時段內，往後推到時段結束（當地 end:00，
 * 已過則隔日）。不落（或靜默停用）則原值返回。 ai_judgment／戰役／
 * 財政結算的到期時間都套用，避免整夜每分鐘空轉。
 */
export function blackoutFloor(t: number, bstart: number, bend: number): number {
  const d = new Date(t);
  if (!isWithinBlackout(d, bstart, bend)) return t;
  const end = sanitizeBlackoutHour(bend);
  const start = sanitizeBlackoutHour(bstart);
  if (start === end) return t; // 停用
  const today = localDateString(d);
  let inst = localSlotInstant(today, end, 0);
  if (inst.getTime() <= t) inst = new Date(inst.getTime() + 24 * 60 * 60_000);
  return inst.getTime();
}

export function sanitizeBlackoutHour(h: unknown): number {
  const n = Number(h);
  if (!Number.isFinite(n)) return 0;
  return Math.min(23, Math.max(0, Math.floor(n)));
}

/** 單一 SQL 讀出所有子系統的排程狀態（一次 round-trip）。 */
async function readSnapshot(): Promise<Snapshot> {
  const res = await db.execute(sql`
    SELECT
      w.world_sim_enabled AS ws_enabled,
      w.world_sim_next_run_at AS ws_next,
      w.ai_judgment_enabled AS aj_enabled,
      w.ai_judgment_next_run_at AS aj_next,
      w.settlement_blackout_start_hour AS bstart,
      w.settlement_blackout_end_hour AS bend,
      w.turn_times AS turn_times,
      w.last_turn_at AS last_turn_at,
      (SELECT MIN(next_resolve_at) FROM war_campaigns WHERE status = 'active') AS war_next,
      (SELECT MIN(expires_at) FROM diplomacy_treaties
        WHERE status = 'active' AND expires_at IS NOT NULL) AS tr_exp,
      (SELECT MIN(expires_at) FROM diplomacy_treaties
        WHERE status = 'active' AND expires_at IS NOT NULL
          AND expiry_warned_at IS NULL) AS tr_warn
    FROM world_game_state w
    WHERE w.id = 1
  `);
  const raw = (res.rows[0] ?? {}) as Record<string, unknown>;
  const now = Date.now();
  const values = new Map<SchedulerWakeKey, number | null>();
  for (const [key, compute] of computers) {
    try {
      const v = compute(raw);
      // 負值（過期未處理）一律視為立即到期（0）。
      values.set(key, v === null ? null : Math.max(0, v));
    } catch (err) {
      // 單一子系統計算失敗：只讓它退回每 tick 都跑（fail-open）。
      logger.error({ err, key }, "scheduler wake compute failed");
      values.set(key, 0);
    }
  }
  return { at: now, values };
}
