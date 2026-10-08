/**
 * 厭戰度再平衡遷移:只升級「仍是舊預設」的欄位,管理員調過的值不動,且只跑一次。
 * game_balance_settings 是單列 id=1 的共用表,所以每個測試前後都備份 / 還原。
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const { pool } = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runGameBalanceMigrations } = await import("./gameBalanceMigrations");
const { runWarWearinessRebalanceMigration, WEARINESS_REBALANCE_FLAG } = await import(
  "./warWearinessRebalanceMigration"
);

type Backup = { existed: boolean; params: unknown };
let backup: Backup = { existed: false, params: {} };
let flagExisted = false;

async function readParams(): Promise<Record<string, any> | null> {
  const r = await pool.query("SELECT params FROM game_balance_settings WHERE id = 1");
  return r.rows[0] ? (r.rows[0].params as Record<string, any>) : null;
}
async function setParams(params: unknown | null) {
  await pool.query("DELETE FROM game_balance_settings WHERE id = 1");
  if (params !== null) {
    await pool.query("INSERT INTO game_balance_settings (id, params) VALUES (1, $1::jsonb)", [JSON.stringify(params)]);
  }
}
async function clearFlag() {
  await pool.query("DELETE FROM game_flags WHERE key = $1", [WEARINESS_REBALANCE_FLAG]);
}
async function hasFlag() {
  return (await pool.query("SELECT 1 FROM game_flags WHERE key = $1", [WEARINESS_REBALANCE_FLAG])).rows.length > 0;
}

before(async () => {
  await runGameMigrations();
  await runGameBalanceMigrations();
  await pool.query("CREATE TABLE IF NOT EXISTS game_flags (key text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT NOW())");
  const cur = await readParams();
  backup = { existed: cur !== null, params: cur ?? {} };
  flagExisted = await hasFlag();
});
beforeEach(async () => {
  await clearFlag();
});
after(async () => {
  await setParams(backup.existed ? backup.params : null);
  if (flagExisted) await pool.query("INSERT INTO game_flags (key) VALUES ($1) ON CONFLICT DO NOTHING", [WEARINESS_REBALANCE_FLAG]);
  else await clearFlag();
  await pool.end();
});

const OLD = { warWearinessWartimeRecovery: 0, warWearinessPeacetimeRecovery: 3, warWearinessGainMultiplierPct: 100 };

test("三個欄位都是舊預設 → 全部升級,其他欄位與其他區塊原封不動", async () => {
  await setParams({ war: { ...OLD, warIntensityPct: 77, other: "keep" }, politics: { x: 1 } });
  await runWarWearinessRebalanceMigration();
  const p = await readParams();
  assert.equal(p!.war.warWearinessWartimeRecovery, 2);
  assert.equal(p!.war.warWearinessPeacetimeRecovery, 5);
  assert.equal(p!.war.warWearinessGainMultiplierPct, 65);
  assert.equal(p!.war.warIntensityPct, 77);
  assert.equal(p!.war.other, "keep");
  assert.deepEqual(p!.politics, { x: 1 });
  assert.equal(await hasFlag(), true);
});

test("管理員調過的欄位不動,只升級仍是舊預設的那幾個(逐欄位獨立)", async () => {
  await setParams({ war: { warWearinessWartimeRecovery: 1, warWearinessPeacetimeRecovery: 3, warWearinessGainMultiplierPct: 80 } });
  await runWarWearinessRebalanceMigration();
  const w = (await readParams())!.war;
  assert.equal(w.warWearinessWartimeRecovery, 1, "管理員設的 1 保留");
  assert.equal(w.warWearinessPeacetimeRecovery, 5, "仍是舊預設 3 → 升級");
  assert.equal(w.warWearinessGainMultiplierPct, 80, "管理員設的 80 保留");
});

test("管理員刻意設成『比新預設更寬鬆』的值也不動", async () => {
  await setParams({ war: { warWearinessWartimeRecovery: 9, warWearinessPeacetimeRecovery: 12, warWearinessGainMultiplierPct: 20 } });
  await runWarWearinessRebalanceMigration();
  const w = (await readParams())!.war;
  assert.deepEqual([w.warWearinessWartimeRecovery, w.warWearinessPeacetimeRecovery, w.warWearinessGainMultiplierPct], [9, 12, 20]);
});

test("只跑一次:升級後管理員改回舊值,重啟不會再被蓋掉", async () => {
  await setParams({ war: { ...OLD } });
  await runWarWearinessRebalanceMigration();
  await setParams({ war: { ...OLD } }); // 管理員刻意改回舊值
  await runWarWearinessRebalanceMigration(); // 模擬重啟
  const w = (await readParams())!.war;
  assert.deepEqual([w.warWearinessWartimeRecovery, w.warWearinessPeacetimeRecovery, w.warWearinessGainMultiplierPct], [0, 3, 100]);
});

test("冪等:連跑兩次(第二次旗標已認領)結果相同,不拋錯", async () => {
  await setParams({ war: { ...OLD } });
  await runWarWearinessRebalanceMigration();
  const first = await readParams();
  await runWarWearinessRebalanceMigration();
  assert.deepEqual(await readParams(), first);
});

test("沒存過設定(無列)→ 什麼都不做、不建列、旗標仍認領", async () => {
  await setParams(null);
  await runWarWearinessRebalanceMigration();
  assert.equal(await readParams(), null, "不能憑空建出設定列(否則會蓋掉日後的新預設)");
  assert.equal(await hasFlag(), true);
});

test("欄位不存在(舊資料沒這幾個鍵)→ 不補寫,交給 zod 吃新預設", async () => {
  await setParams({ war: { warIntensityPct: 50 } });
  await runWarWearinessRebalanceMigration();
  assert.deepEqual((await readParams())!.war, { warIntensityPct: 50 });
});

test("壞形狀的 params(無 war / war 非物件 / 陣列)→ 不炸、不改", async () => {
  for (const bad of [{}, { war: null }, { war: "x" }, { war: [1, 2] }, []]) {
    await clearFlag();
    await setParams(bad);
    await runWarWearinessRebalanceMigration();
    assert.deepEqual(await readParams(), bad, JSON.stringify(bad));
  }
});

test("字串型的舊值('100')不被誤判為舊預設(嚴格比對數字)", async () => {
  await setParams({ war: { warWearinessGainMultiplierPct: "100" } });
  await runWarWearinessRebalanceMigration();
  assert.equal((await readParams())!.war.warWearinessGainMultiplierPct, "100");
});

test("升級後的 params 仍能通過 zod 解析並得到預期值", async () => {
  const { gameBalanceSettingsSchema } = await import("./gameBalance");
  await setParams({ war: { ...OLD } });
  await runWarWearinessRebalanceMigration();
  const parsed = gameBalanceSettingsSchema.parse((await readParams())!);
  assert.equal(parsed.war.warWearinessWartimeRecovery, 2);
  assert.equal(parsed.war.warWearinessPeacetimeRecovery, 5);
  assert.equal(parsed.war.warWearinessGainMultiplierPct, 65);
});
