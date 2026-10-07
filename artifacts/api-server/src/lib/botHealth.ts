/**
 * Discord 機器人連線健康判斷（純函式，可單測）。
 *
 * 為什麼需要：discord.js 的 `client.ws.status === Ready` 只代表「最後一次狀態」，連線被中間網路
 * 靜默切斷（半開連線）或 session 失效時仍可能顯示 Ready，但事件已不再送達，斜線指令就會
 * 逾時變成「該申請未受回應」。可靠的活性訊號是「心跳 ACK 的時間」：連線活著時每 ~41 秒更新一次。
 */

/** discord.js 認定「不可恢復」的關閉碼（discord.js 觸發 ShardDisconnect 就不會再重連）。 */
export const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: "Token 驗證失敗（Token 錯誤或已被重設）",
  4010: "Shard 設定無效",
  4011: "需要分片（Sharding Required）",
  4012: "API 版本無效",
  4013: "Intents 無效",
  4014: "未授權的特權 Intent（請到 Discord Developer Portal → Bot 開啟 Message Content Intent）",
};

export function describeCloseCode(code: number | null | undefined): string {
  if (code == null) return "未知";
  return FATAL_CLOSE_CODES[code] ?? `關閉碼 ${code}`;
}

/** 這個關閉碼是否屬於「設定性錯誤」：立刻重試只會再失敗，應退避並提示人工處理。 */
export function isConfigClose(code: number | null | undefined): boolean {
  return code != null && code in FATAL_CLOSE_CODES;
}

export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

export type Liveness = "healthy" | "connecting" | "zombie" | "down";

/**
 * 綜合判斷：
 *  - down：沒有 client 或 ws 已是 Disconnected／Idle
 *  - connecting：正在連線／重連（給一段寬限，過了仍沒好就當 zombie）
 *  - zombie：ws 說 Ready，但心跳 ACK 太久沒更新（或根本沒有過）
 *  - healthy：Ready 且心跳新鮮
 */
export function assessLiveness(input: {
  hasClient: boolean;
  wsReady: boolean;
  wsDisconnected: boolean;
  /** 最近一次心跳 ACK 的時間戳（ms）；沒有則 null */
  lastHeartbeatAt: number | null;
  /** 最近一次進入 Ready／Resume 的時間戳（ms）；沒有則 null */
  readySince: number | null;
  /** 最近一次開始連線／重連的時間戳（ms）；沒有則 null */
  connectingSince: number | null;
  now: number;
}): Liveness {
  const { hasClient, wsReady, wsDisconnected, lastHeartbeatAt, readySince, connectingSince, now } = input;
  if (!hasClient || wsDisconnected) return "down";
  if (!wsReady) {
    // 連線中：給 2 分鐘；超過就視為卡死。
    return connectingSince !== null && now - connectingSince > 2 * 60 * 1000 ? "zombie" : "connecting";
  }
  // Ready：剛上線的前 HEARTBEAT_STALE_MS 內還沒有 ACK 屬正常（第一次心跳要等 ~41 秒）。
  const ref = lastHeartbeatAt ?? readySince;
  if (ref === null) return "healthy";
  return now - ref > HEARTBEAT_STALE_MS ? "zombie" : "healthy";
}

/** 重啟退避：設定性錯誤拉長間隔（避免被 Discord 限流／洗日誌），其他錯誤快速重試。 */
export function restartDelayMs(attempt: number, configError: boolean): number {
  const base = configError ? 5 * 60 * 1000 : 5_000;
  const cap = configError ? 30 * 60 * 1000 : 2 * 60 * 1000;
  return Math.min(cap, base * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
}
