import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { settleOilScores } from "../lib/oilRigService";
import {
  OIL_WIN_SCORE, pointsPerHour, validateSeasonRestart, type OilSeasonStatus,
} from "../lib/oilRigCore";
import { OIL_RIG_SEEDS } from "../lib/oilRigSeeds";
import { ERAS } from "../lib/mapRegionEras";

/**
 * 廢棄油井:公開狀態(地圖與榜單用,無需登入)+ 管理員手動結算/選擇下一賽季年代。
 * 不在 OpenAPI spec(與 adminReset 同慣例,前端 raw fetch)。
 */
const router: IRouter = Router();

router.get("/oil-rigs", async (_req, res) => {
  const seasonRes = await db.execute(sql`
    SELECT id, season_number, status, started_at, ended_at, winner_nation_name, winner_score, next_era
    FROM oil_seasons ORDER BY season_number DESC LIMIT 1
  `);
  const season = seasonRes.rows[0] as Record<string, unknown> | undefined;

  const rigsRes = await db.execute(sql`
    SELECT r.slug, r.name, r.sea, r.lng, r.lat, r.holder_nation_id, r.held_since,
           n.name AS holder_name, n.map_color AS holder_color
    FROM oil_rigs r LEFT JOIN player_nations n ON n.id = r.holder_nation_id
    ORDER BY r.id
  `);
  const anchors = new Map(OIL_RIG_SEEDS.map((s) => [s.slug, s.anchorRegions]));
  const rigs = (rigsRes.rows as Record<string, unknown>[]).map((r) => ({
    slug: r.slug, name: r.name, sea: r.sea, lng: r.lng, lat: r.lat,
    holder: r.holder_nation_id ? { nationId: r.holder_nation_id, name: r.holder_name, color: r.holder_color } : null,
    heldSince: r.held_since,
    anchorRegions: anchors.get(r.slug as string) ?? [],
  }));

  let leaderboard: unknown[] = [];
  if (season) {
    const lb = await db.execute(sql`
      SELECT s.nation_id, s.score, n.name, n.map_color,
             (SELECT count(*)::int FROM oil_rigs r WHERE r.holder_nation_id = s.nation_id) AS held
      FROM oil_scores s JOIN player_nations n ON n.id = s.nation_id
      WHERE s.season_id = ${season["id"] as number}
      ORDER BY s.score DESC, s.reached_at ASC LIMIT 20
    `);
    leaderboard = (lb.rows as Record<string, unknown>[]).map((r) => ({
      nationId: r.nation_id, name: r.name, color: r.map_color,
      score: Math.round(Number(r.score) * 100) / 100, heldRigs: r.held,
      pointsPerHour: pointsPerHour(Number(r.held)),
    }));
  }
  res.json({ winScore: OIL_WIN_SCORE, season: season ?? null, rigs, leaderboard });
});

/** 管理員:立刻結算一次(用於驗證或補算);回傳結果。 */
router.post("/admin/oil-rigs/settle", requireAdmin, async (req, res) => {
  try {
    res.json(await settleOilScores());
  } catch (err) {
    req.log.error({ err }, "admin oil settle failed");
    res.status(500).json({ error: "油井計分結算失敗,請查看伺服器記錄" });
  }
});

/**
 * 管理員:冷卻期內指定下一賽季的年代(只記錄,不重置任何東西)。
 * 實際「重開賽季」的重置範圍尚待產品決定,故這裡刻意不做破壞性動作。
 */
router.post("/admin/oil-rigs/next-era", requireAdmin, async (req, res) => {
  const nextEra = typeof req.body?.era === "string" ? req.body.era : null;
  const cur = await db.execute(sql`SELECT id, status FROM oil_seasons ORDER BY season_number DESC LIMIT 1`);
  const row = cur.rows[0] as { id: number; status: OilSeasonStatus } | undefined;
  if (!row) { res.status(404).json({ error: "尚無賽季" }); return; }
  const v = validateSeasonRestart(row.status, nextEra, ERAS.map((e) => e.slug));
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  await db.execute(sql`UPDATE oil_seasons SET next_era = ${nextEra} WHERE id = ${row.id}`);
  res.json({ ok: true, nextEra });
});

export default router;
