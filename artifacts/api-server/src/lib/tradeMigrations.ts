import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * 貿易系統的 idempotent 啟動遷移(2026-10-08)。
 *
 * 只建新表 nation_goods,不碰 player_nations(鐵則:新增 player_nations 欄位要放最前面的
 * 資源欄位遷移,而本系統刻意避開)。必須在 player_nations 建立之後執行(FK)。
 * 不包 try/catch:失敗必須讓 bootstrap 大聲失敗。
 * 永不跑 drizzle-kit push。
 */
export async function runTradeMigrations(): Promise<void> {
  await withTestMigrationStamp("trade", runTradeMigrationsInner);
}

export async function runTradeMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS nation_goods (
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      good text NOT NULL
        CHECK (good IN ('food','ironcoal','oil','rare','spice','cloth')),
      stock bigint NOT NULL DEFAULT 0 CHECK (stock >= 0),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (nation_id, good)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS nation_goods_good_idx ON nation_goods (good)
  `);
}
