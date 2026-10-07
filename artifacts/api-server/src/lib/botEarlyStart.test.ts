import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "discord.js";
import { startBotEarly, __resetBotEarlyForTest } from "./botEarlyStart";
import { stopDiscordBot, getDiscordClient, __resetBotDiagForTest } from "./discordBot";

const realLogin = Client.prototype.login;
let logins = 0;
const origToken = process.env["DISCORD_BOT_TOKEN"];

beforeEach(async () => {
  logins = 0;
  (Client.prototype as unknown as { login: () => Promise<string> }).login = async function () { logins++; return "ok"; };
  await stopDiscordBot(); __resetBotDiagForTest(); __resetBotEarlyForTest();
});
afterEach(async () => {
  await stopDiscordBot();
  Client.prototype.login = realLogin;
  if (origToken === undefined) delete process.env["DISCORD_BOT_TOKEN"]; else process.env["DISCORD_BOT_TOKEN"] = origToken;
});

test("核心：有 Token 時，機器人立刻啟動，完全不需要等任何資料庫遷移", async () => {
  process.env["DISCORD_BOT_TOKEN"] = "env-token";
  startBotEarly();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(getDiscordClient(), "已建立 client");
  assert.equal(logins, 1);
});

test("重複呼叫只會啟動一次", async () => {
  process.env["DISCORD_BOT_TOKEN"] = "env-token";
  startBotEarly(); startBotEarly(); startBotEarly();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(logins, 1);
});
