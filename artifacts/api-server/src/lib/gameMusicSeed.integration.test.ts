/**
 * 預設歌單播種:只在新庫播一次;不覆蓋管理員自己上傳的曲目;刪除後不會長回來;
 * 四個音檔都真的存在且是 OGG。需要資料庫(DATABASE_URL)。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const { sql } = await import("drizzle-orm");
const { db, pool, gameMusicTracksTable } = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { seedDefaultMusic, DEFAULT_MUSIC_TRACKS } = await import("./gameMusicSeed");

// 共用開發庫:備份現有歌單與旗標,測完還原。
let backupTracks: Array<typeof gameMusicTracksTable.$inferSelect> = [];
let hadFlag = false;

before(async () => {
  await runGameMigrations();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_music_seed (
      id integer PRIMARY KEY CHECK (id = 1),
      seeded_at timestamptz NOT NULL DEFAULT NOW(),
      track_count integer NOT NULL DEFAULT 0
    )`);
  backupTracks = await db.select().from(gameMusicTracksTable);
  hadFlag = (await db.execute(sql`SELECT 1 FROM game_music_seed`)).rows.length > 0;
});

after(async () => {
  try {
    await db.delete(gameMusicTracksTable);
    for (const t of backupTracks) await db.insert(gameMusicTracksTable).values(t);
    await db.execute(sql`DELETE FROM game_music_seed`);
    if (hadFlag) await db.execute(sql`INSERT INTO game_music_seed (id) VALUES (1)`);
  } finally {
    await pool.end();
  }
});

async function reset() {
  await db.delete(gameMusicTracksTable);
  await db.execute(sql`DELETE FROM game_music_seed`);
}
async function titles() {
  const rows = await db.select().from(gameMusicTracksTable).orderBy(gameMusicTracksTable.sortOrder);
  return rows.map((r) => r.title);
}

test("四個預設音檔存在、是 OGG、大小在單檔上限內", async () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/music");
  for (const t of DEFAULT_MUSIC_TRACKS) {
    const buf = await readFile(path.join(dir, t.file));
    assert.equal(buf.subarray(0, 4).toString("latin1"), "OggS", `${t.file} 不是 OGG`);
    assert.ok(buf.length > 10_000 && buf.length < 20 * 1024 * 1024, `${t.file} 大小異常 ${buf.length}`);
  }
});

test("空庫第一次啟動 → 依序播入四首", async () => {
  await reset();
  const r = await seedDefaultMusic();
  assert.equal(r.seeded, 4);
  assert.deepEqual(await titles(), ["馬賽曲", "國際歌", "天佑吾王", "普魯士的榮耀"]);
  const rows = await db.select().from(gameMusicTracksTable);
  assert.ok(rows.every((x) => x.contentType === "audio/ogg" && x.byteSize === x.bytes.length));
});

test("再跑一次不會重複播種", async () => {
  const r = await seedDefaultMusic();
  assert.equal(r.seeded, 0);
  assert.equal(r.skipped, "already-seeded");
  assert.equal((await titles()).length, 4);
});

test("管理員刪光歌單後重啟,預設曲目不會長回來", async () => {
  await db.delete(gameMusicTracksTable);
  const r = await seedDefaultMusic();
  assert.equal(r.seeded, 0);
  assert.deepEqual(await titles(), []);
});

test("歌單已有管理員自己上傳的曲目 → 不播種,也不覆蓋", async () => {
  await reset();
  await db.insert(gameMusicTracksTable).values({
    title: "自訂曲", contentType: "audio/ogg", byteSize: 4, bytes: Buffer.from("OggS"), sortOrder: 1,
  });
  const r = await seedDefaultMusic();
  assert.equal(r.seeded, 0);
  assert.equal(r.skipped, "playlist-not-empty");
  assert.deepEqual(await titles(), ["自訂曲"]);
});

// 沙盒的 PGlite 遇到「多連線同時送 ~6MB bytea」會協定錯亂(與播種邏輯無關:純寫入同樣大小的
// bytea 也會崩),所以預設跳過;在真正的 Postgres 上設 MUSIC_SEED_CONCURRENCY=1 執行。
test("兩個實例同時啟動只會播一次", { skip: process.env.MUSIC_SEED_CONCURRENCY !== "1" }, async () => {
  await reset();
  const results = await Promise.all([seedDefaultMusic(), seedDefaultMusic(), seedDefaultMusic()]);
  assert.equal(results.reduce((s, r) => s + r.seeded, 0), 4);
  assert.equal((await titles()).length, 4);
});
