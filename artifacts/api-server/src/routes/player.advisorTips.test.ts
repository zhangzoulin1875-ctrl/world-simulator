/**
 * Task #306 — 看板顧問小tips 端點（POST /api/player/nation/advisor-tips）整合測試。
 *
 * 走真正的 Express 端點（掛 session cookie），以測試替身固定 anthropic 回應，
 * 鎖住三項行為：
 *
 *  1. 已設定說話風格 → 呼叫成功，advisor_tips 被覆寫為 AI 產生的清單。
 *  2. 未設定說話風格（null）→ 400（zh-TW），不動 advisor_tips。
 *  3. AI 失敗 → 502（zh-TW），且原本的 advisor_tips 完整保留（不被清空）。
 *
 * 需要 DATABASE_URL 指向已由正常伺服器啟動遷移過的資料庫。所有資料以
 * `__advtiptest__` / `advtiptest-` 前綴標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the advisor-tips tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, like, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, userSessionsTable } = await import(
  "@workspace/db"
);
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const playerRouter = (await import("./player")).default;

const NATION_MARKER = "__advtiptest__";
const USER_MARKER = "advtiptest-";
const runId = randomBytes(4).toString("hex");
const ownerUserId = `${USER_MARKER}${runId}`;

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

/** 讓 anthropic 回傳固定的 tips JSON（模擬模型成功產出）。 */
function stubAiTips(list: string[]): void {
  anthropic.messages.create = (async () => ({
    content: [{ type: "text", text: JSON.stringify({ tips: list }) }],
  })) as unknown as MessagesCreate;
}

/** 讓 anthropic 呼叫拋錯（模擬 AI 失敗）。 */
function stubAiThrow(): void {
  anthropic.messages.create = (async () => {
    throw new Error("模擬 AI 失敗");
  }) as unknown as MessagesCreate;
}

function restoreAi(): void {
  anthropic.messages.create = realMessagesCreate;
}

let server: http.Server;
let baseUrl: string;
let sessionToken: string;

async function cleanup(): Promise<void> {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${NATION_MARKER + "%"}`);
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function upsertNation(opts: {
  advisorStyle: string | null;
  advisorTips: string[];
}): Promise<void> {
  await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}`,
      leaderName: NATION_MARKER,
      government: "君主制",
      discordUserId: ownerUserId,
      advisorStyle: opts.advisorStyle,
      advisorTips: opts.advisorTips,
    })
    .onConflictDoUpdate({
      target: playerNationsTable.discordUserId,
      set: { advisorStyle: opts.advisorStyle, advisorTips: opts.advisorTips },
    });
}

async function readTips(): Promise<string[]> {
  const [row] = await db
    .select({ advisorTips: playerNationsTable.advisorTips })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, ownerUserId))
    .limit(1);
  assert.ok(row, "test nation not found");
  return row.advisorTips;
}

async function postAdvisorTips(): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/player/nation/advisor-tips`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  await runGameMigrations();
  await cleanup();

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
  app.use("/api", playerRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  sessionToken = await createSession({
    discordUserId: ownerUserId,
    username: ownerUserId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });
});

after(async () => {
  restoreAi();
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

test("已設定說話風格 → 成功產生並覆寫 advisor_tips", async () => {
  await upsertNation({ advisorStyle: "溫柔的軍師", advisorTips: [] });
  const generated = Array.from(
    { length: 20 },
    (_, i) => `風格化小提示第${i + 1}則`,
  );
  stubAiTips(generated);
  try {
    const { status, json } = await postAdvisorTips();
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.hasNation, true);
    const persisted = await readTips();
    assert.deepEqual(persisted, generated, "advisor_tips 應被覆寫為 AI 清單");
  } finally {
    restoreAi();
  }
});

test("未設定說話風格 → 400（zh-TW），不動 advisor_tips", async () => {
  const oldTips = ["舊提示一", "舊提示二"];
  await upsertNation({ advisorStyle: null, advisorTips: oldTips });
  // 就算 AI 可用也不該被呼叫；設成拋錯以確保端點在到達 AI 前就 400。
  stubAiThrow();
  try {
    const { status, json } = await postAdvisorTips();
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, /說話風格/);
    assert.deepEqual(await readTips(), oldTips, "400 不應更動 advisor_tips");
  } finally {
    restoreAi();
  }
});

test("AI 失敗 → 502（zh-TW），且保留原本的 advisor_tips", async () => {
  const oldTips = ["珍貴的舊提示一", "珍貴的舊提示二", "珍貴的舊提示三"];
  await upsertNation({ advisorStyle: "熱血教官", advisorTips: oldTips });
  stubAiThrow();
  try {
    const { status, json } = await postAdvisorTips();
    assert.equal(status, 502, JSON.stringify(json));
    assert.ok(typeof json.error === "string" && json.error.length > 0);
    assert.match(json.error, /失敗/);
    assert.deepEqual(
      await readTips(),
      oldTips,
      "AI 失敗時原本的 advisor_tips 必須完整保留",
    );
  } finally {
    restoreAi();
  }
});
