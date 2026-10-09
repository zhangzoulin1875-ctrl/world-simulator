/**
 * 廢棄油井服務層整合測試(需要 DATABASE_URL)。
 * 涵蓋:種子冪等、開季、計分(只依經過時間)、並行結算不重複加分、
 * 達標結束賽季、冷卻期不計分、同一時間只能有一個 active 賽季。
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set to run the oil rig tests");

const { sql, inArray } = await import("drizzle-orm");
const { db, pool, playerNationsTable } = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runOilRigMigrations } = await import("./oilRigMigrations");
const { seedOilRigs, ensureFirstSeason, settleOilScores } = await import("./oilRigService");
const { OIL_RIG_SEEDS } = await import("./oilRigSeeds");
const { OIL_WIN_SCORE, pointsPerHour, OIL_MAX_CATCHUP_HOURS } = await import("./oilRigCore");

const T0 = new Date("2026-10-09T00:00:00Z");
const hoursLater = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const nations: string[] = [];

async function newNation(name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO player_nations (id, name) VALUES (${id}::uuid, ${name})`);
  nations.push(id);
  return id;
}
async function giveRigs(nationId: string, count: number, offset = 0) {
  const slugs = OIL_RIG_SEEDS.slice(offset, offset + count).map((r) => r.slug);
  for (const s of slugs) await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = ${nationId}::uuid WHERE slug = ${s}`);
}
async function scoreOf(nationId: string): Promise<number> {
  const r = await db.execute(sql`SELECT score FROM oil_scores WHERE nation_id = ${nationId}::uuid`);
  return r.rows[0] ? Number((r.rows[0] as { score: number }).score) : 0;
}
const seasonRow = async () => (await db.execute(sql`SELECT * FROM oil_seasons ORDER BY id DESC LIMIT 1`)).rows[0] as Record<string, unknown>;

before(async () => {
  await runGameMigrations();
  await runOilRigMigrations();
});
beforeEach(async () => {
  await db.execute(sql`DELETE FROM oil_scores`);
  await db.execute(sql`DELETE FROM oil_seasons`);
  await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = NULL, held_since = NULL`);
  await ensureFirstSeason(T0);
});
after(async () => {
  if (nations.length) await db.delete(playerNationsTable).where(inArray(playerNationsTable.id, nations));
  await db.execute(sql`DELETE FROM oil_scores`);
  await db.execute(sql`DELETE FROM oil_seasons`);
  await pool.end();
});

test("種子:16 座油井,重跑不重複、不覆寫持有者", async () => {
  await seedOilRigs();
  const n = await newNation("持有者");
  await giveRigs(n, 1);
  await seedOilRigs();
  const rows = (await db.execute(sql`SELECT count(*)::int AS c FROM oil_rigs`)).rows[0] as { c: number };
  assert.equal(rows.c, 16);
  const held = (await db.execute(sql`SELECT count(*)::int AS c FROM oil_rigs WHERE holder_nation_id = ${n}::uuid`)).rows[0] as { c: number };
  assert.equal(held.c, 1, "重跑 seed 不可洗掉持有者");
});

test("遷移冪等:連跑兩次不報錯", async () => {
  await runOilRigMigrations();
  await runOilRigMigrations();
});

test("開季:ensureFirstSeason 冪等,且同時只能有一個 active 賽季", async () => {
  await ensureFirstSeason(T0);
  await ensureFirstSeason(T0);
  const c = (await db.execute(sql`SELECT count(*)::int AS c FROM oil_seasons`)).rows[0] as { c: number };
  assert.equal(c.c, 1);
  // 部分唯一索引:直接硬塞第二個 active 必須被擋
  await assert.rejects(
    db.execute(sql`INSERT INTO oil_seasons (season_number, status) VALUES (2, 'active')`),
    (e: unknown) => {
      // drizzle 把底層錯誤包在 cause;Postgres 唯一違反的錯誤碼是 23505
      const code = (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
      assert.equal(code, "23505", "第二個 active 賽季必須被唯一索引擋下");
      return true;
    },
  );
  // 但 cooldown 可以多個
  await db.execute(sql`INSERT INTO oil_seasons (season_number, status) VALUES (2, 'cooldown')`);
  await db.execute(sql`INSERT INTO oil_seasons (season_number, status) VALUES (3, 'cooldown')`);
});

test("計分:佔 4 座、經過 10 小時 = 4 座每小時得分 × 10", async () => {
  const a = await newNation("甲國");
  await giveRigs(a, 4);
  const r = await settleOilScores(hoursLater(10));
  assert.equal(r.scored, true);
  assert.equal(await scoreOf(a), pointsPerHour(4) * 10);
});

test("沒有佔領者不產生分數,但時間照樣前進(不會之後補算空窗期)", async () => {
  const r1 = await settleOilScores(hoursLater(5));
  assert.equal(r1.gains?.length, 0);
  const a = await newNation("乙國");
  await giveRigs(a, 2);
  await settleOilScores(hoursLater(6));    // 只該算 1 小時,不是 6 小時
  assert.equal(await scoreOf(a), pointsPerHour(2) * 1);
});

test("同一時刻重複結算不重複加分(經過 0 小時)", async () => {
  const a = await newNation("丙國");
  await giveRigs(a, 3);
  await settleOilScores(hoursLater(2));
  const once = await scoreOf(a);
  await settleOilScores(hoursLater(2));
  await settleOilScores(hoursLater(2));
  assert.equal(await scoreOf(a), once);
});

test("並行結算:同時 6 個呼叫只會加一次分", async () => {
  const a = await newNation("丁國");
  await giveRigs(a, 5);
  await Promise.all(Array.from({ length: 6 }, () => settleOilScores(hoursLater(3))));
  assert.equal(await scoreOf(a), pointsPerHour(5) * 3);
});

test("伺服器停擺很久:單次結算有補算上限,不會瞬間達標", async () => {
  const a = await newNation("戊國");
  await giveRigs(a, 8);
  await settleOilScores(hoursLater(24 * 365));
  assert.equal(await scoreOf(a), pointsPerHour(8) * OIL_MAX_CATCHUP_HOURS);
  assert.equal((await seasonRow())["status"], "active");
});

test("時鐘倒退:不扣分、不當機", async () => {
  const a = await newNation("己國");
  await giveRigs(a, 2);
  await settleOilScores(hoursLater(10));
  const before_ = await scoreOf(a);
  await settleOilScores(hoursLater(1));
  assert.equal(await scoreOf(a), before_);
});

test("達標:賽季結束、記錄勝者快照、進入冷卻", async () => {
  const a = await newNation("勝利國");
  await giveRigs(a, 5);
  await db.execute(sql`INSERT INTO oil_scores (season_id, nation_id, score) SELECT id, ${a}::uuid, ${OIL_WIN_SCORE - 1} FROM oil_seasons WHERE status = 'active'`);
  const r = await settleOilScores(hoursLater(1));
  assert.equal(r.winner?.nationId, a);
  assert.equal(r.winner?.nationName, "勝利國");
  const s = await seasonRow();
  assert.equal(s["status"], "cooldown");
  assert.equal(s["winner_nation_id"], a);
  assert.equal(s["winner_nation_name"], "勝利國");
  assert.ok(Number(s["winner_score"]) >= OIL_WIN_SCORE);
  assert.ok(s["ended_at"]);
});

test("冷卻期不再計分(沒有 active 賽季)", async () => {
  const a = await newNation("庚國");
  await giveRigs(a, 5);
  await db.execute(sql`UPDATE oil_seasons SET status = 'cooldown'`);
  const r = await settleOilScores(hoursLater(48));
  assert.deepEqual({ scored: r.scored, reason: r.reason }, { scored: false, reason: "no_active_season" });
  assert.equal(await scoreOf(a), 0);
});

test("兩國同時越線:分數高者勝", async () => {
  const a = await newNation("A國"), b = await newNation("B國");
  await giveRigs(a, 3, 0); await giveRigs(b, 3, 3);
  await db.execute(sql`INSERT INTO oil_scores (season_id, nation_id, score) SELECT id, ${a}::uuid, ${OIL_WIN_SCORE} FROM oil_seasons WHERE status='active'`);
  await db.execute(sql`INSERT INTO oil_scores (season_id, nation_id, score) SELECT id, ${b}::uuid, ${OIL_WIN_SCORE + 500} FROM oil_seasons WHERE status='active'`);
  const r = await settleOilScores(hoursLater(1));
  assert.equal(r.winner?.nationId, b);
});

test("勝者國家日後被刪除,賽季仍保留勝者名稱快照", async () => {
  const a = await newNation("將被刪除的國");
  await giveRigs(a, 5);
  await db.execute(sql`INSERT INTO oil_scores (season_id, nation_id, score) SELECT id, ${a}::uuid, ${OIL_WIN_SCORE} FROM oil_seasons WHERE status='active'`);
  await settleOilScores(hoursLater(1));
  await db.execute(sql`DELETE FROM player_nations WHERE id = ${a}::uuid`);
  const s = await seasonRow();
  assert.equal(s["winner_nation_id"], null);
  assert.equal(s["winner_nation_name"], "將被刪除的國");
});
