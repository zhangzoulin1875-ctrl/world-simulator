import test from "node:test";
import assert from "node:assert/strict";
import { BRANCH_MAX, BRANCH_MIN, branchCount, drawBranches, pickRandom } from "./branchDraw";
import { REGIME_EDGES, edgesFrom } from "./regimeGraph";
import { GOVERNMENTS } from "../governments";

function seeded(seed: number): () => number {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("數量:3~5 之間,出邊不足就全給、絕不超過出邊數", () => {
  const r = seeded(1);
  for (let avail = 0; avail <= 9; avail++) {
    for (let i = 0; i < 300; i++) {
      const n = branchCount(avail, r);
      assert.ok(n <= avail, `avail=${avail} n=${n}`);
      if (avail >= BRANCH_MIN) assert.ok(n >= BRANCH_MIN && n <= BRANCH_MAX, `avail=${avail} n=${n}`);
      else assert.equal(n, avail, "出邊少於 3 條就全給");
    }
  }
  assert.equal(branchCount(0, Math.random), 0);
});

test("數量分布:出邊足夠時 3、4、5 都會出現", () => {
  const r = seeded(42); const seen = new Set<number>();
  for (let i = 0; i < 500; i++) seen.add(branchCount(5, r));
  assert.deepEqual([...seen].sort(), [3, 4, 5]);
});

test("pickRandom:不改原陣列、不重複、數量正確", () => {
  const src = [1, 2, 3, 4, 5, 6]; const copy = src.slice();
  const out = pickRandom(src, 4, seeded(7));
  assert.deepEqual(src, copy);
  assert.equal(out.length, 4); assert.equal(new Set(out).size, 4);
  assert.ok(out.every((x) => src.includes(x)));
  assert.deepEqual(pickRandom(src, 0, seeded(1)), []);
  assert.equal(pickRandom(src, 99, seeded(1)).length, 6);
});

test("drawBranches:每個政體抽出的目的地都是真的出邊、不重複、不含革命", () => {
  const r = seeded(2024);
  for (const g of GOVERNMENTS) {
    const legal = new Set(edgesFrom(g.slug).map((e) => e.to));
    for (let i = 0; i < 100; i++) {
      const got = drawBranches(g.slug, r);
      assert.equal(new Set(got).size, got.length, "不重複");
      for (const d of got) assert.ok(legal.has(d), `${g.slug} -> ${d} 不是合法出邊`);
      assert.ok(!got.includes(g.slug), "不會抽到自己");
      assert.ok(got.length >= Math.min(legal.size, BRANCH_MIN));
      assert.ok(got.length <= Math.min(legal.size, BRANCH_MAX));
    }
  }
});

test("出邊 ≤3 的政體:每次都全給(沒有隨機性,也不會把人卡死)", () => {
  const r = seeded(9);
  for (const g of GOVERNMENTS) {
    const legal = [...new Set(edgesFrom(g.slug).map((e) => e.to))];
    if (legal.length > BRANCH_MIN) continue;
    for (let i = 0; i < 50; i++) assert.deepEqual(drawBranches(g.slug, r).sort(), legal.slice().sort(), g.slug);
  }
});

test("出邊 5 條的建國起點:確實有變化,且每個目的地都有機會被抽到", () => {
  const r = seeded(31337);
  for (const g of ["absolute_monarchy", "aristocracy", "parliamentary_republic"]) {
    const legal = [...new Set(edgesFrom(g).map((e) => e.to))];
    assert.equal(legal.length, 5, g);
    const freq = new Map<string, number>(); const shapes = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const got = drawBranches(g, r); shapes.add(got.join(","));
      for (const d of got) freq.set(d, (freq.get(d) ?? 0) + 1);
    }
    assert.ok(shapes.size > 5, `${g} 應有多種不同的樹,實際 ${shapes.size}`);
    for (const d of legal) assert.ok((freq.get(d) ?? 0) > 800, `${g} -> ${d} 被抽到太少:${freq.get(d)}`);
  }
});

test("回傳順序穩定(依政體圖順序),同一組選擇不會因洗牌順序而不同", () => {
  const order = edgesFrom("absolute_monarchy").map((e) => e.to);
  for (let s = 1; s < 30; s++) {
    const got = drawBranches("absolute_monarchy", seeded(s));
    const idx = got.map((d) => order.indexOf(d));
    assert.deepEqual(idx, idx.slice().sort((a, b) => a - b));
  }
  assert.ok(REGIME_EDGES.length > 0);
});
