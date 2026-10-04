import { eq } from "drizzle-orm";
import { runAutopilotMigrationsInner } from "./autopilotMigrations";
import { logger } from "./logger";
import {
  db,
  autopilotSettingsTable,
  playerNationsTable,
  type AutopilotSettings,
} from "@workspace/db";

/**
 * 託管狀態查詢（含短 TTL 記憶體快取）。鎖定中介層每個寫入請求都會問一次
 * 「這個玩家是否託管中」，快取避免每次打 DB；啟用／解除時主動失效，
 * 多實例情境下最壞延遲 = TTL。
 */
const TTL_MS = 5_000;
const cache = new Map<string, { at: number; locked: boolean }>();

export function invalidateAutopilotCache(discordUserId?: string): void {
  if (discordUserId) cache.delete(discordUserId);
  else cache.clear();
}

/** 該 Discord 使用者的國家是否處於託管鎖定中。 */
export async function isAutopilotLocked(discordUserId: string): Promise<boolean> {
  const hit = cache.get(discordUserId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.locked;
  const [row] = await withAutopilotTable(() => db
    .select({ enabled: autopilotSettingsTable.enabled })
    .from(playerNationsTable)
    .innerJoin(
      autopilotSettingsTable,
      eq(autopilotSettingsTable.nationId, playerNationsTable.id),
    )
    .where(eq(playerNationsTable.discordUserId, discordUserId))
    .limit(1));
  const locked = row?.enabled === true;
  cache.set(discordUserId, { at: Date.now(), locked });
  return locked;
}

export async function getAutopilotSettings(
  nationId: string,
): Promise<AutopilotSettings | null> {
  const [row] = await withAutopilotTable(() => db
    .select()
    .from(autopilotSettingsTable)
    .where(eq(autopilotSettingsTable.nationId, nationId))
    .limit(1));
  return row ?? null;
}

/**
 * 自我修復：啟動遷移若因故沒建成 autopilot_settings（例如取鎖逾時後無鎖繼續卻失敗），
 * 第一次讀寫時補建（冪等，只 CREATE）。回傳 true 代表這次確實補建並值得重試。
 */
let repairing: Promise<boolean> | null = null;
export function ensureAutopilotTable(): Promise<boolean> {
  if (!repairing) {
    repairing = runAutopilotMigrationsInner()
      .then(() => {
        // 成功就立刻放行：之後若表又不見，下一次仍可再補建。
        repairing = null;
        return true;
      })
      .catch((err) => {
        logger.error({ err }, "autopilot: self-heal migration failed");
        // 失敗才節流 30 秒，避免資料庫不可用時每個請求都狂打 DDL。
        setTimeout(() => {
          repairing = null;
        }, 30_000);
        return false;
      });
  }
  return repairing;
}

/** Postgres 42P01 = undefined_table（drizzle 會把它包在 cause 裡）。 */
export function isMissingTableError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (code === "42P01") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** 執行 fn；遇缺表就自建後重試一次。 */
export async function withAutopilotTable<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    logger.warn({ err }, "autopilot: table missing, self-healing");
    if (!(await ensureAutopilotTable())) throw err;
    return fn();
  }
}
