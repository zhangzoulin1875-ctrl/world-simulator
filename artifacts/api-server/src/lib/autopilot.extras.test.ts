import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  politicsPendingIdeasTable,
  politicsPendingDecisionsTable,
  superEventsTable,
  superEventResponsesTable,
  type PlayerNation,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations, runRegionControlMigrations } from "./gameMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runPoliticsMigrations } from "./politicsMigrations";
import { runSuperEventMigrations } from "./superEventMigrations";
import { runAutopilotMigrations } from "./autopilotMigrations";
import {
  normalizeExtrasPlan,
  runAutopilotExtras,
  loadRespondableEvents,
} from "./autopilotExtras";

/**
 * AI 託管「政治與事件層」測試（真實 DB，AI 以樁固定輸出）。
 *
 * 驗證：純函式正規化（白名單／去重／截斷）、寫入與手動提交相同的待判定表、
 * 護欄（已有待判定不覆寫、政變封鎖不提交想法與決策但仍可應對事件、
 * 已結束／已應對事件不再應對、捏造的 eventId 被丟棄）、AI 非 JSON 時不寫入。
 */

const TEST_TAG = "autopilot-extras-test";
const TEST_USER_ID = `${TEST_TAG}-user-${process.pid}`;

type MessagesCreate = typeof anthropic.messages.create;
let aiText = "{}";
function installStub(): void {
  anthropic.messages.create = (async () => ({
    content: [{ type: "text", text: aiText }],
  })) as unknown as MessagesCreate;
}
function setAi(obj: unknown): void {
  aiText = JSON.stringify(obj);
}

let nationId = "";
let eventIds: string[] = [];

async function reloadNation(): Promise<PlayerNation> {
  const [row] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "測試國家不存在");
  return row;
}

async function makeEvent(title: string, status = "active"): Promise<string> {
  const [e] = await db
    .insert(superEventsTable)
    .values({ title: `${TEST_TAG}-${title}`, summary: "測試事件", scope: "global", status })
    .returning({ id: superEventsTable.id });
  eventIds.push(e!.id);
  return e!.id;
}

async function wipe(): Promise<void> {
  await db.delete(politicsPendingIdeasTable).where(eq(politicsPendingIdeasTable.nationId, nationId));
  await db.delete(politicsPendingDecisionsTable).where(eq(politicsPendingDecisionsTable.nationId, nationId));
  await db.delete(superEventResponsesTable).where(eq(superEventResponsesTable.nationId, nationId));
  for (const id of eventIds) await db.delete(superEventsTable).where(eq(superEventsTable.id, id));
  eventIds = [];
  await db.update(playerNationsTable).set({ coupPolicyLockTurns: 0 }).where(eq(playerNationsTable.id, nationId));
}

async function purgeAll(): Promise<void> {
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.discordUserId, `${TEST_TAG}-user%`));
  for (const n of nations) {
    await db.delete(regionControlsTable).where(eq(regionControlsTable.nationId, n.id));
  }
  await db.delete(playerNationsTable).where(like(playerNationsTable.discordUserId, `${TEST_TAG}-user%`));
  await db.delete(superEventsTable).where(like(superEventsTable.title, `${TEST_TAG}-%`));
}

before(async () => {
  await runGameMigrations();
  await runMapRegionSync();
  await runRegionControlMigrations();
  await runPoliticsMigrations();
  await runSuperEventMigrations();
  await runAutopilotMigrations();
  installStub();
  await purgeAll();
  const [nation] = await db
    .insert(playerNationsTable)
    .values({ name: `${TEST_TAG}-國`, leaderName: TEST_TAG, discordUserId: TEST_USER_ID })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation);
  nationId = nation.id;
  // 全球事件只要求「掌控任一地區」即算受影響。
  const [region] = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable).limit(1);
  assert.ok(region, "找不到種入的地區");
  await db.insert(regionControlsTable).values({ nationId, regionId: region.id, percent: 100 }).onConflictDoNothing();
});

after(async () => {
  await wipe();
  await purgeAll();
  await pool.end();
});

const LIMITS = { idea: 50, decision: 50, response: 20 };

test("normalizeExtrasPlan：白名單事件、去重、依上限截斷、空字串視為 null", () => {
  const plan = normalizeExtrasPlan(
    {
      policyIdea: "  " + "想".repeat(80) + "  ",
      governmentDecision: "   ",
      eventResponses: [
        { eventId: "e1", text: "應".repeat(40) },
        { eventId: "e1", text: "重複的" },
        { eventId: "not-allowed", text: "越權" },
      ],
    },
    new Set(["e1", "e2"]),
    LIMITS,
  );
  assert.equal(plan.policyIdea!.length, 50);
  assert.equal(plan.governmentDecision, null);
  assert.deepEqual(plan.eventResponses.map((r) => r.eventId), ["e1"]);
  assert.equal(plan.eventResponses[0]!.text.length, 20);
});

test("normalizeExtrasPlan：欄位缺漏或型別錯誤時退化為空計畫，不丟錯", () => {
  const plan = normalizeExtrasPlan({ policyIdea: 123, eventResponses: "oops" }, new Set(), LIMITS);
  assert.equal(plan.policyIdea, null);
  assert.deepEqual(plan.eventResponses, []);
});

test("寫入：政策想法、政府決策、事件應對都寫進與手動提交相同的待判定表", async () => {
  await wipe();
  const ev = await makeEvent("瘟疫");
  setAi({ policyIdea: "興修水利", governmentDecision: "減稅安民", eventResponses: [{ eventId: ev, text: "設置隔離所" }] });
  const r = await runAutopilotExtras(await reloadNation(), "balanced", "", "classical");
  assert.equal(r.idea, true);
  assert.equal(r.decision, true);
  assert.equal(r.events, 1);
  const ideas = await db.select().from(politicsPendingIdeasTable).where(eq(politicsPendingIdeasTable.nationId, nationId));
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0]!.idea, "興修水利");
  assert.equal(ideas[0]!.direction, "general");
  const decisions = await db.select().from(politicsPendingDecisionsTable).where(eq(politicsPendingDecisionsTable.nationId, nationId));
  assert.equal(decisions[0]!.decision, "減稅安民");
  const resp = await db.select().from(superEventResponsesTable).where(eq(superEventResponsesTable.nationId, nationId));
  assert.equal(resp.length, 1);
  assert.equal(resp[0]!.status, "pending");
  assert.equal(resp[0]!.discordUserId, TEST_USER_ID);
  await wipe();
});

test("護欄：已有待判定想法／決策時不覆寫玩家原有內容", async () => {
  await wipe();
  await db.insert(politicsPendingIdeasTable).values({ nationId, direction: "general", idea: "玩家原有想法" });
  await db.insert(politicsPendingDecisionsTable).values({ nationId, decision: "玩家原有決策" });
  setAi({ policyIdea: "AI 想法", governmentDecision: "AI 決策", eventResponses: [] });
  const r = await runAutopilotExtras(await reloadNation(), "balanced", "", "classical");
  assert.equal(r.idea, false);
  assert.equal(r.decision, false);
  const ideas = await db.select().from(politicsPendingIdeasTable).where(eq(politicsPendingIdeasTable.nationId, nationId));
  assert.equal(ideas[0]!.idea, "玩家原有想法");
  await wipe();
});

test("護欄：政變封鎖期間不提交想法／決策，但仍可應對事件", async () => {
  await wipe();
  await db.update(playerNationsTable).set({ coupPolicyLockTurns: 3 }).where(eq(playerNationsTable.id, nationId));
  const ev = await makeEvent("饑荒");
  setAi({ policyIdea: "不該提交", governmentDecision: "不該提交", eventResponses: [{ eventId: ev, text: "開倉賑災" }] });
  const r = await runAutopilotExtras(await reloadNation(), "steady", "", "classical");
  assert.equal(r.idea, false);
  assert.equal(r.decision, false);
  assert.equal(r.events, 1);
  const ideas = await db.select().from(politicsPendingIdeasTable).where(eq(politicsPendingIdeasTable.nationId, nationId));
  assert.equal(ideas.length, 0);
  await wipe();
});

test("事件篩選：已結束、已應對的事件不再應對；捏造的 eventId 被丟棄", async () => {
  await wipe();
  const live = await makeEvent("進行中");
  const ended = await makeEvent("已結束", "ended");
  const done = await makeEvent("已應對");
  await db.insert(superEventResponsesTable).values({ eventId: done, nationId, discordUserId: TEST_USER_ID, responseText: "先前應對", status: "pending" });
  const respondable = (await loadRespondableEvents(await reloadNation())).map((e) => e.id);
  assert.ok(respondable.includes(live));
  assert.ok(!respondable.includes(ended), "已結束事件不應出現");
  assert.ok(!respondable.includes(done), "已應對事件不應出現");

  setAi({ policyIdea: null, governmentDecision: null, eventResponses: [{ eventId: live, text: "處理" }, { eventId: "fabricated-id", text: "捏造" }, { eventId: ended, text: "對已結束事件" }] });
  const r = await runAutopilotExtras(await reloadNation(), "balanced", "", "classical");
  assert.equal(r.events, 1, "只有進行中且在清單內的事件被應對");
  const resp = await db.select().from(superEventResponsesTable).where(eq(superEventResponsesTable.nationId, nationId));
  assert.ok(!resp.some((x) => x.eventId === ended));
  assert.equal(resp.find((x) => x.eventId === done)!.responseText, "先前應對", "舊應對不被覆寫");
  await wipe();
});

test("AI 回傳非 JSON：拋出錯誤且不寫入任何東西", async () => {
  await wipe();
  aiText = "這不是 JSON";
  const n = await reloadNation();
  await assert.rejects(() => runAutopilotExtras(n, "balanced", "", "classical"));
  const ideas = await db.select().from(politicsPendingIdeasTable).where(eq(politicsPendingIdeasTable.nationId, nationId));
  assert.equal(ideas.length, 0);
});

