import { eq } from "drizzle-orm";
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
  const [row] = await db
    .select({ enabled: autopilotSettingsTable.enabled })
    .from(playerNationsTable)
    .innerJoin(
      autopilotSettingsTable,
      eq(autopilotSettingsTable.nationId, playerNationsTable.id),
    )
    .where(eq(playerNationsTable.discordUserId, discordUserId))
    .limit(1);
  const locked = row?.enabled === true;
  cache.set(discordUserId, { at: Date.now(), locked });
  return locked;
}

export async function getAutopilotSettings(
  nationId: string,
): Promise<AutopilotSettings | null> {
  const [row] = await db
    .select()
    .from(autopilotSettingsTable)
    .where(eq(autopilotSettingsTable.nationId, nationId))
    .limit(1);
  return row ?? null;
}
