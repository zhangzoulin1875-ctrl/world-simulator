import { Router, type IRouter } from "express";
import { requireAdmin } from "../middlewares/requireAdmin";
import { logger } from "../lib/logger";
import { copyAllData, type CopyReport } from "../lib/dbMigrate/copyData";

/**
 * 一次性的跨資料庫搬家(例如 Neon → Aiven)。raw-fetch,不進 OpenAPI spec。
 *
 * 用法(目標 = 服務目前連著的 DATABASE_URL,來源 = MIGRATE_SOURCE_URL):
 *   1. 先把 DATABASE_URL 指向新庫並部署,讓啟動遷移在空庫建好全部表。
 *   2. 設定環境變數 MIGRATE_SOURCE_URL = 舊庫(Neon)連線字串。
 *   3. POST /api/admin/db-migrate   { "confirm": "copy-into-current-db" }   (背景執行)
 *      GET  /api/admin/db-migrate   查進度與每表筆數比對結果。
 *   4. 搬完確認 ok,刪除 MIGRATE_SOURCE_URL。
 *
 * 安全:只讀來源、只寫目前庫;目標非空會拒絕(需明確 truncate=true);連線字串只來自環境變數,不經 request body。
 */
const router: IRouter = Router();

type State =
  | { status: "idle" }
  | { status: "running"; startedAt: string; lastLog: string; done: number }
  | { status: "done"; finishedAt: string; report: CopyReport }
  | { status: "error"; finishedAt: string; error: string };

let state: State = { status: "idle" };

function maskHost(u: string): string {
  try { const x = new URL(u); return `${x.hostname}:${x.port || "5432"}${x.pathname}`; } catch { return "(invalid url)"; }
}

router.get("/admin/db-migrate", requireAdmin, (_req, res) => {
  const src = process.env["MIGRATE_SOURCE_URL"];
  const dst = process.env["DATABASE_URL"];
  res.json({
    source: src ? maskHost(src) : null,
    target: dst ? maskHost(dst) : null,
    sameDatabase: !!src && !!dst && maskHost(src) === maskHost(dst),
    state,
  });
});

router.post("/admin/db-migrate", requireAdmin, (req, res) => {
  const src = process.env["MIGRATE_SOURCE_URL"];
  const dst = process.env["DATABASE_URL"];
  if (!src) { res.status(400).json({ error: "MIGRATE_SOURCE_URL 未設定(舊庫連線字串)" }); return; }
  if (!dst) { res.status(400).json({ error: "DATABASE_URL 未設定" }); return; }
  if (maskHost(src) === maskHost(dst)) { res.status(400).json({ error: "來源與目標是同一個資料庫,拒絕執行" }); return; }
  if (req.body?.confirm !== "copy-into-current-db") {
    res.status(400).json({ error: '需帶 {"confirm":"copy-into-current-db"}', source: maskHost(src), target: maskHost(dst) });
    return;
  }
  if (state.status === "running") { res.status(409).json({ error: "已有搬家在執行", state }); return; }

  const truncate = req.body?.truncate === true;
  const ssl = process.env["DB_SSL"] === "1";
  state = { status: "running", startedAt: new Date().toISOString(), lastLog: "開始", done: 0 };
  logger.warn({ source: maskHost(src), target: maskHost(dst), truncate }, "[db-migrate] 開始搬家");

  void copyAllData(src, dst, {
    truncateTarget: truncate,
    ssl,
    log: (m) => {
      if (state.status === "running") state = { ...state, lastLog: m.slice(0, 200), done: state.done + 1 };
    },
  })
    .then((report) => {
      state = { status: "done", finishedAt: new Date().toISOString(), report };
      logger.warn({ ok: report.ok, tables: report.tables.length, ms: report.elapsedMs }, "[db-migrate] 完成");
    })
    .catch((e: Error) => {
      state = { status: "error", finishedAt: new Date().toISOString(), error: e.message.slice(0, 300) };
      logger.error({ err: e.message }, "[db-migrate] 失敗");
    });

  res.status(202).json({ started: true, source: maskHost(src), target: maskHost(dst), truncate });
});

export default router;
