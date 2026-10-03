/**
 * Task #158 — 玩家大廳群聊端點的真實資料庫整合測試。
 *
 * 大廳是所有玩家共用的單一群聊，與一對一私訊並存。這裡鎖住其讀寫不變量：
 *
 *  1. 讀取：回傳所有玩家的大廳訊息，依時間正序（舊→新），並帶出每則的
 *     發話國家名稱／id 與 fromMe 旗標（自己發的為 true）。
 *  2. 尚未建國者讀取／張貼皆回 400（requirePlayer 守門）。
 *  3. 張貼守門：空白／非字串回 400；超過 2000 字回 400（剛好 2000 字放行）。
 *  4. 正常張貼成功並可被其他玩家讀到（前後空白已 trim）。
 *
 * 走真正的 Express 端點（掛 session cookie）。需要 DATABASE_URL 指向已由正常
 * 伺服器啟動遷移過的資料庫。所有資料以 `__lobbytest__` / `lobbytest-` 前綴標記，
 * 跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the diplomacy-lobby tests");
}

// requireAdmin 於模組載入時讀取 process.env.ADMIN_TOKEN，必須在 import 之前設定。
const ADMIN_TOKEN = "lobbytest-admin-token";
process.env.ADMIN_TOKEN = ADMIN_TOKEN;

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { inArray, like, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  diplomacyLobbyMessagesTable,
  userSessionsTable,
} = await import("@workspace/db");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const diplomacyModule = await import("./diplomacy");
const diplomacyRouter = diplomacyModule.default;
const { __resetLobbyPostCooldownForTests } = diplomacyModule;

const NATION_MARKER = "__lobbytest__";
const USER_MARKER = "lobbytest-";

const runId = randomBytes(4).toString("hex");

let server: http.Server;
let baseUrl: string;

let nationA: string;
let nationB: string;
let sessionA: string;
let sessionB: string;
let sessionNoNation: string;

async function createNation(label: string, discordUserId: string) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${label}-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId,
      isNpc: false,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function clearMessages() {
  __resetLobbyPostCooldownForTests();
  const ids = [nationA, nationB].filter(Boolean);
  if (ids.length === 0) return;
  await db
    .delete(diplomacyLobbyMessagesTable)
    .where(inArray(diplomacyLobbyMessagesTable.senderNationId, ids));
}

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${NATION_MARKER + "%"}`);
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function getLobby(
  token: string,
  before?: number,
): Promise<{ status: number; json: any }> {
  const qs = before === undefined ? "" : `?before=${before}`;
  const res = await fetch(`${baseUrl}/api/diplomacy/lobby/messages${qs}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  return { status: res.status, json: await res.json() };
}

async function postLobby(
  body: unknown,
  token: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/diplomacy/lobby/messages`, {
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

  const userA = `${USER_MARKER}A-${runId}`;
  const userB = `${USER_MARKER}B-${runId}`;
  const userNoNation = `${USER_MARKER}none-${runId}`;
  nationA = await createNation("A", userA);
  nationB = await createNation("B", userB);

  sessionA = await createSession({
    discordUserId: userA,
    username: userA,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });
  sessionB = await createSession({
    discordUserId: userB,
    username: userB,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });
  sessionNoNation = await createSession({
    discordUserId: userNoNation,
    username: userNoNation,
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

test("尚未建國者讀取／張貼皆回 400", async () => {
  const g = await getLobby(sessionNoNation);
  assert.equal(g.status, 400);
  const p = await postLobby("嗨", sessionNoNation);
  assert.equal(p.status, 400);
});

test("空白內容回 400", async () => {
  await clearMessages();
  for (const empty of ["", "   ", "\n\t "]) {
    const { status, json } = await postLobby(empty, sessionA);
    assert.equal(status, 400, `空白內容 ${JSON.stringify(empty)} 應回 400`);
    assert.ok(String(json.error ?? "").includes("不可為空"));
  }
});

test("非字串內容回 400", async () => {
  await clearMessages();
  for (const bad of [undefined, null, 123, { text: "hi" }, ["a"]]) {
    const { status } = await postLobby(bad, sessionA);
    assert.equal(status, 400, `非字串內容 ${JSON.stringify(bad)} 應回 400`);
  }
});

test("超過 2000 字回 400，剛好 2000 字放行", async () => {
  await clearMessages();
  const { status, json } = await postLobby("字".repeat(2001), sessionA);
  assert.equal(status, 400);
  assert.ok(String(json.error ?? "").includes("2000"));
  const ok = await postLobby("字".repeat(2000), sessionA);
  assert.equal(ok.status, 200, "剛好 2000 字應成功張貼");
});

test("正常張貼並依時間正序被所有玩家讀到，帶發話國家名稱與 fromMe", async () => {
  await clearMessages();
  const msgA = `hello-A-${runId}`;
  const msgB = `hello-B-${runId}`;

  const postedA = await postLobby(`  ${msgA}  `, sessionA);
  assert.equal(postedA.status, 200);
  assert.equal(postedA.json.body, msgA, "回應內容應已 trim");
  assert.equal(postedA.json.fromMe, true);

  await postLobby(msgB, sessionB);

  // B 視角讀取：兩則都在，依舊→新排序，自己那則 fromMe=true。
  const { status, json } = await getLobby(sessionB);
  assert.equal(status, 200);
  const mine = json.messages.filter((m: any) =>
    [msgA, msgB].includes(m.body),
  );
  assert.equal(mine.length, 2, "兩則大廳訊息都應被讀到");
  assert.deepEqual(
    mine.map((m: any) => m.body),
    [msgA, msgB],
    "應維持舊→新順序",
  );
  const byBody = new Map<string, any>(mine.map((m: any) => [m.body, m]));
  assert.equal(byBody.get(msgA).fromMe, false, "A 發的訊息在 B 視角 fromMe=false");
  assert.equal(byBody.get(msgB).fromMe, true, "B 發的訊息在 B 視角 fromMe=true");
  assert.ok(
    String(byBody.get(msgA).senderNationName).includes("A"),
    "應帶出發話國家名稱",
  );
  assert.equal(
    byBody.get(msgA).senderNationId,
    nationA,
    "應帶出發話國家 id",
  );
});

test("無效 before 游標回 400", async () => {
  for (const bad of ["abc", "0", "-3", "1.5"]) {
    const res = await fetch(
      `${baseUrl}/api/diplomacy/lobby/messages?before=${bad}`,
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionA}` } },
    );
    assert.equal(res.status, 400, `before=${bad} 應回 400`);
  }
});

test("before 游標分頁：只回較舊訊息並正確標記 hasMore", async () => {
  await clearMessages();

  // 張貼 5 則，記錄各自的 id（依序遞增）；每次張貼前清冷卻，避免發言冷卻擋下。
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    __resetLobbyPostCooldownForTests();
    const posted = await postLobby(`page-${i}-${runId}`, sessionA);
    assert.equal(posted.status, 200);
    ids.push(posted.json.id);
  }

  // 不帶游標：拿到全部 5 則、依舊→新排序、hasMore=false。
  const first = await getLobby(sessionA);
  assert.equal(first.status, 200);
  const mine = first.json.messages.filter((m: any) =>
    ids.includes(m.id),
  );
  assert.equal(mine.length, 5, "首頁應拿到全部 5 則");
  assert.deepEqual(
    mine.map((m: any) => m.id),
    [...ids].sort((a, b) => a - b),
    "應維持舊→新順序",
  );
  assert.equal(first.json.hasMore, false, "首頁後面沒有更舊訊息");

  // 帶 before = 第 3 則的 id：只回更舊的兩則（第 0、1 則），不含第 2 則本身。
  const older = await getLobby(sessionA, ids[2]);
  assert.equal(older.status, 200);
  const olderMine = older.json.messages.filter((m: any) =>
    ids.includes(m.id),
  );
  assert.deepEqual(
    olderMine.map((m: any) => m.id),
    [ids[0], ids[1]],
    "before 應只回嚴格更舊的訊息",
  );
  assert.ok(
    !olderMine.some((m: any) => m.id === ids[2]),
    "游標本身不應包含在結果中",
  );
});

async function deleteLobby(
  id: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/diplomacy/lobby/messages/${id}`, {
    method: "DELETE",
    headers,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // 忽略：某些回應可能沒有 body
  }
  return { status: res.status, json };
}

test("缺管理金鑰無法刪除大廳訊息（403），訊息仍在", async () => {
  await clearMessages();
  const posted = await postLobby(`del-guard-${runId}`, sessionA);
  assert.equal(posted.status, 200);
  const id = posted.json.id;

  // 完全不帶金鑰、以及帶玩家 session cookie（非管理金鑰）都應被擋，且錯誤為繁體中文。
  const noToken = await deleteLobby(id);
  assert.equal(noToken.status, 403, "缺管理金鑰應回 403");
  assert.ok(
    String(noToken.json?.error ?? "").includes("管理員"),
    "未授權錯誤應為繁體中文",
  );
  const withSession = await deleteLobby(id, {
    cookie: `${SESSION_COOKIE_NAME}=${sessionA}`,
  });
  assert.equal(withSession.status, 403, "玩家 session 非管理金鑰，應回 403");
  assert.ok(
    String(withSession.json?.error ?? "").includes("管理員"),
    "未授權錯誤應為繁體中文",
  );

  // 訊息仍應存在。
  const { json } = await getLobby(sessionA);
  assert.ok(
    json.messages.some((m: any) => m.id === id),
    "被擋下的刪除不應移除訊息",
  );
});

test("錯誤管理金鑰無法刪除大廳訊息（403，繁體中文）", async () => {
  await clearMessages();
  const posted = await postLobby(`del-wrong-${runId}`, sessionA);
  assert.equal(posted.status, 200);
  const wrong = await deleteLobby(posted.json.id, {
    authorization: "Bearer not-the-admin-token",
  });
  assert.equal(wrong.status, 403, "錯誤金鑰應回 403");
  assert.ok(
    String(wrong.json?.error ?? "").includes("管理員"),
    "未授權錯誤應為繁體中文",
  );
});

test("帶管理金鑰可硬刪除大廳訊息，之後列表不再包含該則", async () => {
  await clearMessages();
  const keep = await postLobby(`del-keep-${runId}`, sessionA);
  __resetLobbyPostCooldownForTests();
  const remove = await postLobby(`del-remove-${runId}`, sessionA);
  assert.equal(keep.status, 200);
  assert.equal(remove.status, 200);

  const del = await deleteLobby(remove.json.id, {
    authorization: `Bearer ${ADMIN_TOKEN}`,
  });
  assert.equal(del.status, 200, "帶管理金鑰應可刪除");
  assert.equal(del.json.id, remove.json.id, "回傳被刪除訊息的 id");

  const { json } = await getLobby(sessionA);
  assert.ok(
    !json.messages.some((m: any) => m.id === remove.json.id),
    "刪除後列表不應再包含該訊息",
  );
  assert.ok(
    json.messages.some((m: any) => m.id === keep.json.id),
    "其他訊息不應受影響",
  );
});

test("刪除不存在的大廳訊息回 404", async () => {
  await clearMessages();
  const del = await deleteLobby(2_000_000_000, {
    authorization: `Bearer ${ADMIN_TOKEN}`,
  });
  assert.equal(del.status, 404, "找不到的訊息應回 404");
  assert.ok(String(del.json?.error ?? "").length > 0, "應帶繁體中文錯誤訊息");
});

test("無效訊息 id 回 400", async () => {
  for (const bad of ["abc", "0", "-3", "1.5"]) {
    const res = await fetch(
      `${baseUrl}/api/diplomacy/lobby/messages/${bad}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    assert.equal(res.status, 400, `id=${bad} 應回 400`);
  }
});
