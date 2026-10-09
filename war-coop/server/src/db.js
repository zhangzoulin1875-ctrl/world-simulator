import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export function makePool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 未設定');
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 5), ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? false : { rejectUnauthorized: false } });
  // 閒置連線出錯(例如資料庫重啟)不能讓整個服務崩潰:記錄後讓連線池自行汰換
  pool.on('error', (err) => console.error('pg pool error (已忽略,連線池會重建):', err.message));
  return pool;
}

/** 啟動時套用 sql/*.sql(依檔名順序,已套用的略過)。檔案本身冪等,所以失敗重跑也安全。 */
export async function migrate(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = path.join(here, '..', 'sql');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const name = f.replace(/\.sql$/, '');
    if (done.has(name)) continue;
    await pool.query(readFileSync(path.join(dir, f), 'utf8'));
    await pool.query('INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    console.log('migration applied:', name);
  }
}
