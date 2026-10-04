import { strict as assert } from "node:assert";
import test, { before, after } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5433/postgres";
}
if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "https://stub.invalid/v1";
}
if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "x";
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, generalsTable, generalDrawsTable, userSessionsTable } = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("./sessions");
const { runGeneralsMigrations } = await import("./generalsMigrations");
const generalsRouter = (await import("../routes/generals")).default;

const MARK = "__drawbug__";
const runId = randomBytes(4).toString("hex");
const userId = `drawbug-${runId}`;
let server: http.Server, baseUrl: string, token: string, nationId: string;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

before(async () => {
  await runGeneralsMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));

  const [n] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: userId,
      name: `${MARK}${runId}`,
      leaderName: "Leader",
      government: "君主制",
      money: 1000000,
    })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;

  token = await createSession({
    discordUserId: userId,
    username: userId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", generalsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (nationId) {
    await db.delete(generalsTable).where(eq(generalsTable.ownerNationId, nationId));
    await db.delete(generalDrawsTable).where(eq(generalDrawsTable.ownerNationId, nationId));
    await db.delete(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  }
  await db.delete(userSessionsTable).where(like(userSessionsTable.discordUserId, "drawbug-%"));
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await pool.end();
});

test("Test POST /api/military/generals/draw endpoint", async () => {
  console.log("Calling POST /api/military/generals/draw...");
  const res = await api("POST", "/api/military/generals/draw");
  console.log("Response status:", res.status);
  console.log("Response json:", JSON.stringify(res.json, null, 2));
});
