import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * 資料庫保活：Supabase 免費版對「7 天內查詢太少」的專案會自動暫停。
 * 玩家冷清時，省電閘門會讓背景迴圈完全不碰 DB，因此另設每 12 小時一次的
 * 極輕量 `SELECT 1`（約每天 2 次，可忽略不計）。
 *
 * 僅在設定 DB_KEEPALIVE=1 時啟用（Neon 不需要、也不該用它定時喚醒 compute）。
 */
const KEEPALIVE_INTERVAL_MS = 12 * 60 * 60 * 1000;

export function startDbKeepalive(): void {
  if (process.env["DB_KEEPALIVE"] !== "1") return;
  const tick = () => {
    db.execute(sql`SELECT 1`).catch((err) =>
      logger.error({ err }, "db keepalive failed"),
    );
  };
  setTimeout(tick, 60_000);
  setInterval(tick, KEEPALIVE_INTERVAL_MS).unref();
  logger.info("db keepalive started (every 12h)");
}
