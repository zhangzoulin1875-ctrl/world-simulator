import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, parliamentStateTable, constitutionsTable, domesticEventsTable } = await import("@workspace/db");
const { ensureParliamentTestSchema } = await import("../parliament/testSchema");
const { settleNationParliament } = await import("../parliament/service");
const { saveDraft, loadConstitution } = await import("./service");
const { submitConstitution, scanFlaws, setConstitutionAiForTest, setConstitutionRunnerForTest } = await import("./submit");
const { triggerCrisis, maybeTriggerCrisis } = await import("./crisis");
const { runDomesticEventSettlement, resolveEvent, getPendingEvent, sendEventToNations } = await import("../domesticEvents/service");
const { setEventTextQueuerForTest } = await import("../domesticEvents/text");
const { CRISIS_GRACE_TICKS, CRISIS_SPACING_TICKS } = await import("./core");

const MARK = "CriT"; const run = randomBytes(3).toString("hex"); let n = 0;
const text = (() => { const b = "第一條國家主權屬於全體人民權力來自於人民之授予議會掌握立法財政與監督之權領袖負責執行並對議會負責司法獨立不受干預軍隊效忠憲法而非個人稅賦之設立須經議會同意基本權利受到保障任何人不得任意逮捕"; let o = ""; while (o.length < 600) o += b; return o; })();

const flawsJson = JSON.stringify({ flaws: [
  { title: "軍隊指揮權不明", description: "憲法沒有規定軍隊歸誰指揮,軍方與議會各自宣稱擁有最高統帥權。" },
  { title: "修憲門檻含糊", description: "修憲需要『多數同意』卻未說明是哪一種多數,議會內吵成一團。" },
  { title: "緊急狀態無期限", description: "領袖宣布緊急狀態後沒有任何期限,反對黨指控這是變相獨裁。" },
] });
let flawReply = flawsJson, failFlaw = false, flawCalls = 0;
let pending: Promise<void>[] = [];

async function mkNation() {
  const [row] = await db.insert(playerNationsTable).values({
    discordUserId: `cr-${run}-${n}`, name: `${MARK}${run}${n++}`, leaderName: "t", government: "議會內閣制", money: 50_000,
  } as any).returning();
  await settleNationParliament(row!, null, 0);
  return row!;
}
const fresh = async (id: string) => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id)))[0]!;
const setTick = (id: string, tick: number) => db.update(parliamentStateTable).set({ tick }).where(eq(parliamentStateTable.nationId, id));
const events = (id: string) => db.select().from(domesticEventsTable).where(eq(domesticEventsTable.nationId, id));
async function ratify(id: string) {
  await saveDraft(id, text); pending = [];
  const r = await submitConstitution(id); await Promise.all(pending);
  assert.equal(r.ok, true);
  return (await loadConstitution(id))!;
}

before(async () => {
  await ensureParliamentTestSchema();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  setEventTextQueuerForTest(() => {});
  setConstitutionRunnerForTest((job) => { pending.push(job().catch(() => {})); });
  setConstitutionAiForTest(async (feature, _s, user) => {
    if (feature === "constitution.quality") return '{"score":85,"feedback":"完整","flaws":[]}';
    if (feature === "constitution.flaws") { flawCalls++; if (failFlaw) throw new Error("AI down"); return flawReply; }
    const names = [...user.matchAll(/^- (.+?)\(/gm)].map((m) => m[1]!);
    return JSON.stringify({ votes: names.map((p) => ({ party: p, vote: "yes", reason: "支持" })) });
  });
});
after(async () => {
  setConstitutionAiForTest(null); setConstitutionRunnerForTest(null); setEventTextQueuerForTest(null);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("通過後自動掃漏洞：存 3 個、id 由程式指定、都未觸發", async () => {
  const nat = await mkNation(); const row = await ratify(nat.id);
  assert.equal(row.status, "ratified");
  const fl = row.flaws as any[];
  assert.equal(fl.length, 3); assert.deepEqual(fl.map((f) => f.id), ["f1", "f2", "f3"]);
  assert.ok(fl.every((f) => f.triggered === false && f.triggeredTick === null));
});

test("掃描失敗：憲法仍然通過（不反悔）、flaws 留空；之後補掃成功", async () => {
  const nat = await mkNation();
  failFlaw = true; const row = await ratify(nat.id); failFlaw = false;
  assert.equal(row.status, "ratified", "漏洞掃描失敗不能讓已通過的憲法退回");
  assert.ok(!row.flaws || (row.flaws as any[]).length === 0);
  assert.equal(await scanFlaws(nat.id), true, "補掃成功");
  assert.equal(((await loadConstitution(nat.id))!.flaws as any[]).length, 3);
});

test("掃描冪等：已有清單不重掃（不花 AI、不覆蓋已觸發紀錄）", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  await triggerCrisis(nat.id, 20);
  const before1 = (await loadConstitution(nat.id))!.flaws;
  flawCalls = 0;
  assert.equal(await scanFlaws(nat.id), false); assert.equal(flawCalls, 0);
  assert.deepEqual((await loadConstitution(nat.id))!.flaws, before1);
});

test("掃描輸出壞格式（不足 3 個）：不寫入，憲法照樣通過", async () => {
  const nat = await mkNation();
  flawReply = JSON.stringify({ flaws: [{ title: "A", description: "x" }] });
  const row = await ratify(nat.id); flawReply = flawsJson;
  assert.equal(row.status, "ratified"); assert.ok(!row.flaws || (row.flaws as any[]).length === 0);
});

test("引爆：建立 constitutional_crisis 事件，標題/敘述=漏洞文字，標記該漏洞已觸發，不被 AI 改寫", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  const id = await triggerCrisis(nat.id, 30);
  assert.ok(id);
  const ev = (await events(nat.id)).find((e) => e.id === id)!;
  assert.equal(ev.kind, "constitutional_crisis"); assert.equal(ev.title, "軍隊指揮權不明");
  assert.ok(ev.body.includes("最高統帥權")); assert.equal(ev.aiRewritten, 1); assert.equal(ev.status, "pending");
  assert.equal(ev.choices.length, 3); assert.deepEqual(ev.choices.map((c: any) => c.id).sort(), ["comply", "crackdown", "delay"]);
  const fl = (await loadConstitution(nat.id))!.flaws as any[];
  assert.equal(fl[0].triggered, true); assert.equal(fl[0].triggeredTick, 30); assert.equal(fl[1].triggered, false);
});

test("一個漏洞只爆一次：依序引爆 f1→f2→f3，之後不再有危機", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  const titles: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = await triggerCrisis(nat.id, 10 + i * 40);
    if (id) { titles.push((await events(nat.id)).find((e) => e.id === id)!.title); await db.update(domesticEventsTable).set({ status: "resolved" }).where(eq(domesticEventsTable.id, id)); }
  }
  assert.deepEqual(titles, ["軍隊指揮權不明", "修憲門檻含糊", "緊急狀態無期限"], "第 4 次沒有漏洞可用");
});

test("該國已有待處理事件：不引爆、漏洞也不會被白白用掉", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  await sendEventToNations("recall_wave", [nat.id]);
  assert.equal(await triggerCrisis(nat.id, 40), null);
  const fl = (await loadConstitution(nat.id))!.flaws as any[];
  assert.ok(fl.every((f) => f.triggered === false), "事件建立失敗，漏洞保留");
});

test("並發引爆：兩個結算同時挑漏洞，只會成功一次、只標記一個漏洞", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  const rs = await Promise.all([triggerCrisis(nat.id, 50), triggerCrisis(nat.id, 50), triggerCrisis(nat.id, 50)]);
  assert.equal(rs.filter(Boolean).length, 1);
  assert.equal(((await loadConstitution(nat.id))!.flaws as any[]).filter((f) => f.triggered).length, 1);
  assert.equal((await events(nat.id)).filter((e) => e.kind === "constitutional_crisis").length, 1);
});

test("玩家處理危機：固定效果套用（順應→議會+8 穩定+4 國庫-800），事件變 resolved", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  await db.update(playerNationsTable).set({ stability: 50, money: 10_000 }).where(eq(playerNationsTable.id, nat.id));
  await db.update(parliamentStateTable).set({ satisfaction: 50 }).where(eq(parliamentStateTable.nationId, nat.id));
  const id = (await triggerCrisis(nat.id, 60))!;
  const r = await resolveEvent(await fresh(nat.id), id, "comply", { rand: () => 0.99 });
  assert.equal(r.ok, true);
  const after1 = await fresh(nat.id);
  assert.equal(after1.stability, 54); assert.equal(Number(after1.money), 9200);
  const st = (await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nat.id)))[0]!;
  assert.equal(st.satisfaction, 58);
  assert.equal((await events(nat.id)).find((e) => e.id === id)!.status, "resolved");
});

test("危機逾期未處理：自動套用預設（擱置）並標 expired", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  await db.update(playerNationsTable).set({ stability: 50 }).where(eq(playerNationsTable.id, nat.id));
  const id = (await triggerCrisis(nat.id, 70))!;
  await setTick(nat.id, 70 + 3);
  await runDomesticEventSettlement(() => 0.99);
  const ev = (await events(nat.id)).find((e) => e.id === id)!;
  assert.equal(ev.status, "expired"); assert.equal(ev.chosenId, "delay");
  assert.equal((await fresh(nat.id)).stability, 44);
});

test("擲骰：沒通過憲法的國家永遠不會有危機", async () => {
  const nat = await mkNation(); await saveDraft(nat.id, text);
  await setTick(nat.id, 200);
  assert.equal(await maybeTriggerCrisis(nat.id, 200, () => 0), null);
  const none = await mkNation(); assert.equal(await maybeTriggerCrisis(none.id, 200, () => 0), null);
});

test("擲骰：寬限期內不發；寬限期後擲中才發；擲不中不發", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  const ratifiedTick = (await loadConstitution(nat.id))!.ratifiedTick!;
  assert.equal(await maybeTriggerCrisis(nat.id, ratifiedTick + CRISIS_GRACE_TICKS - 1, () => 0), null, "寬限期內");
  assert.equal(await maybeTriggerCrisis(nat.id, ratifiedTick + CRISIS_GRACE_TICKS, () => 0.99), null, "擲不中");
  assert.ok(await maybeTriggerCrisis(nat.id, ratifiedTick + CRISIS_GRACE_TICKS, () => 0), "擲中");
});

test("擲骰：上次危機後 32 回合內不再發", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  const t0 = (await loadConstitution(nat.id))!.ratifiedTick! + CRISIS_GRACE_TICKS;
  const id = (await maybeTriggerCrisis(nat.id, t0, () => 0))!;
  await db.update(domesticEventsTable).set({ status: "resolved" }).where(eq(domesticEventsTable.id, id));
  assert.equal(await maybeTriggerCrisis(nat.id, t0 + CRISIS_SPACING_TICKS - 1, () => 0), null);
  assert.ok(await maybeTriggerCrisis(nat.id, t0 + CRISIS_SPACING_TICKS, () => 0));
});

test("事件結算整合：擲骰回合 + 有漏洞 → 發危機，且同一回合不再另發隨機事件", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  const t = (await loadConstitution(nat.id))!.ratifiedTick! + CRISIS_GRACE_TICKS + 2;
  const tick = t % 2 === 0 ? t : t + 1;
  await setTick(nat.id, tick);
  await runDomesticEventSettlement(() => 0);
  const evs = (await events(nat.id)).filter((e) => e.status === "pending");
  assert.equal(evs.length, 1); assert.equal(evs[0]!.kind, "constitutional_crisis");
});

test("管理員投放函式本身就拒絕憲法危機（不能只靠路由擋）", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  let threw = false;
  try { await sendEventToNations("constitutional_crisis", [nat.id]); } catch { threw = true; }
  assert.equal(threw, true, "sendEventToNations 必須對 constitutional_crisis 丟錯");
  assert.equal((await events(nat.id)).filter((e) => e.kind === "constitutional_crisis").length, 0, "不得建立任何危機事件");
});

test("連續並發（事件剛處理完就同時再來）：每個漏洞仍只會被標記一次、事件數=標記數", async () => {
  const nat = await mkNation(); await ratify(nat.id);
  let total = 0;
  for (let round = 0; round < 3; round++) {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => triggerCrisis(nat.id, 100 + round * 40)));
    const ids = rs.filter((x): x is string => !!x);
    assert.ok(ids.length <= 1, `第 ${round} 輪最多一個成功，實際 ${ids.length}`);
    total += ids.length;
    for (const id of ids) await db.update(domesticEventsTable).set({ status: "resolved" }).where(eq(domesticEventsTable.id, id));
  }
  const fl = (await loadConstitution(nat.id))!.flaws as any[];
  assert.equal(fl.filter((f) => f.triggered).length, total, "被標記的漏洞數 = 實際建立的事件數");
  assert.equal((await events(nat.id)).filter((e) => e.kind === "constitutional_crisis").length, total);
  assert.equal(new Set(fl.filter((f) => f.triggered).map((f) => f.triggeredTick)).size, total, "每個漏洞的觸發回合各不相同");
});
