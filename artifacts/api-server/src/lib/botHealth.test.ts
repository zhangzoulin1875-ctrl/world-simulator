import test from "node:test";
import assert from "node:assert/strict";
import {
  assessLiveness, describeCloseCode, isConfigClose, restartDelayMs, HEARTBEAT_STALE_MS, FATAL_CLOSE_CODES,
} from "./botHealth";

const base = { hasClient: true, wsReady: true, wsDisconnected: false, lastHeartbeatAt: null as number | null, readySince: null as number | null, connectingSince: null as number | null, now: 1_000_000 };

test("健康：Ready 且心跳新鮮", () => {
  assert.equal(assessLiveness({ ...base, lastHeartbeatAt: base.now - 30_000, readySince: base.now - 600_000 }), "healthy");
});

test("殭屍：ws 說 Ready，但心跳 ACK 超過門檻沒更新（這就是『連著卻收不到指令』）", () => {
  assert.equal(assessLiveness({ ...base, lastHeartbeatAt: base.now - HEARTBEAT_STALE_MS - 1, readySince: base.now - 900_000 }), "zombie");
  assert.equal(assessLiveness({ ...base, lastHeartbeatAt: base.now - HEARTBEAT_STALE_MS + 1_000, readySince: base.now - 900_000 }), "healthy");
});

test("剛上線還沒第一次心跳：以 Ready 時間為準，不會被誤判成殭屍；但太久都沒有就是殭屍", () => {
  assert.equal(assessLiveness({ ...base, lastHeartbeatAt: null, readySince: base.now - 20_000 }), "healthy");
  assert.equal(assessLiveness({ ...base, lastHeartbeatAt: null, readySince: base.now - HEARTBEAT_STALE_MS - 5_000 }), "zombie");
});

test("沒有 client／ws 已斷線 → down", () => {
  assert.equal(assessLiveness({ ...base, hasClient: false, wsReady: false }), "down");
  assert.equal(assessLiveness({ ...base, wsReady: false, wsDisconnected: true }), "down");
});

test("連線中：2 分鐘內算 connecting（不吵），超過算卡死 zombie", () => {
  assert.equal(assessLiveness({ ...base, wsReady: false, connectingSince: base.now - 30_000 }), "connecting");
  assert.equal(assessLiveness({ ...base, wsReady: false, connectingSince: base.now - 121_000 }), "zombie");
  assert.equal(assessLiveness({ ...base, wsReady: false, connectingSince: null }), "connecting");
});

test("關閉碼：4014 給出『開 Message Content Intent』的人話；未知碼不當設定錯誤", () => {
  assert.match(describeCloseCode(4014), /Message Content Intent/);
  assert.equal(isConfigClose(4014), true);
  assert.equal(isConfigClose(4004), true);
  assert.equal(isConfigClose(1006), false);
  assert.equal(isConfigClose(null), false);
  assert.equal(describeCloseCode(1006), "關閉碼 1006");
  assert.equal(describeCloseCode(null), "未知");
});

test("致命碼清單與 discord.js 的 UNRECOVERABLE_CLOSE_CODES 一致（升級 discord.js 時此測試會提醒）", async () => {
  const { GatewayCloseCodes } = await import("discord.js");
  const expected = [
    GatewayCloseCodes.AuthenticationFailed, GatewayCloseCodes.InvalidShard, GatewayCloseCodes.ShardingRequired,
    GatewayCloseCodes.InvalidAPIVersion, GatewayCloseCodes.InvalidIntents, GatewayCloseCodes.DisallowedIntents,
  ].sort();
  assert.deepEqual(Object.keys(FATAL_CLOSE_CODES).map(Number).sort(), expected);
});

test("重啟退避：一般錯誤快速重試且有上限；設定錯誤間隔明顯更長", () => {
  assert.equal(restartDelayMs(1, false), 5_000);
  assert.equal(restartDelayMs(2, false), 10_000);
  assert.equal(restartDelayMs(50, false), 2 * 60 * 1000);
  assert.equal(restartDelayMs(1, true), 5 * 60 * 1000);
  assert.equal(restartDelayMs(50, true), 30 * 60 * 1000);
  assert.ok(restartDelayMs(1, true) > restartDelayMs(1, false) * 10);
});
