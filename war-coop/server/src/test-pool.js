// 僅供本機測試:用內嵌 PGlite 提供與 pg.Pool 相同的 query/connect 介面,不走網路 socket。
// 正式環境不會載入這個檔案(只有設了 USE_PGLITE=1 才 import)。
import { PGlite } from '@electric-sql/pglite';

export async function makePglitePool() {
  const db = new PGlite();
  await db.waitReady;
  let tail = Promise.resolve();
  const lock = () => { let release; const prev = tail; tail = new Promise((r) => (release = r)); return prev.then(() => release); };
  const toRes = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  const exec = async (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) { await db.exec(sql); return { rows: [], rowCount: 0 }; }
    if (!params || !params.length) { const r = await db.exec(sql); return { rows: r.at(-1)?.rows ?? [], rowCount: 0 }; }
    return toRes(await db.query(sql, params));
  };
  return {
    async query(sql, params) { const release = await lock(); try { return await exec(sql, params); } finally { release(); } },
    on() {},
    async connect() { const release = await lock(); return { query: (s, p) => exec(s, p), release }; },
  };
}
