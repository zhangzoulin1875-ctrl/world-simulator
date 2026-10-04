import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * 資料庫保活。免費託管資料庫會把「一段時間沒有資料庫活動」的服務判定為閒置:
 *   - Aiven 免費方案:閒置會關機(需要定時活動)。
 *   - Supabase 免費方案:7 天沒活動會暫停。
 *   - Neon:相反,活動會喚醒 compute 燒額度,所以 Neon 預設不保活。
 *
 * 是否啟動:
 *   DB_KEEPALIVE=1 強制啟動;DB_KEEPALIVE=0 強制關閉;
 *   未設定時:連線主機含 "neon.tech" 則不啟動,其他(Aiven、Supabase…)預設啟動。
 * 間隔:DB_KEEPALIVE_MINUTES,預設 10,夾在 1~1440。
 *
 * 限制:這只在服務醒著時有效。Render 免費方案 15 分鐘沒有外部請求會讓整個程序休眠,
 * 內部計時器也會跟著停,所以對外的 /api/healthz ping 仍需保留。
 */
export const DEFAULT_KEEPALIVE_MINUTES = 10;

export function resolveKeepaliveMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_KEEPALIVE_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_KEEPALIVE_MINUTES;
  return Math.min(1440, Math.max(1, Math.floor(n)));
}

export function shouldKeepalive(env: { DB_KEEPALIVE?: string; DATABASE_URL?: string }): boolean {
  if (env.DB_KEEPALIVE === "1") return true;
  if (env.DB_KEEPALIVE === "0") return false;
  return !/neon\.tech/i.test(env.DATABASE_URL ?? "");
}

let inflight = false;

/** 跑一次保活查詢:讀真實資料表(非僅 SELECT 1),失敗只記錄、不重疊執行。 */
export async function pingDatabaseOnce(
  run: () => Promise<unknown> = () => db.execute(sql`SELECT count(*)::int AS n FROM world_game_state`),
): Promise<boolean> {
  if (inflight) return true;
  inflight = true;
  try {
    await run();
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message }, "db keepalive failed");
    return false;
  } finally {
    inflight = false;
  }
}

export function startDbKeepalive(): void {
  if (!shouldKeepalive({ DB_KEEPALIVE: process.env["DB_KEEPALIVE"], DATABASE_URL: process.env["DATABASE_URL"] })) return;
  const minutes = resolveKeepaliveMinutes(process.env["DB_KEEPALIVE_MINUTES"]);
  setTimeout(() => void pingDatabaseOnce(), 60_000).unref();
  setInterval(() => void pingDatabaseOnce(), minutes * 60_000).unref();
  logger.info({ minutes }, "db keepalive started");
}
