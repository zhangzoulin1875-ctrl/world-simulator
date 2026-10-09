import { seasonFreeze } from "./middlewares/seasonFreeze";
import { apiErrorHandler } from "./middlewares/apiErrorHandler";
import express, { type Express } from "express";
import path from "node:path";
import fs from "node:fs";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { csrfGuard } from "./middlewares/csrf";
import { autopilotLock } from "./middlewares/autopilotLock";
import { logger } from "./lib/logger";
import { noteGameActivity } from "./lib/schedulerWake";

const app: Express = express();

// Behind the Replit reverse proxy (a single trusted hop): honor
// X-Forwarded-Proto/Host so OAuth redirect URIs and secure cookies resolve to
// the real https app domain. A specific hop count (not `true`) keeps req.ip
// trustworthy so the AI-endpoint IP rate limit can't be bypassed by a spoofed
// X-Forwarded-For (express-rate-limit ERR_ERL_PERMISSIVE_TRUST_PROXY).
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(cookieParser());
// Block cross-site state changes on cookie-authenticated routes. Runs after
// cookie-parser (needs req.cookies) and before the routers.
app.use(csrfGuard);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
// AI 全權託管：託管中的玩家寫入一律 423（僅放行解除託管／登出／通知已讀）。
app.use(seasonFreeze);
app.use(autopilotLock);

// 省電喚醒快取：任何 API 請求都代表遊戲有活動（Neon 本來就會被喚醒），
// 順手標記排程快取重讀——玩家改了回合時段/宣戰/締約等設定後，背景
// 迴圈最晚下一個 tick 就會看到新的到期時間（見 schedulerWake.ts）。
app.use((req, res, next) => {
  if (req.method !== "GET") noteGameActivity();
  next();
});

app.use("/api", router);

// --- 非 Replit 部署（Render 等）：同源伺服前端 SPA ---
// STATIC_DIR 指向 discord-news 建置輸出（dist/public）；未設定或不存在時完全不影響
// 原有行為（例如 Replit 上由反向代理分開服務前後端）。
const staticDir = process.env.STATIC_DIR;
if (staticDir && fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  // SPA fallback：非 /api 的 GET 一律回 index.html（支援 /game/* 等前端路由）。
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

app.use(apiErrorHandler);

export default app;
