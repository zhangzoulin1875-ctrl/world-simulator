import test, { after } from "node:test";
import assert from "node:assert/strict";
const { sql, getTableColumns } = await import("drizzle-orm");
const { db, pool, worldGameStateTable } = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runWorldSimMigrations } = await import("./worldSimMigrations");
const { runMapRegionEraStatsSync } = await import("./mapRegionEraStats");
const { runGameNewsMigrations } = await import("./gameNewsMigrations");
const { runEconomyMigrations } = await import("./economyMigrations");
/** 補全所有會替 world_game_state 加欄位的遷移(測試庫可能被其他測試弄髒) */
const fullSchema = async () => { await runGameMigrations(); await runWorldSimMigrations(); await runGameNewsMigrations(); await runEconomyMigrations(); };
const { recalcArmyProductionReservations } = await import("./armyReservationRecalc");

after(async () => { await pool.end(); });

/**
 * 回歸守門(2026-10-06 事故)。
 * 新增 worldGameStateTable 欄位時,若 ALTER 只放在啟動鏈很後面的 runWorldSimMigrations:
 * 線上舊 schema 上,排在它前面、又會 select() 這張表的步驟(recalcArmyProductionReservations)
 * 會因「欄位不存在」整串失敗;正式環境遷移失敗只記錄後繼續服務,於是後面的遷移永遠不跑,
 * 欄位永遠加不上,所有讀 world_game_state 的請求(首頁 /player/nation 等)全部 500。
 *
 * 注意:world_sim_* 等既有欄位本來就只在 runWorldSimMigrations 才加,但它們在線上早已存在,所以沒出事。
 * 出事的永遠是『第一次』加新欄位的那次發版,所以這個測試直接驗行為:
 * 只有「建表那一步」之後(= 線上升級時,新欄位還沒被 runWorldSimMigrations 加上),
 * 排在 runWorldSimMigrations 之前的讀表步驟必須能正常執行。
 */
test("線上升級情境:把『較新』的欄位拿掉(模擬舊 schema)後,只跑到建表步驟,啟動鏈前段會讀 world_game_state 的步驟必須成功", async () => {
  await fullSchema();
  const cols = Object.values(getTableColumns(worldGameStateTable)).map((c) => (c as { name: string }).name);
  // 目前版本新增的欄位(列在這裡 = 必須放在建表處)。以後新增欄位請把名字加進來。
  const NEWEST_COLUMNS = ["cost_linear_pct", "cost_curve_pct"];
  for (const c of NEWEST_COLUMNS) assert.ok(cols.includes(c), `schema 應該有 ${c}`);
  for (const c of NEWEST_COLUMNS) await db.execute(sql.raw(`ALTER TABLE world_game_state DROP COLUMN IF EXISTS "${c}"`));
  try {
    await runMapRegionEraStatsSync(); // 建表處:最早的步驟
    const have = new Set((await db.execute(sql`select column_name from information_schema.columns where table_name='world_game_state'`)).rows.map((r: any) => r.column_name as string));
    for (const c of NEWEST_COLUMNS) assert.ok(have.has(c), `${c} 必須在建表處(mapRegionEraStats.ts)就被加上,不能只放後面的遷移`);
    await recalcArmyProductionReservations(); // 事故當時就是它失敗
  } finally {
    await fullSchema();
  }
});

test("兩處 ALTER 並存是冪等的:重複執行不會重複加 CHECK 約束、不會報錯", async () => {
  await runMapRegionEraStatsSync(); await runWorldSimMigrations(); await runMapRegionEraStatsSync(); await runWorldSimMigrations();
  const c = (await db.execute(sql`select count(*)::int n from pg_constraint where conrelid='world_game_state'::regclass and contype='c' and pg_get_constraintdef(oid) like '%cost_linear_pct%'`)).rows[0] as { n: number };
  assert.equal(c.n, 1, "cost_linear_pct 只有一條 CHECK");
  const d = (await db.execute(sql`select count(*)::int n from pg_constraint where conrelid='world_game_state'::regclass and contype='c' and pg_get_constraintdef(oid) like '%cost_curve_pct%'`)).rows[0] as { n: number };
  assert.equal(d.n, 1, "cost_curve_pct 只有一條 CHECK");
});
