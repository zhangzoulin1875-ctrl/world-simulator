/**
 * Task #510 — integration tests (real DB) for the unit-design charge system:
 *
 *  1. Founding grant: inserting a player_nations row without specifying
 *     unit_design_charges yields the column DEFAULT 5.
 *  2. Conditional deduct: the claim UPDATE (`>= 1` guard) decrements exactly
 *     once and returns no row once charges hit 0.
 *  3. Refund / turn regen clamp: `LEAST(cap, x + 1)` never exceeds 5.
 *  4. Route: POST /api/military/design-unit with 0 charges → 400 zh-TW
 *     設計次數不足 (the charge claim runs BEFORE any AI call, so no AI stub
 *     is needed).
 *
 * Rows carry the `__chargetest__` / `chargetest-` markers and are cleaned up
 * before AND after the run.
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the unit design charge tests",
  );
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, like, notExists, sql } = await import("drizzle-orm");
const { db, playerNationsTable, regionControlsTable, mapRegionsTable, userSessionsTable } =
  await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("./sessions");
const { UNIT_DESIGN_CHARGE_CAP } = await import("./military");
const militaryRouter = (await import("../routes/military")).default;

const NATION_MARKER = "__chargetest__";
const USER_MARKER = "chargetest-";

const runId = randomBytes(4).toString("hex");
const userId = `${USER_MARKER}${runId}`;
const nationName = `${NATION_MARKER}${runId}`;

let server: http.Server;
let baseUrl: string;
let sessionToken: string;
let nationId: string;
let regionId: number;

async function cleanup(): Promise<void> {
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function setCharges(n: number): Promise<void> {
  await db
    .update(playerNationsTable)
    .set({ unitDesignCharges: n })
    .where(eq(playerNationsTable.id, nationId));
}

async function getCharges(): Promise<number> {
  const [row] = await db
    .select({ charges: playerNationsTable.unitDesignCharges })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "test nation must exist");
  return row!.charges;
}

/** The exact claim UPDATE used by routes/military.ts and cabinet executeDesign. */
async function claimCharge(): Promise<boolean> {
  const claimed = await db
    .update(playerNationsTable)
    .set({
      unitDesignCharges: sql`${playerNationsTable.unitDesignCharges} - 1`,
    })
    .where(
      and(
        eq(playerNationsTable.discordUserId, userId),
        sql`${playerNationsTable.unitDesignCharges} >= 1`,
      ),
    )
    .returning();
  return claimed.length > 0;
}

/** The exact refund / turn-regen UPDATE (LEAST clamp at the cap). */
async function regenCharge(): Promise<void> {
  await db
    .update(playerNationsTable)
    .set({
      unitDesignCharges: sql`LEAST(${UNIT_DESIGN_CHARGE_CAP}, ${playerNationsTable.unitDesignCharges} + 1)`,
    })
    .where(eq(playerNationsTable.discordUserId, userId));
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  await cleanup();

  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(regionControlsTable)
          .where(eq(regionControlsTable.regionId, mapRegionsTable.id)),
      ),
    )
    .orderBy(mapRegionsTable.id)
    .limit(1);
  assert.equal(regions.length, 1, "need an unclaimed region to run the tests");
  regionId = regions[0]!.id;

  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: userId,
      name: nationName,
      leaderName: "次數測試領袖",
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });
  nationId = nation!.id;
  await db
    .insert(regionControlsTable)
    .values({ regionId, nationId, percent: 100 });

  sessionToken = await createSession({
    discordUserId: userId,
    username: userId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info() {},
      warn() {},
      error() {},
    };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", militaryRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server ? server.close((err) => (err ? reject(err) : resolve())) : resolve(),
  );
  await cleanup();
});

test("建國預設 5 次設計次數（欄位 DEFAULT）", async () => {
  assert.equal(await getCharges(), UNIT_DESIGN_CHARGE_CAP);
});

test("條件式扣次：每次扣 1，0 次時 claim 不到列", async () => {
  await setCharges(2);
  assert.equal(await claimCharge(), true);
  assert.equal(await getCharges(), 1);
  assert.equal(await claimCharge(), true);
  assert.equal(await getCharges(), 0);
  assert.equal(await claimCharge(), false, "0 次時不得再扣");
  assert.equal(await getCharges(), 0, "失敗的 claim 不得改變次數");
});

test("退還／回合恢復以 LEAST 封頂 5", async () => {
  await setCharges(UNIT_DESIGN_CHARGE_CAP);
  await regenCharge();
  assert.equal(await getCharges(), UNIT_DESIGN_CHARGE_CAP, "滿次數時 +1 不得超過上限");

  await setCharges(3);
  await regenCharge();
  assert.equal(await getCharges(), 4);
});

test("POST /api/military/design-unit：0 次 → 400 設計次數不足（不呼叫 AI）", async () => {
  await setCharges(0);
  const res = await api("POST", "/api/military/design-unit", {
    category: "infantry",
    requirement: "一支測試用的重步兵",
  });
  assert.equal(res.status, 400);
  assert.match(String(res.json.error), /設計次數不足/);
  assert.equal(await getCharges(), 0, "失敗請求不得改變次數");
});
