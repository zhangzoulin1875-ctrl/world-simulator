import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import { db, pool, playerNationsTable, focusBranchesTable } from "@workspace/db";
import { runFocusMigrations } from "../focusMigrations";
import { ensureFocusTestSchema } from "./testSchema";
import { ensureBranches, isBranchAllowed, readBranches } from "./branchService";
import { edgesFrom } from "./regimeGraph";
import { governmentLabel } from "../governments";

const TAG = "branch-test";
const seeded = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

async function mk(gov = "absolute_monarchy") {
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}-${Math.random().toString(36).slice(2, 8)}`, leaderName: TAG, government: governmentLabel(gov)!, isNpc: true,
  } as never).returning();
  return n!;
}
const rows = (id: string) => db.select().from(focusBranchesTable).where(eq(focusBranchesTable.nationId, id));
const cleanup = async () => { await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`)); };

before(async () => {
  await ensureFocusTestSchema();
  await cleanup();
});
after(async () => { await cleanup(); await pool.end(); });
beforeEach(cleanup);

test("migration 可重複執行(idempotent),表與唯一索引存在", async () => {
  await runFocusMigrations(); await runFocusMigrations();
  const r = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='focus_branches'`);
  const names = r.rows.map((x: { indexname: string }) => x.indexname);
  assert.ok(names.includes("focus_branches_nation_from_to_uq"), names.join(","));
});

test("第一次要才抽:存進資料庫,之後重複讀取結果完全一樣(不重抽)", async () => {
  const n = await mk();
  assert.equal(await readBranches(n.id, "absolute_monarchy"), null, "一開始沒有");
  const first = await ensureBranches(n.id, "absolute_monarchy", seeded(1));
  assert.ok(first.length >= 3 && first.length <= 5);
  // 換一個完全不同的亂數源,仍然拿到同一批 = 真的是讀資料庫,不是重抽
  for (let s = 2; s < 20; s++) assert.deepEqual(await ensureBranches(n.id, "absolute_monarchy", seeded(s)), first);
  assert.equal((await rows(n.id)).length, first.length, "資料庫裡只有一套");
});

test("只會抽到真的出邊;出邊 ≤3 的政體(神權制)全給", async () => {
  const n = await mk("theocracy");
  const got = await ensureBranches(n.id, "theocracy", seeded(5));
  assert.deepEqual(got.slice().sort(), edgesFrom("theocracy").map((e) => e.to).sort());
});

test("併發:多輪、每輪 8 個請求同時發現沒抽過 → 每輪資料庫只留一套、數量恆為 3~5、大家拿到同一套", async () => {
  // 不變量:聯集會讓數量超過 5(各請求抽出不同組合、全被寫入),所以要斷言上限而不只是「沒報錯」
  for (let round = 0; round < 15; round++) {
    const n = await mk();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => ensureBranches(n.id, "absolute_monarchy", seeded(round * 50 + i))));
    const stored = (await rows(n.id)).map((r) => r.toGovernment).sort();
    assert.equal(new Set(stored).size, stored.length, `第 ${round} 輪:不可有重複列`);
    assert.ok(stored.length >= 3 && stored.length <= 5, `第 ${round} 輪:樹應為 3~5 條,實際 ${stored.length}(${stored.join(",")})`);
    for (const r of results) assert.deepEqual(r.slice().sort(), stored, `第 ${round} 輪:每個請求都該拿到資料庫最終那一套`);
    assert.deepEqual((await ensureBranches(n.id, "absolute_monarchy", seeded(999))).slice().sort(), stored);
  }
});

test("換政體 → 以新政體為根另外抽;舊根的分支保留當歷史", async () => {
  const n = await mk();
  const a = await ensureBranches(n.id, "absolute_monarchy", seeded(3));
  const b = await ensureBranches(n.id, "constitutional_monarchy", seeded(3));
  assert.deepEqual(b.slice().sort(), edgesFrom("constitutional_monarchy").map((e) => e.to).sort(), "君主立憲只有 3 條出邊,全給");
  assert.deepEqual((await readBranches(n.id, "absolute_monarchy"))!.slice().sort(), a.slice().sort(), "舊根沒被動到");
  assert.equal((await rows(n.id)).length, a.length + b.length);
});

test("繞一圈回到舊政體:沿用當初抽到的那批,不能靠繞圈刷新分支", async () => {
  const n = await mk();
  const original = await ensureBranches(n.id, "absolute_monarchy", seeded(11));
  await ensureBranches(n.id, "constitutional_monarchy", seeded(11));
  const back = await ensureBranches(n.id, "absolute_monarchy", seeded(777));
  assert.deepEqual(back.slice().sort(), original.slice().sort());
});

test("isBranchAllowed:在樹上才回 true;不在樹上的合法出邊回 false", async () => {
  const n = await mk();
  const got = await ensureBranches(n.id, "absolute_monarchy", seeded(21));
  const legal = edgesFrom("absolute_monarchy").map((e) => e.to);
  for (const to of legal) assert.equal(await isBranchAllowed(n.id, "absolute_monarchy", to), got.includes(to), to);
  assert.equal(await isBranchAllowed(n.id, "absolute_monarchy", "socialist_council"), false, "根本不是出邊");
});

test("兩個國家互不影響(各自的樹);刪除國家時分支一併清掉", async () => {
  const a = await mk(); const b = await mk();
  const ga = await ensureBranches(a.id, "absolute_monarchy", seeded(1));
  let differs = false;
  for (let s = 2; s < 40 && !differs; s++) {
    const nb = await mk();
    const gb = await ensureBranches(nb.id, "absolute_monarchy", seeded(s));
    if (gb.join() !== ga.join()) differs = true;
  }
  assert.ok(differs, "不同國家應該會抽到不同的樹");
  assert.equal(await readBranches(b.id, "absolute_monarchy"), null, "沒碰過的國家不受影響");
  await db.delete(playerNationsTable).where(eq(playerNationsTable.id, a.id));
  assert.equal((await rows(a.id)).length, 0, "ON DELETE CASCADE");
});
