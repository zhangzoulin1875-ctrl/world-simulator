/**
 * 預設歌單播種:新資料庫第一次啟動時,把四首公有領域國歌/軍樂放進 game_music_tracks。
 * 音檔與授權來源見 assets/music/SOURCES.md。
 *
 * 規則:
 *  - 只在「從未播種過」且「歌單目前是空的」時播種;播種後寫入旗標(game_music_seed),
 *    之後管理員刪掉預設曲目不會在重啟時長回來。
 *  - 歌單已有管理員自己上傳的曲目 → 不播種(視為已自行管理),直接寫旗標。
 *  - 用 advisory lock 序列化,避免多個實例同時啟動時重複播種。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, gameMusicTracksTable } from "@workspace/db";
import { logger } from "./logger";

export const DEFAULT_MUSIC_TRACKS: ReadonlyArray<{ title: string; file: string }> = [
  { title: "馬賽曲", file: "la-marseillaise.ogg" },
  { title: "國際歌", file: "the-internationale.ogg" },
  { title: "天佑吾王", file: "god-save-the-king.ogg" },
  { title: "普魯士的榮耀", file: "preussens-gloria.ogg" },
];

const SEED_LOCK_KEY = 7_310_245;

/** 音檔目錄:build 會複製到 dist/assets/music;開發(tsx 直跑原始碼)時在 ../../assets/music。 */
function musicDirCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, "assets/music"), // dist/index.mjs 旁
    path.resolve(here, "../../assets/music"), // src/lib/ → api-server/assets/music
  ];
}

async function readTrackFile(file: string): Promise<Buffer | null> {
  for (const dir of musicDirCandidates()) {
    try {
      return await readFile(path.join(dir, file));
    } catch {
      /* 試下一個候選 */
    }
  }
  return null;
}

export async function seedDefaultMusic(): Promise<{ seeded: number; skipped: string }> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_music_seed (
      id integer PRIMARY KEY CHECK (id = 1),
      seeded_at timestamptz NOT NULL DEFAULT NOW(),
      track_count integer NOT NULL DEFAULT 0
    )
  `);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);

    const flag = await tx.execute(sql`SELECT 1 FROM game_music_seed WHERE id = 1`);
    if (flag.rows.length > 0) return { seeded: 0, skipped: "already-seeded" };

    const existing = await tx.execute(sql`SELECT COUNT(*)::int AS n FROM game_music_tracks`);
    if (Number((existing.rows[0] as { n: number }).n) > 0) {
      await tx.execute(sql`INSERT INTO game_music_seed (id, track_count) VALUES (1, 0)`);
      return { seeded: 0, skipped: "playlist-not-empty" };
    }

    const loaded: Array<{ title: string; bytes: Buffer }> = [];
    for (const t of DEFAULT_MUSIC_TRACKS) {
      const bytes = await readTrackFile(t.file);
      if (!bytes) {
        // 缺檔不寫旗標,下次啟動再試(避免永久錯過)。
        logger.warn({ file: t.file }, "default music file missing; seed skipped");
        return { seeded: 0, skipped: `missing-file:${t.file}` };
      }
      loaded.push({ title: t.title, bytes });
    }

    let order = 0;
    for (const t of loaded) {
      order += 1;
      await tx.insert(gameMusicTracksTable).values({
        title: t.title,
        contentType: "audio/ogg",
        byteSize: t.bytes.length,
        bytes: t.bytes,
        sortOrder: order,
      });
    }
    await tx.execute(
      sql`INSERT INTO game_music_seed (id, track_count) VALUES (1, ${loaded.length})`,
    );
    logger.info({ tracks: loaded.length }, "default music playlist seeded");
    return { seeded: loaded.length, skipped: "" };
  });
}
