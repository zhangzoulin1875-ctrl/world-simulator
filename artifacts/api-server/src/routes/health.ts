import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getBotDiagnostics, getStoredToken } from "../lib/discordBot";

const router: IRouter = Router();

// Task #248 — 換版驗證：Render 會為 git 連動的服務注入 RENDER_GIT_COMMIT
//（完整 SHA）。把它帶在 healthz 回應裡，從外部就能確認「新 revision 已
// 上線」（舊的 zod 產生器 schema 不含此欄位，直接組物件避免動 generated
// 檔案；本地／非 Render 環境為 null 不影響 keep-awake ping）。
router.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    commit: process.env["RENDER_GIT_COMMIT"] ?? null,
  });
});

/**
 * keep-awake 專用:實際查一次資料庫。Aiven 免費方案會把「沒有資料庫活動」的服務判定為閒置並關機,
 * 只打 /healthz(不碰 DB)擋不住。這支刻意與 /healthz 分開,Render 的存活檢查仍用 DB-free 的 /healthz,
 * 避免資料庫短暫斷線時被誤判為服務掛掉而重啟。
 */
router.get("/healthz/db", async (_req, res) => {
  const started = Date.now();
  try {
    // 讀一張真實資料表(非僅 select 1),確保算作實際活動;5 秒逾時避免拖住 ping。
    const r = await Promise.race([
      pool.query("select (select count(*)::int from world_game_state) as n, now() as ts"),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("db timeout")), 5000)),
    ]);
    res.json({ status: "ok", db: "ok", ms: Date.now() - started, worldState: (r.rows[0] as { n: number }).n, commit: process.env["RENDER_GIT_COMMIT"] ?? null });
  } catch (e) {
    res.status(503).json({ status: "degraded", db: "error", ms: Date.now() - started, error: (e as Error).message.slice(0, 120) });
  }
});

/**
 * 給外部監控（UptimeRobot 等）用:Discord 機器人連線是否「真的活著」（心跳新鮮），不健康回 503。
 * 刻意與 /healthz 分開——Render 的存活檢查不能因為機器人掛掉而 503，否則整個服務會被重啟。
 * 還沒設定 Token 的全新部署不算異常（回 200，bot: "not-configured"），避免誤警報。
 */
router.get("/healthz/bot", async (_req, res) => {
  let hasToken = false;
  try {
    hasToken = Boolean(await getStoredToken());
  } catch {
    hasToken = false;
  }
  const d = getBotDiagnostics();
  if (!hasToken) {
    res.json({ status: "ok", bot: "not-configured", commit: process.env["RENDER_GIT_COMMIT"] ?? null });
    return;
  }
  const healthy = d.liveness === "healthy" || d.liveness === "connecting";
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    bot: d.liveness,
    pingMs: d.pingMs,
    lastHeartbeatAgoSec: d.lastHeartbeatAgoSec,
    lastDisconnect: d.lastDisconnectCode === null ? null : { code: d.lastDisconnectCode, reason: d.lastDisconnectReason, agoMin: d.lastDisconnectAgoMin },
    autoRestarts: d.restarts,
    lastRestartReason: d.lastRestartReason,
    commit: process.env["RENDER_GIT_COMMIT"] ?? null,
  });
});

export default router;
