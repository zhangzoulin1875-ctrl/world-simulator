/**
 * Task #116 — 私人外交訊息端點（GET /api/diplomacy/messages/:nationId）
 * 的真實資料庫整合測試。此端點以 pair 雙向查詢回傳兩國之間的私人通訊內容，
 * 比互動歷史更敏感。這裡鎖住其隱私與正確性不變量，避免日後查詢條件被改壞
 * （or/and 括號寫錯、少了某一方向）而把「對方與第三國」或「我與第三國」的
 * 私訊混進來：
 *
 *  1. 三國情境（A↔B、A↔C、B↔C 各有訊息）：以 A 查 B 只見 A↔B 私訊，
 *     A↔C 與 B↔C 一律排除。
 *  2. 雙向：A→B 與 B→A 的訊息都會被撈到，fromMe 旗標正確。
 *  3. 排序：依 id 舊→新（回傳前 rows.reverse()）。
 *  4. 對自己查詢回 400。
 *
 * 另鎖住寄送端點（POST /api/diplomacy/messages/:nationId）的守門，避免日後被
 * 改壞而讓玩家對不該通訊的對象發送私訊、或塞入空白／超長內容：
 *
 *  5. 寄給自己回 400。
 *  6. 寄給 NPC 或無主國家回 400。
 *  7. 空白／非字串內容回 400。
 *  8. 超過 2000 字回 400（剛好 2000 字放行）。
 *  9. 正常寄送成功並可被對方讀到（前後空白已 trim、fromMe 旗標正確）。
 *
 * 走真正的 Express 端點（掛 session cookie），因此驗證的是線上查詢本身。
 * 需要 DATABASE_URL 指向已由正常伺服器啟動遷移過的資料庫。所有資料以
 * `__msgtest__` / `msgtest-` 前綴標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the diplomacy-messages tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { inArray, like, or, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  diplomacyMessagesTable,
  userSessionsTable,
} = await import("@workspace/db");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const diplomacyRouter = (await import("./diplomacy")).default;

const NATION_MARKER = "__msgtest__";
const USER_MARKER = "msgtest-";

const runId = randomBytes(4).toString("hex");

let server: http.Server;
let baseUrl: string;

// A 為擁有者（掛 session）；B、C 為第三國。
let nationA: string;
let nationB: string;
let nationC: string;
let nationUnowned: string;
let ownerUserId: string;
let sessionToken: string;
let recipientSessionToken: string;

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

async function insertMessage(
  senderNationId: string,
  recipientNationId: string,
  body: string,
) {
  await db.insert(diplomacyMessagesTable).values({
    senderNationId,
    recipientNationId,
    body,
  });
}

async function clearMessages() {
  const ids = [nationA, nationB, nationC].filter(Boolean);
  if (ids.length === 0) return;
  await db
    .delete(diplomacyMessagesTable)
    .where(
      or(
        inArray(diplomacyMessagesTable.senderNationId, ids),
        inArray(diplomacyMessagesTable.recipientNationId, ids),
      ),
    );
}

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${NATION_MARKER + "%"}`);
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function getMessages(
  nationId: string,
  token: string = sessionToken,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/diplomacy/messages/${nationId}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  return { status: res.status, json: await res.json() };
}

async function postMessage(
  nationId: string,
  body: unknown,
  token: string = sessionToken,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/diplomacy/messages/${nationId}`, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  await runDiplomacyMigrations();
  await cleanup();

  ownerUserId = `${USER_MARKER}owner-${runId}`;
  const recipientUserId = `${USER_MARKER}B-${runId}`;
  nationA = await createNation("A", { discordUserId: ownerUserId });
  nationB = await createNation("B", { discordUserId: recipientUserId });
  nationC = await createNation("C", { discordUserId: `${USER_MARKER}C-${runId}` });
  // 無主國家（非 NPC 且 discordUserId=null）不可通訊；NPC 對話另見 diplomacy.npcChat.test.ts。
  nationUnowned = await createNation("UNOWNED", { discordUserId: null });

  sessionToken = await createSession({
    discordUserId: ownerUserId,
    username: ownerUserId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });
  recipientSessionToken = await createSession({
    discordUserId: recipientUserId,
    username: recipientUserId,
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
  app.use("/api", diplomacyRouter);
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

test("三國情境：以 A 查 B 只見 A↔B 私訊，A↔C 與 B↔C 一律排除", async () => {
  await clearMessages();
  // A↔B（雙向）— 應被回傳。
  await insertMessage(nationA, nationB, "AB-out");
  await insertMessage(nationB, nationA, "AB-in");
  // A↔C：我與第三國的私訊，查 B 時不得混入。
  await insertMessage(nationA, nationC, "AC-out");
  await insertMessage(nationC, nationA, "AC-in");
  // B↔C：對方與第三國的私訊，完全與 A 無關，不得混入。
  await insertMessage(nationB, nationC, "BC-out");
  await insertMessage(nationC, nationB, "BC-in");

  const { status, json } = await getMessages(nationB);
  assert.equal(status, 200);
  const bodies = json.messages.map((m: any) => m.body).sort();
  assert.equal(json.messages.length, 2, "只應回傳 A↔B 的兩筆");
  assert.deepEqual(bodies, ["AB-in", "AB-out"]);
});

test("雙向：A→B 與 B→A 都被撈到，fromMe 旗標正確", async () => {
  await clearMessages();
  await insertMessage(nationA, nationB, "from-A"); // 我寄的
  await insertMessage(nationB, nationA, "from-B"); // 對方寄的

  const { status, json } = await getMessages(nationB);
  assert.equal(status, 200);
  assert.equal(json.messages.length, 2);
  const byBody = new Map(json.messages.map((m: any) => [m.body, m.fromMe]));
  assert.equal(byBody.get("from-A"), true, "A→B 應為 fromMe=true");
  assert.equal(byBody.get("from-B"), false, "B→A 應為 fromMe=false");
});

test("排序：依 id 舊→新", async () => {
  await clearMessages();
  await insertMessage(nationA, nationB, "first");
  await insertMessage(nationB, nationA, "second");
  await insertMessage(nationA, nationB, "third");

  const { json } = await getMessages(nationB);
  assert.deepEqual(
    json.messages.map((m: any) => m.body),
    ["first", "second", "third"],
    "應維持插入（舊→新）順序",
  );
  const ids = json.messages.map((m: any) => m.id);
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i - 1] < ids[i], "id 必須遞增（舊→新）");
  }
});

test("對自己查詢回 400", async () => {
  await clearMessages();
  const { status, json } = await getMessages(nationA);
  assert.equal(status, 400);
  assert.ok(
    String(json.error ?? "").includes("自己"),
    `錯誤訊息應說明不可與自己對話：${JSON.stringify(json)}`,
  );
});

// ── 寄送端點守門（POST /api/diplomacy/messages/:nationId）──────────

test("寄給自己回 400", async () => {
  await clearMessages();
  const { status, json } = await postMessage(nationA, "給自己的訊息");
  assert.equal(status, 400);
  assert.ok(
    String(json.error ?? "").includes("自己"),
    `錯誤訊息應說明不可傳給自己：${JSON.stringify(json)}`,
  );
});

// Task #228 起 NPC 國家已可對話（AI 回覆，見 diplomacy.npcChat.test.ts）；
// 此處僅鎖住「無主國家（非 NPC 且無玩家）不可對話」的守門。
test("寄給無主國家回 400", async () => {
  await clearMessages();
  const { status, json } = await postMessage(nationUnowned, "給無主國家的訊息");
  assert.equal(status, 400);
  assert.ok(
    String(json.error ?? "").includes("玩家"),
    `錯誤訊息應說明只能與玩家或 NPC 國家通訊：${JSON.stringify(json)}`,
  );
});

test("空白內容回 400", async () => {
  await clearMessages();
  for (const empty of ["", "   ", "\n\t "]) {
    const { status, json } = await postMessage(nationB, empty);
    assert.equal(status, 400, `空白內容 ${JSON.stringify(empty)} 應回 400`);
    assert.ok(
      String(json.error ?? "").includes("不可為空"),
      `錯誤訊息應說明內容不可為空：${JSON.stringify(json)}`,
    );
  }
});

test("非字串內容回 400", async () => {
  await clearMessages();
  for (const bad of [undefined, null, 123, { text: "hi" }, ["a"]]) {
    const { status } = await postMessage(nationB, bad);
    assert.equal(status, 400, `非字串內容 ${JSON.stringify(bad)} 應回 400`);
  }
});

test("超過 2000 字回 400", async () => {
  await clearMessages();
  const { status, json } = await postMessage(nationB, "字".repeat(2001));
  assert.equal(status, 400);
  assert.ok(
    String(json.error ?? "").includes("2000"),
    `錯誤訊息應說明長度上限：${JSON.stringify(json)}`,
  );
  // 剛好 2000 字必須被接受。
  const ok = await postMessage(nationB, "字".repeat(2000));
  assert.equal(ok.status, 200, "剛好 2000 字應成功寄出");
});

test("正常寄送成功，且可被對方讀到", async () => {
  await clearMessages();
  const outgoing = `hello-${runId}`;
  const { status, json } = await postMessage(nationB, `  ${outgoing}  `);
  assert.equal(status, 200);
  assert.equal(json.fromMe, true, "寄件方應為 fromMe=true");
  assert.equal(json.body, outgoing, "回應內容應已 trim 前後空白");

  // 對方（nationB）以自己的 session 查詢 nationA 應能讀到這封訊息。
  const inbox = await getMessages(nationA, recipientSessionToken);
  assert.equal(inbox.status, 200);
  const received = inbox.json.messages.find((m: any) => m.body === outgoing);
  assert.ok(received, `對方應收到訊息：${JSON.stringify(inbox.json)}`);
  assert.equal(received.fromMe, false, "對方視角應為 fromMe=false");
});
