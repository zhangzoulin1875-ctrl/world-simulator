/**
 * Task #228 — 與 NPC 對話端點（POST /api/diplomacy/messages/:nationId，NPC 分支）
 * 的真實資料庫整合測試，聚焦「每回合每位玩家與 NPC 的 AI 對話上限」不變量。
 *
 * 額度在呼叫 AI 前，以「INSERT ... ON CONFLICT DO UPDATE ... WHERE used_count <
 * cap RETURNING」原子認領，故併發下也不會超額：
 *
 *  1. 併發 N（>上限）則對同一 NPC 送訊息 → 恰好 AI_CHAT_TURN_CAP 則成功（200），
 *     其餘回 400（本回合次數已用完），DB used_count 停在上限。
 *  2. 上限跨所有 NPC 共用（同一玩家同一回合）：對 NPC-1 用滿後，對 NPC-2 仍被擋。
 *
 * AI（decideNpcChatReply）以覆寫共享 anthropic 單例的 messages.create 樁掉，回傳
 * 固定合法 JSON，避免呼叫真實模型；如此才能確定成功次數 = 額度而非 AI 成敗。
 *
 * 所有資料以 `__npcchattest__` / `npcchattest-` 前綴標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the npc-chat tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, inArray, like, or, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  diplomacyMessagesTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  diplomacyAiChatQuotasTable,
  worldGameStateTable,
  userSessionsTable,
} = await import("@workspace/db");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { AI_CHAT_TURN_CAP } = await import("../lib/diplomacy");
const { addYearsToGameDate } = await import("../lib/turnEngine");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const diplomacyRouter = (await import("./diplomacy")).default;

const NATION_MARKER = "__npcchattest__";
const USER_MARKER = "npcchattest-";

const runId = randomBytes(4).toString("hex");

let server: http.Server;
let baseUrl: string;

let nationA: string; // 玩家（掛 session）
let nationNpc1: string;
let nationNpc2: string;
let ownerUserId: string;
let sessionToken: string;
let turnDate = "";
// 原始 world_game_state.game_date（單行 id=1，跨測試共用），跑後還原。
let originalGameDate = "";

// 保存原始 anthropic.messages.create 以便還原。
const originalCreate = anthropic.messages.create;

async function createNation(
  label: string,
  opts: { discordUserId?: string | null; isNpc?: boolean } = {},
) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${label}-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: opts.discordUserId ?? null,
      isNpc: opts.isNpc ?? false,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function resetQuota() {
  // 清掉本玩家所有回合的額度列，確保從 0 起算。
  await db
    .delete(diplomacyAiChatQuotasTable)
    .where(eq(diplomacyAiChatQuotasTable.nationId, nationA));
}

async function clearChatArtifacts() {
  const ids = [nationA, nationNpc1, nationNpc2].filter(Boolean);
  if (ids.length === 0) return;
  await db
    .delete(diplomacyMessagesTable)
    .where(
      or(
        inArray(diplomacyMessagesTable.senderNationId, ids),
        inArray(diplomacyMessagesTable.recipientNationId, ids),
      ),
    );
  await db
    .delete(diplomacyRelationEventsTable)
    .where(
      or(
        inArray(diplomacyRelationEventsTable.actorNationId, ids),
        inArray(diplomacyRelationEventsTable.targetNationId, ids),
      ),
    );
  await db
    .delete(diplomacyRelationsTable)
    .where(
      or(
        inArray(diplomacyRelationsTable.nationAId, ids),
        inArray(diplomacyRelationsTable.nationBId, ids),
      ),
    );
}

async function currentTurnDate(): Promise<string> {
  const [gs] = await db
    .select({
      turnDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return gs?.turnDate ?? "";
}

// 模擬每日回合推進：把 world_game_state.game_date 依 years_per_turn 前進，
// 回傳新回合日期（YYYY-MM-DD）。與回合引擎 addYearsToGameDate 同一套推導。
async function advanceTurnDate(): Promise<string> {
  const [gs] = await db
    .select({
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      yearsPerTurn: worldGameStateTable.yearsPerTurn,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  assert.ok(gs, "world_game_state 單行 (id=1) 應存在");
  const next = addYearsToGameDate(gs.gameDate, gs.yearsPerTurn);
  await db
    .update(worldGameStateTable)
    .set({ gameDate: next, updatedAt: sql`NOW()` })
    .where(eq(worldGameStateTable.id, 1));
  return next;
}

async function readQuota(nationId: string, forTurnDate: string) {
  const [row] = await db
    .select({ usedCount: diplomacyAiChatQuotasTable.usedCount })
    .from(diplomacyAiChatQuotasTable)
    .where(
      and(
        eq(diplomacyAiChatQuotasTable.nationId, nationId),
        eq(diplomacyAiChatQuotasTable.turnDate, forTurnDate),
      ),
    )
    .limit(1);
  return row;
}

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${NATION_MARKER + "%"}`);
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function chat(
  nationId: string,
  body: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/diplomacy/messages/${nationId}`, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  await runDiplomacyMigrations();
  await cleanup();

  // 樁掉 AI：回傳固定合法 JSON，確保成功次數 = 額度而非 AI 成敗。
  (anthropic.messages as unknown as { create: unknown }).create = async () => ({
    content: [{ type: "text", text: '{"reply":"（測試回覆）","relationDelta":0}' }],
  });

  ownerUserId = `${USER_MARKER}owner-${runId}`;
  nationA = await createNation("A", { discordUserId: ownerUserId });
  nationNpc1 = await createNation("NPC1", {
    discordUserId: `${USER_MARKER}NPC1-${runId}`,
    isNpc: true,
  });
  nationNpc2 = await createNation("NPC2", {
    discordUserId: `${USER_MARKER}NPC2-${runId}`,
    isNpc: true,
  });

  sessionToken = await createSession({
    discordUserId: ownerUserId,
    username: ownerUserId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  const [gs] = await db
    .select({
      turnDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  turnDate = gs?.turnDate ?? "";
  originalGameDate = turnDate;

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
  app.use("/api", diplomacyRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  (anthropic.messages as unknown as { create: unknown }).create = originalCreate;
  // 還原 game_date（單行共用，避免污染其他測試/開發資料）。
  if (originalGameDate) {
    await db
      .update(worldGameStateTable)
      .set({ gameDate: originalGameDate, updatedAt: sql`NOW()` })
      .where(eq(worldGameStateTable.id, 1));
  }
  await resetQuota();
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

// 併發防護（同下方回合重置測試）：外部 forced-turn 測試可能中途推進
// game_date 使額度鍵改變；日期不穩就整段重試。
test("併發送出多則 → 恰好 AI_CHAT_TURN_CAP 則成功，其餘回 400", async () => {
  const MAX_ATTEMPTS = 4;
  let done = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
    await resetQuota();
    await clearChatArtifacts();

    const d0 = await currentTurnDate();
    const attempts = AI_CHAT_TURN_CAP + 3;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) => chat(nationNpc1, `訊息-${i}`)),
    );
    if ((await currentTurnDate()) !== d0) continue; // 回合被外部推進 → 重試

    const ok = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 400);
    assert.equal(
      ok.length,
      AI_CHAT_TURN_CAP,
      `應恰好 ${AI_CHAT_TURN_CAP} 則成功，實際 ${ok.length}`,
    );
    assert.equal(
      rejected.length,
      attempts - AI_CHAT_TURN_CAP,
      `其餘 ${attempts - AI_CHAT_TURN_CAP} 則應回 400`,
    );
    for (const r of rejected) {
      assert.ok(
        String(r.json.error ?? "").includes("次數已用完"),
        `被擋訊息應說明次數用完：${JSON.stringify(r.json)}`,
      );
    }

    // DB used_count 應停在上限，不會超額。
    const [quota] = await db
      .select({ usedCount: diplomacyAiChatQuotasTable.usedCount })
      .from(diplomacyAiChatQuotasTable)
      .where(
        and(
          eq(diplomacyAiChatQuotasTable.nationId, nationA),
          eq(diplomacyAiChatQuotasTable.turnDate, d0),
        ),
      )
      .limit(1);
    assert.ok(quota, "應有額度列");
    assert.equal(quota.usedCount, AI_CHAT_TURN_CAP, "used_count 必須停在上限");
    done = true;
  }
  assert.ok(done, "併發額度測試多次重試仍被外部回合推進打斷");
});

test("上限跨所有 NPC 共用：對 NPC-1 用滿後，對 NPC-2 仍被擋", async () => {
  const MAX_ATTEMPTS = 4;
  let done = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
    await resetQuota();
    await clearChatArtifacts();

    const d0 = await currentTurnDate();

    // 對 NPC-1 循序用滿上限。
    for (let i = 0; i < AI_CHAT_TURN_CAP; i++) {
      const { status } = await chat(nationNpc1, `對一-${i}`);
      assert.equal(status, 200, `第 ${i + 1} 則對 NPC-1 應成功`);
    }
    if ((await currentTurnDate()) !== d0) continue; // 回合被外部推進 → 重試

    // 額度已滿；改對 NPC-2 仍應被擋（額度以玩家為單位，非以 NPC 為單位）。
    const { status, json } = await chat(nationNpc2, "對二");
    if (status === 200 && (await currentTurnDate()) !== d0) continue; // 合法重置 → 重試
    assert.equal(status, 400, `對 NPC-2 應被擋：${JSON.stringify(json)}`);
    assert.ok(
      String(json.error ?? "").includes("次數已用完"),
      `錯誤訊息應說明次數用完：${JSON.stringify(json)}`,
    );
    done = true;
  }
  assert.ok(done, "跨 NPC 共用額度測試多次重試仍被外部回合推進打斷");
});

// 每回合上限的關鍵漏洞：回合日期一推進，玩家就該重新取得完整額度。額度以
// (nationId, turnDate) 為鍵，故舊回合用滿的列不會外溢到新回合。
//
// 併發防護：驗證流程會同時跑 lib glob 與整合清單（共用 dev DB），對方的
// forced-turn 測試會推進 world_game_state.game_date，讓額度鍵中途改變、
// 額度被「合法地」重置。每階段結束時驗證日期未被外部推進；被推進就整段
// 重試（有限次數），只有在日期穩定的前提下才做嚴格斷言。
test("回合推進後額度重置：用滿上限者於下一回合可再對話，舊回合用量不外溢", async () => {
  const MAX_ATTEMPTS = 4;

  // ── 階段一：D1 用滿上限，超額被擋 ──
  let d1 = "";
  let phase1Done = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !phase1Done; attempt++) {
    await resetQuota();
    await clearChatArtifacts();

    d1 = await currentTurnDate();
    assert.ok(d1, "應能取得當前回合日期");

    // 於當前回合 D1 用滿上限。
    for (let i = 0; i < AI_CHAT_TURN_CAP; i++) {
      const { status } = await chat(nationNpc1, `D1-${i}`);
      assert.equal(status, 200, `D1 第 ${i + 1} 則應成功`);
    }
    if ((await currentTurnDate()) !== d1) continue; // 回合被外部推進 → 重試

    // D1 已達上限：再送應被擋。
    const { status, json } = await chat(nationNpc1, "D1-超額");
    if (status === 200 && (await currentTurnDate()) !== d1) continue; // 合法重置 → 重試
    assert.equal(status, 400, `D1 超額應被擋：${JSON.stringify(json)}`);
    assert.ok(
      String(json.error ?? "").includes("次數已用完"),
      `D1 超額錯誤訊息應說明次數用完：${JSON.stringify(json)}`,
    );
    phase1Done = true;
  }
  assert.ok(phase1Done, "D1 階段多次重試仍被外部回合推進打斷");

  // ── 階段二：推進回合 → 額度重置、新回合可用滿完整上限 ──
  let phase2Done = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !phase2Done; attempt++) {
    // 推進回合日期（模擬每日回合推進 world_game_state.game_date）。
    const beforeDate = await currentTurnDate();
    const d2 = await advanceTurnDate();
    assert.notEqual(d2, beforeDate, "回合推進後 turnDate 必須改變");

    // 新回合：同一玩家、同一 NPC，應可重新對話（額度重置）。
    // 先驗證日期未被外部改動（含被還原回舊日期），再做嚴格斷言——否則
    // 併發的 forced-turn / after() 還原會讓額度鍵中途變回用滿的舊回合。
    const first = await chat(nationNpc1, "D2-1");
    if ((await currentTurnDate()) !== d2) continue; // 又被外部推進/還原 → 重試
    assert.equal(
      first.status,
      200,
      `下一回合應可再對話：${JSON.stringify(first.json)}`,
    );

    // D2 新列自 1 起算，未繼承舊回合用量。
    const newQuota = await readQuota(nationA, d2);
    assert.ok(newQuota, "應有 D2 新額度列");
    assert.equal(
      newQuota.usedCount,
      1,
      "D2 新列應自 1 起算，未繼承舊回合用量",
    );

    // 確認新回合可用滿完整上限（證明拿到的是全新額度，而非舊回合殘額）。
    let interrupted = false;
    for (let i = 1; i < AI_CHAT_TURN_CAP; i++) {
      const { status } = await chat(nationNpc1, `D2-${i + 1}`);
      if (status !== 200 && (await currentTurnDate()) !== d2) {
        interrupted = true; // 外部推進/還原打斷 → 整段重試
        break;
      }
      assert.equal(status, 200, `D2 第 ${i + 1} 則應成功`);
    }
    if (interrupted) continue;
    const over = await chat(nationNpc1, "D2-超額");
    if (over.status === 200 && (await currentTurnDate()) !== d2) continue;
    assert.equal(over.status, 400, "D2 用滿完整上限後才被擋");
    phase2Done = true;
  }
  assert.ok(phase2Done, "D2 階段多次重試仍被外部回合推進打斷");

  // 額度以 (nationId, turnDate) 為鍵：D1 舊列仍停在上限——舊回合用量
  // 不會外溢，也不會佔用新回合的額度。
  const oldQuota = await readQuota(nationA, d1);
  assert.ok(oldQuota, "應保留 D1 舊額度列");
  assert.equal(
    oldQuota.usedCount,
    AI_CHAT_TURN_CAP,
    "D1 舊列應仍停在上限（未被新回合影響）",
  );
});
