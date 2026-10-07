import { logger } from "./logger";
import { startDiscordBot, getStoredToken, startBotWatchdog } from "./discordBot";

/**
 * 啟動 Discord 機器人與看門狗。獨立於遷移鏈：機器人只需要 Token，不該被幾十步資料庫遷移擋住
 * （遷移任何一步卡住，過去會讓機器人、看門狗、回合迴圈全部沒啟動，而 port 已開、/healthz 仍 200，
 * Render 不會重啟，外部看不出來）。
 * 讀 Token 若用資料庫（沒設環境變數），bot_settings 表在新庫上可能還沒建——失敗時重試，直到成功為止。
 */
let botBootStarted = false;

/** 測試用：允許重複啟動。 */
export function __resetBotEarlyForTest(): void {
  botBootStarted = false;
}

export function startBotEarly(): void {
  if (botBootStarted) return;
  botBootStarted = true;
  const attempt = (n: number): void => {
    getStoredToken()
      .then((token) => {
        if (token) {
          startDiscordBot(token);
        } else {
          logger.warn("No Discord bot token configured — set one via dashboard");
        }
      })
      .catch((err) => {
        const delay = Math.min(60_000, 3_000 * 2 ** Math.min(n, 5));
        logger.warn({ err, attempt: n + 1, retryInMs: delay }, "Failed to load bot token; retrying");
        setTimeout(() => attempt(n + 1), delay).unref();
      })
      .finally(() => startBotWatchdog());
  };
  attempt(0);
}
