# 架空世界模擬器

## Overview

Discord-native fictional-world simulator: players sign in with Discord and build a nation on a shared 373-region world map — 建國、世界地圖、軍事、外交、政治、經濟、回合制. React + Vite dashboard hosts the game; a Discord bot only DMs players game notifications; Anthropic Claude backs the AI systems (unit design, war/finance/politics resolution, NPC diplomacy). The former "Discord News" newsroom & 微國家資訊系統 were fully removed — only the game remains.

## User preferences

- 溝通與介面一律使用繁體中文（台灣）；錯誤訊息 zh-TW，僅專有名詞/憑證保留英文。

## Stack

- **Monorepo** pnpm workspaces · Node 24 · TS 5.9 · Express 5 · PostgreSQL + Drizzle · Zod (`zod/v4`) + drizzle-zod · Orval codegen (OpenAPI) · esbuild server bundle · discord.js v14 · React + Vite + TanStack Query + wouter.
- **AI**: Anthropic via Replit AI Integrations. Dual-tier abstraction in `lib/aiModels.ts` (env `AI_MODEL_QUALITY`/`AI_MODEL_BULK`) preserved, but **both tiers now default to Haiku** (`claude-haiku-4-5`) for cost — 全系統統一用 Haiku。原本 quality 線（兵種設計/戰爭/財政結算/超事件生成/內閣主判定）走 Sonnet，如需恢復把 `AI_MODEL_QUALITY` 設回 `claude-sonnet-4-6` 即可（不必改碼）。
- **AI 用量與限額（Task #593）**：所有 anthropic 呼叫**一律走 `lib/gameAi.ts` 的 `callGameAi(feature, tier, params)`**（21 功能註冊表；wrapper 在呼叫當下動態取用 `anthropic.messages.create`，測試屬性樁不受影響——新增 AI 呼叫點勿直接 import anthropic）。每次呼叫記錄到 `ai_usage_logs`（30 天 prune 於回合引擎；記錄失敗吞掉）；`ai_feature_settings` 可設每功能 max_tokens 覆寫（下限 256）與每日 token 配額（NEWS_SCHEDULE_TZ 當地日；設定/用量讀取失敗 fail-open）。配額用罄丟 `AiQuotaExceededError`——玩家手動路由（兵種設計/顧問/內閣候選/外交訊息/條約）須先回滾扣款再回 503 zh-TW；背景迴圈各自 try/catch。admin API `/api/ai-usage/*`（requireAdmin raw fetch、不進 spec）＋ AdminOnly 頁 `/ai-usage`。

## Artifacts

- `artifacts/api-server` — Express API + Discord bot worker (single process).
- `artifacts/discord-news` — React dashboard; `/` redirects to `/game`. `/game/*` pages render full-screen outside the admin Layout; only read-only world map + AdminOnly pages live outside `/game`.

## 鐵則（違反會壞資料或壞架構）

- **Never run `drizzle-kit push`** — interactive, proposes destructive truncations, forever sees phantom diffs. ALL schema changes are guarded idempotent startup migrations run from `index.ts`, FK-ordered (game → map/region-control/era/city → military → diplomacy → politics → war → economy → …). `scripts/post-merge.sh` only runs `pnpm install`.
- **drizzle schema 的 `.references(onDelete)` ≠ 實際 DB 約束**：手寫啟動遷移才是 FK 的 SSOT。實測 `diplomacy_wars`／`diplomacy_treaties` 的 nation 欄位（nation_a/b_id、declared_by、proposer/target）在真實 DB **無 ON DELETE CASCADE**（僅 `diplomacy_wars.ceasefire_proposed_by` 為 SET NULL），儘管 schema 宣告 cascade。故任何硬刪國家的路徑都必須**顯式刪除**這兩表的相關列，否則殘留「進行中（endedAt NULL）」孤兒戰爭列會凍結對手外交（見 NPC↔NPC inert-war 鐵則）。改任何刪國邏輯前先 `pg_constraint` 查真實約束，勿信 schema。
- **Dropped columns stay dropped**: `player_nations` static `production`/`population`/`tech_per_turn` were one-way DROPped — stats are computed per request. Never re-add.
- **Replit object storage is NOT used** (sidecar auth broken repl-wide). Binaries live in Postgres bytea: `game_images` (admin ≤10MB / player ≤5MB uploads, served at `GET /api/storage/images/:id`), `game_music_tracks` (HTTP Range streaming). Image URLs validated by `validateImageUrl` (explicit 400, never silent drop).
- **NPC↔NPC war rows must never be created** — they never settle and permanently freeze that pair's diplomacy. Every declare-war/campaign path re-guards target `!isNpc && discordUserId`.
- **API auth split**: Admin APIs = `requireAdmin` (`ADMIN_TOKEN` bearer / `x-admin-token`), frontend raw fetch, **NOT in the OpenAPI spec**. Player APIs = Discord-session-gated (401 zh-TW), **in the spec** (Orval hooks + zod). AI endpoints add `aiRateLimit` (5/min/IP). 內閣 player APIs are a deliberate exception (session-gated but raw fetch, not in spec).
- **Race safety**: resource mutations = `db.transaction` + conditional `UPDATE ... WHERE` spend guards; founding/legions = `pg_advisory_xact_lock`; unique violation → 409 via `pgErrorCode` (walks the Drizzle `cause` chain). In-memory locks claimed synchronously before any `await`.
- **Numbers**: stored stat columns (stability/unrest/warWeariness/4 satisfactions/tax/budgets) are integers 0–100; computed values rounded to ≤1 decimal **only at route serialization** (never in compute helpers — turn engine needs full precision). Population/production/tech = integers.
- **Time**: daily/turn logic uses local dates in `NEWS_SCHEDULE_TZ` (default `Asia/Taipei`); `localDateString` in `lib/time.ts`.
- **科技樹時代守門（主幹線閘門）**：全球統一線性科技樹（牌組/AI 生成科技已全面移除）。完成該領域該時代**全部主幹線節點**才推進該領域時代（`advanceDomainEra`/`isEraMainLinesComplete`，`lib/techTree.ts`）；舊時代節點永遠可回頭研發；三領域（social/production/military）各自獨立推進。不要改成看全域 `current_era` 擋研發。
- **戰爭傷亡是伺服器決定的**：AI 只給敘事與意圖（aggressionPct），損失量全部來自 `lib/war.ts` 純函式（有戰力上限）。不要讓任何 AI 欄位變成損失數量。

## Discord Bot

- `DISCORD_BOT_TOKEN` missing/invalid → API still serves, bot offline, watchdog retries. Intents = **`[Guilds]` only**, no privileged intents. Purpose is DM notifications only (外交/回合/政治) — no channels, no slash commands.
- 換新 bot：沿用同名 secrets（`DISCORD_BOT_TOKEN`/`DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`）填入新 application 的值即可。

## World Map（唯讀）

- 373 regions / 14 macro regions（`map_regions` + adjacencies，seed `mapRegions.ts`；tests 鎖定 counts/對稱性）；288 cities（`map_cities`）。SSOT = `scripts/src/worldmap/regionMaster.ts`（肥沃度 `f` 基準 0–120，data-only 未接玩法；種子測試鎖值域帶）。
- **時代數據**: 373 regions × 14 eras（古典→未來）in `map_region_era_stats`，deterministic（無 AI）。全域時代與時鐘在單列 `world_game_state` (id=1)。
- UI: `pages/world-map.tsx`（玩家 `/game/map` 與 admin `/world-map` 共用）＋ `components/world-district-map.tsx`（d3-geo + 靜態 `public/world-districts.topo.json`）。視圖：一般/人口/生產素質/科技點數/政治（政治視圖上色 by 主導國，公開 `GET /api/map/political`）。
- Build pipelines（只在改行政區時跑）：`build:worldmap`、`build:areas`。

## Game systems（各域重點）

- **玩家國家**：`player_nations`（nullable unique `discord_user_id`，null=無主國家；stability/unrest/warWeariness + 4 滿意度）。`GET /api/player/nation` 不自動建國；人口/生產/科技 per-request 計算 = Σ(percent × era stat + `region_controls.population_bonus`)，`::bigint` 先轉再乘；穩定度乘數 ±30%。軍事可用 = computed − spent − 前線 − 傷兵。
- **建國**：14 政體（`lib/governments.ts`，建國後鎖定）；自創（未被佔領地區 → 100% 掌控，advisory lock）或接手無主國家（conditional UPDATE）。退出 → 無主（領土保留）；刪除 → 硬刪。
- **地區歸屬** `region_controls`：nation × region × percent 1–100，每區 Σ ≤ 100 由寫入端保證；hourly 超額健檢自動等比修復。
- **國家管理 admin `/npc-nations`**：PATCH 可編輯任何國家但**永不寫 `discord_user_id`/`is_npc`**；`regions` 僅在有帶時 full-replace。
- **軍事**：3 tabs（建造軍隊/指揮部/軍事指令）＋ 兵種設計（AI，每類上限 5）。招募/購買 tx + conditional-UPDATE；設計先扣點、失敗退款；日購買上限 = 1% 人口。軍事科技 = 全球科技樹 military 領域（見科技樹）。**生產力花費 vs 佔用（Task #568）**：招募另收一次性花費 ⌈數量 × 有效 prodCostPer100 ÷ 100⌉，記為流量 `recruit_production_spends`（本回合 = created_at > world_game_state.last_turn_at，回合引擎 claim 後清舊列）；解散不退、跨回合失效；佔用 = unitProductionReservation 不變；可用生產力 = 生產 − 佔用 − 本回合招募花費（`computeAvailableProduction`）；金錢購買只收金錢＋佔用。prodUpkeep（每回合生產力維護費扣減）已整組移除，勿再加回。
- **戰爭** `/game/military/war/:id`：campaign（每區一場，30min 冷卻）≤3 軍團/邊、≤5 兵種/團、4 指令型；到期即結算（`cycle_hours` 預設 4h，非批次）；AI 失敗重試、3 次 → 膠著；傷兵國家池 + 復原；城市 holdout 保底（城未陷 → 守方至少留 1%）；領土移轉只在交戰雙方之間、封頂 loser 持分。戰爭結束的每條路徑都必須 `endCampaignsForWar`。**勝負判定以兩位主帥各自持分計（非該邊合計，Task #579）**：領土移轉的輸家永遠是敗方主帥，晚加入者持分不會被本戰役移轉，合計判定會讓敗方側 joiner 殘餘持分卡死戰役；主帥兩區歸零＋城陷即分勝負，joiner 殘餘保留。
- **回合引擎**：minute tick 在 `turn_hour:turn_minute` 觸發每日回合（conditional UPDATE claim `last_turn_date IS DISTINCT FROM today`）：推進日期/時代 → 每國科技/稅收（扣維護 ≥0）→ 人口成長（per-region 累積在 `population_bonus`）→ 政治/經濟/超事件結算 → 軍事快照 → **NPC 除名**。admin `POST /api/turn/run` `force:true` 可跳過當日限制。
- **NPC 除名（領土歸零自動除名）**：軍事快照後執行 `runNpcExtinctionCheck`（`lib/npcExtinction.ts`）：掃 `is_npc=true` 且無任何 `region_controls`（percent CHECK 1–100，歸零列已刪 → 沒列＝零領土）的 NPC → 通知交戰中真人對手（「戰爭結束：敵國已滅亡」，`notifyWarEndedByElimination`，走 `fireNotify` 站內優先）→ `endCampaignsForNation` 優雅結束戰役（釋放交戰鎖/歸還傷兵/通知）→ **同交易顯式刪除**該 NPC 的 `diplomacy_wars`／`diplomacy_treaties` 列（無真實 cascade，見鐵則）＋硬刪國家（re-guard `is_npc=true`）。無主國家（`is_npc=false`）與玩家國家**永不**自動除名。每 NPC 各自 try/catch，單一失敗不阻斷回合；偵測每回合重跑＝自癒。`TurnUpdateSummary.npcExtinction.deletedCount` 回報。
- **stats_era vs current_era**：玩家數據永遠以 `stats_era` 計（null → fallback `current_era`）；`current_era` 管地圖顯示/背景/解鎖/生成。自然換代同步兩者；admin 改年份只動 `current_era`（除非 `syncEraStats:true`）。
- **科技樹（全球統一線性，文明六式）**：全球共用一棵樹 `tech_tree_nodes`（domain × era × 線 lineKey/lineKind 主幹或支線 × sortOrder；支線有 branchAnchor 掛回主幹節點；效果 jsonb、keySlug 關鍵科技標記、主幹基礎成本高於支線）；種子確定性（`lib/techTreeSeed/`，14 時代 × 3 領域、每時代每領域 ≥2 主幹線、每線 ≥10 節點，不變量測試鎖住）。各國狀態在 `player_tech_tree_states`（每領域一列：領域時代、進行中節點＋**成本快照**＋累積進度＋分配比例）＋ `player_researched_tree_nodes`。**回合制研發不可累積**：每回合灌點 = 全國科研點 × 該領域比例（整數 %，三領域合計 100，**最大餘數法拆分**——`lib/researchAllocation.ts` 純函式，回合引擎與總覽路由共用，份額總和守恆＝整數收入）；完成套效果 + `fireNotify`；**未分配/無進行中 → 作廢**（不轉移）；**完成溢出（progress − 成本快照）玩家國家退回庫存 `tech_points`**，NPC/無主作廢。**自產科研點不入庫**（不寫 `tech_points`，庫存只來自條約/送禮/admin）。同領域一次只能研一項（409）；成本在開始研發當下快照鎖定（`lib/researchCost.ts` 純函式管線，成本 = 基礎 × 國力倍率 × 領先時代加價 `ahead_era_cost_multiplier`）；**研發中節點顯示鎖定的成本快照**（其餘節點動態計價）。前置規則：主幹線上一節點；支線要 anchor＋線內上一節點。內閣自動研發改為從可研發樹節點挑選。玩家 API in spec；**admin 編輯器 `/tech-tree-admin`**（raw fetch、不進 spec）可全 CRUD，刪除已被研發/研發中節點需 `force=1` 連鎖清理。
- **NPC 科技（沿樹逐格研發）**：科技樹兩表（`player_tech_tree_states`/`player_researched_tree_nodes`）已改鍵到 **nation_id**（`discord_user_id` 欄位保留但全 NULL 化、永不再寫——切勿 DROP，也勿再用它查詢）；退出國家時科技進度跟著無主國家保留。NPC 每回合在回合引擎內確定性自動研發（`lib/npcTechTree.ts`：無 AI，科研點 × 固定比例灌入三領域，`autoPickNpcResearch` 挑「時代 ≤ 世界時代」候選中最早時代→主幹優先→sortOrder→id；首次由 `tech_era_*` 指標 lazy 初始化：授予有效時代前全部主幹＋關鍵節點、加當代關鍵節點）。`tech_era_*` 三領域指標仍在（null=跟隨世界 `current_era`），但已降為**鏡像/後援**：每回合 `syncNpcTechEraMirror` 從樹狀態回寫，僅供顯示與無樹狀態時的後援。NPC 兵種類別解鎖以**已研發樹節點**為準（`loadNpcMilitaryKeySlugs` 查樹 join keySlug）；無樹狀態才退回 `MILITARY_KEY_TECHS.eraSlug` 時代近似；種子測試鎖定 keySlug 節點樹上時代與靜態定義一致。NPC 軍事時代一律以 `current_era` 夾取（模板設計與開戰組軍同基準，勿用 stats_era）。NPC 不付 `ahead_era_cost_multiplier`（研發跟隨、不領先世界時代）。**庫存科技點（`player_nations.tech_points`，來自條約/送禮/admin）玩家國家每回合自動消化**：回合研發結算時依領域分配比例拆分投入「進行中節點」，吸收上限＝剩餘所需成本，交易內條件式 UPDATE（tech_points ≥ 消耗量）只扣實際吸收量，溢出/無進行中節點的份額留庫存下回合再消化（自產科研點「未分配/無進行中即作廢」不變，完成溢出退庫存）；NPC/無主國家不消化庫存。
- **結算節奏 worldScheduler**：AI 判定/戰役結算 cadence 存 `world_game_state`（預設 240m），atomic `UPDATE ... WHERE next_run_at <= NOW()` claim；**結算靜默時段**（預設 00–08 local，跨午夜 OK）同時擋外交與戰役結算；admin `/world-sim` 可調。**NPC 主動行動（`runNpcInitiativesTurn` 自行提案條約／宣戰／結盟）已停用** — `runAiJudgment` 只跑 `npcWarTick`（NPC 在既有戰爭中應戰）＋ `settleDueCampaigns`（戰役結算）；`npcInitiative.ts` 保留但不再被呼叫（僅測試引用），要恢復就在 `runAiJudgment` 重新掛回 step 1。NPC 仍會回應玩家主動送來的條約與對話（`decideNpcTreatyResponse`／`decideNpcChatReply`），管理員 `ai_judgment_directive` 仍注入這些回應與戰役結算。
- **經濟**：稅收制（生產力不再產錢）：每回合稅 = floor(人口 × 稅率 × 徵稅效率 / 10000)，稅率上限 50、只能透過 AI 判定的財政政策自由文字改。預算 4 項（法律/文化/宗教/權利，% of 稅收）：<5% 該滿意度 −5、>10% +5。財政分頁 `upkeepPerTurn` 必須與回合引擎同組成（軍隊＋建築＋地區資源建築，合併後 ⌈⌉），有整合測試對帳鎖住。**國庫危機**（`evaluateTreasuryPenalty`，只罰有主國家）：赤字（維護費缺口）四滿意度 −10/穩定 −8/暴動 +8；單純歸零 −5/−4/+4；同一條 UPDATE 內以 SQL clamp 0–100 套用（軍方滿意度欄位上線後應一併納入）。
- **外交**：5 tabs；4 條約類型 + 自訂。條約**雙向交換**（offer* AND request*：金錢/科技/地區含部分 %＋**定期糧食輸送**每回合結算），`activateTreaty` 一 tx 內先 offer 後 request，任何不足 → 400 全回滾（legacy 列可能是相反的付款語義）。**定期生產力輸送＝純流量**（`treatyProductionFlows.ts`，比照糧食）：即時計入 `computeAdjustedNationStats`/breakdown 的 treatyNet，回合結算**永不寫 `production_bonus`**（同 prodUpkeep 類禁令，勿再改回累積制）；廢約即效果消失。重複提案由 partial unique index 擋（409）。NPC 決策 FOR UPDATE、含 7 天記憶（被拒/撤回/關係事件）、重提冷卻 10 分。廢除 −30 關係 vs 撤回無罰。**NPC 即時對話行動**：聊天回覆可執行真實決策（sanitize → 固定順序 executor → 各自 try/catch，委派既有 race-safe 寫入層；宣戰/開戰限真人玩家）。**聯盟**：一國可同時屬多個聯盟（多聯盟制）。
- **附庸**：附庸條約（`proposer_is_vassal` 定向）＝每回合貢金 %稅收＋雙方強制和平＋**宗主自動參戰**（附庸被宣戰時）＋**附庸外交受限**——附庸「宣戰／建立聯盟／加入聯盟（含接受邀請）／攻打無人領土（自動建戰）」皆過 `requireSuzerainConsent`（`lib/vassalConsent.ts`）：NPC 宗主＝**確定性純函式判定**（不呼叫 AI：宣戰看宗主↔目標阻擋條約或關係>0；聯盟看宗主↔附庸關係<0），拒絕 403；真人宗主＝`vassal_consent_requests` pending（partial unique (vassal,action) WHERE pending → 409）→ 宗主於前端核准 → 附庸重試時 conditional UPDATE 一次性消耗（嚴格比對 target/alliance，無目標時 match IS NULL）。可能白耗批准的 409/404 前置檢查要放在守門**之前**（重名聯盟、聯盟不存在）。NPC 附庸永不主動宣戰（`vassal_requires_consent`）；附庸的內閣自動宣戰靜默跳過。
- **內閣代理停用開關**：`lib/cabinet/types.ts` 的 `DISABLED_CABINET_DOMAINS`（目前含 `diplomacy`＝外交代理停用）：回合引擎跳過該領域 runDomain、候選/任命路由回 403 zh-TW、批准路由先查 pending 領域再擋（否決/卸任/設定仍可用以清理）、overview 回 `disabled` 欄位、前端顯示「已停用」。要恢復只需把領域自集合移除（模組與 registry 完整保留）。
- **站內通知**：`fireNotify` **永遠**先寫站內通知（不受 DM opt-out 影響），再走 `deliverDm` opt-out 閘 DM。保留每玩家最新 100 則。
- **超事件 admin `/super-events`**：AI 結算 per-nation deltas × (exposure × gov × fit × stage)；**人口例外** = 直接 % of scoped 人口（只乘 impactPct × 全域倍率，不吃 gov/fit/stage）。`targetStats` 白名單雙層強制：AI prompt 指引 + 每次 AI 判定後 `restrictEffectToTargetStats` 歸零非目標欄位（任何新 apply 路徑都要做）。事件生產者自己決定 scope（generator AI 不決定）。**損失上下限**（settings `loss_min_pct`/`loss_max_pct`，`normalizeLossBounds`/`clampHarmfulDelta`）：只夾**負面**最終有效值（人口%/生產%/四滿意度降/安定降/暴動升；乘完所有倍率後、點數視同百分點），max=0 取消負面、增益不受影響、0 損失不會被 min 抬成損失；**per-delta 夾限**（主效果與回應效果各自夾，非每回合總量帽）；`buildEffectSummary` 顯示同夾（與實套一致）。
- **背景音樂**：Postgres 存檔 + Range streaming；播放器 context 掛在 WouterRouter 內跨路由持續播放。

## Testing

- Workflows：`typecheck`（全 workspace）、`test`（api-server lib 單元 + discord-news）、`test-integration`（真 DB race/integration，`--test-concurrency=1`）、`test-defender-pushback`（獨立跑 war.defenderPushbackSettle，**不在** test-integration 名單內，勿重複加回）。**不要在 shell 直接跑 tsc/測試**（會被 SIGTERM）——用 workflow。
- Integration tests 跑在共用開發 DB：資料用名稱前綴標記、self-cleaning；lib glob 與 integration 併行會自我碰撞（假性 23505/23503），要分開跑。
- **遷移戳記（Task #569）**：`test`/`test-integration` 指令以 `MIGRATION_TEST_RUN_ID=<唯一值>` 前綴啟動 → 同一測試回合內每個遷移模組只跑一次（`migrationLock.ts` 以 game_flags 戳記 `test-migration-stamp:<module>:<runId>` 跳過重跑；未設環境變數＝行為不變）。驗證「遷移本身行為」的測試必須直呼 `runXxxMigrationsInner` 繞過戳記（例：regionBuildings.race）。
- **戰爭測試不打真 AI（Task #569）**：war.race / war.multiNationSettle / war.defenderPushbackSettle / worldSim.warCycle 於模組載入即安裝 anthropic 基準樁（地形簡報合法文字）；war.race 的樁依 system prompt 分流——「兵種設計 AI」請求回合法 JSON 陣列（空地/無主「即時建國 NPC」的開戰守門需要兵種模板）。新增戰爭測試檔比照辦理。
