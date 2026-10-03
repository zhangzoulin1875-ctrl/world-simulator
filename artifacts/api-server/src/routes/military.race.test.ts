/**
 * Task #45 — integration tests (real DB) for the concurrent-spend
 * protections in routes/military.ts:
 *
 *  1. Two concurrent POST /api/military/recruit with a budget for exactly one
 *     order → exactly one 200 and one 400, spent counters incremented once,
 *     army quantity written once (conditional-UPDATE spend guard).
 *  2. Two concurrent POST /api/military/purchase with money for exactly one
 *     order → one 200, one 400 金錢不足, money never negative, quota counted
 *     once (money conditional UPDATE inside the transaction rolls back the
 *     quota claim of the loser).
 *  3. Two concurrent purchases that each fit the daily cap but together
 *     exceed it → one 200 and one 400 超過今日購買額度; used_units stays
 *     within dailyPurchaseCap (raw-SQL insert-or-increment cap in WHERE).
 *
 * Requires DATABASE_URL pointing at a database migrated by a normal server
 * start (map_regions, map_region_era_stats, player_nations, region_controls,
 * military_* tables and the seeded default unit templates must exist). All
 * rows created here carry a recognizable marker and are cleaned up before AND
 * after the run, so the test is repeatable:
 * `pnpm --filter @workspace/api-server run test:integration`.
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the military race tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, like, notExists, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  userSessionsTable,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  militaryPurchaseQuotasTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const {
  recruitCost,
  recruitProductionSpend,
  dailyPurchaseCap,
  unitProductionReservation,
  MIN_UPKEEP_PER_UNIT,
  MAX_ORDER_QUANTITY,
} = await import("../lib/military");
const { computeNationStats, getStatsEraSlug } = await import(
  "../lib/nationStats"
);
const { localDateString } = await import("../lib/time");
const militaryRouter = (await import("./military")).default;

/**
 * Marker prefixes so leftovers from any (even crashed) run are removable.
 * Deliberately distinct from player.race.test.ts's `__racetest__`/`racetest-`
 * namespace so neither suite's wildcard cleanup can touch the other's rows —
 * note that `_` is a LIKE single-char wildcard, so the player suite's
 * `__racetest__%` pattern must not be able to match these (it requires the
 * literal "racetest", which "miltest" never contains).
 */
const NATION_MARKER = "__miltest__";
const USER_MARKER = "miltest-";

const runId = randomBytes(4).toString("hex");
const userId = `${USER_MARKER}${runId}`;
const nationName = `${NATION_MARKER}${runId}`;

let server: http.Server;
let baseUrl: string;
let sessionToken: string;

let nationId: string;
let regionId: number;
let eraSlug: string;
let stats: { population: number; production: number };
let template: {
  id: number;
  prodCostPer100: number;
  popCostPerUnit: number;
  moneyCostPerUnit: number;
  woodCostPerUnit: number;
  oreCostPerUnit: number;
  prodUpkeepPerUnit: number;
};
let foreignTemplateId: number;

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

async function cleanup(): Promise<void> {
  // Deleting nations cascades to region_controls (nation_id) and to
  // player_armies / military_purchase_quotas (discord_user_id FKs).
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function setNationResources(values: {
  money?: number;
  productionSpent?: number;
  populationSpent?: number;
}): Promise<void> {
  await db
    .update(playerNationsTable)
    .set(values)
    .where(eq(playerNationsTable.id, nationId));
}

async function nationRow() {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "test nation must exist");
  return row!;
}

async function armyQuantity(): Promise<number> {
  const [row] = await db
    .select({ quantity: playerArmiesTable.quantity })
    .from(playerArmiesTable)
    .where(
      and(
        eq(playerArmiesTable.discordUserId, userId),
        eq(playerArmiesTable.templateId, template.id),
      ),
    );
  return row?.quantity ?? 0;
}

async function armyReserved(): Promise<{
  production: number;
  population: number;
}> {
  const [row] = await db
    .select({
      production: playerArmiesTable.productionReserved,
      population: playerArmiesTable.populationReserved,
    })
    .from(playerArmiesTable)
    .where(
      and(
        eq(playerArmiesTable.discordUserId, userId),
        eq(playerArmiesTable.templateId, template.id),
      ),
    );
  return { production: row?.production ?? 0, population: row?.population ?? 0 };
}

async function resetArmies(): Promise<void> {
  await db
    .delete(playerArmiesTable)
    .where(eq(playerArmiesTable.discordUserId, userId));
}

async function quotaUsed(dateLabel: string): Promise<number> {
  const [row] = await db
    .select({ usedUnits: militaryPurchaseQuotasTable.usedUnits })
    .from(militaryPurchaseQuotasTable)
    .where(
      and(
        eq(militaryPurchaseQuotasTable.discordUserId, userId),
        eq(militaryPurchaseQuotasTable.dateLabel, dateLabel),
      ),
    );
  return row?.usedUnits ?? 0;
}

async function resetQuota(): Promise<void> {
  await db
    .delete(militaryPurchaseQuotasTable)
    .where(eq(militaryPurchaseQuotasTable.discordUserId, userId));
}

before(async () => {
  await cleanup();

  // A nation with a 100% control over one unclaimed region so that
  // computeNationStats yields real production/population budgets.
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
      leaderName: "競態測試領袖",
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });
  nationId = nation!.id;
  await db
    .insert(regionControlsTable)
    .values({ regionId, nationId, percent: 100 });

  eraSlug = await getStatsEraSlug();
  stats = await computeNationStats(nationId, eraSlug);
  assert.ok(
    stats.production > 0 && stats.population > 0,
    `controlled region must yield stats (got ${JSON.stringify(stats)})`,
  );

  // Task #511 — 預設種子模板不再可建造，測試改用玩家自創兵種模板
  // （infantry 無解鎖時代門檻，任何時代皆可招募）。刪除國家會 cascade 清掉。
  const [tpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ownerDiscordUserId: userId,
      isDefault: false,
      category: "infantry",
      name: `${NATION_MARKER}race-${runId}`,
      eraSlug,
      hp: 100,
      attack: 100,
      defense: 10,
      speed: 1,
      accuracy: 80,
      range: "melee",
      // 成本沿用預設步兵基準（1/1/10），讓單一地區的小生產力預算裝得下一筆訂單。
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 10,
      // Task #546/#557 — 招募與購買的生產力佔用 = ⌈數量 × 每單位生產力維護費 ÷ 100⌉；
      // 顯式設為下限值（applyTechBonuses 對 0 也會補到 0.1），讓測試期望
      // 可直接用 unitProductionReservation(template, qty) 推導。
      prodUpkeepPerUnit: MIN_UPKEEP_PER_UNIT,
    })
    .returning({
      id: militaryUnitTemplatesTable.id,
      prodCostPer100: militaryUnitTemplatesTable.prodCostPer100,
      popCostPerUnit: militaryUnitTemplatesTable.popCostPerUnit,
      moneyCostPerUnit: militaryUnitTemplatesTable.moneyCostPerUnit,
      woodCostPerUnit: militaryUnitTemplatesTable.woodCostPerUnit,
      oreCostPerUnit: militaryUnitTemplatesTable.oreCostPerUnit,
      prodUpkeepPerUnit: militaryUnitTemplatesTable.prodUpkeepPerUnit,
    });
  assert.ok(tpl, "custom test template must be inserted");
  template = tpl!;

  // Task #549 守門測試用：無主模板（owner null，非本人 → 一律 404）。
  const [foreign] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ownerDiscordUserId: null,
      isDefault: false,
      category: "infantry",
      name: `${NATION_MARKER}foreign-${runId}`,
      eraSlug,
      hp: 100,
      attack: 100,
      defense: 10,
      speed: 1,
      accuracy: 80,
      range: "melee",
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 10,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  assert.ok(foreign, "foreign test template must be inserted");
  foreignTemplateId = foreign!.id;

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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

test("concurrent recruit with budget for one order → one 200, one 400, spent counted once", async () => {
  const quantity = 100;
  const cost = recruitCost(template, quantity);
  // Task #568 — 招募除了佔用（cost.production）還有一次性生產力花費，
  // 預算必須同時容納兩者，否則單筆訂單就會被打回。
  const spend = recruitProductionSpend(template, quantity);
  assert.ok(
    cost.production + spend <= stats.production &&
      cost.population <= stats.population,
    `one order must fit the region budget (cost ${JSON.stringify(cost)}, spend ${spend}, stats ${JSON.stringify(stats)})`,
  );

  // Leave exactly one order's worth of available production/population
  // (occupation + one-time recruit spend).
  await resetQuota();
  await setNationResources({
    productionSpent: stats.production - cost.production - spend,
    populationSpent: stats.population - cost.population,
  });
  const armyBefore = await armyQuantity();

  const recruit = () =>
    api("POST", "/api/military/recruit", { templateId: template.id, quantity });
  const [a, b] = await Promise.all([recruit(), recruit()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(
    statuses,
    [200, 400],
    `expected one winner and one loser, got ${a.status}/${b.status}: ` +
      `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`,
  );
  const loser = a.status === 400 ? a : b;
  assert.match(String(loser.json.error ?? ""), /不足/);

  // Spent counters were incremented exactly once (never past the budget) and
  // the army was written exactly once. Task #568 — 一次性花費記在流量表，
  // 不進 production_spent，所以佔用計數器只加 cost.production。
  const nation = await nationRow();
  assert.equal(nation.productionSpent, stats.production - spend);
  assert.equal(nation.populationSpent, stats.population);
  assert.equal(await armyQuantity(), armyBefore + quantity);
});

test("concurrent purchase with money for one order → one 200, one 400, money never negative", async () => {
  const quantity = 10;
  const moneyCost = template.moneyCostPerUnit * quantity;
  const cap = dailyPurchaseCap(stats.population);
  assert.ok(
    cap >= quantity * 2,
    `daily cap must allow both orders so money is the only limit (cap ${cap})`,
  );

  // Task #546 — 購買也佔用生產力，先清空 spent 讓金錢成為唯一限制。
  await resetQuota();
  await setNationResources({ money: moneyCost, productionSpent: 0 });
  const armyBefore = await armyQuantity();
  const dateLabel = localDateString(new Date());

  const purchase = () =>
    api("POST", "/api/military/purchase", {
      templateId: template.id,
      quantity,
    });
  const [a, b] = await Promise.all([purchase(), purchase()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(
    statuses,
    [200, 400],
    `expected one winner and one loser, got ${a.status}/${b.status}: ` +
      `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`,
  );
  const loser = a.status === 400 ? a : b;
  assert.match(String(loser.json.error ?? ""), /金錢不足/);

  // Money deducted exactly once (to zero, never negative); the loser's quota
  // claim was rolled back with its transaction; army written exactly once.
  // Task #546 — the winner's production reservation was counted exactly once.
  const reserve = unitProductionReservation(template, quantity);
  assert.ok(reserve >= 1, "purchase must reserve at least 1 production");
  const nation = await nationRow();
  assert.equal(nation.money, 0, "money must be spent exactly once");
  assert.equal(
    nation.productionSpent,
    reserve,
    "purchase reservation must be counted exactly once",
  );
  assert.equal(await quotaUsed(dateLabel), quantity);
  assert.equal(await armyQuantity(), armyBefore + quantity);
});

test("concurrent purchases together exceeding the daily cap → one 200, one 400, cap holds", async () => {
  const cap = dailyPurchaseCap(stats.population);
  const quantity = Math.floor(cap / 2) + 1;
  assert.ok(
    quantity >= 1 && quantity <= cap && quantity * 2 > cap,
    `quantity must fit alone but not twice (cap ${cap}, quantity ${quantity})`,
  );
  assert.ok(
    quantity <= MAX_ORDER_QUANTITY,
    `quantity must not exceed the per-order limit (${quantity})`,
  );

  const moneyCost = template.moneyCostPerUnit * quantity;
  const money = moneyCost * 4; // plenty — the quota must be the only limit
  assert.ok(Number.isSafeInteger(money), "test money must be a safe integer");

  // Task #546 — 清空 spent 讓每日額度成為唯一限制（購買現在也佔生產力）。
  await resetQuota();
  await setNationResources({ money, productionSpent: 0 });
  const armyBefore = await armyQuantity();
  const dateLabel = localDateString(new Date());

  const purchase = () =>
    api("POST", "/api/military/purchase", {
      templateId: template.id,
      quantity,
    });
  const [a, b] = await Promise.all([purchase(), purchase()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(
    statuses,
    [200, 400],
    `expected one winner and one loser, got ${a.status}/${b.status}: ` +
      `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`,
  );
  const loser = a.status === 400 ? a : b;
  assert.match(String(loser.json.error ?? ""), /超過今日購買額度/);

  // Quota counted once and stays within the cap; money deducted once.
  const used = await quotaUsed(dateLabel);
  assert.equal(used, quantity, "quota must count the winner only");
  assert.ok(used <= cap, `used_units (${used}) must never exceed the cap (${cap})`);
  const nation = await nationRow();
  assert.equal(nation.money, money - moneyCost, "money must be spent exactly once");
  assert.equal(await armyQuantity(), armyBefore + quantity);
});

test("recruit then disband all → reserved fully released, spent returns to baseline", async () => {
  const quantity = 100;
  const cost = recruitCost(template, quantity);
  await resetQuota();
  await resetArmies();
  await setNationResources({ productionSpent: 0, populationSpent: 0 });

  const r = await api("POST", "/api/military/recruit", {
    templateId: template.id,
    quantity,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let nation = await nationRow();
  assert.equal(nation.productionSpent, cost.production, "recruit reserves production");
  assert.equal(nation.populationSpent, cost.population, "recruit reserves population");
  const reserved = await armyReserved();
  assert.equal(reserved.production, cost.production, "army row records reserved production");
  assert.equal(reserved.population, cost.population, "army row records reserved population");

  const d = await api("POST", "/api/military/armies/disband", {
    templateId: template.id,
    quantity,
  });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  nation = await nationRow();
  assert.equal(nation.productionSpent, 0, "disbanding all frees all production");
  assert.equal(nation.populationSpent, 0, "disbanding all frees all population");
  assert.equal(await armyQuantity(), 0, "army row is removed when emptied");
});

test("recruit then partial disband → proportional (floored) release", async () => {
  const quantity = 100;
  const remove = 30;
  const cost = recruitCost(template, quantity);
  await resetQuota();
  await resetArmies();
  await setNationResources({ productionSpent: 0, populationSpent: 0 });

  const r = await api("POST", "/api/military/recruit", {
    templateId: template.id,
    quantity,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const prodRelease = Math.floor((cost.production * remove) / quantity);
  const popRelease = Math.floor((cost.population * remove) / quantity);
  const d = await api("POST", "/api/military/armies/disband", {
    templateId: template.id,
    quantity: remove,
  });
  assert.equal(d.status, 200, JSON.stringify(d.json));

  const nation = await nationRow();
  assert.equal(nation.productionSpent, cost.production - prodRelease);
  assert.equal(nation.populationSpent, cost.population - popRelease);
  const reserved = await armyReserved();
  assert.equal(reserved.production, cost.production - prodRelease);
  assert.equal(reserved.population, cost.population - popRelease);
  assert.equal(await armyQuantity(), quantity - remove);
});

// Task #546 — 金錢購買也佔用生產力（⌈數量 × 每單位生產力維護費 ÷ 100⌉），
// 解散時按既有 releaseReservation 邏輯釋放；人口仍不佔用。
test("purchase reserves production (÷100 of prod upkeep), disband releases it", async () => {
  const quantity = 10;
  const moneyCost = template.moneyCostPerUnit * quantity;
  const reserve = unitProductionReservation(template, quantity);
  assert.ok(reserve >= 1, "purchase must reserve at least 1 production");
  await resetQuota();
  await resetArmies();
  await setNationResources({
    money: moneyCost,
    productionSpent: 0,
    populationSpent: 0,
  });

  const p = await api("POST", "/api/military/purchase", {
    templateId: template.id,
    quantity,
  });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  let nation = await nationRow();
  assert.equal(
    nation.productionSpent,
    reserve,
    "money purchase reserves production",
  );
  assert.equal(nation.populationSpent, 0, "money purchase reserves no population");
  const reserved = await armyReserved();
  assert.equal(
    reserved.production,
    reserve,
    "money-bought army row records its production reservation",
  );
  assert.equal(reserved.population, 0, "money-bought army reserves no population");

  const d = await api("POST", "/api/military/armies/disband", {
    templateId: template.id,
    quantity,
  });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  nation = await nationRow();
  assert.equal(
    nation.productionSpent,
    0,
    "disbanding all money-bought units frees the full reservation",
  );
  assert.equal(nation.populationSpent, 0, "population stays untouched");
  assert.equal(await armyQuantity(), 0);
});

// Task #546 — 生產力不足時購買整筆回滾：金錢/木材/礦石不扣、配額不記、軍隊不變。
test("purchase with no available production → 400 生產力不足, full rollback", async () => {
  const quantity = 10;
  const moneyCost = template.moneyCostPerUnit * quantity;
  await resetQuota();
  await resetArmies();
  await setNationResources({
    money: moneyCost,
    // 佔滿全部生產力 → 可用 0，購買佔用（≥1）必定超額。
    productionSpent: stats.production,
    populationSpent: 0,
  });
  const dateLabel = localDateString(new Date());

  const p = await api("POST", "/api/military/purchase", {
    templateId: template.id,
    quantity,
  });
  assert.equal(p.status, 400, JSON.stringify(p.json));
  assert.match(String(p.json.error ?? ""), /生產力不足/);

  const nation = await nationRow();
  assert.equal(nation.money, moneyCost, "money must not be deducted");
  assert.equal(
    nation.productionSpent,
    stats.production,
    "production spent must be unchanged",
  );
  assert.equal(await quotaUsed(dateLabel), 0, "quota claim must be rolled back");
  assert.equal(await armyQuantity(), 0, "no army may be written");

  // 還原 spent，避免影響後續測試。
  await setNationResources({ productionSpent: 0 });
});

test("delete custom template → releases its armies' reserved spend", async () => {
  await resetArmies();
  await setNationResources({ productionSpent: 500, populationSpent: 300 });

  const [custom] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ownerDiscordUserId: userId,
      isDefault: false,
      category: "infantry",
      name: `${NATION_MARKER}custom-${runId}`,
      eraSlug,
      hp: 10,
      attack: 5,
      defense: 5,
      speed: 1,
      accuracy: 50,
      range: "melee",
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 1,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  const customId = custom!.id;
  await db.insert(playerArmiesTable).values({
    discordUserId: userId,
    templateId: customId,
    quantity: 50,
    productionReserved: 200,
    populationReserved: 120,
  });

  const del = await api("DELETE", `/api/military/templates/${customId}`);
  assert.equal(del.status, 200, JSON.stringify(del.json));

  const nation = await nationRow();
  assert.equal(
    nation.productionSpent,
    300,
    "deleting a custom template frees its armies' reserved production",
  );
  assert.equal(
    nation.populationSpent,
    180,
    "deleting a custom template frees its armies' reserved population",
  );
});

// ── Task #549 — 非本人（無主）模板不可建造／改名（一律 404） ─────

test("recruit with a foreign template id → 404 zh-TW rejection", async () => {
  await resetQuota();
  await setNationResources({ productionSpent: 0, populationSpent: 0 });
  const r = await api("POST", "/api/military/recruit", {
    templateId: foreignTemplateId,
    quantity: 10,
  });
  assert.equal(r.status, 404, JSON.stringify(r.json));
  assert.match(String(r.json.error ?? ""), /找不到這個兵種模板/);
});

test("purchase with a foreign template id → 404 zh-TW rejection", async () => {
  await resetQuota();
  await setNationResources({ money: 1_000_000 });
  const r = await api("POST", "/api/military/purchase", {
    templateId: foreignTemplateId,
    quantity: 10,
  });
  assert.equal(r.status, 404, JSON.stringify(r.json));
  assert.match(String(r.json.error ?? ""), /找不到這個兵種模板/);
});

test("rename a foreign template → 404 zh-TW rejection", async () => {
  const r = await api(
    "PATCH",
    `/api/military/templates/${foreignTemplateId}/name`,
    { name: "改名測試" },
  );
  assert.equal(r.status, 404, JSON.stringify(r.json));
  assert.match(String(r.json.error ?? ""), /找不到這個兵種模板/);
});

test("overview templates contain only own custom units (no defaults)", async () => {
  const r = await api("GET", "/api/military/overview");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const templates = r.json.templates as Array<{
    id: number;
    isDefault: boolean;
  }>;
  assert.ok(Array.isArray(templates), "overview must return templates");
  assert.ok(
    templates.every((t) => !t.isDefault),
    "no default templates may be visible to players",
  );
  assert.ok(
    templates.some((t) => t.id === template.id),
    "own custom template must be visible",
  );
});
