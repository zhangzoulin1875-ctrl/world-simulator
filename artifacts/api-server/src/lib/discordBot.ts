import { Client, Events, GatewayIntentBits, Status } from "discord.js";
import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { attachSupportBot } from "./supportBot";

// The bot no longer ingests any messages — it only needs a gateway connection
// so the game can DM players (diplomacy/turn notifications) via the REST client.
// Intents are reduced to the minimum (Guilds); Message Content / Guild Messages
// are intentionally NOT requested.

export interface BotState {
  ready: boolean;
  username: string | null;
  guildCount: number;
}

const state: BotState = {
  ready: false,
  username: null,
  guildCount: 0,
};

let client: Client | null = null;

const DISCONNECT_GRACE_MS = 10_000;
let disconnectedSince: number | null = null;
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

export function getBotState(): BotState {
  let ready = isWebsocketReady();
  if (!ready && disconnectedSince !== null) {
    // During the grace period after a shard disconnect, keep reporting ready
    // so that automatic reconnects don't cause UI flapping.
    if (Date.now() - disconnectedSince < DISCONNECT_GRACE_MS) {
      ready = true;
    }
  }
  return { ...state, ready };
}

export function getDiscordClient(): Client | null {
  return client;
}

export async function stopDiscordBot(): Promise<void> {
  clearLoginRetry();
  loginAttempt = 0;
  currentToken = null;
  disconnectedSince = null;
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
  attachSupportBot(client);

  client.once(Events.ClientReady, (c) => {
    state.ready = true;
    disconnectedSince = null;
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

  client.on(Events.ShardDisconnect, () => {
    // Don't immediately mark as disconnected — discord.js auto-reconnects.
    // getBotState() applies a grace period before flipping ready to false.
    if (disconnectedSince === null) disconnectedSince = Date.now();
  });

  client.on(Events.ShardReconnecting, () => {
    if (disconnectedSince === null) disconnectedSince = Date.now();
  });

  client.on(Events.ShardResume, () => {
    state.ready = true;
    disconnectedSince = null;
  });

  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to login Discord bot");
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

const WATCHDOG_INTERVAL_MS = 10 * 60 * 1000;
let watchdogTimer: NodeJS.Timeout | null = null;
let watchdogRunning = false;

async function runWatchdog(): Promise<void> {
  if (watchdogRunning) return;
  watchdogRunning = true;
  try {
    const ready = isWebsocketReady();
    if (ready) {
      logger.debug({}, "Discord bot watchdog: connection healthy");
      return;
    }
    // Disconnected. Try the in-memory token first, fall back to stored token.
    const token = currentToken ?? (await getStoredToken());
    if (!token) {
      logger.warn({}, "Discord bot watchdog: not connected and no token available");
      return;
    }
    logger.warn({}, "Discord bot watchdog: not connected, restarting");
    try {
      await restartDiscordBot(token);
    } catch (err) {
      logger.error({ err }, "Discord bot watchdog: restart failed");
    }
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
