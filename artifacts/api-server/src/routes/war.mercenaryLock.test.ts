/**
 * 傭兵合約期間的軍團鎖定(真實 DB):
 *  1. 簽約中 PUT /api/war/campaigns/:id/legions 回 409,訊息說明由傭兵團代管。
 *  2. 詳情 GET 帶 mercenaryLocked = true,且傭兵欄位的 myLegions[].mercenary 有值。
 *  3. 解約後 mercenaryLocked = false,PUT 不再被合約擋下。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the mercenary lock tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, inArray, sql } = await import("drizzle-orm");
const {
  db, pool, playerNationsTable, diplomacyWarsTable, warCampaignsTable,
  warCampaignLegionsTable, mapRegionsTable, mercenaryStatesTable, mercenaryDeploymentsTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const svc = await import("../lib/mercenaryService");
const warRouter = (await import("./war")).default;

const TAG = "__mlocktest__";
const runId = randomBytes(4).toString("hex");
const userB = `mlocktest-${runId}-b`;
let nA = "", nB = "", cid = 0, warId = 0;
let server: http.Server;
let baseUrl = "";
let token = "";

async function mkNation(name: string, userId: string): Promise<string> {
  const [r] = await db.insert(playerNationsTable)
    .values({ name: TAG + name + runId, discordUserId: userId } as never)
    .returning({ id: playerNationsTable.id });
  return r!.id;
}

before(async () => {
  nA = await mkNation("a", `mlocktest-${runId}-a`);
  nB = await mkNation("b", userB);
  // 規則:有進行中戰役不能解除武裝,所以先解除武裝並簽約,再建戰役。
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const regs = (await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable).limit(2)).map((r) => r.id);
  assert.ok(regs.length >= 2);
  const [w] = await db.insert(diplomacyWarsTable).values({
    nationAId: nA < nB ? nA : nB, nationBId: nA < nB ? nB : nA, declaredByNationId: nA,
  }).returning({ id: diplomacyWarsTable.id });
  warId = w!.id;
  const [c] = await db.insert(warCampaignsTable).values({
    warId, attackerNationId: nA, defenderNationId: nB,
    attackerRegionId: regs[0]!, defenderRegionId: regs[1]!,
    nextResolveAt: new Date(Date.now() + 3_600_000),
  } as never).returning({ id: warCampaignsTable.id });
  cid = c!.id;

  await svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "B", mode: "defend" });

  token = await createSession({
    discordUserId: userB, username: userB, globalName: null, avatar: null, manageableGuildIds: [],
  });
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", warRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.delete(mercenaryDeploymentsTable).where(inArray(mercenaryDeploymentsTable.nationId, [nA, nB]));
  await db.delete(mercenaryStatesTable).where(inArray(mercenaryStatesTable.nationId, [nA, nB]));
  await db.delete(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid));
  await db.delete(warCampaignsTable).where(eq(warCampaignsTable.id, cid));
  await db.delete(diplomacyWarsTable).where(eq(diplomacyWarsTable.id, warId));
  await db.delete(playerNationsTable).where(sql`${playerNationsTable.name} LIKE ${TAG + "%"}`);
  await pool.end();
});

const headers = () => ({ "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}` });

test("簽約中:儲存軍團被 409 擋下,詳情標記 mercenaryLocked 與傭兵軍團", async () => {
  const put = await fetch(`${baseUrl}/api/war/campaigns/${cid}/legions`, {
    method: "PUT", headers: headers(),
    body: JSON.stringify({ legions: [{ slot: "A", garrisoningCity: false, units: [] }] }),
  });
  assert.equal(put.status, 409);
  const body = (await put.json()) as { error: string };
  assert.match(body.error, /傭兵/);

  // 傭兵的軍團列沒有被這次請求蓋掉
  const legs = await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid));
  assert.equal(legs.filter((l) => l.nationId === nB && l.slot === "B").length, 1);

  const get = await fetch(`${baseUrl}/api/war/campaigns/${cid}`, { headers: headers() });
  assert.equal(get.status, 200);
  const detail = (await get.json()) as {
    mercenaryLocked: boolean;
    myLegions: { slot: string; mercenary: { companyName: string; troops: number } | null }[];
  };
  assert.equal(detail.mercenaryLocked, true);
  const b = detail.myLegions.find((l) => l.slot === "B");
  assert.ok(b?.mercenary, "B 欄位應標為傭兵");
  assert.ok(b!.mercenary!.troops > 0);
});

test("解約後:mercenaryLocked = false,儲存不再被合約擋下", async () => {
  await svc.terminateContract(nB);
  const get = await fetch(`${baseUrl}/api/war/campaigns/${cid}`, { headers: headers() });
  const detail = (await get.json()) as { mercenaryLocked: boolean };
  assert.equal(detail.mercenaryLocked, false);

  const put = await fetch(`${baseUrl}/api/war/campaigns/${cid}/legions`, {
    method: "PUT", headers: headers(),
    body: JSON.stringify({ legions: [] }),
  });
  const body = (await put.json().catch(() => ({}))) as { error?: string };
  assert.ok(!/傭兵合約/.test(body.error ?? ""), `不應再因合約被擋: ${put.status} ${body.error}`);
});
