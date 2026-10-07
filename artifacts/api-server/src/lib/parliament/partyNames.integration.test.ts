import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import { db, pool, playerNationsTable, parliamentPartiesTable } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runParliamentMigrations } from "../parliamentMigrations";
import { rebuildParties, nameUnnamedParties, tierOfNation } from "./service";
import type { NationFacts } from "./parties";

/** AI 黨名 — 真資料庫整合測試：成功覆蓋模板名、失敗保留、重組時沿用舊名。 */
const TAG = "__pname_test__";
type MC = typeof anthropic.messages.create;
const realCreate: MC = anthropic.messages.create.bind(anthropic.messages);

const FACTS = (name: string): NationFacts => ({
  nationName: name, tier: "democracy", stability: 50, warWeariness: 0, militarySatisfaction: 50,
  atWar: false, taxRatePct: 10, governmentSlug: "parliamentary_republic",
});
async function mk(suffix: string) {
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: `${TAG}${suffix}`, name: `${TAG}${suffix}`, leaderName: "t", government: "議會內閣制",
  } as any).returning();
  return n!;
}
async function parties(id: string) {
  return db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, id));
}
/** AI 依請求裡的 id 回傳「奇名N」。 */
function stubNames(prefix = "奇名") {
  anthropic.messages.create = (async (p: any) => {
    const text: string = p.messages[0].content;
    const ids = [...text.matchAll(/id=(\d+)/g)].map((m) => m[1]!);
    return { content: [{ type: "text", text: JSON.stringify({
      parties: ids.map((id, i) => ({ id, name: `${prefix}${"甲乙丙丁戊"[i]}同盟`, description: `黨綱${id}` })),
    }) }] };
  }) as unknown as MC;
}

before(async () => {
  await runParliamentMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
});
afterEach(() => { anthropic.messages.create = realCreate; });
after(async () => {
  anthropic.messages.create = realCreate;
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  await pool.end();
});

test("AI 成功：模板名被換成有個性的名字並寫入黨綱，立場與席次不變", async () => {
  const n = await mk("a");
  await rebuildParties(n, { tick: 0 }, FACTS(n.name ?? "測試國"));
  await new Promise((r) => setTimeout(r, 50));
  anthropic.messages.create = realCreate; // 先讓背景那次(打不到 stub 網址)失敗收場
  const before = await parties(n.id);
  assert.equal(before.length, 5);
  stubNames();
  const changed = await nameUnnamedParties(n);
  assert.equal(changed, 5);
  const after = await parties(n.id);
  assert.ok(after.every((p) => p.name.startsWith("奇名") && p.description.startsWith("黨綱")));
  assert.deepEqual(after.map((p) => [p.id, p.stance, p.seats]).sort(), before.map((p) => [p.id, p.stance, p.seats]).sort());
});

test("AI 失敗：保留模板名，遊戲照常", async () => {
  const n = await mk("b");
  await rebuildParties(n, { tick: 0 }, FACTS(n.name ?? "測試國"));
  anthropic.messages.create = (async () => { throw new Error("boom"); }) as unknown as MC;
  assert.equal(await nameUnnamedParties(n), 0);
  const ps = await parties(n.id);
  assert.equal(ps.length, 5);
  assert.ok(ps.every((p) => !p.name.startsWith("奇名")));
});

test("AI 回傳模板名：整批不採用", async () => {
  const n = await mk("c");
  await rebuildParties(n, { tick: 0 }, FACTS(n.name ?? "測試國"));
  anthropic.messages.create = (async (p: any) => {
    const ids = [...String(p.messages[0].content).matchAll(/id=(\d+)/g)].map((m) => m[1]!);
    const rows = await parties(n.id);
    return { content: [{ type: "text", text: JSON.stringify({
      parties: ids.map((id) => ({ id, name: rows.find((r) => String(r.id) === id)!.name, description: "" })),
    }) }] };
  }) as unknown as MC;
  assert.equal(await nameUnnamedParties(n), 0);
});

test("重組時同立場的黨沿用舊名與黨綱", async () => {
  const n = await mk("d");
  await rebuildParties(n, { tick: 0 }, FACTS(n.name ?? "測試國"));
  stubNames("舊名");
  await nameUnnamedParties(n);
  const named = await parties(n.id);
  anthropic.messages.create = (async () => { throw new Error("no ai"); }) as unknown as MC;
  await rebuildParties(n, { tick: 12 }, FACTS(n.name ?? "測試國"));
  const re = await parties(n.id);
  for (const p of re) {
    const old = named.find((o) => o.stance === p.stance);
    if (old) { assert.equal(p.name, old.name); assert.equal(p.description, old.description); }
  }
  assert.ok(re.some((p) => p.name.startsWith("舊名")), "至少有一個黨沿用舊名");
});

test("專制國不呼叫 AI 命名", async () => {
  const n = await mk("e");
  // 先讓前面測試遺留的背景命名任務收場，再開始計數。
  await new Promise((r) => setTimeout(r, 300));
  let called = 0;
  anthropic.messages.create = (async () => { called++; throw new Error("x"); }) as unknown as MC;
  await rebuildParties(n, { tick: 0 }, { ...FACTS(n.name ?? "測試國"), tier: "autocracy", governmentSlug: "military_dictatorship" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(called, 0);
  assert.equal((await parties(n.id))[0]!.stance, "loyalist");
});
