# 架空世界模擬器 — Render 部署指南

從 Replit 原始碼重新部署到 Render。已改動的檔案只有 `artifacts/api-server/src/app.ts`
（新增 `STATIC_DIR` 同源靜態檔案伺服，讓前後端跑在同一個網域，Discord OAuth
和 session cookie 不會有跨網域問題），其餘都是原始碼原封不動。

## 部署前需要準備

1. **Anthropic API key** — 到 https://console.anthropic.com 建立自己的 key。
   （原本用 Replit 的 AI Integration 代理，離開 Replit 後改連官方 API，
   程式碼不用改，環境變數指過去就好。）
2. **Discord 應用程式憑證** — 到 https://discord.com/developers/applications
   選原本的應用程式：
   - Bot 頁：Reset Token 取得 `DISCORD_BOT_TOKEN`
   - OAuth2 頁：記下 Client ID 和 Client Secret

## 部署步驟

1. **把這個資料夾推上 GitHub**（新 repo，設為 private 即可）。
2. 到 https://render.com → **New → Blueprint**，選剛建立的 repo。
   Render 會讀 `render.yaml`，建立 web 服務 + PostgreSQL 資料庫。
3. 部署過程會跳出視窗問你 `sync: false` 的機密變數，填入：
   - `AI_INTEGRATIONS_ANTHROPIC_API_KEY`（sk-ant- 開頭）
   - `DISCORD_BOT_TOKEN`、`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`
   - `ADMIN_TOKEN`（管理後台密碼，自訂一串隨機字）
4. 等 Docker 建置完成、服務啟動。啟動時會自動跑所有資料庫遷移和
   地圖/城市播種（全新資料庫，玩家從零開始）。
5. **更新 Discord OAuth 重新導向網址**：回 Discord Developer Portal →
   OAuth2 → Redirects，加上 `https://<你的服務網域>/api/auth/discord/callback`。
6. 打開 `https://<你的服務網域>` 測試，登入 Discord，開始玩。

## 免費方案注意事項

- **資料庫**：`render.yaml` 預設 `plan: free`，**30 天後會被刪除**。
  要長期玩，部署完到資料庫頁面直接 Upgrade 到 Starter（約 $7/月），資料會保留。
- **休眠**：免費 web 服務 15 分鐘沒有流量就休眠。用外部 ping（cron-job.org
  每 5-10 分鐘打一次 `/api/healthz`）可以保活。也可以考慮升級到 paid plan。

## 防休眠 Ping

服務部署好之後，把網址告訴 Superagent，它會幫你把自動 ping 設起來。

## 環境變數

全部清單和說明見 `.env.example`。Render 上由 `render.yaml` 管理：
`DATABASE_URL`、`PORT` 由 Render 自動注入，不必手動設。

## 疑難排解

- 服務起不來：Render dashboard → Logs。`/api/healthz` 是免 DB 健康檢查。
- OAuth 失敗：確認 redirect URI 完全一致（含 https）。
- AI 功能 503：檢查 Anthropic key 額度；AI 配額管理在 admin 頁 `/ai-usage`。
