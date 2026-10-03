/**
 * Task #230 — integration tests (real DB) confirming the two admin-adjustable
 * background loops (NPC 自動演變 / AI 外交·戰役判定) actually reschedule at the
 * frequency stored in world_game_state, run independently of each other, and
 * stay safe under a misconfigured frequency.
 *
 * The pure scheduler helpers (isDue / computeNextRunAt / sanitizeFrequencyMinutes)
 * are covered by worldScheduler.test.ts. This file exercises the real atomic
 * "condition-UPDATE claim" SQL that drives the loops:
 *   - claimWorldSimSchedule advances ONLY its own next_run_at, by exactly its
 *     own frequency (next_run_at − last_run_at, both derived from the same NOW()
 *     inside the UPDATE — precise, not flaky). claimAiJudgmentSchedule now takes
 *     caller-computed (now, nextRunAt) timestamps (the blackout-aware next-run
 *     math lives in settlementBlackout.ts / its unit tests); the claim itself
 *     still atomically gates on enabled + due (next_run_at <= NOW()).
 *   - Changing one loop's frequency column changes the next scheduled run for
 *     that loop only; the other loop is untouched.
 *   - A disabled or not-yet-due loop is never claimed.
 *   - The DB CHECK constraint rejects a zero / negative frequency, so a
 *     misconfigured value can never cause a tight loop or a never-running loop.
 *
 * Operates on the singleton world_game_state row (id=1): the original settings
 * columns are snapshotted in before() and restored in after(). Runs serially in
 * the test:integration workflow (--test-concurrency=1), so the singleton is not
 * contended by other files.
 *
 * Requires DATABASE_URL pointing at a DB migrated by a normal server start.
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the world-scheduler integration tests",
  );
}

const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runMapRegionEraStatsSync } = await import("./mapRegionEraStats");
const { runWorldSimMigrations } = await import("./worldSimMigrations");
const { claimWorldSimSchedule, claimAiJudgmentSchedule } = await import(
  "./worldScheduler"
);

const MINUTE_MS = 60_000;

/**
 * Drizzle wraps the driver error: the top-level message is "Failed query: …"
 * and the CHECK-constraint text lives in the `cause` chain. Match across it.
 */
function isCheckViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const msg = (cur as { message?: unknown }).message;
    if (typeof msg === "string" && /check|violat|constraint/i.test(msg)) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

interface ScheduleRow {
  worldSimEnabled: boolean;
  worldSimFrequencyMinutes: number;
  worldSimLastRunAt: Date | null;
  worldSimNextRunAt: Date | null;
  aiJudgmentEnabled: boolean;
  aiJudgmentFrequencyMinutes: number;
  aiJudgmentLastRunAt: Date | null;
  aiJudgmentNextRunAt: Date | null;
  worldSimIntensity: number;
  worldSimHostileToPlayers: boolean;
}

async function readSchedule(): Promise<ScheduleRow> {
  const res = await db.execute(sql`
    SELECT world_sim_enabled,
           world_sim_frequency_minutes,
           world_sim_last_run_at,
           world_sim_next_run_at,
           ai_judgment_enabled,
           ai_judgment_frequency_minutes,
           ai_judgment_last_run_at,
           ai_judgment_next_run_at,
           world_sim_intensity,
           world_sim_hostile_to_players
    FROM world_game_state WHERE id = 1
  `);
  const r = res.rows[0] as Record<string, unknown>;
  assert.ok(r, "world_game_state id=1 must exist after migrations");
  const asDate = (v: unknown): Date | null => (v == null ? null : new Date(v as string));
  return {
    worldSimEnabled: Boolean(r["world_sim_enabled"]),
    worldSimFrequencyMinutes: Number(r["world_sim_frequency_minutes"]),
    worldSimLastRunAt: asDate(r["world_sim_last_run_at"]),
    worldSimNextRunAt: asDate(r["world_sim_next_run_at"]),
    aiJudgmentEnabled: Boolean(r["ai_judgment_enabled"]),
    aiJudgmentFrequencyMinutes: Number(r["ai_judgment_frequency_minutes"]),
    aiJudgmentLastRunAt: asDate(r["ai_judgment_last_run_at"]),
    aiJudgmentNextRunAt: asDate(r["ai_judgment_next_run_at"]),
    worldSimIntensity: Number(r["world_sim_intensity"]),
    worldSimHostileToPlayers: Boolean(r["world_sim_hostile_to_players"]),
  };
}

/** Configure both loops, forcing both due (next_run_at 1h in the past). */
async function seedSchedule(opts: {
  worldSimEnabled: boolean;
  worldSimFrequencyMinutes: number;
  aiJudgmentEnabled: boolean;
  aiJudgmentFrequencyMinutes: number;
  /** true = next_run_at in the past (due); false = in the future (not due). */
  due: boolean;
}) {
  const nextExpr = opts.due
    ? sql`NOW() - INTERVAL '1 hour'`
    : sql`NOW() + INTERVAL '1 hour'`;
  await db.execute(sql`
    UPDATE world_game_state SET
      world_sim_enabled = ${opts.worldSimEnabled},
      world_sim_frequency_minutes = ${opts.worldSimFrequencyMinutes},
      world_sim_last_run_at = NULL,
      world_sim_next_run_at = ${nextExpr},
      ai_judgment_enabled = ${opts.aiJudgmentEnabled},
      ai_judgment_frequency_minutes = ${opts.aiJudgmentFrequencyMinutes},
      ai_judgment_last_run_at = NULL,
      ai_judgment_next_run_at = ${nextExpr}
    WHERE id = 1
  `);
}

/** After a claim: next_run_at must equal last_run_at + frequency exactly. */
function assertRescheduledBy(
  lastRunAt: Date | null,
  nextRunAt: Date | null,
  frequencyMinutes: number,
  label: string,
) {
  assert.ok(lastRunAt, `${label}: last_run_at should be set after a claim`);
  assert.ok(nextRunAt, `${label}: next_run_at should be set after a claim`);
  const deltaMs = nextRunAt.getTime() - lastRunAt.getTime();
  assert.equal(
    deltaMs,
    frequencyMinutes * MINUTE_MS,
    `${label}: next_run_at − last_run_at should equal ${frequencyMinutes} min`,
  );
  assert.ok(
    nextRunAt.getTime() > lastRunAt.getTime(),
    `${label}: next run must be strictly in the future (no tight loop)`,
  );
}

let original: ScheduleRow;

before(async () => {
  await runGameMigrations();
  await runMapRegionEraStatsSync();
  await runWorldSimMigrations();
  original = await readSchedule();
});

after(async () => {
  // Restore the singleton exactly as we found it.
  await db.execute(sql`
    UPDATE world_game_state SET
      world_sim_enabled = ${original.worldSimEnabled},
      world_sim_frequency_minutes = ${original.worldSimFrequencyMinutes},
      world_sim_last_run_at = ${original.worldSimLastRunAt},
      world_sim_next_run_at = ${original.worldSimNextRunAt},
      ai_judgment_enabled = ${original.aiJudgmentEnabled},
      ai_judgment_frequency_minutes = ${original.aiJudgmentFrequencyMinutes},
      ai_judgment_last_run_at = ${original.aiJudgmentLastRunAt},
      ai_judgment_next_run_at = ${original.aiJudgmentNextRunAt},
      world_sim_intensity = ${original.worldSimIntensity},
      world_sim_hostile_to_players = ${original.worldSimHostileToPlayers}
    WHERE id = 1
  `);
  await pool.end();
});

test("each loop reschedules by its own frequency, independently", async () => {
  await seedSchedule({
    worldSimEnabled: true,
    worldSimFrequencyMinutes: 100,
    aiJudgmentEnabled: true,
    aiJudgmentFrequencyMinutes: 200,
    due: true,
  });
  const before = await readSchedule();
  assert.ok(before.worldSimNextRunAt && before.aiJudgmentNextRunAt);

  // Claim ONLY the world-sim loop.
  assert.equal(await claimWorldSimSchedule(), true, "world-sim should claim");
  const afterWs = await readSchedule();
  assertRescheduledBy(
    afterWs.worldSimLastRunAt,
    afterWs.worldSimNextRunAt,
    100,
    "world-sim",
  );
  // The AI-judgment loop must be completely untouched.
  assert.equal(afterWs.aiJudgmentLastRunAt, null, "ai last_run untouched");
  assert.equal(
    afterWs.aiJudgmentNextRunAt?.getTime(),
    before.aiJudgmentNextRunAt?.getTime(),
    "ai next_run untouched by world-sim claim",
  );

  // Claim the AI-judgment loop with caller-computed timestamps (last = now,
  // next = now + its 200-min frequency), mirroring how the tick computes them.
  const ajNow = new Date();
  const ajNext = new Date(ajNow.getTime() + 200 * MINUTE_MS);
  const claim = await claimAiJudgmentSchedule(ajNow, ajNext);
  assert.ok(claim, "ai-judgment should claim and return settings");
  const afterAi = await readSchedule();
  assertRescheduledBy(
    afterAi.aiJudgmentLastRunAt,
    afterAi.aiJudgmentNextRunAt,
    200,
    "ai-judgment",
  );
  // The world-sim schedule is unchanged from its own claim above.
  assert.equal(
    afterAi.worldSimNextRunAt?.getTime(),
    afterWs.worldSimNextRunAt?.getTime(),
    "world-sim next_run untouched by ai-judgment claim",
  );
});

test("updating the frequency column changes the next scheduled run", async () => {
  // Start at 100 min, claim once.
  await seedSchedule({
    worldSimEnabled: true,
    worldSimFrequencyMinutes: 100,
    aiJudgmentEnabled: false,
    aiJudgmentFrequencyMinutes: 360,
    due: true,
  });
  assert.equal(await claimWorldSimSchedule(), true);
  const first = await readSchedule();
  assertRescheduledBy(
    first.worldSimLastRunAt,
    first.worldSimNextRunAt,
    100,
    "world-sim @100",
  );

  // Admin lowers the frequency to 15 min; force due again and re-claim.
  await db.execute(sql`
    UPDATE world_game_state
    SET world_sim_frequency_minutes = 15,
        world_sim_next_run_at = NOW() - INTERVAL '1 hour'
    WHERE id = 1
  `);
  assert.equal(await claimWorldSimSchedule(), true);
  const second = await readSchedule();
  assertRescheduledBy(
    second.worldSimLastRunAt,
    second.worldSimNextRunAt,
    15,
    "world-sim @15",
  );
});

test("a disabled loop is never claimed; the other loop still runs", async () => {
  await seedSchedule({
    worldSimEnabled: false, // disabled
    worldSimFrequencyMinutes: 100,
    aiJudgmentEnabled: true,
    aiJudgmentFrequencyMinutes: 200,
    due: true,
  });
  const before = await readSchedule();

  assert.equal(
    await claimWorldSimSchedule(),
    false,
    "disabled world-sim must not claim",
  );
  const afterWs = await readSchedule();
  assert.equal(
    afterWs.worldSimNextRunAt?.getTime(),
    before.worldSimNextRunAt?.getTime(),
    "disabled loop next_run must not advance",
  );
  assert.equal(afterWs.worldSimLastRunAt, null, "disabled loop last_run stays null");

  // The enabled loop is unaffected by the other being disabled.
  assert.ok(
    await claimAiJudgmentSchedule(
      new Date(),
      new Date(Date.now() + 200 * MINUTE_MS),
    ),
    "enabled ai-judgment still claims",
  );
});

test("a not-yet-due loop is not claimed", async () => {
  await seedSchedule({
    worldSimEnabled: true,
    worldSimFrequencyMinutes: 100,
    aiJudgmentEnabled: true,
    aiJudgmentFrequencyMinutes: 200,
    due: false, // next_run_at in the future
  });
  assert.equal(
    await claimWorldSimSchedule(),
    false,
    "future next_run must not claim (world-sim)",
  );
  assert.equal(
    await claimAiJudgmentSchedule(
      new Date(),
      new Date(Date.now() + 200 * MINUTE_MS),
    ),
    null,
    "future next_run must not claim (ai-judgment)",
  );
});

test("DB CHECK rejects a zero / negative frequency (no tight loop possible)", async () => {
  for (const badValue of [0, -1, -1440]) {
    await assert.rejects(
      db.execute(sql`
        UPDATE world_game_state
        SET world_sim_frequency_minutes = ${badValue}
        WHERE id = 1
      `),
      isCheckViolation,
      `world_sim_frequency_minutes = ${badValue} must be rejected`,
    );
    await assert.rejects(
      db.execute(sql`
        UPDATE world_game_state
        SET ai_judgment_frequency_minutes = ${badValue}
        WHERE id = 1
      `),
      isCheckViolation,
      `ai_judgment_frequency_minutes = ${badValue} must be rejected`,
    );
  }

  // The columns retain a valid value, so the claim SQL always advances forward.
  await seedSchedule({
    worldSimEnabled: true,
    worldSimFrequencyMinutes: 1, // minimum allowed
    aiJudgmentEnabled: false,
    aiJudgmentFrequencyMinutes: 360,
    due: true,
  });
  assert.equal(await claimWorldSimSchedule(), true);
  const after = await readSchedule();
  assertRescheduledBy(
    after.worldSimLastRunAt,
    after.worldSimNextRunAt,
    1,
    "world-sim @min",
  );
});
