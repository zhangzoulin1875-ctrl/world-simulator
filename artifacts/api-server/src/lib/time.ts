// Shared time helpers for daily/schedule logic. The whole game uses local
// calendar dates in NEWS_SCHEDULE_TZ (default Asia/Taipei) so that "today"
// lines up across the turn engine, military daily quotas and admin tools.

/** Timezone used for all daily/schedule boundaries (override via env). */
export const NEWS_SCHEDULE_TZ = process.env["NEWS_SCHEDULE_TZ"] ?? "Asia/Taipei";

/** Format an instant as YYYY-MM-DD in the configured schedule timezone. */
export function localDateString(d: Date): string {
  // en-CA renders ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: NEWS_SCHEDULE_TZ }).format(
    d,
  );
}

/**
 * Offset (ms) of the given instant in `timeZone` relative to UTC, such that
 * `localWallClock = utcInstant + offset`. Computed via Intl so it respects DST.
 */
export function tzOffsetMs(d: Date, timeZone: string = NEWS_SCHEDULE_TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (type: string) =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUTC - d.getTime();
}

/**
 * The UTC instant for local calendar date `YYYY-MM-DD` at `hour:minute` in the
 * schedule timezone. Used by the multi-slot turn scheduler to turn each
 * configured wall-clock time into a comparable real-world instant.
 */
export function localSlotInstant(
  localDate: string,
  hour: number,
  minute: number,
  timeZone: string = NEWS_SCHEDULE_TZ,
): Date {
  const [y, m, d] = localDate.split("-").map((s) => Number.parseInt(s, 10));
  // First guess: interpret the wall clock as if it were UTC, then correct by the
  // zone offset at that instant (single-pass; sufficient outside DST fold edges).
  const guess = Date.UTC(y!, (m! - 1), d!, hour, minute, 0);
  const offset = tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}
