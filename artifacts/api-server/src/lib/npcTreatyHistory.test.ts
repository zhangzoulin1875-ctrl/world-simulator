import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, or, sql } from "drizzle-orm";
import { db, pool, playerNationsTable, diplomacyTreatiesTable } from "@workspace/db";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import { fetchNpcTreatyHistory } from "./npcTreatyHistory";
import { summarizeNpcTreatyHistory, NPC_HISTORY_MAX_ENTRIES } from "./diplomacy";

/**
 * Task #85 — NPC 提案記憶歷史查詢（fetchNpcTreatyHistory）的真實資料庫整合測試。
 * routes/diplomacy.ts 的 NPC 分支直接呼叫同一個函式，因此這裡驗證的就是
 * 線上查詢本身：
 * - 雙向 pair 都算同一對（A→B 與 B→A）
 * - 只撈三種已結束狀態（rejected / withdrawn / superseded）
 * - 7 天窗外的列被排除
 * - 超過 5 筆只取最新（updatedAt 新→舊）
 * - 排除剛插入的本筆提案（excludeTreatyId）
 * - 其他 pair 的歷史不會被撈進來
 */

const TEST_TAG = "__npchisttest__";

let playerId: string;
let npcId: string;
let otherId: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-03T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

async function createNation(name: string, isNpc = false) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({ name: `${TEST_TAG}${name}`, leaderName: TEST_TAG, isNpc })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function insertTreaty(
  overrides: Partial<{
    proposerNationId: string;
    targetNationId: string;
    type: string;
    status: string;
    durationDays: number | null;
    offerMoney: number;
    offerTechPoints: number;
    responseNote: string | null;
    updatedAt: Date;
  }> = {},
) {
  const [row] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: overrides.proposerNationId ?? playerId,
      targetNationId: overrides.targetNationId ?? npcId,
      type: overrides.type ?? "nonaggression",
      durationDays: overrides.durationDays ?? null,
      offerMoney: overrides.offerMoney ?? 0,
      offerTechPoints: overrides.offerTechPoints ?? 0,
      offerRegionIds: [],
      status: overrides.status ?? "rejected",
      awaitingNationId: null,
      responseNote: overrides.responseNote ?? null,
      updatedAt: overrides.updatedAt ?? daysAgo(1),
    })
    .returning({ id: diplomacyTreatiesTable.id });
  assert.ok(row, "test treaty insert failed");
  return row.id;
}

async function deleteTestTreaties() {
  const ids = [playerId, npcId, otherId].filter(Boolean);
  if (ids.length === 0) return;
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        inArray(diplomacyTreatiesTable.proposerNationId, ids),
        inArray(diplomacyTreatiesTable.targetNationId, ids),
      ),
    );
}

before(async () => {
  await runDiplomacyMigrations();
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);

  playerId = await createNation("player");
  npcId = await createNation("npc", true);
  otherId = await createNation("other");
});

beforeEach(async () => {
  await deleteTestTreaties();
});

after(async () => {
  await deleteTestTreaties();
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
  await pool.end();
});

function fetchHistory(excludeTreatyId = -1) {
  return fetchNpcTreatyHistory({
    myNationId: playerId,
    npcNationId: npcId,
    excludeTreatyId,
    now: NOW,
  });
}

test("雙向 pair 都算同一對：player→npc 與 npc→player 都被撈到，方向旗標正確", async () => {
  await insertTreaty({ updatedAt: daysAgo(1) }); // player→npc
  await insertTreaty({
    proposerNationId: npcId,
    targetNationId: playerId,
    status: "withdrawn",
    updatedAt: daysAgo(2),
  }); // npc→player

  const rows = await fetchHistory();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.proposedByNpc, false, "最新一筆為玩家提案");
  assert.equal(rows[1]!.proposedByNpc, true, "第二筆為 NPC 提案");
});

test("其他 pair 的歷史不會被撈進來", async () => {
  await insertTreaty({ targetNationId: otherId }); // player→other
  await insertTreaty({ proposerNationId: otherId, targetNationId: npcId }); // other→npc

  const rows = await fetchHistory();
  assert.equal(rows.length, 0);
});

test("只撈 rejected/withdrawn/superseded；proposed/active/expired/annulled 被排除", async () => {
  await insertTreaty({ status: "rejected", updatedAt: daysAgo(1) });
  await insertTreaty({ status: "withdrawn", updatedAt: daysAgo(2) });
  await insertTreaty({ status: "superseded", updatedAt: daysAgo(3) });
  await insertTreaty({ status: "active", updatedAt: daysAgo(1) });
  await insertTreaty({ status: "expired", updatedAt: daysAgo(1) });
  await insertTreaty({ status: "annulled", updatedAt: daysAgo(1) });
  await insertTreaty({ status: "proposed", updatedAt: daysAgo(1) });

  const rows = await fetchHistory();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.status).sort(),
    ["rejected", "superseded", "withdrawn"],
  );
});

test("7 天窗：窗外的列被排除、窗內保留", async () => {
  await insertTreaty({ updatedAt: daysAgo(6), responseNote: "窗內" });
  await insertTreaty({ updatedAt: daysAgo(8), responseNote: "窗外" });

  const rows = await fetchHistory();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.responseNote, "窗內");
});

test("超過 5 筆只取最新，且依 updatedAt 新→舊排序", async () => {
  for (let i = 1; i <= 7; i++) {
    // 全部落在 7 天窗內（0.5 ~ 3.5 天前），note 標記天序。
    await insertTreaty({
      updatedAt: daysAgo(i * 0.5),
      responseNote: `第${i}筆`,
    });
  }

  const rows = await fetchHistory();
  assert.equal(rows.length, NPC_HISTORY_MAX_ENTRIES);
  assert.deepEqual(
    rows.map((r) => r.responseNote),
    ["第1筆", "第2筆", "第3筆", "第4筆", "第5筆"],
    "應為最新 5 筆、新→舊",
  );
});

test("排除剛插入的本筆提案（即使狀態意外命中也不會記到自己頭上）", async () => {
  const selfId = await insertTreaty({ status: "rejected", updatedAt: daysAgo(1) });
  await insertTreaty({ status: "rejected", updatedAt: daysAgo(2), responseNote: "別筆" });

  const rows = await fetchHistory(selfId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.responseNote, "別筆");
});

test("查詢結果可直接餵給 summarizeNpcTreatyHistory 產生 prompt 摘要", async () => {
  await insertTreaty({
    type: "alliance",
    status: "rejected",
    durationDays: 30,
    offerMoney: 500,
    responseNote: "誠意不足",
    updatedAt: daysAgo(2),
  });

  const rows = await fetchHistory();
  const lines = summarizeNpcTreatyHistory(rows, NOW);
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.ok(line.includes("同盟條約"), `應含條約類型：${line}`);
  assert.ok(line.includes("誠意不足"), `應含 responseNote：${line}`);
});
