import { strict as assert } from "node:assert";
import test from "node:test";
import {
  isDue,
  computeNextRunAt,
  sanitizeFrequencyMinutes,
  MIN_FREQUENCY_MINUTES,
  MAX_FREQUENCY_MINUTES,
} from "./worldScheduler";

test("isDue treats null nextRunAt as due (never run before)", () => {
  assert.equal(isDue(null, new Date("2026-07-05T00:00:00Z")), true);
});

test("isDue is true when nextRunAt is in the past or exactly now", () => {
  const now = new Date("2026-07-05T12:00:00Z");
  assert.equal(isDue(new Date("2026-07-05T11:59:59Z"), now), true);
  assert.equal(isDue(new Date(now.getTime()), now), true);
});

test("isDue is false when nextRunAt is in the future", () => {
  const now = new Date("2026-07-05T12:00:00Z");
  assert.equal(isDue(new Date("2026-07-05T12:00:01Z"), now), false);
  assert.equal(isDue(new Date("2026-07-06T00:00:00Z"), now), false);
});

test("computeNextRunAt adds frequencyMinutes to now", () => {
  const now = new Date("2026-07-05T12:00:00Z");
  // 6 小時（360 分）＝ AI 判定預設。
  assert.equal(
    computeNextRunAt(now, 360).getTime(),
    new Date("2026-07-05T18:00:00Z").getTime(),
  );
  // 1440 分＝約每日一次（NPC 自動演變預設）。
  assert.equal(
    computeNextRunAt(now, 1440).getTime(),
    new Date("2026-07-06T12:00:00Z").getTime(),
  );
  // 1 分鐘最小間隔。
  assert.equal(
    computeNextRunAt(now, 1).getTime(),
    new Date("2026-07-05T12:01:00Z").getTime(),
  );
});

// ── Task #230 — 頻率防呆：0/負值/NaN/荒謬大值都不得造成緊迴圈或永不執行 ──

test("sanitizeFrequencyMinutes clamps zero/negative to the minimum", () => {
  assert.equal(sanitizeFrequencyMinutes(0), MIN_FREQUENCY_MINUTES);
  assert.equal(sanitizeFrequencyMinutes(-1), MIN_FREQUENCY_MINUTES);
  assert.equal(sanitizeFrequencyMinutes(-99999), MIN_FREQUENCY_MINUTES);
});

test("sanitizeFrequencyMinutes clamps absurdly large values to the maximum", () => {
  assert.equal(sanitizeFrequencyMinutes(MAX_FREQUENCY_MINUTES + 1), MAX_FREQUENCY_MINUTES);
  assert.equal(sanitizeFrequencyMinutes(9_999_999), MAX_FREQUENCY_MINUTES);
});

test("sanitizeFrequencyMinutes coerces non-finite / fractional inputs", () => {
  // 任何非有限值（NaN／±Infinity）都視為壞值，夾成最小值（安全預設）。
  assert.equal(sanitizeFrequencyMinutes(Number.NaN), MIN_FREQUENCY_MINUTES);
  assert.equal(sanitizeFrequencyMinutes(Number.POSITIVE_INFINITY), MIN_FREQUENCY_MINUTES);
  assert.equal(sanitizeFrequencyMinutes(Number.NEGATIVE_INFINITY), MIN_FREQUENCY_MINUTES);
  // 小數無條件捨去後再夾。
  assert.equal(sanitizeFrequencyMinutes(5.9), 5);
  assert.equal(sanitizeFrequencyMinutes(0.5), MIN_FREQUENCY_MINUTES);
});

test("sanitizeFrequencyMinutes passes valid values through unchanged", () => {
  assert.equal(sanitizeFrequencyMinutes(1), 1);
  assert.equal(sanitizeFrequencyMinutes(360), 360);
  assert.equal(sanitizeFrequencyMinutes(1440), 1440);
  assert.equal(sanitizeFrequencyMinutes(MAX_FREQUENCY_MINUTES), MAX_FREQUENCY_MINUTES);
});

test("computeNextRunAt never returns a time at or before now (no tight loop)", () => {
  const now = new Date("2026-07-05T12:00:00Z");
  // 0/負值都被夾成最小 1 分鐘 → 下次到期嚴格在未來。
  assert.equal(
    computeNextRunAt(now, 0).getTime(),
    new Date("2026-07-05T12:01:00Z").getTime(),
  );
  assert.equal(
    computeNextRunAt(now, -100).getTime(),
    new Date("2026-07-05T12:01:00Z").getTime(),
  );
  assert.ok(computeNextRunAt(now, 0).getTime() > now.getTime());
  assert.ok(computeNextRunAt(now, -100).getTime() > now.getTime());
});

test("computeNextRunAt caps absurd frequencies (no never-running loop)", () => {
  const now = new Date("2026-07-05T12:00:00Z");
  const capped = computeNextRunAt(now, 9_999_999).getTime();
  assert.equal(
    capped,
    now.getTime() + MAX_FREQUENCY_MINUTES * 60_000,
  );
});
