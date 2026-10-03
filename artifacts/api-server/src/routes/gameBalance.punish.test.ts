/**
 * Task #547 — 濫用紀錄「加重處罰」端點整合測試（真 DB＋真 Express）。
 *
 * 鎖定 routes/gameBalance.ts POST /game-balance/abuse-records/:id/punish：
 *  - admin token 守門（無 token → 401）；
 *  - 只有 war_order 領域可處罰（其他 → 400）；
 *  - 成功處罰：punishedAt/punishNote/punishment 寫入、國家數值 SQL clamp
 *    套用（金錢 ≥0、滿意度/穩定 −、暴動/厭戰 +）、常備軍各兵種
 *    floor(quantity × pct / 100) 扣減；
 *  - 一次性閘：重複處罰 → 409；已撤銷 → 處罰 409；已處罰 → 撤銷 409（互斥）；
 *  - 無關聯國家：非零國家處罰 → 400，全 0 僅標記 → 200。
 *
 * 需要 DATABASE_URL。資料以 `gbpunish-`／`__gbpunish__` 前綴標記、自清：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the game balance punish tests",
  );
}

const runId = randomBytes(4).toString("hex");
// requireAdmin 於模組載入時讀 env；動態 import 之前先確保有值。
process.env.ADMIN_TOKEN ||= `gbpunish-token-${runId}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const express = (await import("express")).default;
const { eq, like } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerArmiesTable,
  playerNotificationsTable,
  militaryUnitTemplatesTable,
  aiAbuseRecordsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runPoliticsMigrations } = await import("../lib/politicsMigrations");
const { runMilitaryMigrations } = await import("../lib/militaryMigrations");
const { runGameBalanceMigrations } = await import(
  "../lib/gameBalanceMigrations"
);
const gameBalanceRouter = (await import("./gameBalance")).default;

const USER_MARKER = "gbpunish-";
const NATION_MARKER = "__gbpunish__";
const uid = `${USER_MARKER}${runId}`;

let server: http.Server;
let baseUrl: string;
let nationId = "";
let templateId = 0;

async function cleanup() {
  await db
    .delete(aiAbuseRecordsTable)
    .where(like(aiAbuseRecordsTable.discordUserId, `${USER_MARKER}%`));
  await db
    .delete(aiAbuseRecordsTable)
    .where(like(aiAbuseRecordsTable.nationName, `${NATION_MARKER}%`));
  await db
    .delete(playerNotificationsTable)
    .where(like(playerNotificationsTable.discordUserId, `${USER_MARKER}%`));
  // player_armies / templates cascade on nation delete.
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  withToken = true,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(withToken ? { "x-admin-token": ADMIN_TOKEN } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function insertAbuseRecord(
  overrides: Partial<typeof aiAbuseRecordsTable.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(aiAbuseRecordsTable)
    .values({
      domain: "war_order",
      verdict: "penalized",
      discordUserId: uid,
      nationId,
      nationName: `${NATION_MARKER}處罰國`,
      inputText: "測試輸入",
      reason: "測試理由",
      context: {},
      ...overrides,
    })
    .returning({ id: aiAbuseRecordsTable.id });
  return row!.id;
}

async function loadNation() {
  const [n] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  assert.ok(n);
  return n;
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runMilitaryMigrations();
  await runGameBalanceMigrations();
  await cleanup();

  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}處罰國`,
      isNpc: false,
      discordUserId: uid,
      money: 1000,
      stability: 50,
      unrest: 10,
      warWeariness: 20,
      satisfactionFarmers: 60,
      satisfactionWorkers: 60,
      satisfactionNobles: 60,
      satisfactionClergy: 60,
      satisfactionMilitary: 60,
    })
    .returning({ id: playerNationsTable.id });
  nationId = nation!.id;

  const [template] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ownerDiscordUserId: uid,
      category: "infantry",
      name: `${NATION_MARKER}步兵`,
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
  templateId = template!.id;

  await db.insert(playerArmiesTable).values({
    discordUserId: uid,
    templateId,
    quantity: 105,
  });

  const app = express();
  app.use(express.json());
  // routes 依賴 req.log（pino shim）。
  app.use((req, _res, next) => {
    (req as any).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api", gameBalanceRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server ? server.close((e) => (e ? reject(e) : resolve())) : resolve(),
  );
  await cleanup();
  await pool.end();
});

test("無 admin token → 401", async () => {
  const recordId = await insertAbuseRecord();
  const res = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    {},
    false,
  );
  assert.equal(res.status, 401);
});

test("非 war_order 領域 → 400", async () => {
  const recordId = await insertAbuseRecord({ domain: "unit_design" });
  const res = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    { money: 10 },
  );
  assert.equal(res.status, 400);
  assert.match(res.json.error, /戰爭指令/);
});

test("不存在的紀錄 → 404；壞 ID → 400；超界參數 → 400", async () => {
  const missing = await api(
    "POST",
    "/game-balance/abuse-records/999999999/punish",
    {},
  );
  assert.equal(missing.status, 404);
  const badId = await api("POST", "/game-balance/abuse-records/abc/punish", {});
  assert.equal(badId.status, 400);
  const recordId = await insertAbuseRecord();
  const over = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    { armyCasualtyPct: 101 },
  );
  assert.equal(over.status, 400);
});

test("成功處罰：紀錄標記＋國家數值 clamp＋常備軍 floor 扣減＋站內通知", async () => {
  const recordId = await insertAbuseRecord();
  const res = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    {
      money: 300,
      satisfactionDelta: 5,
      stabilityDelta: 8,
      unrestDelta: 6,
      warWearinessDelta: 7,
      armyCasualtyPct: 10,
      note: "測試處罰",
    },
  );
  assert.equal(res.status, 200);
  assert.ok(res.json.record.punishedAt);
  assert.equal(res.json.record.punishNote, "測試處罰");
  assert.equal(res.json.record.punishment.money, 300);
  assert.equal(res.json.record.punishment.armyCasualtyPct, 10);

  const nation = await loadNation();
  assert.equal(nation.money, 700);
  assert.equal(nation.satisfactionFarmers, 55);
  assert.equal(nation.satisfactionMilitary, 55);
  assert.equal(nation.stability, 42);
  assert.equal(nation.unrest, 16);
  assert.equal(nation.warWeariness, 27);

  // 105 − floor(105 × 10 / 100) = 105 − 10 = 95。
  const [army] = await db
    .select()
    .from(playerArmiesTable)
    .where(eq(playerArmiesTable.discordUserId, uid))
    .limit(1);
  assert.equal(army!.quantity, 95);

  // 站內通知（背景寫入，輪詢等待）。
  let notified = false;
  for (let i = 0; i < 20 && !notified; i++) {
    const rows = await db
      .select()
      .from(playerNotificationsTable)
      .where(eq(playerNotificationsTable.discordUserId, uid));
    notified = rows.some((r) => r.body.includes("加重處罰"));
    if (!notified) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(notified, "應寫入加重處罰站內通知");

  // 重複處罰 → 409（一次性閘）。
  const again = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    { money: 1 },
  );
  assert.equal(again.status, 409);

  // 已處罰 → 撤銷 409（互斥）。
  const revert = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/revert`,
    { money: 0 },
  );
  assert.equal(revert.status, 409);
});

test("已撤銷的紀錄 → 處罰 409（互斥反向）", async () => {
  const recordId = await insertAbuseRecord();
  const revert = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/revert`,
    { money: 0 },
  );
  assert.equal(revert.status, 200);
  const res = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    {},
  );
  assert.equal(res.status, 409);
});

test("無關聯國家：非零國家處罰 → 400；全 0 僅標記 → 200", async () => {
  const recordId = await insertAbuseRecord({
    discordUserId: null,
    nationId: null,
  });
  const nonZero = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    { money: 10 },
  );
  assert.equal(nonZero.status, 400);
  const armyOnly = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    { armyCasualtyPct: 5 },
  );
  assert.equal(armyOnly.status, 400);
  const markOnly = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/punish`,
    {},
  );
  assert.equal(markOnly.status, 200);
  assert.ok(markOnly.json.record.punishedAt);
});

test("撤銷帶 warWearinessDelta → 厭戰度下修（Task #547 回補新欄位）", async () => {
  const recordId = await insertAbuseRecord();
  const beforeNation = await loadNation();
  const res = await api(
    "POST",
    `/game-balance/abuse-records/${recordId}/revert`,
    { warWearinessDelta: 5 },
  );
  assert.equal(res.status, 200);
  const afterNation = await loadNation();
  assert.equal(
    afterNation.warWeariness,
    Math.max(0, beforeNation.warWeariness - 5),
  );
});
