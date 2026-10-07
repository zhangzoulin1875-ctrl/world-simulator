import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withMigrationLockStamped } from "./migrationLock";

/**
 * 選舉與議會 — idempotent 遷移。只 ADD / CREATE IF NOT EXISTS，絕不 DROP。
 * 依賴 player_nations（FK），須放在遷移鏈尾端。
 */
export async function runParliamentMigrations(): Promise<void> {
  await withMigrationLockStamped("parliament", () => runParliamentMigrationsInner());
}

type MigrationExecutor = Pick<typeof db, "execute">;

export async function runParliamentMigrationsInner(
  executor: MigrationExecutor = db,
): Promise<void> {
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS parliament_state (
      nation_id uuid PRIMARY KEY REFERENCES player_nations(id) ON DELETE CASCADE,
      satisfaction integer NOT NULL DEFAULT 60,
      tick integer NOT NULL DEFAULT 0,
      last_demand_tick integer,
      active_demand jsonb,
      protest_text text NOT NULL DEFAULT '',
      last_report_tick integer,
      last_report_feedback text NOT NULL DEFAULT '',
      revolutions integer NOT NULL DEFAULT 0,
      prev_tax_rate integer,
      prev_army_pop text,
      prev_policy_count integer,
      last_parties_tick integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT parliament_state_sat_check CHECK (satisfaction >= 0 AND satisfaction <= 100)
    )
  `);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS parliament_parties (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      name text NOT NULL,
      stance text NOT NULL,
      description text NOT NULL DEFAULT '',
      weight integer NOT NULL DEFAULT 1,
      seats integer NOT NULL DEFAULT 0,
      color text NOT NULL DEFAULT '#888888',
      is_ruling boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT parliament_parties_seats_check CHECK (seats >= 0 AND seats <= 100)
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS parliament_parties_nation_idx ON parliament_parties (nation_id)
  `);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS parliament_log (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      tick integer NOT NULL,
      kind text NOT NULL,
      summary text NOT NULL,
      sat_delta integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS parliament_log_nation_idx ON parliament_log (nation_id, id)
  `);
  // 已存在的舊表補欄位（CREATE IF NOT EXISTS 不會補欄位）。
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS prev_tax_rate integer`);
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS prev_army_pop text`);
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS prev_policy_count integer`);
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS last_election_tick integer`);
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS caretaker boolean NOT NULL DEFAULT false`);
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS formation_failures integer NOT NULL DEFAULT 0`);
  await executor.execute(sql`ALTER TABLE parliament_parties ADD COLUMN IF NOT EXISTS in_coalition boolean NOT NULL DEFAULT false`);
  // 既有存檔:把現在的總理黨(is_ruling)補成單黨政府成員,避免升級後有些國家完全沒有聯合成員。
  await executor.execute(sql`UPDATE parliament_parties SET in_coalition = true WHERE is_ruling = true AND in_coalition = false`);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS parliament_campaign_actions (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      election_tick integer NOT NULL,
      party_id text NOT NULL,
      action text NOT NULL,
      caught boolean NOT NULL DEFAULT false,
      cost bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS parliament_campaign_nation_idx ON parliament_campaign_actions (nation_id, election_tick)
  `);
  // 同一屆、同一個黨、同一招只能有一筆:並發雙擊由資料庫擋下(整筆交易含扣款一起回滾)。
  await executor.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS parliament_campaign_unique_idx
    ON parliament_campaign_actions (nation_id, election_tick, party_id, action)
  `);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS military_demands (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      region_id integer NOT NULL,
      region_name text NOT NULL,
      target_nation_id uuid,
      target_nation_name text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    )
  `);
  // 2026-10-07:要求逾時(回合制)+ 決策當下的滿意度留痕(有效值/基底值)。
  await executor.execute(sql`ALTER TABLE military_demands ADD COLUMN IF NOT EXISTS created_tick integer`);
  await executor.execute(sql`ALTER TABLE military_demands ADD COLUMN IF NOT EXISTS due_tick integer`);
  await executor.execute(sql`ALTER TABLE military_demands ADD COLUMN IF NOT EXISTS effective_satisfaction integer`);
  await executor.execute(sql`ALTER TABLE military_demands ADD COLUMN IF NOT EXISTS base_satisfaction integer`);
  await executor.execute(sql`CREATE INDEX IF NOT EXISTS military_demands_nation_idx ON military_demands (nation_id, created_at)`);
  await executor.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS military_demands_one_pending_uidx ON military_demands (nation_id) WHERE status = 'pending'`);

  // ── 憲法系統 ─────────────────────────────────────────────────────────
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS constitutions (
      nation_id uuid PRIMARY KEY REFERENCES player_nations(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'draft',
      draft_text text NOT NULL DEFAULT '',
      final_text text,
      ratified_tick integer,
      ratified_at timestamptz,
      submissions integer NOT NULL DEFAULT 0,
      last_submit_tick integer,
      last_review jsonb,
      flaws jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT constitutions_status_check CHECK (status IN ('draft','reviewing','ratified')),
      CONSTRAINT constitutions_len_check CHECK (char_length(draft_text) <= 12000)
    )
  `);
  await executor.execute(sql`ALTER TABLE constitutions ADD COLUMN IF NOT EXISTS review_started_at timestamptz`);
  await executor.execute(sql`ALTER TABLE constitutions ADD COLUMN IF NOT EXISTS submit_paid bigint NOT NULL DEFAULT 0`);
  // 「通過後不可更改」的硬規則放在資料庫層：不論哪條程式路徑（含日後新增的）都繞不過。
  // 已通過的列：禁止改 final_text / draft_text / status，也禁止刪除（nation 被刪時的 CASCADE 例外，
  // 因為 CASCADE 刪除發生在 nation 被刪的情況，此時沒有「憲法被修改」的問題）。
  // 只允許更新 flaws（階段 3 漏洞掃描）、last_review、updated_at。
  await executor.execute(sql`
    CREATE OR REPLACE FUNCTION constitutions_lock_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'ratified' THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.final_text IS DISTINCT FROM OLD.final_text
           OR NEW.draft_text IS DISTINCT FROM OLD.draft_text
           OR NEW.ratified_tick IS DISTINCT FROM OLD.ratified_tick
           OR NEW.ratified_at IS DISTINCT FROM OLD.ratified_at THEN
          RAISE EXCEPTION 'constitution is ratified and cannot be modified';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  // 不用 DROP（本檔慣例只增不刪）：trigger 不存在才建立；函式本體用 CREATE OR REPLACE 已可更新規則。
  await executor.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'constitutions_lock_trg') THEN
        CREATE TRIGGER constitutions_lock_trg BEFORE UPDATE ON constitutions
        FOR EACH ROW EXECUTE FUNCTION constitutions_lock_guard();
      END IF;
    END $$
  `);
}
