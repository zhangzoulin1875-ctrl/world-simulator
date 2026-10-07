import { Client, Events, GatewayIntentBits, Status } from "discord.js";
import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { attachSupportBot, setDiagnosticsProvider } from "./supportBot";
import { startCodeIndexRefresh } from "./supportCodeSource";
import { assessLiveness, describeCloseCode, isConfigClose, restartDelayMs, type Liveness } from "./botHealth";

// 機器人用途：遊戲 DM 通知＋AI 客服頻道。客服要讀訊息內容，所以需要 GuildMessages 與
// 特權的 MessageContent intent（必須在 Discord Developer Portal → Bot 開啟，否則登入會被
// 4014 拒絕且 discord.js 不會重連）。

export interface BotState {
  ready: boolean;
  username: string | null;
  guildCount: number;
}

/** 供 /api/bot/status 曝露的診斷資訊：下次出事可以從外部直接看到原因。 */
export interface BotDiagnostics {
  liveness: Liveness;
  pingMs: number | null;
  lastHeartbeatAgoSec: number | null;
  lastDisconnectCode: number | null;
  lastDisconnectReason: string | null;
  lastDisconnectAgoMin: number | null;
  restarts: number;
  lastRestartReason: string | null;
}

const diag = {
  lastHeartbeatAt: null as number | null,
  readySince: null as number | null,
  connectingSince: null as number | null,
  lastDisconnectCode: null as number | null,
  lastDisconnectAt: null as number | null,
  restarts: 0,
  lastRestartReason: null as string | null,
  restartAttempt: 0,
  nextRestartAllowedAt: 0,
};

const state: BotState = {
  ready: false,
  username: null,
  guildCount: 0,
};

let client: Client | null = null;

let loginAttempt = 0;
let loginRetryTimer: NodeJS.Timeout | null = null;
let currentToken: string | null = null;

function clearLoginRetry(): void {
  if (loginRetryTimer) {
    clearTimeout(loginRetryTimer);
    loginRetryTimer = null;
  }
}

function isWebsocketReady(): boolean {
  if (!client) return false;
  // discord.js exposes the underlying gateway shard manager status. When the
  // shard is `Ready` the bot is fully connected; transient values like
  // Connecting/Resuming/Reconnecting indicate self-healing in progress.
  try {
    return (client.ws as { status?: number }).status === Status.Ready;
  } catch {
    return false;
  }
}

/** 最近一次心跳 ACK：優先讀 discord.js 的結構化欄位（shard.lastPingTimestamp），再與 Debug 事件記錄取較新者。 */
function latestHeartbeatAt(): number | null {
  let best = diag.lastHeartbeatAt;
  try {
    for (const shard of client?.ws.shards.values() ?? []) {
      const t = (shard as { lastPingTimestamp?: number }).lastPingTimestamp;
      if (typeof t === "number" && t > 0 && (best === null || t > best)) best = t;
    }
  } catch { /* 取不到就只用 Debug 記錄 */ }
  return best;
}

function currentLiveness(now = Date.now()): Liveness {
  let wsReady = false, wsDisconnected = true;
  if (client) {
    try {
      const st = (client.ws as { status?: number }).status;
      wsReady = st === Status.Ready;
      wsDisconnected = st === Status.Disconnected || st === Status.Idle;
    } catch { /* 視為斷線 */ }
  }
  return assessLiveness({
    hasClient: client !== null,
    wsReady,
    wsDisconnected,
    lastHeartbeatAt: latestHeartbeatAt(),
    readySince: diag.readySince,
    connectingSince: diag.connectingSince,
    now,
  });
}

export function getBotState(): BotState {
  // 短暫重連（connecting）仍算連著，避免畫面閃爍；殭屍（Ready 但心跳停了）與斷線才回報 false。
  const l = currentLiveness();
  return { ...state, ready: l === "healthy" || l === "connecting" };
}

export function getBotDiagnostics(): BotDiagnostics {
  const now = Date.now();
  return {
    liveness: currentLiveness(now),
    pingMs: client && Number.isFinite(client.ws.ping) && client.ws.ping >= 0 ? Math.round(client.ws.ping) : null,
    lastHeartbeatAgoSec: (() => { const t = latestHeartbeatAt(); return t === null ? null : Math.round((now - t) / 1000); })(),
    lastDisconnectCode: diag.lastDisconnectCode,
    lastDisconnectReason: diag.lastDisconnectCode === null ? null : describeCloseCode(diag.lastDisconnectCode),
    lastDisconnectAgoMin: diag.lastDisconnectAt === null ? null : Math.round((now - diag.lastDisconnectAt) / 60000),
    restarts: diag.restarts,
    lastRestartReason: diag.lastRestartReason,
  };
}

/** 測試用：重設重啟退避與診斷狀態。 */
export function __resetBotDiagForTest(): void {
  diag.lastHeartbeatAt = null; diag.readySince = null; diag.connectingSince = null;
  diag.lastDisconnectCode = null; diag.lastDisconnectAt = null;
  diag.restarts = 0; diag.lastRestartReason = null; diag.restartAttempt = 0; diag.nextRestartAllowedAt = 0;
  restarting = false;
}

/** 測試用：直接跑一次看門狗檢查。 */
export async function __runWatchdogForTest(): Promise<void> {
  await runWatchdog();
}

export function getDiscordClient(): Client | null {
  return client;
}

export async function stopDiscordBot(): Promise<void> {
  clearLoginRetry();
  loginAttempt = 0;
  currentToken = null;
  diag.lastHeartbeatAt = null;
  diag.readySince = null;
  diag.connectingSince = null;
  if (!client) return;
  try {
    await client.destroy();
  } catch (err) {
    logger.warn({ err }, "Error destroying client");
  }
  client = null;
  state.ready = false;
  state.username = null;
  state.guildCount = 0;
}

export async function validateToken(token: string): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const test = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await test.login(token);
    const username = test.user?.username ?? "unknown";
    await test.destroy();
    return { ok: true, username };
  } catch (err) {
    try { await test.destroy(); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function getStoredToken(): Promise<string | null> {
  const envToken = process.env["DISCORD_BOT_TOKEN"];
  if (envToken && envToken.trim().length > 0) return envToken;
  const rows = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, 1)).limit(1);
  return rows[0]?.token ?? null;
}

export async function saveToken(token: string): Promise<void> {
  await db
    .insert(botSettingsTable)
    .values({ id: 1, token, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botSettingsTable.id,
      set: { token, updatedAt: new Date() },
    });
}

export async function restartDiscordBot(token: string): Promise<void> {
  await stopDiscordBot();
  await new Promise((r) => setTimeout(r, 200));
  startDiscordBot(token);
}

function scheduleLoginRetry(token: string): void {
  const MAX_DELAY_MS = 60_000;
  loginAttempt += 1;
  // Never give up: even after many failures, the watchdog or transient
  // outages should keep trying. Cap the backoff at MAX_DELAY_MS.
  const delay = Math.min(MAX_DELAY_MS, 1_000 * 2 ** Math.min(loginAttempt - 1, 6));
  logger.warn(
    { attempt: loginAttempt, delayMs: delay },
    "Scheduling Discord bot login retry",
  );
  clearLoginRetry();
  loginRetryTimer = setTimeout(() => {
    loginRetryTimer = null;
    if (client || currentToken !== token) return;
    startDiscordBot(token);
  }, delay);
}

export function startDiscordBot(token: string): void {
  if (client) return;
  clearLoginRetry();
  currentToken = token;

  client = new Client({
    // GuildMessages + MessageContent：AI 客服要讀客服頻道的訊息內容。
    // MessageContent 是特權 intent，需在 Discord Developer Portal 開啟。
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  setDiagnosticsProvider(getBotDiagnostics);
  attachSupportBot(client);
  startCodeIndexRefresh();

  diag.connectingSince = Date.now();
  diag.lastHeartbeatAt = null;
  diag.readySince = null;

  client.once(Events.ClientReady, (c) => {
    state.ready = true;
    diag.readySince = Date.now();
    diag.connectingSince = null;
    diag.restartAttempt = 0;
    loginAttempt = 0;
    state.username = c.user.username;
    state.guildCount = c.guilds.cache.size;
    logger.info(
      { username: c.user.username, guilds: c.guilds.cache.size },
      "Discord bot connected",
    );
  });

  client.on(Events.GuildCreate, () => {
    if (client) state.guildCount = client.guilds.cache.size;
  });

  client.on(Events.GuildDelete, () => {
    if (client) state.guildCount = client.guilds.cache.size;
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, "Discord client error");
  });

  client.on(Events.ShardError, (err) => {
    logger.error({ err }, "Discord shard error");
  });

  client.on(Events.Invalidated, () => {
    // Session 被 Discord 判定失效：discord.js 不會自己復原，直接重建。
    logger.error({}, "Discord session invalidated — restarting bot");
    void forceRestart("session invalidated");
  });

  // 心跳 ACK：連線活著時每 ~41 秒一次，是判斷「是不是殭屍連線」的依據。
  // （discord.js 的 Debug 事件會印出 "Heartbeat acknowledged"。）
  client.on(Events.Debug, (msg) => {
    if (msg.includes("Heartbeat acknowledged")) diag.lastHeartbeatAt = Date.now();
  });

  // ShardDisconnect＝discord.js 判定「不可恢復」(Token 錯、Intent 未開…) 而放棄重連，
  // 不是暫時斷線。記錄關閉碼並重建（設定性錯誤會拉長退避，避免狂刷）。
  client.on(Events.ShardDisconnect, (event) => {
    const code = (event as { code?: number } | undefined)?.code ?? null;
    diag.lastDisconnectCode = code;
    diag.lastDisconnectAt = Date.now();
    logger.error(
      { code, reason: describeCloseCode(code) },
      "Discord shard disconnected and will not auto-reconnect",
    );
    void forceRestart(`shard disconnect ${code ?? "?"}: ${describeCloseCode(code)}`, isConfigClose(code));
  });

  client.on(Events.ShardReconnecting, () => {
    if (diag.connectingSince === null) diag.connectingSince = Date.now();
  });

  client.on(Events.ShardResume, () => {
    state.ready = true;
    diag.connectingSince = null;
    diag.readySince = Date.now();
  });

  client.on(Events.ShardReady, () => {
    diag.connectingSince = null;
    diag.readySince = Date.now();
  });

  client.login(token).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    // discord.js 對未開的特權 intent 會丟 "Used disallowed intents"，給一句人看得懂的提示。
    if (/disallowed intents/i.test(msg)) {
      logger.error({ err }, "Failed to login Discord bot: Message Content Intent 沒有開（Developer Portal → Bot → Privileged Gateway Intents）");
      diag.lastDisconnectCode = 4014;
      diag.lastDisconnectAt = Date.now();
    } else {
      logger.error({ err }, "Failed to login Discord bot");
    }
    const failedClient = client;
    client = null;
    state.ready = false;
    if (failedClient) {
      failedClient.destroy().catch(() => undefined);
    }
    if (currentToken === token) {
      scheduleLoginRetry(token);
    }
  });
}

const WATCHDOG_INTERVAL_MS = 60 * 1000;
let watchdogTimer: NodeJS.Timeout | null = null;
let watchdogRunning = false;
let restarting = false;

/**
 * 重建機器人連線。有互斥與退避：設定性錯誤（Token／Intent）間隔拉長，避免狂刷被 Discord 限流。
 * 回傳是否真的執行了重啟。
 */
export async function forceRestart(reason: string, configError = false): Promise<boolean> {
  if (restarting) return false;
  const now = Date.now();
  if (now < diag.nextRestartAllowedAt) return false;
  restarting = true;
  try {
    const token = currentToken ?? (await getStoredToken());
    if (!token) {
      logger.warn({ reason }, "Discord bot restart skipped: no token available");
      return false;
    }
    diag.restartAttempt += 1;
    diag.nextRestartAllowedAt = now + restartDelayMs(diag.restartAttempt, configError);
    diag.restarts += 1;
    diag.lastRestartReason = reason;
    logger.warn({ reason, attempt: diag.restartAttempt }, "Restarting Discord bot");
    await restartDiscordBot(token);
    return true;
  } catch (err) {
    logger.error({ err, reason }, "Discord bot restart failed");
    return false;
  } finally {
    restarting = false;
  }
}

async function runWatchdog(): Promise<void> {
  if (watchdogRunning) return;
  watchdogRunning = true;
  try {
    const l = currentLiveness();
    if (l === "healthy" || l === "connecting") {
      logger.debug({ liveness: l }, "Discord bot watchdog: ok");
      return;
    }
    // down／zombie：zombie 是「ws 說 Ready 但心跳停了」，一般檢查看不出來。
    await forceRestart(`watchdog: ${l}`);
  } finally {
    watchdogRunning = false;
  }
}

export function startBotWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    runWatchdog().catch((err) => logger.error({ err }, "watchdog tick failed"));
  }, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref();
  logger.info({ intervalMs: WATCHDOG_INTERVAL_MS }, "Discord bot watchdog started");
}
