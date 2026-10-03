import { Router, type IRouter } from "express";

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

export default router;
