import { pg } from "@workspace/db";

type Client = InstanceType<typeof pg.Client>;

/**
 * 跨資料庫資料搬家(Neon → Aiven 等)。
 * 前提:目標庫的表結構已由應用程式啟動遷移建好(DATABASE_URL 指向目標庫啟動一次)。
 * 本模組只搬「資料」:依外鍵拓撲排序逐表複製、校正序列、比對筆數。不改動來源庫。
 */

export interface CopyTableResult { table: string; source: number; copied: number; ok: boolean; error?: string }
export interface CopyReport {
  tables: CopyTableResult[];
  sequencesFixed: number;
  ok: boolean;
  elapsedMs: number;
}

const BATCH_ROWS = 500;
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** 依外鍵把表排序:被參照的表在前。有環時剩餘的表接在最後(逐表關閉外鍵檢查不可用,故仍依序嘗試)。 */
export function sortTablesByForeignKeys(tables: string[], fks: Array<{ child: string; parent: string }>): string[] {
  const set = new Set(tables);
  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of fks) {
    if (child !== parent && set.has(child) && set.has(parent)) deps.get(child)!.add(parent);
  }
  const out: string[] = [];
  const done = new Set<string>();
  let progress = true;
  while (out.length < tables.length && progress) {
    progress = false;
    for (const t of [...tables].sort()) {
      if (done.has(t)) continue;
      if ([...deps.get(t)!].every((p) => done.has(p))) { out.push(t); done.add(t); progress = true; }
    }
  }
  for (const t of [...tables].sort()) if (!done.has(t)) out.push(t); // 環:放最後
  return out;
}

async function listTables(c: Client): Promise<string[]> {
  const r = await c.query(
    `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`,
  );
  return r.rows.map((x) => x.table_name as string);
}

async function listFks(c: Client): Promise<Array<{ child: string; parent: string }>> {
  const r = await c.query(`
    select cl.relname as child, pl.relname as parent
    from pg_constraint k
    join pg_class cl on cl.oid = k.conrelid
    join pg_class pl on pl.oid = k.confrelid
    where k.contype = 'f' and k.connamespace = 'public'::regnamespace`);
  return r.rows as Array<{ child: string; parent: string }>;
}

async function columnsOf(c: Client, table: string): Promise<string[]> {
  const r = await c.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1 and is_generated <> 'ALWAYS' order by ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name as string);
}

/** json/jsonb 欄位(欄名 → 型別)。pg 讀出會自動 parse 且寫回陣列會被當 Postgres 陣列,故改以 text 原文往返。 */
async function jsonColumnsOf(c: Client, table: string): Promise<Map<string, string>> {
  const r = await c.query(
    `select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1 and data_type in ('json','jsonb')`,
    [table],
  );
  return new Map(r.rows.map((x: { column_name: string; data_type: string }) => [x.column_name, x.data_type]));
}

async function countRows(c: Client, table: string): Promise<number> {
  const r = await c.query(`select count(*)::bigint n from public.${qi(table)}`);
  return Number(r.rows[0].n);
}

/** 把所有「nextval 預設值」的序列校正到該欄位的 max(id)。回傳校正數。 */
export async function fixSequences(dst: Client): Promise<number> {
  const r = await dst.query(`
    select c.relname as tbl, a.attname as col, pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) as seq
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      and pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) is not null`);
  let n = 0;
  for (const row of r.rows as Array<{ tbl: string; col: string; seq: string }>) {
    const m = await dst.query(`select coalesce(max(${qi(row.col)}), 0)::bigint v from public.${qi(row.tbl)}`);
    const v = BigInt(m.rows[0].v as string);
    if (v > 0n) await dst.query(`select setval($1::regclass, $2::bigint, true)`, [row.seq, v.toString()]);
    else await dst.query(`select setval($1::regclass, 1, false)`, [row.seq]);
    n++;
  }
  return n;
}

export async function copyAllData(
  srcUrl: string,
  dstUrl: string,
  opts: { truncateTarget?: boolean; log?: (m: string) => void; ssl?: boolean } = {},
): Promise<CopyReport> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const mk = (u: string) => new pg.Client({ connectionString: u, ...(opts.ssl ? { ssl: { rejectUnauthorized: false } } : {}), connectionTimeoutMillis: 20_000 });
  const src = mk(srcUrl), dst = mk(dstUrl);
  await src.connect(); await dst.connect();
  const results: CopyTableResult[] = [];
  try {
    const srcTables = await listTables(src);
    const dstTables = new Set(await listTables(dst));
    const tables = srcTables.filter((t) => dstTables.has(t));
    const missing = srcTables.filter((t) => !dstTables.has(t));
    if (missing.length) log(`目標庫缺少 ${missing.length} 張表(略過): ${missing.join(", ")}`);
    const ordered = sortTablesByForeignKeys(tables, await listFks(dst));

    if (opts.truncateTarget) {
      await dst.query(`truncate ${ordered.map((t) => `public.${qi(t)}`).join(", ")} restart identity cascade`);
      log("目標庫已清空");
    } else {
      for (const t of ordered) {
        if ((await countRows(dst, t)) > 0) throw new Error(`目標表 ${t} 已有資料;請用 truncateTarget 或換空庫`);
      }
    }

    for (const t of ordered) {
      const cols = await columnsOf(src, t);
      const dcols = new Set(await columnsOf(dst, t));
      const use = cols.filter((c) => dcols.has(c));
      const jsonTypes = await jsonColumnsOf(dst, t);
      const jsonCols = new Set(jsonTypes.keys());
      const total = await countRows(src, t);
      let copied = 0;
      try {
        if (total > 0 && use.length > 0) {
          const colList = use.map(qi).join(", ");
          // json/jsonb 讀成 text 原文:區分 SQL NULL 與 JSON null,且不經 JS parse,完全保真
          const selList = use.map((c) => (jsonCols.has(c) ? `${qi(c)}::text as ${qi(c)}` : qi(c))).join(", ");
          // 資料量小(正式庫約 80 MB),單表一次讀入記憶體即可
          const res = await src.query(`select ${selList} from public.${qi(t)}`);
          const rows = res.rows as Record<string, unknown>[];
          await dst.query("begin");
          for (let i = 0; i < rows.length; i += BATCH_ROWS) {
            const chunk = rows.slice(i, i + BATCH_ROWS);
            const params: unknown[] = [];
            const tuples = chunk.map((row) => `(${use.map((col) => { params.push(row[col] ?? null); return jsonCols.has(col) ? `$${params.length}::${jsonTypes.get(col)}` : `$${params.length}`; }).join(", ")})`);
            // 單句參數上限 65535
            if (params.length > 65000) throw new Error(`表 ${t} 單批參數過多,請調低 BATCH_ROWS`);
            await dst.query(`insert into public.${qi(t)} (${colList}) overriding system value values ${tuples.join(", ")}`, params);
            copied += chunk.length;
          }
          await dst.query("commit");
        }
        const after = await countRows(dst, t);
        results.push({ table: t, source: total, copied: after, ok: after === total });
        log(`${t}: ${total} → ${after}`);
      } catch (e) {
        await dst.query("rollback").catch(() => {});
        results.push({ table: t, source: total, copied, ok: false, error: (e as Error).message.slice(0, 200) });
        log(`${t}: 失敗 ${(e as Error).message.slice(0, 120)}`);
      }
    }
    const sequencesFixed = await fixSequences(dst);
    return { tables: results, sequencesFixed, ok: results.every((r) => r.ok), elapsedMs: Date.now() - t0 };
  } finally {
    await src.end().catch(() => {}); await dst.end().catch(() => {});
  }
}
