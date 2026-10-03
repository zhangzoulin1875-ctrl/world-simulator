import { eq } from "drizzle-orm";
import { db, playerNationsTable } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #604 — 啟動遷移：掃描 player_nations 全表，找出「國名」不符合新規則
 * （超過 25 字、或含空白/標點/特殊符號）的列，以 1000–9999 的四位隨機數字取代，
 * 確保取代後的數字於 DB 全域唯一（衝突則重試）。幂等：已合規者不動。
 *
 * 新規則：/^[\p{L}\p{N}]+$/u（Unicode 字母與數字），長度 1–25。
 */
export async function runNationNameSanitizeMigration(): Promise<void> {
  await withTestMigrationStamp(
    "nation-name-sanitize",
    runNationNameSanitizeMigrationInner,
  );
}

const VALID_NATION_NAME = /^[\p{L}\p{N}]+$/u;
const MAX_LEN = 25;

async function runNationNameSanitizeMigrationInner(): Promise<void> {
  const allNations = await db
    .select({ id: playerNationsTable.id, name: playerNationsTable.name })
    .from(playerNationsTable);

  const violations = allNations.filter(
    (n) =>
      n.name !== null &&
      (n.name.length > MAX_LEN || !VALID_NATION_NAME.test(n.name)),
  );

  if (violations.length === 0) {
    logger.info("nation name sanitize: no violations found, skipping");
    return;
  }

  logger.info(
    { count: violations.length },
    "nation name sanitize: found violations, replacing with random 4-digit codes",
  );

  const taken = new Set(allNations.map((n) => n.name));

  for (const nation of violations) {
    // 隨機四位數字（1000–9999），衝突時重試，最多 100 次。
    let newName: string | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = String(Math.floor(Math.random() * 9000) + 1000);
      if (!taken.has(candidate)) {
        newName = candidate;
        taken.add(candidate);
        break;
      }
    }
    if (!newName) {
      logger.warn(
        { nationId: nation.id, oldName: nation.name },
        "nation name sanitize: could not find unique 4-digit replacement after 100 attempts, skipping",
      );
      continue;
    }

    await db
      .update(playerNationsTable)
      .set({ name: newName })
      .where(eq(playerNationsTable.id, nation.id));

    logger.warn(
      { nationId: nation.id, oldName: nation.name, newName },
      "nation name sanitize: replaced violating nation name",
    );
  }
}
