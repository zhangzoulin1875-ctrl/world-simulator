import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, constitutionsTable } = await import("@workspace/db");
const { ensureParliamentTestSchema } = await import("../lib/parliament/testSchema");
const { settleNationParliament } = await import("../lib/parliament/service");
const { createSession } = await import("../lib/sessions");
const { setConstitutionAiForTest, setConstitutionRunnerForTest } = await import("../lib/constitution/submit");
const { triggerCrisis } = await import("../lib/constitution/crisis");
const { setEventTextQueuerForTest } = await import("../lib/domesticEvents/text");
const { governmentLabel } = await import("../lib/governments");
const { default: app } = await import("../app");

const MARK = "CRt"; const run = randomBytes(3).toString("hex");
let server: import("node:http").Server; let base = ""; let n = 0;
let pending: Promise<void>[] = [];
const text = (() => { const b = "第一條國家主權屬於全體人民權力來自於人民之授予議會掌握立法財政與監督之權領袖負責執行並對議會負責司法獨立不受干預軍隊效忠憲法而非個人稅賦之設立須經議會同意基本權利受到保障任何人不得任意逮捕"; let o = ""; while (o.length < 600) o += b; return o; })();

async function mk(gov = "parliamentary") {
  const uid = `cs-${run}-${n}`;
  const [row] = await db.insert(playerNationsTable).values({
    discordUserId: uid, name: `${MARK}${run}${n++}`, leaderName: "t", government: governmentLabel(gov)!, money: 10_000,
  } as any).returning();
  await settleNationParliament(row!, null, 0);
  const tok = await createSession({ discordUserId: uid, username: "t", avatar: null } as any);
  return { id: row!.id, cookie: `dn_session=${tok}` };
}
const H = (cookie?: string) => ({ "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}) });
const getC = (c?: string) => fetch(`${base}/api/constitution`, { headers: c ? { cookie: c } : {} });
const put = (c: string, t: unknown) => fetch(`${base}/api/constitution/draft`, { method: "PUT", headers: H(c), body: JSON.stringify({ text: t }) });
const submit = (c?: string) => fetch(`${base}/api/constitution/submit`, { method: "POST", headers: H(c), body: "{}" });

before(async () => {
  await ensureParliamentTestSchema();
  setEventTextQueuerForTest(() => {});
  setConstitutionRunnerForTest((job) => { pending.push(job().catch(() => {})); });
  setConstitutionAiForTest(async (feature, _s, user) => {
    if (feature === "constitution.quality") return '{"score":85,"feedback":"結構完整","flaws":["未規定軍隊指揮權"]}';
    if (feature === "constitution.flaws") return JSON.stringify({ flaws: [
      { title: "軍隊指揮權不明", description: "軍方與議會各自宣稱擁有最高統帥權。" },
      { title: "修憲門檻含糊", description: "議會對何謂多數吵成一團。" },
      { title: "緊急狀態無期限", description: "反對黨指控這是變相獨裁。" } ] });
    const names = [...user.matchAll(/^- (.+?)\(/gm)].map((m) => m[1]!);
    return JSON.stringify({ votes: names.map((p) => ({ party: p, vote: "yes", reason: "支持" })) });
  });
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  setConstitutionAiForTest(null); setConstitutionRunnerForTest(null); setEventTextQueuerForTest(null);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}${run}%`));
  server.close(); await pool.end();
});

test("未登入：GET / PUT / POST 全是 401", async () => {
  assert.equal((await getC()).status, 401);
  assert.equal((await put("", text)).status, 401);
  assert.equal((await submit()).status, 401);
});

test("前端契約：GET /constitution 的欄位與型別（前端 ConstitutionView 依賴這些）", async () => {
  const { cookie } = await mk();
  const j = (await (await getC(cookie)).json()) as any;
  assert.equal(j.status, "none"); assert.equal(j.required, true);
  assert.equal(typeof j.draftText, "string"); assert.equal(j.finalText, null); assert.equal(j.ratifiedAt, null);
  assert.equal(j.submissions, 0); assert.equal(j.lastReview, null);
  assert.deepEqual(Object.keys(j.limits).sort(), ["maxLen", "minSubmitLen"]);
  assert.deepEqual(Object.keys(j.submit).sort(), ["cooldownLeft", "cooldownTicks", "cost"]);
  assert.deepEqual(j.penalty && Object.keys(j.penalty).sort(), ["floor", "perTick"]);
  assert.ok(!("flaws" in j), "隱藏漏洞清單不得出現在回傳");
});

test("完整流程（HTTP）：存草稿 → 送審 202 → 輪詢 → 通過；通過後定稿可讀、不可再改", async () => {
  const { cookie } = await mk();
  assert.equal((await put(cookie, text)).status, 200);
  assert.equal(((await (await getC(cookie)).json()) as any).status, "draft");
  pending = []; const s = await submit(cookie);
  assert.equal(s.status, 202); assert.deepEqual(await s.json(), { ok: true, status: "reviewing" });
  await Promise.all(pending);
  const j = (await (await getC(cookie)).json()) as any;
  assert.equal(j.status, "ratified"); assert.equal(j.finalText, text); assert.ok(j.ratifiedAt);
  assert.equal(j.lastReview.outcome, "ratified"); assert.ok(j.lastReview.votes.length >= 1);
  assert.deepEqual(j.lastReview.flaws, [], "通過時不給品質缺陷清單（避免預告危機）");
  assert.ok(!("flaws" in j) && !JSON.stringify(j).includes("軍隊指揮權不明"), "隱藏漏洞不得外洩");
  assert.equal((await put(cookie, "偷改")).status, 409);
  assert.equal((await submit(cookie)).status, 409);
});

test("審議中：GET 回 reviewing；草稿被鎖（PUT 409）；重複送審 409", async () => {
  const { cookie } = await mk(); await put(cookie, text);
  setConstitutionRunnerForTest(() => {}); // 背景任務暫不執行，停在審議中
  assert.equal((await submit(cookie)).status, 202);
  assert.equal(((await (await getC(cookie)).json()) as any).status, "reviewing");
  assert.equal((await put(cookie, text + "x")).status, 409);
  assert.equal((await submit(cookie)).status, 409);
  setConstitutionRunnerForTest((job) => { pending.push(job().catch(() => {})); });
});

test("錯誤碼：沒草稿送審 400；字數太短 400；國庫不足 402", async () => {
  const a = await mk(); assert.equal((await submit(a.cookie)).status, 400);
  await put(a.cookie, "太短"); assert.equal((await submit(a.cookie)).status, 400);
  const b = await mk(); await put(b.cookie, text);
  await db.update(playerNationsTable).set({ money: 999 }).where(eq(playerNationsTable.id, b.id));
  assert.equal((await submit(b.cookie)).status, 402);
});

test("專制政體：required=false；送審 403（橡皮圖章議會不審憲法）", async () => {
  const { cookie } = await mk("absolute_monarchy");
  const j = (await (await getC(cookie)).json()) as any;
  assert.equal(j.required, false);
  assert.equal((await submit(cookie)).status, 403);
});

test("憲法危機經玩家事件 API 可見：標題=漏洞文字、三個選項、不洩漏效果數字，可正常處理", async () => {
  const { id, cookie } = await mk(); await put(cookie, text); pending = []; await submit(cookie); await Promise.all(pending);
  const evId = (await triggerCrisis(id, 30))!; assert.ok(evId);
  const ev = (await (await fetch(`${base}/api/domestic-events`, { headers: { cookie } })).json()) as any;
  assert.equal(ev.pending.kind, "constitutional_crisis"); assert.equal(ev.pending.title, "軍隊指揮權不明");
  assert.deepEqual(ev.pending.choices.map((c: any) => c.id), ["comply", "crackdown", "delay"]);
  assert.ok(!JSON.stringify(ev).includes("civilWarRisk") && !("effects" in ev.pending));
  const r = await fetch(`${base}/api/domestic-events/${evId}/resolve`, { method: "POST", headers: H(cookie), body: JSON.stringify({ choiceId: "comply" }) });
  assert.equal(r.status, 200); assert.equal(((await r.json()) as any).ok, true);
  assert.equal(((await (await fetch(`${base}/api/domestic-events`, { headers: { cookie } })).json()) as any).pending, null);
});

test("別人的憲法互不相干：A 通過不影響 B 的狀態", async () => {
  const a = await mk(); const b = await mk();
  await put(a.cookie, text); pending = []; await submit(a.cookie); await Promise.all(pending);
  assert.equal(((await (await getC(b.cookie)).json()) as any).status, "none");
});
