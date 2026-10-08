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
  // 黑市(2026-10-08):中間價與成交紀錄。同樣只建新表、不碰 player_nations。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS market_prices (
      good text PRIMARY KEY
        CHECK (good IN ('wood','ore','ironcoal','oil','rare','spice','cloth')),
      mid double precision NOT NULL CHECK (mid > 0),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS market_trades (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      good text NOT NULL
        CHECK (good IN ('wood','ore','ironcoal','oil','rare','spice','cloth')),
      side text NOT NULL CHECK (side IN ('buy','sell')),
      qty bigint NOT NULL CHECK (qty > 0),
      money bigint NOT NULL CHECK (money >= 0),
      fee bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
      mid_after double precision NOT NULL,
      actor text NOT NULL DEFAULT 'player' CHECK (actor IN ('player','npc')),
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS market_trades_nation_good_idx
      ON market_trades (nation_id, good, created_at)
  `);
}
