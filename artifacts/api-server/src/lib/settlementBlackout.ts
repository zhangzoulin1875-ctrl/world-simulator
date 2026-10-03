/**
 * 結算靜默時段（settlement blackout）的純函式輔助模組。
 *
 * 需求：晚上某個時段（預設當地時間 00:00–08:00）不要進行「戰爭／外交結算」
 * （＝ AI 外交·戰役判定迴圈）。落在靜默時段內的下次到期時間，會延到時段結束
 * （end:00）才結算。例：22:00 宣戰、週期 4 小時 → 到期 02:00 落在靜默時段
 * → 延到 08:00 結算，之後 12:00／16:00／20:00，再跳過 00:00–08:00 → 次日 08:00。
 *
 * 全部為純函式、時鐘無關（可注入 now / tz），只依賴同樣純粹的 time.ts。
 * 不 import db，可在 `test`（src/lib/*.test.ts）工作流以單元測試覆蓋。
 */
import { NEWS_SCHEDULE_TZ, tzOffsetMs, localSlotInstant } from "./time";

/** 排程頻率下限（分鐘）：保證 next_run_at 一定嚴格晚於 now，避免緊迴圈。 */
const MIN_FREQ_MINUTES = 1;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 夾到合法的整點小時（0–23）；非數值退回 0。 */
export function sanitizeBlackoutHour(h: number): number {
  if (!Number.isFinite(h)) return 0;
  const x = Math.floor(h);
  if (x < 0) return 0;
  if (x > 23) return 23;
  return x;
}

/** 取得某瞬間在 tz 當地的「小時」（0–23）。 */
export function localHourInTz(d: Date, tz: string = NEWS_SCHEDULE_TZ): number {
  const wall = new Date(d.getTime() + tzOffsetMs(d, tz));
  return wall.getUTCHours();
}

/**
 * 判斷 `hour` 是否落在靜默時段 [start, end) 內。
 *  - start === end：停用（永遠不在靜默時段）。
 *  - start < end：當日區間 [start, end)。
 *  - start > end：跨午夜（例：22→6，涵蓋 [start,24) 與 [0,end)）。
 */
export function isHourInBlackout(
  hour: number,
  startHour: number,
  endHour: number,
): boolean {
  const start = sanitizeBlackoutHour(startHour);
  const end = sanitizeBlackoutHour(endHour);
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** 某瞬間（依 tz 當地時間）是否落在靜默時段內。 */
export function isWithinBlackout(
  d: Date,
  startHour: number,
  endHour: number,
  tz: string = NEWS_SCHEDULE_TZ,
): boolean {
  return isHourInBlackout(localHourInTz(d, tz), startHour, endHour);
}

/**
 * 計算下次結算時間：base = now + 頻率；若 base 落在靜默時段，則延到該時段結束
 * （當地 end:00）。回傳值保證嚴格晚於 now。
 *
 * 跨午夜（start > end）時：
 *  - 落在「傍晚段」（hour >= start）→ 延到「隔日」的 end:00。
 *  - 落在「凌晨段」（hour < end）→ 延到「當日」的 end:00。
 * 這兩種情況統一以「若當日 end:00 已早於 base 就進到隔日」自動處理。
 */
export function computeNextRunAtWithBlackout(
  now: Date,
  frequencyMinutes: number,
  startHour: number,
  endHour: number,
  tz: string = NEWS_SCHEDULE_TZ,
): Date {
  const freq = Math.max(
    MIN_FREQ_MINUTES,
    Number.isFinite(frequencyMinutes)
      ? Math.floor(frequencyMinutes)
      : MIN_FREQ_MINUTES,
  );
  const base = new Date(now.getTime() + freq * 60_000);
  const start = sanitizeBlackoutHour(startHour);
  const end = sanitizeBlackoutHour(endHour);
  if (start === end) return base; // 靜默時段停用

  const hour = localHourInTz(base, tz);
  if (!isHourInBlackout(hour, start, end)) return base;

  // base 落在靜默時段 → 延到時段結束（當地 end:00）。
  const wall = new Date(base.getTime() + tzOffsetMs(base, tz));
  const y = wall.getUTCFullYear();
  const mo = wall.getUTCMonth() + 1;
  const d = wall.getUTCDate();
  let endInstant = localSlotInstant(`${y}-${pad2(mo)}-${pad2(d)}`, end, 0, tz);
  if (endInstant.getTime() <= base.getTime()) {
    // 傍晚段：當日 end:00 已過 → 進到隔日的 end:00。
    const nextWall = new Date(Date.UTC(y, mo - 1, d));
    nextWall.setUTCDate(nextWall.getUTCDate() + 1);
    endInstant = localSlotInstant(
      `${nextWall.getUTCFullYear()}-${pad2(nextWall.getUTCMonth() + 1)}-${pad2(
        nextWall.getUTCDate(),
      )}`,
      end,
      0,
      tz,
    );
  }
  return endInstant;
}
