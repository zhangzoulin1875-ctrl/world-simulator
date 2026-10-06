/**
 * 管理員發放資源（POST /api/gifts）的真實資料庫整合測試。此端點會原子遞增
 * 國家的科技點數／金錢並封頂，寫錯就可能讓資源溢位（int4）或發到錯的對象。
 * 這裡鎖住指定國家路徑的線上守門與副作用：
 *
 *  1. 未帶／錯誤 admin token → 401；amount 非法 → 400；國家不存在 → 404。
 *  2. 對指定玩家國家發科技點數 → 該國科技點數精確增加，且非同步寫入一則
 *     type=gift 的站內通知（輪詢驗證端到端串接）。
 *  3. 對指定玩家國家發金錢 → 金錢精確增加（int8 路徑）。
 *  4. 對 NPC（無 Discord 帳號）發放 → affectedCount 1、notifiedCount 0。
 *  5. 封頂：接近上限時再發放，結果剛好等於上限、不溢位（LEAST + bigint 相加）。
 *
 * 只針對「指定國家」路徑（以 id 命中單一標記國家），不測普發（會動到共用開發
 * 資料庫裡的所有真實國家）。所有列以 `__gifttest__` 前綴標記，跑前跑後清除，
 * 可重複執行：`pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the gifts tests");
}
if (!process.env.ADMIN_TOKEN) {
  throw new Error("ADMIN_TOKEN must be set to run the gifts tests");
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const express = (await import("express")).default;
const { and, eq, isNull, like } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerNotificationsTable,
  nationSatisfactionBuffsTable,
  nationPopulationBuffsTable,
  worldGameStateTable,
  regionControlsTable,
  mapRegionsTable,
} = await import("@workspace/db");
const giftsRouter = (await import("./gifts")).default;

const NATION_MARKER = "__gifttest__";
const runId = randomBytes(4).toString("hex");
const playerUserId = `gifttest-player-${runId}`;

const TECH_MAX = 2_000_000_000;

let server: http.Server;
let baseUrl: string;
let playerNationId: string;
let npcNationId: string;

// Task #504 — 開局資源設定測試會改動共用開發 DB 的全域單列
// world_game_state；跑前快照、跑後還原，避免影響其他測試與真實遊戲。
let startingSnapshot: {
  startingTechPoints: number;
  startingMoney: number;
} | null = null;

async function cleanup() {
  await db
    .delete(playerNotificationsTable)
    .where(eq(playerNotificationsTable.discordUserId, playerUserId));
  // region_controls は FK on DELETE CASCADE がないため先に削除する
  if (npcNationId) {
    await db
      .delete(regionControlsTable)
      .where(eq(regionControlsTable.nationId, npcNationId));
  }
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
}

async function readNation(id: string) {
  const [row] = await db
    .select({
      techPoints: playerNationsTable.techPoints,
      money: playerNationsTable.money,
      wood: playerNationsTable.wood,
      ore: playerNationsTable.ore,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id))
    .limit(1);
  assert.ok(row, "找不到測試國家");
  return row;
}

async function postGift(
  body: unknown,
  token: string | null = ADMIN_TOKEN,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/gifts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

before(async () => {
  await cleanup();

  const [snap] = await db
    .select({
      startingTechPoints: worldGameStateTable.startingTechPoints,
      startingMoney: worldGameStateTable.startingMoney,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  startingSnapshot = snap ?? null;

  const [player] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}player-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: playerUserId,
      isNpc: false,
      techPoints: 100,
      money: 1000,
    })
    .returning({ id: playerNationsTable.id });
  playerNationId = player!.id;

  const [npc] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}npc-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: null,
      isNpc: true,
      techPoints: 100,
      money: 1000,
    })
    .returning({ id: playerNationsTable.id });
  npcNationId = npc!.id;

  // NPC 需要至少一個地區，否則 runNpcExtinctionCheck 回合時會把它刪掉。
  const [freeRegion] = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(regionControlsTable, eq(regionControlsTable.regionId, mapRegionsTable.id))
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .limit(1);
  if (freeRegion) {
    await db.insert(regionControlsTable).values({
      regionId: freeRegion.id,
      nationId: npcNationId,
      percent: 1,
    });
  }

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info() {},
      warn() {},
      error() {},
    };
    next();
  });
  app.use(express.json());
  app.use("/api", giftsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (startingSnapshot) {
    await db
      .update(worldGameStateTable)
      .set(startingSnapshot)
      .where(eq(worldGameStateTable.id, 1));
  }
  await cleanup();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("未帶 token → 401；錯誤 token → 401", async () => {
  const none = await postGift(
    { resource: "money", amount: 10, target: { type: "nation", nationId: playerNationId } },
    null,
  );
  assert.equal(none.status, 401);
  const wrong = await postGift(
    { resource: "money", amount: 10, target: { type: "nation", nationId: playerNationId } },
    "definitely-not-the-admin-token",
  );
  assert.equal(wrong.status, 401);
});

test("amount 非法（0）→ 400，且未改動國家", async () => {
  const before = await readNation(playerNationId);
  const r = await postGift({
    resource: "techPoints",
    amount: 0,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 400);
  const after = await readNation(playerNationId);
  assert.equal(after.techPoints, before.techPoints);
});

test("國家不存在 → 404", async () => {
  const r = await postGift({
    resource: "money",
    amount: 100,
    target: { type: "nation", nationId: randomUUID() },
  });
  assert.equal(r.status, 404);
});

test("對指定玩家發科技點數 → 精確增加並寫入 gift 通知", async () => {
  const before = await readNation(playerNationId);
  const r = await postGift({
    resource: "techPoints",
    amount: 500,
    target: { type: "nation", nationId: playerNationId },
    note: "活動獎勵",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.affectedCount, 1);
  assert.equal(r.json.notifiedCount, 1);
  const after = await readNation(playerNationId);
  assert.equal(after.techPoints, before.techPoints + 500);

  // 站內通知為 fire-and-forget，輪詢驗證端到端串接。
  let found = false;
  for (let i = 0; i < 30 && !found; i++) {
    const rows = await db
      .select({ id: playerNotificationsTable.id })
      .from(playerNotificationsTable)
      .where(
        and(
          eq(playerNotificationsTable.discordUserId, playerUserId),
          eq(playerNotificationsTable.type, "gift"),
        ),
      )
      .limit(1);
    if (rows.length > 0) found = true;
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(found, "應寫入一則 type=gift 的站內通知");
});

test("對指定玩家發金錢 → 精確增加（int8 路徑）", async () => {
  const before = await readNation(playerNationId);
  const r = await postGift({
    resource: "money",
    amount: 2000,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 200);
  const after = await readNation(playerNationId);
  assert.equal(after.money, before.money + 2000);
});

test("對指定玩家發木材與礦石 → 各自精確增加，不影響其他資源", async () => {
  const before = await readNation(playerNationId);
  const w = await postGift({
    resource: "wood",
    amount: 750,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(w.status, 200);
  const o = await postGift({
    resource: "ore",
    amount: 320,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(o.status, 200);
  const after = await readNation(playerNationId);
  assert.equal(after.wood, before.wood + 750);
  assert.equal(after.ore, before.ore + 320);
  assert.equal(after.money, before.money, "金錢不應被動到");
  assert.equal(after.techPoints, before.techPoints, "科技點數不應被動到");
});

test("木材發放：玩家與 NPC 的木材互不影響（只動指定國家）", async () => {
  const npcBefore = await readNation(npcNationId);
  const r = await postGift({
    resource: "wood",
    amount: 10,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.affectedCount, 1);
  const npcAfter = await readNation(npcNationId);
  assert.equal(npcAfter.wood, npcBefore.wood);
});

test("礦石超過上限 → 400；數量非整數 → 400", async () => {
  const tooBig = await postGift({
    resource: "ore",
    amount: 1_000_000_000_000_001,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(tooBig.status, 400);
  const frac = await postGift({
    resource: "wood",
    amount: 1.5,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(frac.status, 400);
});

test("木材發放後玩家收到站內通知，文案含「木材」", async () => {
  await db
    .delete(playerNotificationsTable)
    .where(eq(playerNotificationsTable.discordUserId, playerUserId));
  const r = await postGift({
    resource: "wood",
    amount: 5,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 200);
  const rows = await db
    .select({ body: playerNotificationsTable.body })
    .from(playerNotificationsTable)
    .where(eq(playerNotificationsTable.discordUserId, playerUserId));
  assert.ok(rows.some((n) => n.body.includes("木材")), "通知應提到木材");
});

test("對 NPC（無 Discord 帳號）發放 → affectedCount 1、notifiedCount 0", async () => {
  const r = await postGift({
    resource: "techPoints",
    amount: 50,
    target: { type: "nation", nationId: npcNationId },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.affectedCount, 1);
  assert.equal(r.json.notifiedCount, 0);
});

test("封頂：接近上限再發放 → 剛好等於上限、不溢位", async () => {
  await db
    .update(playerNationsTable)
    .set({ techPoints: TECH_MAX - 5 })
    .where(eq(playerNationsTable.id, playerNationId));
  const r = await postGift({
    resource: "techPoints",
    amount: 1000,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 200);
  const after = await readNation(playerNationId);
  assert.equal(after.techPoints, TECH_MAX);
});

test("滿意度暫時 buff：對玩家全方向寫入 4 列 buff、寫 gift 通知", async () => {
  await db
    .delete(nationSatisfactionBuffsTable)
    .where(eq(nationSatisfactionBuffsTable.discordUserId, playerUserId));
  const r = await postGift({
    resource: "satisfaction",
    amount: 10,
    durationTurns: 5,
    direction: "all",
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.affectedCount, 1);
  assert.equal(r.json.notifiedCount, 1);
  const rows = await db
    .select({
      direction: nationSatisfactionBuffsTable.direction,
      offset: nationSatisfactionBuffsTable.satisfactionOffset,
      remaining: nationSatisfactionBuffsTable.remainingTurns,
    })
    .from(nationSatisfactionBuffsTable)
    .where(eq(nationSatisfactionBuffsTable.discordUserId, playerUserId));
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((x) => x.direction).sort(),
    ["culture", "law", "military", "religion", "rights"],
  );
  for (const row of rows) {
    assert.equal(row.offset, 10);
    assert.equal(row.remaining, 5);
  }
});

test("滿意度暫時 buff：單一方向只寫 1 列", async () => {
  await db
    .delete(nationSatisfactionBuffsTable)
    .where(eq(nationSatisfactionBuffsTable.discordUserId, playerUserId));
  const r = await postGift({
    resource: "satisfaction",
    amount: 7,
    durationTurns: 3,
    direction: "law",
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 200);
  const rows = await db
    .select({ direction: nationSatisfactionBuffsTable.direction })
    .from(nationSatisfactionBuffsTable)
    .where(eq(nationSatisfactionBuffsTable.discordUserId, playerUserId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.direction, "law");
});

test("人口增長率暫時 buff：對玩家寫入 buff 列", async () => {
  await db
    .delete(nationPopulationBuffsTable)
    .where(eq(nationPopulationBuffsTable.discordUserId, playerUserId));
  const r = await postGift({
    resource: "populationGrowth",
    amount: 20,
    durationTurns: 8,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.affectedCount, 1);
  const rows = await db
    .select({
      growth: nationPopulationBuffsTable.growthPct,
      remaining: nationPopulationBuffsTable.remainingTurns,
    })
    .from(nationPopulationBuffsTable)
    .where(eq(nationPopulationBuffsTable.discordUserId, playerUserId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.growth, 20);
  assert.equal(rows[0]!.remaining, 8);
});

test("暫時 buff 對指定 NPC 發放 → 略過（affectedCount 0、無 buff 列）", async () => {
  const r = await postGift({
    resource: "satisfaction",
    amount: 10,
    durationTurns: 5,
    direction: "all",
    target: { type: "nation", nationId: npcNationId },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.affectedCount, 0);
  assert.equal(r.json.notifiedCount, 0);
});

test("暫時 buff 缺持續回合數 → 400", async () => {
  const r = await postGift({
    resource: "populationGrowth",
    amount: 20,
    target: { type: "nation", nationId: playerNationId },
  });
  assert.equal(r.status, 400);
});

// ── Task #504 — 開局資源設定（GET/PUT /api/gifts/starting-resources）──

async function callStartingResources(
  method: "GET" | "PUT",
  body?: unknown,
  token: string | null = ADMIN_TOKEN,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/gifts/starting-resources`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

test("開局資源：未帶 token → 401（GET 與 PUT）", async () => {
  const g = await callStartingResources("GET", undefined, null);
  assert.equal(g.status, 401);
  const p = await callStartingResources(
    "PUT",
    { startingTechPoints: 1, startingMoney: 1 },
    null,
  );
  assert.equal(p.status, 401);
});

test("開局資源：GET 回傳目前設定與上限", async () => {
  const r = await callStartingResources("GET");
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.startingTechPoints, "number");
  assert.equal(typeof r.json.startingMoney, "number");
  assert.equal(r.json.maxTechPoints, 2_000_000_000);
  assert.equal(r.json.maxMoney, 1_000_000_000_000_000);
});

test("開局資源：PUT 非法值 → 400 zh-TW，未改動設定", async () => {
  const before = await callStartingResources("GET");
  for (const bad of [
    { startingTechPoints: -1, startingMoney: 5000 },
    { startingTechPoints: 1.5, startingMoney: 5000 },
    { startingTechPoints: 200, startingMoney: -5 },
    { startingTechPoints: 200, startingMoney: "5000" },
    { startingTechPoints: 2_000_000_001, startingMoney: 5000 },
    {},
  ]) {
    const r = await callStartingResources("PUT", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(String(r.json.error ?? ""), /開局/);
  }
  const after = await callStartingResources("GET");
  assert.equal(after.json.startingTechPoints, before.json.startingTechPoints);
  assert.equal(after.json.startingMoney, before.json.startingMoney);
});

test("開局資源：PUT 合法值 → 更新並可再 GET 讀回", async () => {
  const r = await callStartingResources("PUT", {
    startingTechPoints: 321,
    startingMoney: 6543,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.startingTechPoints, 321);
  assert.equal(r.json.startingMoney, 6543);

  const g = await callStartingResources("GET");
  assert.equal(g.json.startingTechPoints, 321);
  assert.equal(g.json.startingMoney, 6543);

  // 直接查 DB 確認寫入 world_game_state（id=1 單列）。
  const [row] = await db
    .select({
      startingTechPoints: worldGameStateTable.startingTechPoints,
      startingMoney: worldGameStateTable.startingMoney,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  assert.equal(row?.startingTechPoints, 321);
  assert.equal(row?.startingMoney, 6543);
});
