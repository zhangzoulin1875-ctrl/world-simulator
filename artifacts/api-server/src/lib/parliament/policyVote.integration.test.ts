import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import {
  db, pool, playerNationsTable, playerNotificationsTable, politicsEntriesTable,
  politicsPendingIdeasTable, parliamentPartiesTable, parliamentStateTable, aiAbuseRecordsTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations } from "../gameMigrations";
import { runPoliticsMigrations } from "../politicsMigrations";
import { judgeIdea } from "../politicsSettlement";
import { getPoliticsSettings } from "../politicsSettings";
import { emptyPoliticsDigest } from "../politicsDm";
import { ERAS } from "../mapRegionEras";
import { loadPendingVeto, decideVeto, expireStaleVetoes } from "./vetoDecision";

/**
 * 議會政策表決 — 真資料庫整合測試。
 * 席次直接寫入資料表以精準控制票數:福利派 40、節流派 35、宗教派 25。
 */
const TAG = "__pvote_test__";
const ERA = ERAS[0]!.slug;
type MC = typeof anthropic.messages.create;
const realCreate: MC = anthropic.messages.create.bind(anthropic.messages);

const outcome = (title: string, v: number) => ({
  title, description: `${title}的描述`, durationTurns: null,
  modifiers: [{ target: "stability", value: v }],
});

function stubJudgement(extra: Record<string, unknown> = {}) {
  const payload = {
    fitScore: 80, resultType: "policy",
    success: outcome("全民醫療", 3), failure: outcome("醫療改革受挫", -2),
    abuseReason: null, ...extra,
  };
  anthropic.messages.create = (async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })) as unknown as MC;
}

async function mkNation(suffix: string, government: string) {
  const [row] = await db.insert(playerNationsTable).values({
    name: `${TAG}${suffix}`, leaderName: TAG, government, discordUserId: `${TAG}${suffix}`,
    isNpc: false, money: 10_000, stability: 50, unrest: 10, politicalSupport: 50,
  }).returning();
  return row!;
}

async function seedParliament(nationId: string, satisfaction = 60) {
  await db.insert(parliamentStateTable).values({ nationId, satisfaction }).onConflictDoNothing();
  await db.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  await db.insert(parliamentPartiesTable).values([
    { nationId, name: "民生黨", stance: "welfare", weight: 40, seats: 40, color: "#e11d48", isRuling: true },
    { nationId, name: "節流黨", stance: "fiscal_hawk", weight: 35, seats: 35, color: "#2563eb" },
    { nationId, name: "信仰黨", stance: "religious", weight: 25, seats: 25, color: "#16a34a" },
  ]);
}

async function submit(nationId: string, text: string) {
  const [i] = await db.insert(politicsPendingIdeasTable)
    .values({ nationId, direction: "general", idea: `${TAG}${text}` }).returning();
  return i!;
}

async function run(nationId: string, ideaId: number) {
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  const [idea] = await db.select().from(politicsPendingIdeasTable).where(eq(politicsPendingIdeasTable.id, ideaId));
  const settings = await getPoliticsSettings();
  return judgeIdea(nation!, idea!, settings, ERA, emptyPoliticsDigest(null), "", ["law", "culture", "religion", "rights"]);
}

const entries = (id: string) => db.select().from(politicsEntriesTable).where(eq(politicsEntriesTable.nationId, id));
const sat = async (id: string) => (await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, id)))[0]!.satisfaction;
const pending = (id: string) => db.select().from(politicsPendingIdeasTable).where(eq(politicsPendingIdeasTable.nationId, id));

async function cleanup() {
  await db.delete(playerNationsTable).where(sql`${playerNationsTable.name} LIKE ${TAG + "%"}`);
  await db.delete(playerNotificationsTable).where(sql`${playerNotificationsTable.discordUserId} LIKE ${TAG + "%"}`);
  await db.delete(aiAbuseRecordsTable).where(sql`${aiAbuseRecordsTable.inputText} LIKE ${TAG + "%"}`);
}

before(async () => { await runGameMigrations(); await runPoliticsMigrations(); await cleanup(); });
afterEach(() => { anthropic.messages.create = realCreate; });
after(async () => { anthropic.messages.create = realCreate; await cleanup(); await pool.end(); });

const FOR_WELFARE = [{ stance: "welfare", direction: 1 }, { stance: "fiscal_hawk", direction: -1 }]; // 贊成 40 vs 反對 35 → 通過,宗教棄權
const AGAINST_WELFARE = [{ stance: "fiscal_hawk", direction: 1 }]; // 贊成 35;福利派(對立)反對 40 → 否決

test("民主:議會通過 → 成功版生效,想法刪除,議會滿意度不變", async () => {
  const n = await mkNation("-pass", "議會共和制"); await seedParliament(n.id, 60);
  const idea = await submit(n.id, "通過案");
  stubJudgement({ tags: FOR_WELFARE });
  assert.equal(await run(n.id, idea.id), true);
  const e = await entries(n.id);
  assert.equal(e.length, 1); assert.equal(e[0]!.title, "全民醫療");
  assert.equal((await pending(n.id)).length, 0);
  assert.equal(await sat(n.id), 60);
});

test("民主:議會否決 → 不立即生效,暫存等待玩家決定,可看到票數", async () => {
  const n = await mkNation("-veto", "議會共和制"); await seedParliament(n.id);
  const idea = await submit(n.id, "否決案");
  stubJudgement({ tags: AGAINST_WELFARE });
  assert.equal(await run(n.id, idea.id), true);
  assert.equal((await entries(n.id)).length, 0, "否決時不得生效任何條目");
  const rows = await pending(n.id);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.voteState, "vetoed");
  const v = await loadPendingVeto(n.id);
  assert.ok(v); assert.equal(v!.seatsFor, 35); assert.equal(v!.seatsAgainst, 40); assert.equal(v!.seatsAbstain, 25);
  assert.equal(v!.successTitle, "全民醫療"); assert.equal(v!.failureTitle, "醫療改革受挫");
  assert.ok(v!.overridePenalty >= 6 && v!.overridePenalty <= 20);
});

test("強行通過:成功版生效、扣議會滿意度(夾在 0–100)、想法清除", async () => {
  const n = await mkNation("-override", "議會共和制"); await seedParliament(n.id, 60);
  const idea = await submit(n.id, "強推案");
  stubJudgement({ tags: AGAINST_WELFARE });
  await run(n.id, idea.id);
  const v = await loadPendingVeto(n.id);
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, n.id));
  const r = await decideVeto(nation!, "override");
  assert.equal(r.ok, true);
  const e = await entries(n.id);
  assert.equal(e.length, 1); assert.equal(e[0]!.title, "全民醫療");
  assert.equal(await sat(n.id), 60 - v!.overridePenalty);
  assert.equal((await pending(n.id)).length, 0);
});

test("接受否決:失敗版生效,議會滿意度不變", async () => {
  const n = await mkNation("-accept", "議會共和制"); await seedParliament(n.id, 60);
  const idea = await submit(n.id, "接受案");
  stubJudgement({ tags: AGAINST_WELFARE });
  await run(n.id, idea.id);
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, n.id));
  assert.equal((await decideVeto(nation!, "accept")).ok, true);
  const e = await entries(n.id);
  assert.equal(e.length, 1); assert.ok(e[0]!.title.startsWith("【失敗】"));
  assert.equal(await sat(n.id), 60);
});

test("併發雙擊強行通過:只套用一次、只扣一次滿意度", async () => {
  const n = await mkNation("-double", "議會共和制"); await seedParliament(n.id, 60);
  const idea = await submit(n.id, "雙擊案");
  stubJudgement({ tags: AGAINST_WELFARE });
  await run(n.id, idea.id);
  const v = await loadPendingVeto(n.id);
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, n.id));
  const rs = await Promise.all([decideVeto(nation!, "override"), decideVeto(nation!, "override"), decideVeto(nation!, "override")]);
  assert.equal(rs.filter((r) => r.ok).length, 1, "只有一個請求成功");
  assert.equal((await entries(n.id)).length, 1);
  assert.equal(await sat(n.id), 60 - v!.overridePenalty, "只扣一次");
});

test("沒有待決政策時決定 → 404,不動任何東西", async () => {
  const n = await mkNation("-none", "議會共和制"); await seedParliament(n.id, 60);
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, n.id));
  const r = await decideVeto(nation!, "override");
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.status, 404);
  assert.equal(await sat(n.id), 60);
});

test("玩家整回合沒決定:逾期視同接受否決(失敗版),不扣議會滿意度", async () => {
  const n = await mkNation("-stale", "議會共和制"); await seedParliament(n.id, 60);
  const idea = await submit(n.id, "逾期案");
  stubJudgement({ tags: AGAINST_WELFARE });
  await run(n.id, idea.id);
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, n.id));
  assert.equal(await expireStaleVetoes(nation!), 1);
  const e = await entries(n.id);
  assert.equal(e.length, 1); assert.ok(e[0]!.title.startsWith("【失敗】"));
  assert.equal((await pending(n.id)).length, 0);
  assert.equal(await sat(n.id), 60);
});

test("舊預產格式(沒有 tags 欄位):各黨棄權 → 視為通過,不失敗不卡住", async () => {
  const n = await mkNation("-notags", "議會共和制"); await seedParliament(n.id);
  const idea = await submit(n.id, "無標籤案");
  stubJudgement(); // 不帶 tags
  assert.equal(await run(n.id, idea.id), true);
  assert.equal((await entries(n.id))[0]!.title, "全民醫療");
});

test("專制(君主專制)不表決:仍走舊骰子,結果必為成功版或失敗版其一,且不會暫存否決", async () => {
  const n = await mkNation("-autocracy", "君主專制");
  await db.insert(parliamentStateTable).values({ nationId: n.id, satisfaction: 60 }).onConflictDoNothing();
  const idea = await submit(n.id, "專制案");
  stubJudgement({ tags: AGAINST_WELFARE });
  assert.equal(await run(n.id, idea.id), true);
  assert.equal((await entries(n.id)).length, 1);
  assert.equal((await pending(n.id)).length, 0);
  assert.equal(await loadPendingVeto(n.id), null);
});

test("濫用旗標:不給議會表決機會,直接走失敗版", async () => {
  const n = await mkNation("-abuse", "議會共和制"); await seedParliament(n.id);
  const idea = await submit(n.id, "濫用案");
  stubJudgement({ tags: FOR_WELFARE, abuseReason: "試圖操縱數值" });
  assert.equal(await run(n.id, idea.id), true);
  const e = await entries(n.id);
  assert.equal(e.length, 1); assert.ok(e[0]!.title.startsWith("【失敗】"));
  assert.equal(await loadPendingVeto(n.id), null);
});

test("格式錯誤的 tags(未知立場)被丟棄為空 → 棄權通過,不讓整筆判定失敗", async () => {
  const n = await mkNation("-badtags", "議會共和制"); await seedParliament(n.id);
  const idea = await submit(n.id, "壞標籤案");
  stubJudgement({ tags: [{ stance: "loyalist", direction: 1 }, { stance: "nonsense", direction: 9 }] });
  assert.equal(await run(n.id, idea.id), true);
  assert.equal((await entries(n.id)).length, 1);
});
