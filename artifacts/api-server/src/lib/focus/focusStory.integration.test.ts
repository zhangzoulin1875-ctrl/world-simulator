import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import { db, pool, playerNationsTable, focusTextOverridesTable } from "@workspace/db";
import { ensureFocusTestSchema } from "./testSchema";
import { AiQuotaExceededError } from "../gameAi";
import { generateFocusStory, getStoriesForNation } from "./focusStory";
import { getCatalog } from "./catalog";
import { governmentLabel } from "../governments";

const TAG = "story-test";
const FID = "regime.absolute_monarchy_to_military_dictatorship";
const LEADER = "絕對不該出現的領導人姓名";

async function mk() {
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}-國名${Math.random().toString(36).slice(2, 8)}`, leaderName: LEADER, government: governmentLabel("absolute_monarchy")!, isNpc: false, stability: 15, satisfactionMilitary: 80,
  } as never).returning();
  return n!;
}
const stories = (id: string) => db.select().from(focusTextOverridesTable).where(eq(focusTextOverridesTable.nationId, id));
const cleanup = async () => { await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`)); };
const okAi = (text: string, seen: string[] = []) => (async (_f: string, _t: string, p: { messages: Array<{ content: string }> }) => {
  seen.push(p.messages[0]!.content);
  return { content: [{ type: "text", text }] };
}) as never;

before(async () => { await ensureFocusTestSchema(); await cleanup(); });
after(async () => { await cleanup(); await pool.end(); });
beforeEach(cleanup);

test("前提:測試用的國策真的存在", () => { assert.ok(getCatalog().some((d) => d.id === FID)); });

test("AI 成功:存成 source=ai,故事寫進 flavor;prompt 不含國名與領導人,但帶著處境", async () => {
  const n = await mk();
  const seen: string[] = [];
  const text = "連年動盪讓政府失去了對局勢的掌控,軍方在議會外施壓,要求以強硬手段恢復秩序,這一步已不容再拖。";
  assert.equal(await generateFocusStory(n.id, FID, okAi(text, seen)), "ai");
  const [row] = await stories(n.id);
  assert.equal(row!.source, "ai"); assert.equal(row!.flavor, text); assert.equal(row!.focusId, FID);
  assert.equal(seen.length, 1);
  const nm = n.name ?? "";
  assert.ok(nm.length > 5, "測試用的國名要是真的字串,否則 includes 會恆為 true");
  assert.ok(!seen[0]!.includes(LEADER) && !seen[0]!.includes(nm), "國名與領導人不能進 prompt");
  assert.ok(seen[0]!.includes("社會穩定:很低") && seen[0]!.includes("軍方情緒:很高"));
});

test("已經有故事:不重寫、不再呼叫 AI(每國每國策只一次)", async () => {
  const n = await mk();
  await generateFocusStory(n.id, FID, okAi("第一次的故事內容夠長夠長夠長夠長夠長夠長。"));
  let called = 0;
  const r = await generateFocusStory(n.id, FID, (async () => { called++; return { content: [{ type: "text", text: "x" }] }; }) as never);
  assert.equal(r, "exists"); assert.equal(called, 0);
  assert.equal((await stories(n.id)).length, 1);
  assert.ok(((await stories(n.id))[0]!.flavor ?? "").startsWith("第一次"));
});

test("AI 丟錯 / 額度用完 / 輸出太短:都退回模板(source=template),不丟錯", async () => {
  for (const ai of [
    (async () => { throw new Error("nim 429"); }) as never,
    (async () => { throw new AiQuotaExceededError("focus.story"); }) as never,
    okAi("好"),
  ]) {
    const n = await mk();
    assert.equal(await generateFocusStory(n.id, FID, ai), "template");
    const [row] = await stories(n.id);
    assert.equal(row!.source, "template");
    assert.ok((row!.flavor ?? "").includes("軍事獨裁") && (row!.flavor ?? "").length > 20);
  }
});

test("不存在的國策 / 不存在的國家:略過,不寫任何東西", async () => {
  const n = await mk();
  assert.equal(await generateFocusStory(n.id, "nope.x", okAi("x")), "skipped");
  assert.equal(await generateFocusStory("00000000-0000-0000-0000-000000000000", FID, okAi("x")), "skipped");
  assert.equal((await stories(n.id)).length, 0);
});

test("getStoriesForNation:只回有故事的,附來源", async () => {
  const n = await mk();
  assert.equal((await getStoriesForNation(n.id)).size, 0);
  await generateFocusStory(n.id, FID, okAi("夠長的故事夠長的故事夠長的故事夠長的故事。"));
  const m = await getStoriesForNation(n.id);
  assert.equal(m.get(FID)?.source, "ai");
});

test("並發:同一國策同時生成兩次,只會留一筆(唯一索引 + DO NOTHING)", async () => {
  const n = await mk();
  await Promise.all([1, 2, 3].map(() => generateFocusStory(n.id, FID, okAi("並發測試的故事並發測試的故事並發測試的故事。"))));
  assert.equal((await stories(n.id)).length, 1);
});
