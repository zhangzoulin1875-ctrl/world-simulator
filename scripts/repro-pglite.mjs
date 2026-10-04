// Local reproduction DB: PGlite exposed over the Postgres wire protocol
// so the real api-server (node-postgres Pool) can connect to it.
import { PGlite } from "@electric-sql/pglite";
import { writeFileSync, mkdirSync } from "node:fs";

const DATA_DIR = "/tmp/pglite-ws-db";
mkdirSync(DATA_DIR, { recursive: true });

const db = await PGlite.create(DATA_DIR);
const socketMod = await import("@electric-sql/pglite-socket");
const ServerClass = socketMod.PGLiteSocketServer ?? socketMod.default?.PGLiteSocketServer;
console.log("socket server class:", typeof ServerClass);
const server = new ServerClass({ db, port: 5433, host: "127.0.0.1", maxConnections: 50 });
await server.start();

// Ad-hoc query helper for seeding, driven by files so we can poke the DB from bash.
const CMDFILE = "/tmp/pglite-ws-db/cmd.sql";
const OUTFILE = "/tmp/pglite-ws-db/out.json";
setInterval(async () => {
  try {
    if (!existsSync(CMDFILE)) return;
    const sqlText = readFileSync(CMDFILE, "utf8");
    unlinkSync(CMDFILE);
    try {
      const rows = await db.exec(sqlText);
      const out = rows.map((r) => ({
        columns: r.columns?.map((c) => c.name) ?? [],
        rowCount: r.rowsAffected ?? 0,
      }));
      writeFileSync(OUTFILE, JSON.stringify(out, null, 1).slice(0, 50000));
    } catch (e) {
      writeFileSync(OUTFILE, JSON.stringify({ error: String(e) }));
    }
  } catch {
    /* ignore */
  }
}, 400);

// live SQL query channel: write query to q.sql, read result json from q.json
import { readFileSync, unlinkSync, existsSync } from "node:fs";
const QIN = "/tmp/pglite-ws-db/q.sql";
const QOUT = "/tmp/pglite-ws-db/q.json";
setInterval(async () => {
  try {
    if (!existsSync(QIN)) return;
    const sqlText = readFileSync(QIN, "utf8");
    unlinkSync(QIN);
    try {
      const ret = await db.query(sqlText);
      writeFileSync(QOUT, JSON.stringify({ rows: ret.rows, fields: ret.fields }, null, 1).slice(0, 80000));
    } catch (e) {
      writeFileSync(QOUT, JSON.stringify({ error: String(e) }));
    }
  } catch {
    /* ignore */
  }
}, 300);

console.log("pglite socket ready on 127.0.0.1:5433");
