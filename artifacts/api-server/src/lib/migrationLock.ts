import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * 啟動遷移的全域諮詢鎖（advisory lock）。
 *
 * `CREATE UNIQUE INDEX IF NOT EXISTS` 對「兩個連線同時建立同一索引」並不安全，
 * 會在 pg_class 撞出 23505（duplicate key ... already exists）。正式環境的
 * bootstrap 依序 await 各遷移，不會併發；但 `test` workflow 以 `tsx --test`
 * 平行跑多個測試檔（各自獨立 process／連線池），多份檔案的 before() 會同時執行
 * 同一批遷移而互撞。用一把跨 session 的 pg_advisory_lock 把遷移 DDL 串行化即可。
 *
 * 鎖以「專屬連線」取得並釋放（drizzle 的 db.execute 每次可能取到不同的池連線，
 * 無法保證 lock/unlock 落在同一 session）；DDL 仍照常走 db（其他池連線），因為
 * advisory lock 是全域的——只要本次未釋放，其他 process 的取鎖就會等待。
 *
 * 正式部署（autoscale promote）例外：新版本啟動時，舊版本仍在服務並持有熱門資料表
 * 的鎖；若此處以「阻塞式」pg_advisory_lock 等待一個殘留／被佔用的鎖，整個 bootstrap
 * 會卡死、連接埠永遠打不開、健康檢查逾時而部署失敗。因此在 production 改用
 * 「非阻塞 pg_try_advisory_lock + 有上限的重試」；逾時就記錄警告並在無鎖情況下繼續
 * （DDL 皆為冪等，且部署環境的 schema 已由 Replit Publish 套用，本鎖只是保險性的串行器）。
 * dev／test 維持原本的阻塞行為，確保平行測試仍受 23505 保護。
 */
const MIGRATION_LOCK_KEY = 0x6d696772; // "migr"

// 只有正式部署才把取鎖上限化；dev／test 需要維持阻塞式取鎖，避免平行測試重新
// 撞上 CREATE UNIQUE INDEX 的 23505 競態。
const BOUNDED_WAIT = process.env["NODE_ENV"] === "production";
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 500;

/**
 * Task #569 — 測試回合的「遷移已套用」戳記快速路徑。
 *
 * 整套測試（多個測試檔＝多個 process）跑在同一個開發 DB 上，每個檔案的
 * before() 都會重跑同一批 idempotent 啟動遷移，固定開銷可觀。測試指令以
 * `MIGRATION_TEST_RUN_ID=<唯一值>` 前綴啟動後，同一回合內第一個跑完某遷移
 * 模組的檔案會在 game_flags 寫入
 * `test-migration-stamp:<module>:<runId>` 戳記；之後的檔案查到戳記即整段跳過。
 *
 * 設計要點：
 * - 未設 MIGRATION_TEST_RUN_ID（正式啟動、單檔手動跑）→ 完全不走戳記，行為不變。
 * - run id 每次測試回合都唯一 → 程式碼改動後的新回合必定重跑全部遷移。
 * - 單元／整合兩套件可能併發跑在同一 DB（各自的 run id）→ 戳記互不相認、
 *   互不刪除；舊回合殘留由 age-gated 清理（>12 小時）兜底。
 * - 戳記讀寫任何失敗都靜默降級為「重跑遷移」（idempotent，安全）。
 * - 維護規則：驗證「遷移本身行為」（修復/回填等副作用）的測試，必須在測試
 *   本體直呼未包戳記的 `runXxxMigrationsInner`（例：regionBuildings.race 直呼
 *   runResourceMigrationsInner）；只依賴 schema 存在的 before() 呼叫維持走
 *   戳記包裝版即可。新增遷移模組時：原本有鎖 → withMigrationLockStamped；
 *   原本無鎖 → withTestMigrationStamp（切勿引入巢狀 withMigrationLock，會互鎖）。
 */
const TEST_RUN_ID = process.env["MIGRATION_TEST_RUN_ID"];
const STAMP_PREFIX = "test-migration-stamp:";

function stampKey(module: string): string {
  return `${STAMP_PREFIX}${module}:${TEST_RUN_ID}`;
}

async function hasStamp(module: string): Promise<boolean> {
  if (!TEST_RUN_ID) return false;
  try {
    const res = await pool.query(
      "SELECT 1 FROM game_flags WHERE key = $1 LIMIT 1",
      [stampKey(module)],
    );
    return (res.rowCount ?? 0) > 0;
  } catch {
    // game_flags 尚不存在（全新 DB）等 → 視為無戳記，走完整遷移。
    return false;
  }
}

async function writeStamp(module: string): Promise<void> {
  if (!TEST_RUN_ID) return;
  try {
    // 與 diplomacyMigrations 的正式定義完全一致（僅為全新 DB 的先行兜底）。
    await pool.query(`CREATE TABLE IF NOT EXISTS game_flags (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )`);
    await pool.query(
      "INSERT INTO game_flags (key) VALUES ($1) ON CONFLICT (key) DO NOTHING",
      [stampKey(module)],
    );
    // 舊測試回合殘留戳記的 age-gated 清理（run id 永不重用，僅防無限累積）。
    await pool.query(
      `DELETE FROM game_flags WHERE key LIKE '${STAMP_PREFIX}%' AND created_at < NOW() - interval '12 hours'`,
    );
  } catch (err) {
    logger.warn(
      { err, module },
      "測試遷移戳記寫入失敗（非致命：之後的測試檔會重跑該遷移）",
    );
  }
}

/**
 * 有鎖遷移模組用：戳記快速路徑 + advisory lock + 鎖內二次確認。
 * 未設 MIGRATION_TEST_RUN_ID 時等同 withMigrationLock(fn)。
 */
export async function withMigrationLockStamped(
  module: string,
  fn: () => Promise<void>,
): Promise<void> {
  if (await hasStamp(module)) return;
  await withMigrationLock(async () => {
    // 鎖內二次確認：平行測試檔在鎖外同時 miss 時，只有第一個真正執行。
    if (await hasStamp(module)) return;
    await fn();
    await writeStamp(module);
  });
}

/**
 * 無鎖遷移模組用：僅戳記快速路徑，不引入 advisory lock（維持既有併發語意，
 * 且避免與模組內部既有的 withMigrationLock 巢狀取鎖互鎖）。
 * 未設 MIGRATION_TEST_RUN_ID 時等同直接執行 fn。
 */
export async function withTestMigrationStamp(
  module: string,
  fn: () => Promise<void>,
): Promise<void> {
  if (await hasStamp(module)) return;
  await fn();
  await writeStamp(module);
}

export async function withMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  try {
    if (BOUNDED_WAIT) {
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        const res = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [MIGRATION_LOCK_KEY],
        );
        if (res.rows[0]?.locked) {
          acquired = true;
          break;
        }
        if (Date.now() >= deadline) {
          logger.warn(
            "migration advisory lock unavailable within timeout; proceeding without it (idempotent DDL)",
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    } else {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      acquired = true;
    }
    return await fn();
  } finally {
    try {
      // 只在真的取得鎖時才解鎖：對未持有的鎖呼叫 pg_advisory_unlock 會回 false 並
      // 記一筆 WARNING，徒增噪音。
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}
