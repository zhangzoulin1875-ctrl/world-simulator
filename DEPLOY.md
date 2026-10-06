# 架空世界模擬器 — Render 部署指南

從 Replit 原始碼重新部署到 Render。已改動的檔案：
- `artifacts/api-server/src/app.ts`（新增 `STATIC_DIR` 同源靜態檔案伺服，
  讓前後端跑在同一個網域，Discord OAuth 和 session cookie 不會有跨網域問題）
- `lib/integrations-anthropic-ai/src/client.ts`（AI 整合層改為 OpenAI 相容
  chat-completions 端點，外部呼叫介面不變；支援 NVIDIA NIM、OpenRouter、
  Groq、DeepSeek 等任何 OpenAI 格式服務）

## 部署前需要準備

1. **AI 供應商 key**（預設 NVIDIA NIM）— 到 https://build.nvidia.com 用
   NVIDIA 帳號登入，任選一個模型點 **Get API Key**，取得 `nvapi-` 開頭的 key。
   免費額度是評估用的 1000 點（1 點約 1 次請求），長期大量使用需注意額度。
   要換別家也行：任何 OpenAI 相容服務改 base URL 和 key 即可。
2. **Discord 應用程式憑證** — 到 https://discord.com/developers/applications
   選原本的應用程式：
   - Bot 頁：Reset Token 取得 `DISCORD_BOT_TOKEN`
   - OAuth2 頁：記下 Client ID 和 Client Secret
3. **Neon 資料庫** — https://neon.com 免費開專案（Region 選 Singapore），
   Copy connection string（`postgresql://...?sslmode=require`）。

## 部署步驟（手動，免費方案）

1. **把這個資料夾推上 GitHub** repo。
2. 到 https://render.com → **New → Web Service**，選 repo，Language 偵測為
   Docker，Instance Type 選 **Free**，Region 選 Singapore。
3. 環境變數：
   - `DATABASE_URL` → Neon 連線字串（整串含 `?sslmode=require`）
   - `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` → `https://integrate.api.nvidia.com/v1`
   - `AI_INTEGRATIONS_ANTHROPIC_API_KEY` → `nvapi-` 開頭的 key
   - `DISCORD_BOT_TOKEN`、`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`
   - `ADMIN_TOKEN`（管理後台密碼，自訂一串隨機字）
   - `NEWS_SCHEDULE_TZ` → `Asia/Taipei`
4. 等 Docker 建置完成、服務啟動。啟動時會自動跑所有資料庫遷移和
   地圖/城市播種（全新資料庫，玩家從零開始）。
5. **更新 Discord OAuth 重新導向網址**：回 Discord Developer Portal →
   OAuth2 → Redirects，加上 `https://<你的服務網域>/api/auth/discord/callback`。
6. **（AI 客服用）開啟 Message Content Intent**：Discord Developer Portal → 你的應用程式 →
   Bot → Privileged Gateway Intents → 打開 **MESSAGE CONTENT INTENT** 並儲存。
   沒開的話機器人會登入失敗（錯誤 `Used disallowed intents`），連通知 DM 都會中斷。
   邀請機器人進伺服器時需要「檢視頻道、傳送訊息、讀取訊息歷史、新增反應」權限。
   之後由**機器人擁有者**在想當客服的頻道輸入 `/客服頻道 設定` 即可（`/客服頻道 取消`、`/客服頻道 狀態`）。
   **客服查程式碼**：客服會從 GitHub 抓原始碼建索引來回答 Bug／機制問題，預設讀
   `zhangzoulin1875-ctrl/world-simulator` 的 `main`（公開 repo 不需金鑰）。可用環境變數調整：
   `SUPPORT_GITHUB_REPO`（`owner/name`）、`SUPPORT_GITHUB_REF`（分支，預設 main）、
   `SUPPORT_GITHUB_TOKEN`（私有 repo 才需要，只給唯讀 Contents 權限）。
   每 30 分鐘檢查一次有沒有新 commit，沒變就不重抓；GitHub 暫時連不上時沿用舊索引。
7. 打開 `https://<你的服務網域>` 測試，登入 Discord，開始玩。

## 免費方案提醒

- Render Free 的 web 服務 15 分鐘沒流量會休眠，冷啟動約 1 分鐘；
  建議設自動 ping `/api/healthz` 保持喚醒。
- Neon 免費版不會過期；閒置時運算自動暫停、有連線自動喚醒，資料不會不見。
- NVIDIA NIM 免費額度用完後，可在 admin 頁 `/ai-usage` 觀察用量，
  換供應商只需改 `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`、key 和模型名。

全部清單和說明見 `.env.example`。Render 自動注入 `PORT`，不必手動設。

## 疑難排解

- 服務起不來：Render dashboard → Logs。`/api/healthz` 是免 DB 健康檢查。
- OAuth 失敗：確認 redirect URI 完全一致（含 https）。
- AI 功能 503：檢查 AI key 額度；AI 配額管理在 admin 頁 `/ai-usage`。
