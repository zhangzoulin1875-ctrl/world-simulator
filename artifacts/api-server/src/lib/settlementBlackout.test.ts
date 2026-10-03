/**
 * 結算靜默時段純函式的單元測試。時鐘無關（自帶固定 now / tz），可在
 * `test`（src/lib/*.test.ts）工作流執行，不需要 DB。tz 固定用 Asia/Taipei
 * （UTC+8，無日光節約），方便手算對照。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeBlackoutHour,
  localHourInTz,
  isHourInBlackout,
  isWithinBlackout,
  computeNextRunAtWithBlackout,
} from "./settlementBlackout";

const TZ = "Asia/Taipei"; // UTC+8
const MIN = 60_000;

describe("sanitizeBlackoutHour", () => {
  test("夾到 0–23、整數化、非數值退回 0", () => {
    assert.equal(sanitizeBlackoutHour(0), 0);
    assert.equal(sanitizeBlackoutHour(23), 23);
    assert.equal(sanitizeBlackoutHour(-1), 0);
    assert.equal(sanitizeBlackoutHour(24), 23);
    assert.equal(sanitizeBlackoutHour(30), 23);
    assert.equal(sanitizeBlackoutHour(8.9), 8);
    assert.equal(sanitizeBlackoutHour(Number.NaN), 0);
  });
});

describe("localHourInTz (Asia/Taipei = UTC+8)", () => {
  test("換算當地整點小時", () => {
    assert.equal(localHourInTz(new Date("2026-01-01T00:00:00Z"), TZ), 8);
    assert.equal(localHourInTz(new Date("2026-01-01T16:00:00Z"), TZ), 0);
    assert.equal(localHourInTz(new Date("2026-01-01T18:00:00Z"), TZ), 2);
    assert.equal(localHourInTz(new Date("2026-01-01T04:00:00Z"), TZ), 12);
  });
});

describe("isHourInBlackout", () => {
  test("當日區間 [0,8)", () => {
    assert.equal(isHourInBlackout(0, 0, 8), true);
    assert.equal(isHourInBlackout(7, 0, 8), true);
    assert.equal(isHourInBlackout(8, 0, 8), false);
    assert.equal(isHourInBlackout(9, 0, 8), false);
    assert.equal(isHourInBlackout(23, 0, 8), false);
  });
  test("跨午夜區間 [22,6)", () => {
    assert.equal(isHourInBlackout(22, 22, 6), true);
    assert.equal(isHourInBlackout(23, 22, 6), true);
    assert.equal(isHourInBlackout(0, 22, 6), true);
    assert.equal(isHourInBlackout(5, 22, 6), true);
    assert.equal(isHourInBlackout(6, 22, 6), false);
    assert.equal(isHourInBlackout(7, 22, 6), false);
    assert.equal(isHourInBlackout(21, 22, 6), false);
  });
  test("start === end 代表停用（永遠 false）", () => {
    for (let h = 0; h < 24; h++) {
      assert.equal(isHourInBlackout(h, 0, 0), false);
      assert.equal(isHourInBlackout(h, 5, 5), false);
    }
  });
});

describe("isWithinBlackout (Asia/Taipei)", () => {
  test("以當地時間判斷 [0,8)", () => {
    // 當地 02:00（= UTC 18:00 前一日）→ 在靜默時段。
    assert.equal(
      isWithinBlackout(new Date("2026-06-01T18:00:00Z"), 0, 8, TZ),
      true,
    );
    // 當地 08:00（= UTC 00:00）→ 不在（8 不含在 [0,8)）。
    assert.equal(
      isWithinBlackout(new Date("2026-06-01T00:00:00Z"), 0, 8, TZ),
      false,
    );
    // 當地 12:00（= UTC 04:00）→ 不在。
    assert.equal(
      isWithinBlackout(new Date("2026-06-01T04:00:00Z"), 0, 8, TZ),
      false,
    );
  });
});

describe("computeNextRunAtWithBlackout (Asia/Taipei)", () => {
  test("base 不在靜默時段 → 直接回傳 now + 頻率", () => {
    // 當地 10:00 + 4h = 14:00（不在 [0,8)）。
    const now = new Date("2026-06-01T02:00:00Z");
    const next = computeNextRunAtWithBlackout(now, 240, 0, 8, TZ);
    assert.equal(next.getTime(), now.getTime() + 240 * MIN);
  });

  test("base 落在靜默時段 → 延到當地 08:00（宣戰 22:00 → 結算 08:00 例子）", () => {
    // 當地 22:00（UTC 14:00）+ 4h = 隔日 02:00 → 落在 [0,8) → 延到隔日 08:00。
    const now = new Date("2026-06-01T14:00:00Z"); // 當地 2026-06-01 22:00
    const next = computeNextRunAtWithBlackout(now, 240, 0, 8, TZ);
    // 當地 2026-06-02 08:00 = UTC 2026-06-02 00:00。
    assert.equal(next.toISOString(), "2026-06-02T00:00:00.000Z");
  });

  test("跨午夜靜默 [22,6)：傍晚落點 → 延到隔日 06:00", () => {
    // 當地 22:30（UTC 14:30）+ 1h = 23:30 → 傍晚段 → 隔日 06:00。
    const now = new Date("2026-06-01T14:30:00Z");
    const next = computeNextRunAtWithBlackout(now, 60, 22, 6, TZ);
    // 當地 2026-06-02 06:00 = UTC 2026-06-01 22:00。
    assert.equal(next.toISOString(), "2026-06-01T22:00:00.000Z");
  });

  test("跨午夜靜默 [22,6)：凌晨落點 → 延到當日 06:00", () => {
    // 當地 2026-06-02 03:30（UTC 2026-06-01 19:30）+ 1h = 04:30 → 凌晨段 → 當日 06:00。
    const now = new Date("2026-06-01T19:30:00Z");
    const next = computeNextRunAtWithBlackout(now, 60, 22, 6, TZ);
    // 當地 2026-06-02 06:00 = UTC 2026-06-01 22:00。
    assert.equal(next.toISOString(), "2026-06-01T22:00:00.000Z");
  });

  test("靜默停用（start === end）→ 一律 now + 頻率", () => {
    const now = new Date("2026-06-01T14:00:00Z"); // 當地 22:00
    const next = computeNextRunAtWithBlackout(now, 120, 0, 0, TZ);
    assert.equal(next.getTime(), now.getTime() + 120 * MIN);
  });

  test("頻率 < 1 也保證嚴格晚於 now（夾到 1 分鐘）", () => {
    const now = new Date("2026-06-01T04:00:00Z"); // 當地 12:00（不在靜默）
    const next = computeNextRunAtWithBlackout(now, 0, 0, 8, TZ);
    assert.ok(next.getTime() > now.getTime());
    assert.equal(next.getTime(), now.getTime() + 1 * MIN);
  });

  test("回傳值永遠嚴格晚於 now（掃描一整天的落點）", () => {
    for (let h = 0; h < 24; h++) {
      const now = new Date(Date.UTC(2026, 5, 1, h, 0, 0));
      const next = computeNextRunAtWithBlackout(now, 240, 0, 8, TZ);
      assert.ok(
        next.getTime() > now.getTime(),
        `h=${h} 應嚴格晚於 now`,
      );
      // 結果的當地小時永不落在 [0,8)。
      assert.equal(isWithinBlackout(next, 0, 8, TZ), false, `h=${h} 不應落在靜默時段`);
    }
  });
});
