import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  parliamentStateTable,
  parliamentPartiesTable,
  domesticEventsTable,
} from "@workspace/db";
import { runGameMigrations } from "../gameMigrations";
import { runParliamentMigrations } from "../parliamentMigrations";
import { runDomesticEventMigrations } from "./migrations";
import { governmentLabel } from "../governments";
import { createEvent, getPendingEvent, resolveEvent, runDomesticEventSettlement, listCooldownHistory } from "./service";
import { getEventDef, EVENT_DEADLINE_TURNS, EVENT_REPEAT_COOLDOWN_TURNS, DOMESTIC_EVENTS } from "./core";
import { SOCIALIST_PARTY_NAME } from "./parliamentShift";
import { setEventTextQueuerForTest, rewriteEventText } from "./text";

const TAG = "devent-test";
let nationId = "";

const load = async () => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)))[0]!;
const setTick = (tick: number) =>
  db.insert(parliamentStateTable).values({ nationId, satisfaction: 60, tick })
    .onConflictDoUpdate({ target: parliamentStateTable.nationId, set: { tick, satisfaction: 60 } });
const sat = async () => (await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId)))[0]!.satisfaction;
const parties = () => db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
const seedParties = async (rows: { name: string; stance: string; seats: number }[]) => {
  await db.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  await db.insert(parliamentPartiesTable).values(rows.map((r, i) => ({ nationId, name: r.name, stance: r.stance, weight: r.seats, seats: r.seats, color: "#888888", isRuling: i === 0 })));
};
const events = () => db.select().from(domesticEventsTable).where(eq(domesticEventsTable.nationId, nationId));
const setGov = (slug: string) => db.update(playerNationsTable).set({ government: governmentLabel(slug)! }).where(eq(playerNationsTable.id, nationId));
const open = async (kind: string, tick = 2) => (await createEvent(nationId, getEventDef(kind)!, tick))!;

before(async () => {
  (await import("../penaltyScaleLoad")).setPenaltyScaleForTest(1); // 固定倍率 1:這個檔案測的是流程,不是縮放
  setEventTextQueuerForTest(() => {}); // 測試不打真的 AI
  await runGameMigrations();
  await runParliamentMigrations();
  await runDomesticEventMigrations();
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  const [n] = await db
    .insert(playerNationsTable)
    .values({ name: `${TAG}-nation`, leaderName: TAG, discordUserId: `${TAG}-u`, government: governmentLabel("parliamentary")! })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
});

after(async () => {
  setEventTextQueuerForTest(null);
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  await pool.end();
});

beforeEach(async () => {
  await db.delete(domesticEventsTable).where(eq(domesticEventsTable.nationId, nationId));
  await db.update(playerNationsTable)
    .set({ stability: 50, money: 10_000, politicalSupport: 50, satisfactionMilitary: 50, government: governmentLabel("parliamentary")!, isNpc: false })
    .where(eq(playerNationsTable.id, nationId));
  await setTick(1);
  await seedParties([
    { name: "軍人黨", stance: "militarist", seats: 40 },
    { name: "和平黨", stance: "pacifist", seats: 35 },
    { name: "財政黨", stance: "fiscal_hawk", seats: 25 },
  ]);
});

test("同一國同時只能有一個待處理事件(資料庫唯一索引)", async () => {
  const a = await open("recall_wave");
  assert.ok(a);
  const b = await createEvent(nationId, getEventDef("economic_crisis")!, 2);
  assert.equal(b, null, "第二個應被擋下");
  assert.equal((await events()).filter((e) => e.status === "pending").length, 1);
});

test("順應(罷免潮):套用固定效果、事件變 resolved、議會日誌留下紀錄", async () => {
  const ev = await open("recall_wave");
  const r = await resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 });
  assert.equal(r.ok, true);
  const n = await load();
  assert.equal(n.stability, 58);
  assert.equal(n.satisfactionMilitary, 45);
  assert.equal(await sat(), 70);
  const [row] = await events();
  assert.equal(row!.status, "resolved");
  assert.equal(row!.chosenId, "comply");
  assert.ok(row!.outcome && row!.outcome.length > 0);
  assert.equal(await getPendingEvent(nationId), null);
});

test("重複送出同一個事件:第二次被擋,效果只套用一次(包含雙擊/同時請求)", async () => {
  const ev = await open("economic_crisis");
  const [r1, r2] = await Promise.all([
    resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 }),
    resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 }),
  ]);
  assert.equal([r1, r2].filter((r) => r.ok).length, 1, "只有一個成功");
  const n = await load();
  assert.equal(n.money, 10_000 - 2500, "國庫只扣一次");
  assert.equal(n.stability, 58, "穩定只加一次");
});

test("不存在的選項、別人的事件:被拒絕且不改任何數值", async () => {
  const ev = await open("recall_wave");
  const bad = await resolveEvent(await load(), ev.id, "nope");
  assert.equal(bad.ok, false);
  const other = await resolveEvent(await load(), "00000000-0000-0000-0000-000000000000", "comply");
  assert.equal(other.ok, false);
  const n = await load();
  assert.equal(n.stability, 50);
  assert.equal((await events())[0]!.status, "pending", "選項錯誤不會消耗事件");
});

test("社會黨多數 + 順應:議會出現社會黨並過半、成為執政黨、席次總和 100、議會滿意度 +15", async () => {
  const ev = await open("socialist_majority");
  const r = await resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 });
  assert.equal(r.ok, true);
  const ps = await parties();
  assert.equal(ps.reduce((s, p) => s + p.seats, 0), 100);
  const soc = ps.find((p) => p.name === SOCIALIST_PARTY_NAME)!;
  assert.ok(soc && soc.seats > 50 && soc.isRuling);
  assert.equal(ps.filter((p) => p.isRuling).length, 1);
  assert.equal(await sat(), 75);
  assert.equal((await load()).money, 10_000 - 1500);
});

test("君主制也會發生:橡皮圖章議會被插入社會黨並取得多數", async () => {
  await setGov("absolute_monarchy");
  await seedParties([{ name: "王黨", stance: "loyalist", seats: 100 }]);
  const ev = await open("socialist_majority");
  const r = await resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 });
  assert.equal(r.ok, true);
  const ps = await parties();
  assert.equal(ps.reduce((s, p) => s + p.seats, 0), 100);
  assert.ok(ps.find((p) => p.name === SOCIALIST_PARTY_NAME)!.seats > 50);
  assert.ok(ps.some((p) => p.stance === "loyalist"), "效忠黨仍在");
  assert.equal(await sat(), 60, "君主制的議會滿意度固定,不受事件影響");
});

test("鎮壓(戒嚴趕走社會黨):社會黨被逐出議會、穩定大降、軍方上升(擲骰不中時無內戰)", async () => {
  await resolveEvent(await load(), (await open("socialist_majority")).id, "comply", { rand: () => 0.99 });
  assert.ok((await parties()).some((p) => p.name === SOCIALIST_PARTY_NAME));
  const ev2 = await open("socialist_majority", 4);
  await db.update(playerNationsTable).set({ stability: 60 }).where(eq(playerNationsTable.id, nationId));
  const r = await resolveEvent(await load(), ev2.id, "crackdown", { rand: () => 0.99 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.civilWar, false);
  const ps = await parties();
  assert.ok(ps.every((p) => p.stance !== "welfare"), "福利派已被逐出");
  assert.equal(ps.reduce((s, p) => s + p.seats, 0), 100);
  const n = await load();
  assert.equal(n.stability, 35, "穩定 60-25");
  assert.ok(n.satisfactionMilitary > 50, "軍方滿意度上升");
});

test("鎮壓後穩定度低於門檻且擲中:爆發內戰(civilWar=true);擲不中則不爆發", async () => {
  await db.update(playerNationsTable).set({ stability: 30 }).where(eq(playerNationsTable.id, nationId));
  const ev = await open("recall_wave");
  const hit = await resolveEvent(await load(), ev.id, "crackdown", { rand: () => 0.0 });
  assert.equal(hit.ok, true);
  if (hit.ok) assert.equal(hit.civilWar, true, "穩定 30-20=10 低於內戰門檻且擲中");

  await db.delete(domesticEventsTable).where(eq(domesticEventsTable.nationId, nationId));
  await db.update(playerNationsTable).set({ stability: 30, government: governmentLabel("parliamentary")! }).where(eq(playerNationsTable.id, nationId));
  await seedParties([{ name: "軍人黨", stance: "militarist", seats: 60 }, { name: "和平黨", stance: "pacifist", seats: 40 }]);
  const ev2 = await open("recall_wave", 6);
  const miss = await resolveEvent(await load(), ev2.id, "crackdown", { rand: () => 0.99 });
  assert.equal(miss.ok, true);
  if (miss.ok) assert.equal(miss.civilWar, false);
});

test("穩定度夠高的鎮壓不會引爆內戰,即使擲骰必中", async () => {
  await db.update(playerNationsTable).set({ stability: 90 }).where(eq(playerNationsTable.id, nationId));
  const ev = await open("recall_wave");
  const r = await resolveEvent(await load(), ev.id, "crackdown", { rand: () => 0.0 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.civilWar, false);
  assert.equal((await load()).stability, 70);
});

test("結算:擲骰回合 + 擲中 → 建立事件;沒擲中/非擲骰回合 → 不建立", async () => {
  await setTick(2);
  const miss = await runDomesticEventSettlement(() => 0.99);
  assert.equal(miss.created, 0);
  assert.equal((await events()).length, 0);
  await setTick(3);
  const off = await runDomesticEventSettlement(() => 0.0);
  assert.equal(off.created, 0, "奇數回合不擲");
  await setTick(2);
  const hit = await runDomesticEventSettlement(() => 0.0);
  assert.ok(hit.created >= 1);
  const pending = await getPendingEvent(nationId);
  assert.ok(pending);
  assert.equal(pending!.dueTick, 2 + EVENT_DEADLINE_TURNS);
  assert.equal(pending!.choices.length, 3);
});

test("結算:已有待處理事件時不會再擲新事件", async () => {
  await setTick(2);
  await open("recall_wave", 2);
  const r = await runDomesticEventSettlement(() => 0.0);
  assert.equal(r.created, 0);
  assert.equal((await events()).length, 1);
});

test("結算:NPC 國家不會被擲事件", async () => {
  await db.update(playerNationsTable).set({ isNpc: true }).where(eq(playerNationsTable.id, nationId));
  await setTick(2);
  const r = await runDomesticEventSettlement(() => 0.0);
  assert.equal(r.created, 0);
  assert.equal((await events()).length, 0);
});

test("結算:逾期未處理 → 自動套用預設(拖延)並標為 expired;未逾期則保留", async () => {
  const ev = await open("recall_wave", 2);
  await setTick(2 + EVENT_DEADLINE_TURNS - 1);
  const early = await runDomesticEventSettlement(() => 0.99);
  assert.equal(early.expired, 0);
  assert.equal((await getPendingEvent(nationId))!.id, ev.id);

  await setTick(2 + EVENT_DEADLINE_TURNS);
  const late = await runDomesticEventSettlement(() => 0.99);
  assert.equal(late.expired, 1);
  const [row] = await events();
  assert.equal(row!.status, "expired");
  assert.equal(row!.chosenId, "delay");
  const n = await load();
  assert.equal(n.stability, 44, "拖延:50-6");
  assert.equal(await sat(), 52, "拖延:議會 60-8");
});

test("不會連續兩次抽到同一種事件", async () => {
  await setTick(2);
  await createEvent(nationId, getEventDef("recall_wave")!, 2);
  await db.update(domesticEventsTable).set({ status: "resolved" }).where(eq(domesticEventsTable.nationId, nationId));
  await setTick(4);
  for (let i = 0; i < 15; i++) {
    await db.delete(domesticEventsTable).where(eq(domesticEventsTable.status, "pending"));
    await runDomesticEventSettlement(() => 0.0);
    const p = await getPendingEvent(nationId);
    if (p) assert.notEqual(p.kind, "recall_wave");
  }
});

const fakeAi = (text: string) => (async () => ({ content: [{ type: "text", text }] })) as any;
const goodJson = JSON.stringify({
  title: "議會易主",
  body: "補選之後,社會黨人掌握議會,要求政府推動他們的主張。",
  choices: [
    { id: "comply", label: "順應議會意志", hint: "議會滿意,國庫吃緊" },
    { id: "crackdown", label: "戒嚴並驅逐議員", hint: "軍方支持,社會動盪" },
    { id: "delay", label: "部分採納", hint: "各方只滿意一半" },
  ],
});

test("AI 改寫成功:標題、敘述、選項文字被換掉,選項 id 不變;只改寫一次", async () => {
  const ev = await open("socialist_majority");
  assert.equal(await rewriteEventText(ev.id, fakeAi(goodJson)), "ai");
  const p = (await getPendingEvent(nationId))!;
  assert.equal(p.title, "議會易主");
  assert.deepEqual(p.choices.map((c) => c.id), ["comply", "crackdown", "delay"]);
  assert.equal(await rewriteEventText(ev.id, fakeAi(goodJson)), "skipped", "不會重複改寫");
});

test("AI 失敗或輸出不合格:保留模板文字,事件照常可處理", async () => {
  const ev = await open("recall_wave");
  const original = ev.title;
  const boom = (async () => { throw new Error("nim down"); }) as any;
  assert.equal(await rewriteEventText(ev.id, boom), "template");
  assert.equal((await getPendingEvent(nationId))!.title, original);
  const r = await resolveEvent(await load(), ev.id, "delay", { rand: () => 0.99 });
  assert.equal(r.ok, true);
});

test("AI 亂寫數字或改選項 id:整份丟棄,保留模板", async () => {
  const ev = await open("recall_wave");
  const bad = JSON.stringify({ title: "罷免潮", body: "穩定度 -30。", choices: [{ id: "comply", label: "a", hint: "b" }, { id: "crackdown", label: "a", hint: "b" }, { id: "delay", label: "a", hint: "b" }] });
  assert.equal(await rewriteEventText(ev.id, fakeAi(bad)), "template");
  assert.equal((await getPendingEvent(nationId))!.title, ev.title);
});

test("AI 回來前玩家已處理事件:不會覆蓋已結案的事件文字", async () => {
  const ev = await open("economic_crisis");
  let release: (v: any) => void = () => {};
  const slow = (() => new Promise((r) => { release = r; })) as any;
  const pending = rewriteEventText(ev.id, slow);
  await new Promise((r) => setTimeout(r, 30));
  await resolveEvent(await load(), ev.id, "delay", { rand: () => 0.99 });
  release({ content: [{ type: "text", text: goodJson.replace("議會易主", "不該出現") }] });
  await pending;
  const [row] = await events();
  assert.equal(row!.status, "resolved");
  assert.notEqual(row!.title, "不該出現");
});

test("就算 AI 改寫了文字,選項的實際效果仍以程式目錄為準(AI 無法改動結果)", async () => {
  const ev = await open("socialist_majority");
  await rewriteEventText(ev.id, fakeAi(goodJson.replace("順應議會意志", "免費午餐,全部加滿")));
  await resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 });
  const n = await load();
  assert.equal(n.money, 10_000 - 1500);
  assert.equal(n.satisfactionMilitary, 42);
});

/** 造一筆已處理完的歷史事件（直接用 createEvent 建立後標成 resolved，避免佔用 pending 唯一索引）。 */
async function pastEvent(kind: string, tick: number) {
  const ev = await open(kind, tick);
  await db.update(domesticEventsTable).set({ status: "resolved" }).where(eq(domesticEventsTable.id, ev.id));
}

test("重複冷卻：全部種類剛發生過 → 擲中也不發新事件", async () => {
  for (const [i, e] of DOMESTIC_EVENTS.entries()) await pastEvent(e.kind, 10 + i);
  await setTick(20);
  const r = await runDomesticEventSettlement(() => 0.0);
  assert.equal(r.created, 0, "每一種都在 32 回合冷卻內");
  assert.equal(await getPendingEvent(nationId), null);
});

test("重複冷卻：只剩一種冷卻結束 → 只會發那一種", async () => {
  // 其他種類都在冷卻內，獨有 recall_wave 發生在很久以前。
  const t = 100;
  for (const e of DOMESTIC_EVENTS) await pastEvent(e.kind, e.kind === "recall_wave" ? t - EVENT_REPEAT_COOLDOWN_TURNS : t - 2);
  await setTick(t);
  const r = await runDomesticEventSettlement(() => 0.0);
  assert.equal(r.created, 1);
  assert.equal((await getPendingEvent(nationId))!.kind, "recall_wave");
});

test("重複冷卻：差 30 回合仍擋，差 32 回合才放行", async () => {
  for (const e of DOMESTIC_EVENTS) await pastEvent(e.kind, 50);
  // 擲骰只在偶數 tick。50 + 30 = 80（仍在冷卻），50 + 32 = 82（剛好解禁）。
  await setTick(50 + EVENT_REPEAT_COOLDOWN_TURNS - 2);
  const tooSoon = await runDomesticEventSettlement(() => 0.0);
  assert.equal(tooSoon.created, 0, "差 30 回合還在冷卻");
  assert.equal(await getPendingEvent(nationId), null);
  await setTick(50 + EVENT_REPEAT_COOLDOWN_TURNS);
  const ok = await runDomesticEventSettlement(() => 0.0);
  assert.equal(ok.created, 1, "差 32 回合解禁");
});

test("重複冷卻：管理員手動投放不受冷卻限制", async () => {
  await pastEvent("recall_wave", 10);
  await setTick(12);
  const { sendEventToNations } = await import("./service");
  const r = await sendEventToNations("recall_wave", [nationId]);
  assert.equal(r.sent.length, 1, "管理員刻意投放照常生效");
});

test("冷卻歷史依「回合窗口」查，不是最近 N 筆：100 種事件全在冷卻內也不會漏掉任何一種", async () => {
  // 舊做法只取最近 50 筆，100 個種類時會把較早的 50 種當成「沒發生過」而重發。
  for (const [i, e] of DOMESTIC_EVENTS.entries()) await pastEvent(e.kind, 40 + (i % 8));
  const hist = await listCooldownHistory(nationId, 60);
  assert.equal(new Set(hist.map((h) => h.kind)).size, DOMESTIC_EVENTS.length, "窗口內 100 種都要查得到");
  assert.ok(hist.length >= 100);
});

test("冷卻歷史：窗口邊界——差 31 回合在內、差 32 回合已出窗口", async () => {
  await pastEvent("recall_wave", 10);
  assert.equal((await listCooldownHistory(nationId, 10 + EVENT_REPEAT_COOLDOWN_TURNS - 1)).some((h) => h.kind === "recall_wave"), true, "差 31 回合仍在冷卻");
  assert.equal((await listCooldownHistory(nationId, 10 + EVENT_REPEAT_COOLDOWN_TURNS)).some((h) => h.kind === "recall_wave"), false, "差 32 回合解禁");
});

test("冷卻歷史：只看這個國家的事件，別國的不影響", async () => {
  await pastEvent("recall_wave", 10);
  assert.equal((await listCooldownHistory("00000000-0000-0000-0000-000000000000", 12)).length, 0);
});

// ── 金錢代價依時代與國力縮放 ──────────────────────────────────────
import { setPenaltyScaleForTest } from "../penaltyScaleLoad";

test("縮放:同一事件選項,實扣金額 = 基準價 × 倍率;百分點類(穩定/政治支持)不縮放", async () => {
  setPenaltyScaleForTest(148);
  try {
    await db.update(playerNationsTable).set({ money: 5_000_000 }).where(eq(playerNationsTable.id, nationId));
    const ev = await open("economic_crisis");
    const r = await resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 });
    assert.equal(r.ok, true);
    const n = await load();
    assert.equal(n.money, 5_000_000 - 2500 * 148, "基準價 2500 × 148");
    assert.equal(n.stability, 58, "穩定度是百分點,與倍率無關");
  } finally { setPenaltyScaleForTest(1); }
});

test("縮放:倍率越大扣越多,國庫不夠時扣到 0 為止,不會變負數", async () => {
  setPenaltyScaleForTest(3030);
  try {
    await db.update(playerNationsTable).set({ money: 1_000 }).where(eq(playerNationsTable.id, nationId));
    const ev = await open("economic_crisis");
    assert.equal((await resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 })).ok, true);
    assert.equal((await load()).money, 0, "不會出現負數國庫");
  } finally { setPenaltyScaleForTest(1); }
});

test("縮放:獎勵型金錢效果也同倍率放大(代價與獎勵不失衡)", async () => {
  const gains = DOMESTIC_EVENTS.flatMap((d) => d.choices.filter((c) => (c.effects.money ?? 0) > 0).map((c) => ({ d, c })));
  if (gains.length === 0) return; // 目錄目前沒有金錢獎勵選項:略過,但保留這個守門
  const { d, c } = gains[0]!;
  setPenaltyScaleForTest(24);
  try {
    await db.update(playerNationsTable).set({ money: 100 }).where(eq(playerNationsTable.id, nationId));
    const ev = await open(d.kind);
    assert.equal((await resolveEvent(await load(), ev.id, c.id, { rand: () => 0.99 })).ok, true);
    assert.equal((await load()).money, 100 + c.effects.money! * 24);
  } finally { setPenaltyScaleForTest(1); }
});

test("縮放:AI 改寫過的事件,實扣仍以程式目錄的基準價 × 倍率為準", async () => {
  setPenaltyScaleForTest(40);
  try {
    await db.update(playerNationsTable).set({ money: 1_000_000 }).where(eq(playerNationsTable.id, nationId));
    const ev = await open("economic_crisis");
    await db.update(domesticEventsTable).set({
      choices: [{ id: "comply", label: "免費發錢", hint: "完全不用花錢" }, { id: "crackdown", label: "x", hint: "x" }, { id: "delay", label: "y", hint: "y" }] as any,
      aiRewritten: 1,
    }).where(eq(domesticEventsTable.id, ev.id));
    await resolveEvent(await load(), ev.id, "comply", { rand: () => 0.99 });
    assert.equal((await load()).money, 1_000_000 - 2500 * 40, "文字說免費也沒用,扣多少由目錄與倍率決定");
  } finally { setPenaltyScaleForTest(1); }
});
