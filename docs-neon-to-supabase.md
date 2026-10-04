# Neon → Supabase 遷移方案 (world-simulator)

## 為什麼換
- Neon 實測 4.82 CU-hrs / 約 1 天 → 約 145 CU-hrs / 月,額度 100,月中爆。
- 資料量僅 71 MB,Supabase 500 MB 綽綽有餘。
- Supabase 免費版不按醒著時數計費,不再有 compute 額度問題。

## 限制與對策
| 限制 | 對策 |
|---|---|
| 7 天低活動會暫停 | 既有 keep-awake 只打 /api/healthz(不碰 DB)。需加一個每日碰 DB 的輕量查詢 |
| 流量 5 GB/月 | 先觀察遷移後一週的實際流量;首日數字含多次重新部署的播種流量 |
| Render 走 IPv4 | 連線字串用 Shared Pooler **session 模式** (port 5432) |
| advisory lock (地區認領/聯盟/遷移鎖) | 不可用 transaction 模式 (port 6543),否則鎖失效 |
| 500 MB 容量 | 目前 71 MB;超過 400 MB 時清理 relation_events 等歷史表 |

## 步驟
1. Supabase 建專案 (Region: Singapore,與 Render/Neon 同區)。
2. 取得 **直連** 字串做匯出入,**session pooler** 字串給 Render 執行用。
3. 維護窗口(建議玩家少的時段,約 10 分鐘):
   - Render 暫停服務 (避免匯出期間寫入)
   - `pg_dump --no-owner --no-acl --format=custom $NEON_URL > world.dump`
   - `pg_restore --no-owner --no-acl --dbname=$SUPABASE_DIRECT_URL world.dump`
4. 驗證筆數:player_nations、map_regions、diplomacy_treaties、autopilot_settings 兩邊相同。
5. Render 環境變數 `DATABASE_URL` 換成 **session pooler** 字串,重啟。
6. 驗證:/api/healthz、登入、載入國家、AI 託管面板。
7. Neon 專案保留 7 天作為回滾後再刪除。

## 回滾
把 Render 的 `DATABASE_URL` 改回 Neon 連線字串並重啟即可 (Neon 資料在遷移後未再變動)。

## 程式需要的改動
- `lib/db/src/index.ts`: 加 `ssl: { rejectUnauthorized: false }` (Supabase 需要 SSL)。
- 新增每日 DB 保活查詢 (防 7 天暫停)。
