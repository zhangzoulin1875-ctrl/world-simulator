import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client, Events, Status } from "discord.js";
import {
  startDiscordBot, stopDiscordBot, getBotState, getBotDiagnostics, getDiscordClient,
  forceRestart, __resetBotDiagForTest, __runWatchdogForTest,
} from "./discordBot";

/**
 * 不連 Discord：把 Client.prototype.login 換成假的，只驗證我們自己的「判斷＋重啟」邏輯。
 * 用真的 discord.js Client 物件，直接操控 ws.status 與 shard 心跳時間。
 */
const realLogin = Client.prototype.login;
let logins = 0;
let loginImpl: () => Promise<string> = async () => "ok";

beforeEach(async () => {
  logins = 0;
  commandRegistrations = 0;
  loginImpl = async () => "ok";
  (Client.prototype as unknown as { login: () => Promise<string> }).login = async function () { logins++; return loginImpl(); };
  await stopDiscordBot();
  __resetBotDiagForTest();
});
afterEach(async () => {
  await stopDiscordBot();
  Client.prototype.login = realLogin;
});

let commandRegistrations = 0;

/** 讓目前的 client 看起來「已 Ready，且最近一次心跳在 agoMs 毫秒前」。 */
function makeReady(agoMs: number): void {
  const c = getDiscordClient()!;
  (c.ws as unknown as { status: number }).status = Status.Ready;
  c.ws.shards.set(0, { lastPingTimestamp: Date.now() - agoMs } as never);
  c.emit(Events.ClientReady, {
    user: { username: "bot" },
    guilds: { cache: { size: 1 } },
    application: {
      commands: { set: async () => { commandRegistrations++; return []; } },
      fetch: async () => ({ owner: { id: "o" } }),
    },
  } as never);
}

test("健康的連線：getBotState.ready=true，看門狗不重啟", async () => {
  startDiscordBot("tok");
  makeReady(20_000);
  assert.equal(getBotState().ready, true);
  assert.equal(getBotDiagnostics().liveness, "healthy");
  await __runWatchdogForTest();
  assert.equal(getBotDiagnostics().restarts, 0);
  assert.equal(logins, 1);
});

test("核心（殭屍）：ws 顯示 Ready 但心跳停了 5 分鐘 → 回報未連線，看門狗重建連線", async () => {
  startDiscordBot("tok");
  makeReady(5 * 60 * 1000);
  assert.equal(getBotDiagnostics().liveness, "zombie");
  assert.equal(getBotState().ready, false, "舊版這裡會騙人說 connected:true");
  await __runWatchdogForTest();
  const d = getBotDiagnostics();
  assert.equal(d.restarts, 1);
  assert.match(d.lastRestartReason!, /zombie/);
  assert.equal(logins, 2, "重新登入了一次");
});

test("ShardDisconnect（discord.js 已放棄重連）→ 立刻重建，並記下關閉碼與人話原因", async () => {
  startDiscordBot("tok");
  makeReady(10_000);
  getDiscordClient()!.emit(Events.ShardDisconnect, { code: 4014 } as never, 0);
  await new Promise((r) => setTimeout(r, 400));
  const d = getBotDiagnostics();
  assert.equal(d.lastDisconnectCode, 4014);
  assert.match(d.lastDisconnectReason!, /Message Content Intent/);
  assert.equal(d.restarts, 1);
  assert.ok(logins >= 2);
});

test("設定性錯誤(4014)會退避：緊接著再次斷線不會狂重啟", async () => {
  startDiscordBot("tok");
  makeReady(10_000);
  getDiscordClient()!.emit(Events.ShardDisconnect, { code: 4014 } as never, 0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(getBotDiagnostics().restarts, 1);
  // 新 client 又收到同樣的斷線：還在退避期間，不應再重啟
  getDiscordClient()!.emit(Events.ShardDisconnect, { code: 4014 } as never, 0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(getBotDiagnostics().restarts, 1, "退避期間不重啟");
  assert.equal(await forceRestart("again", true), false);
});

test("Session 失效(Invalidated) → 重建", async () => {
  startDiscordBot("tok");
  makeReady(10_000);
  getDiscordClient()!.emit(Events.Invalidated);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(getBotDiagnostics().restarts, 1);
  assert.match(getBotDiagnostics().lastRestartReason!, /invalidated/);
});

test("短暫重連(connecting)不重啟、不閃爍：仍回報 ready", async () => {
  startDiscordBot("tok");
  const c = getDiscordClient()!;
  (c.ws as unknown as { status: number }).status = Status.Reconnecting;
  c.emit(Events.ShardReconnecting, 0);
  assert.equal(getBotDiagnostics().liveness, "connecting");
  assert.equal(getBotState().ready, true);
  await __runWatchdogForTest();
  assert.equal(getBotDiagnostics().restarts, 0);
});

test("重啟互斥：同時多次要求只會真的執行一次", async () => {
  startDiscordBot("tok");
  makeReady(10_000);
  const r = await Promise.all([forceRestart("a"), forceRestart("b"), forceRestart("c")]);
  assert.equal(r.filter(Boolean).length, 1);
  assert.equal(getBotDiagnostics().restarts, 1);
});

test("登入因 Intent 沒開失敗 → 記為 4014，診斷可見，且會排程重試而不是放棄", async () => {
  loginImpl = async () => { throw new Error("Used disallowed intents"); };
  startDiscordBot("tok");
  await new Promise((r) => setTimeout(r, 100));
  const d = getBotDiagnostics();
  assert.equal(d.lastDisconnectCode, 4014);
  assert.match(d.lastDisconnectReason!, /Message Content Intent/);
  assert.equal(getBotState().ready, false);
});

test("沒有 client（已停止）→ down，看門狗在沒有 token 時不會拋錯", async () => {
  assert.equal(getBotDiagnostics().liveness, "down");
  assert.equal(getBotState().ready, false);
  await assert.doesNotReject(__runWatchdogForTest());
});

test("重啟後斜線指令會重新註冊（新 client 一 Ready 就註冊）", async () => {
  startDiscordBot("tok");
  makeReady(10_000);
  assert.equal(commandRegistrations, 1);
  await forceRestart("test");
  makeReady(10_000);
  assert.equal(commandRegistrations, 2);
});
