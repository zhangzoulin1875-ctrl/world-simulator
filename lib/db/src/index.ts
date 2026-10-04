import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon 會在閒置時關閉連線；讓 pool 自己先淘汰閒置連線並開啟 TCP keepalive，
  // 避免拿到已被伺服器端關掉的死連線。
  idleTimeoutMillis: 30_000,
  keepAlive: true,
  connectionTimeoutMillis: 15_000,
  // Supabase 等託管 Postgres 需要 TLS；Neon 連線字串自帶 sslmode=require。
  // 僅在明確設定 DB_SSL=1 時強制（憑證鏈由託管商簽發，不驗證主機名稱）。
  ...(process.env["DB_SSL"] === "1" ? { ssl: { rejectUnauthorized: false } } : {}),
});
// 閒置連線被遠端關閉時 pg 會在 pool 上發 'error'；沒有監聽者會變成
// uncaughtException 直接把整個 Node 程序打掛（使用者端看到 "Load failed"）。
pool.on("error", (err) => {
  console.error("[db] idle pool client error (ignored, pool will reconnect):", err.message);
});
export const db = drizzle(pool, { schema });

/** 供跨庫搬家等工具重用同一個 pg 驅動版本(避免 api-server 另加依賴) */
export { pg };
export * from "./schema";
