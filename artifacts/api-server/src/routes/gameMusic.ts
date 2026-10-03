import express, { Router, type IRouter, type Request, type Response } from "express";
import { asc, eq, sql } from "drizzle-orm";
import { db, gameMusicTracksTable } from "@workspace/db";
import { schemas } from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAdmin";
import { resolveRequestRange } from "../lib/httpRange";

const { ListGameMusicTracksResponse } = schemas;

const router: IRouter = Router();

const MAX_MUSIC_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Accepted audio MIME types (Task #73: MP3/OGG/WAV/M4A). Browsers report a
 * few aliases per format, so we accept the common ones and normalize to a
 * canonical type when serving.
 */
const ACCEPTED_AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_TITLE_LENGTH = 60;

function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_TITLE_LENGTH) return null;
  return trimmed;
}

/** Ordered track rows without the audio bytes (list/metadata queries). */
async function listTrackRows() {
  return db
    .select({
      id: gameMusicTracksTable.id,
      title: gameMusicTracksTable.title,
      contentType: gameMusicTracksTable.contentType,
      byteSize: gameMusicTracksTable.byteSize,
      sortOrder: gameMusicTracksTable.sortOrder,
      createdAt: gameMusicTracksTable.createdAt,
    })
    .from(gameMusicTracksTable)
    .orderBy(asc(gameMusicTracksTable.sortOrder), asc(gameMusicTracksTable.createdAt));
}

/**
 * GET /game/music — public playlist for the game-home music player. In the
 * OpenAPI spec (Orval hooks). No audio bytes; the player streams each track
 * from its `url`.
 */
router.get("/game/music", async (req: Request, res: Response) => {
  try {
    const rows = await listTrackRows();
    const data = ListGameMusicTracksResponse.parse({
      tracks: rows.map((row) => ({
        id: row.id,
        title: row.title,
        url: `/api/storage/music/${row.id}`,
      })),
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to list game music tracks");
    res.status(500).json({ error: "無法讀取音樂清單" });
  }
});

/**
 * POST /game/music  (admin only, NOT in the OpenAPI spec)
 *
 * Raw-body audio upload — same DB-storage pattern as the game-appearance
 * image uploads (object storage sidecar is broken repl-wide). The track
 * title is passed via the `title` query parameter (URL-encoded so zh-TW
 * titles survive; headers are latin-1 only). New tracks are appended to the
 * end of the playlist.
 */
router.post(
  "/game/music",
  requireAdmin,
  express.raw({ type: ACCEPTED_AUDIO_TYPES, limit: MAX_MUSIC_UPLOAD_BYTES }),
  async (req: Request, res: Response) => {
    const contentType = (req.header("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ACCEPTED_AUDIO_TYPES.includes(contentType)) {
      res.status(400).json({ error: "只接受 MP3/OGG/WAV/M4A 音訊檔" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "沒有收到音訊內容" });
      return;
    }
    if (req.body.length > MAX_MUSIC_UPLOAD_BYTES) {
      res.status(400).json({ error: "音訊檔大小不可超過 20 MB" });
      return;
    }
    const title = normalizeTitle(req.query["title"]);
    if (!title) {
      res.status(400).json({ error: "請提供曲名（1–60 字）" });
      return;
    }

    try {
      const [row] = await db
        .insert(gameMusicTracksTable)
        .values({
          title,
          contentType,
          byteSize: req.body.length,
          bytes: req.body,
          // Append to the end of the playlist. COALESCE covers the
          // empty-table case; concurrent admin uploads are rare enough that
          // a duplicate sort_order only means a stable created_at tiebreak.
          sortOrder: sql<number>`(
            SELECT COALESCE(MAX(sort_order), 0) + 1 FROM game_music_tracks
          )`,
        })
        .returning({ id: gameMusicTracksTable.id });
      req.log.info(
        { trackId: row.id, bytes: req.body.length, contentType, title },
        "game music track uploaded",
      );
      res.json({
        id: row.id,
        title,
        url: `/api/storage/music/${row.id}`,
      });
    } catch (err) {
      req.log.error({ err }, "Failed to upload game music track");
      res.status(500).json({ error: "音樂上傳失敗" });
    }
  },
);

/**
 * GET /game/music/admin — admin list with byteSize/contentType/createdAt for
 * the management UI (raw fetch, not in the OpenAPI spec).
 */
router.get("/game/music/admin", requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await listTrackRows();
    res.json({
      tracks: rows.map((row) => ({
        id: row.id,
        title: row.title,
        contentType: row.contentType,
        byteSize: row.byteSize,
        sortOrder: row.sortOrder,
        createdAt: row.createdAt.toISOString(),
        url: `/api/storage/music/${row.id}`,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to list game music tracks (admin)");
    res.status(500).json({ error: "無法讀取音樂清單" });
  }
});

/**
 * PATCH /game/music/:id — rename a track (admin only).
 */
router.patch("/game/music/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "").toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "找不到曲目" });
    return;
  }
  const title = normalizeTitle(req.body?.title);
  if (!title) {
    res.status(400).json({ error: "請提供曲名（1–60 字）" });
    return;
  }
  try {
    const [row] = await db
      .update(gameMusicTracksTable)
      .set({ title })
      .where(eq(gameMusicTracksTable.id, id))
      .returning({ id: gameMusicTracksTable.id });
    if (!row) {
      res.status(404).json({ error: "找不到曲目" });
      return;
    }
    req.log.info({ trackId: id, title }, "game music track renamed");
    res.json({ id, title });
  } catch (err) {
    req.log.error({ err, id }, "Failed to rename game music track");
    res.status(500).json({ error: "更名失敗" });
  }
});

/**
 * PUT /game/music/order — full-replace playlist reorder (admin only). Body:
 * { ids: [uuid, ...] } — must contain exactly the current track ids.
 */
router.put("/game/music/order", requireAdmin, async (req: Request, res: Response) => {
  const raw = req.body?.ids;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    res.status(400).json({ error: "ids 必須是曲目 ID 陣列" });
    return;
  }
  const ids = (raw as string[]).map((v) => v.toLowerCase());
  if (ids.some((v) => !UUID_PATTERN.test(v))) {
    res.status(400).json({ error: "ids 含有無效的曲目 ID" });
    return;
  }
  if (new Set(ids).size !== ids.length) {
    res.status(400).json({ error: "ids 不可重複" });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: gameMusicTracksTable.id })
        .from(gameMusicTracksTable)
        .for("update");
      const existingIds = new Set(existing.map((r) => r.id));
      if (
        existingIds.size !== ids.length ||
        ids.some((v) => !existingIds.has(v))
      ) {
        throw new OrderMismatchError();
      }
      for (let i = 0; i < ids.length; i++) {
        await tx
          .update(gameMusicTracksTable)
          .set({ sortOrder: i + 1 })
          .where(eq(gameMusicTracksTable.id, ids[i]!));
      }
    });
    req.log.info({ count: ids.length }, "game music playlist reordered");
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof OrderMismatchError) {
      res.status(409).json({ error: "曲目清單已變更，請重新整理後再試" });
      return;
    }
    req.log.error({ err }, "Failed to reorder game music playlist");
    res.status(500).json({ error: "排序失敗" });
  }
});

class OrderMismatchError extends Error {}

/**
 * DELETE /game/music/:id — remove a track (admin only).
 */
router.delete("/game/music/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "").toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "找不到曲目" });
    return;
  }
  try {
    const [row] = await db
      .delete(gameMusicTracksTable)
      .where(eq(gameMusicTracksTable.id, id))
      .returning({ id: gameMusicTracksTable.id });
    if (!row) {
      res.status(404).json({ error: "找不到曲目" });
      return;
    }
    req.log.info({ trackId: id }, "game music track deleted");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err, id }, "Failed to delete game music track");
    res.status(500).json({ error: "刪除失敗" });
  }
});

/**
 * GET /storage/music/:id — public audio streaming with HTTP Range support so
 * <audio> seeking works. Each upload gets a fresh UUID, so immutable caching
 * is safe (same rationale as /storage/images/:id).
 */
router.get("/storage/music/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "").toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "找不到音訊檔" });
    return;
  }

  try {
    // Metadata-only lookup first — never load the full bytea (up to 20 MB)
    // into memory just to answer a tiny seek Range. `byte_size` is written
    // at upload time and is the authoritative total.
    const [meta] = await db
      .select({
        contentType: gameMusicTracksTable.contentType,
        byteSize: gameMusicTracksTable.byteSize,
      })
      .from(gameMusicTracksTable)
      .where(eq(gameMusicTracksTable.id, id))
      .limit(1);
    if (!meta) {
      res.status(404).json({ error: "找不到音訊檔" });
      return;
    }

    const total = meta.byteSize;
    res.setHeader("Content-Type", meta.contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Range resolution is a tested pure function (lib/httpRange.ts) so
    // <audio> seek behaviour (206/416/ignore) can't silently regress.
    const resolved = resolveRequestRange(req.header("range"), total);
    if (resolved.kind === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${total}`);
      res.status(416).end();
      return;
    }
    if (resolved.kind === "range") {
      const { start, end } = resolved;
      // Fetch only the requested byte window in SQL (substring is
      // 1-indexed). The track could have been deleted between the two
      // queries — treat that as 404.
      const [slice] = await db
        .select({
          chunk: sql<Buffer>`substring(${gameMusicTracksTable.bytes} from ${start + 1} for ${end - start + 1})`,
        })
        .from(gameMusicTracksTable)
        .where(eq(gameMusicTracksTable.id, id))
        .limit(1);
      if (!slice) {
        res.status(404).json({ error: "找不到音訊檔" });
        return;
      }
      const chunk = slice.chunk;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", String(chunk.length));
      res.end(chunk);
      return;
    }

    const [full] = await db
      .select({ bytes: gameMusicTracksTable.bytes })
      .from(gameMusicTracksTable)
      .where(eq(gameMusicTracksTable.id, id))
      .limit(1);
    if (!full) {
      res.status(404).json({ error: "找不到音訊檔" });
      return;
    }
    res.setHeader("Content-Length", String(full.bytes.length));
    res.end(full.bytes);
  } catch (err) {
    req.log.error({ err, id }, "Failed to serve game music track");
    res.status(500).json({ error: "無法讀取音訊檔" });
  }
});

export default router;
