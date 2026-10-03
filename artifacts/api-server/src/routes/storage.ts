import express, { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, gameImagesTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { getSession, readSessionToken } from "../lib/sessions";

const router: IRouter = Router();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * POST /storage/uploads/game-appearance  (admin only)
 *
 * Direct image upload for the 遊戲外觀 admin page (看板娘/背景圖). The file
 * bytes are sent as the raw request body with an image Content-Type. Images
 * are stored in Postgres (`game_images`) — object storage sidecar auth is
 * broken in this environment, and these are low-volume admin uploads, so DB
 * storage works reliably in both development and production. Returns the
 * site-relative serving URL.
 */
router.post(
  "/storage/uploads/game-appearance",
  requireAdmin,
  express.raw({ type: ACCEPTED_TYPES, limit: MAX_UPLOAD_BYTES }),
  async (req: Request, res: Response) => {
    const contentType = (req.header("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ACCEPTED_TYPES.includes(contentType)) {
      res.status(400).json({ error: "只接受 PNG/JPEG/WebP/GIF/AVIF 圖片" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "沒有收到圖片內容" });
      return;
    }
    if (req.body.length > MAX_UPLOAD_BYTES) {
      res.status(400).json({ error: "圖片大小不可超過 10 MB" });
      return;
    }

    try {
      const [row] = await db
        .insert(gameImagesTable)
        .values({
          contentType,
          byteSize: req.body.length,
          bytes: req.body,
        })
        .returning({ id: gameImagesTable.id });
      req.log.info(
        { imageId: row.id, bytes: req.body.length, contentType },
        "game appearance image uploaded",
      );
      res.json({ url: `/api/storage/images/${row.id}` });
    } catch (error) {
      req.log.error({ err: error }, "Failed to upload game appearance image");
      res.status(500).json({ error: "圖片上傳失敗" });
    }
  },
);

/**
 * POST /storage/uploads/player-image  (Discord session required)
 *
 * Task #30 — player uploads for 國旗/國徽/背景/看板娘 in the in-game settings
 * dialog. Same raw-body DB-storage pattern as the admin endpoint above
 * (object storage sidecar is broken repl-wide), gated on the player session
 * instead of ADMIN_TOKEN, with a smaller size cap.
 */
const MAX_PLAYER_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

router.post(
  "/storage/uploads/player-image",
  express.raw({ type: ACCEPTED_TYPES, limit: MAX_PLAYER_UPLOAD_BYTES }),
  async (req: Request, res: Response) => {
    const session = await getSession(readSessionToken(req));
    if (!session) {
      res.status(401).json({ error: "請先以 Discord 登入" });
      return;
    }
    const contentType = (req.header("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ACCEPTED_TYPES.includes(contentType)) {
      res.status(400).json({ error: "只接受 PNG/JPEG/WebP/GIF/AVIF 圖片" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "沒有收到圖片內容" });
      return;
    }
    if (req.body.length > MAX_PLAYER_UPLOAD_BYTES) {
      res.status(400).json({ error: "圖片大小不可超過 5 MB" });
      return;
    }

    try {
      const [row] = await db
        .insert(gameImagesTable)
        .values({
          contentType,
          byteSize: req.body.length,
          bytes: req.body,
        })
        .returning({ id: gameImagesTable.id });
      req.log.info(
        {
          imageId: row.id,
          bytes: req.body.length,
          contentType,
          userId: session.discordUserId,
        },
        "player image uploaded",
      );
      res.json({ url: `/api/storage/images/${row.id}` });
    } catch (error) {
      req.log.error({ err: error }, "Failed to upload player image");
      res.status(500).json({ error: "圖片上傳失敗" });
    }
  },
);

/**
 * GET /storage/images/:id
 *
 * Serve uploaded game appearance images from the DB. Publicly readable —
 * these images are shown to every player on the game home page. Each upload
 * gets a fresh UUID, so aggressive immutable caching is safe.
 */
router.get("/storage/images/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "").toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "找不到圖片" });
    return;
  }

  try {
    const [row] = await db
      .select()
      .from(gameImagesTable)
      .where(eq(gameImagesTable.id, id))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "找不到圖片" });
      return;
    }
    res.setHeader("Content-Type", row.contentType);
    res.setHeader("Content-Length", String(row.byteSize));
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(row.bytes);
  } catch (err) {
    req.log.error({ err, id }, "Failed to serve game appearance image");
    res.status(500).json({ error: "無法讀取圖片" });
  }
});

export default router;
