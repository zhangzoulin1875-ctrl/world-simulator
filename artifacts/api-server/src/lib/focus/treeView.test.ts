import test from "node:test";
import assert from "node:assert/strict";
import { GOVERNMENTS, FOUNDING_GOVERNMENT_SLUGS } from "../governments";
import { REGIME_EDGES, edgesFrom } from "./regimeGraph";
import { buildFocusTree, computeLayers } from "./treeView";

test("全景分層:建國起點為第 0 層,每個政體都有層數(全部可從建國到達),邊只往前或同層以上不會自己指自己", () => {
  const layers = computeLayers();
  for (const s of FOUNDING_GOVERNMENT_SLUGS) assert.equal(layers.get(s), 0);
  for (const g of GOVERNMENTS) assert.ok(layers.has(g.slug), `${g.slug} 從建國到不了`);
  // 最短層數定義:每條邊的終點層數 <= 起點層數 + 1
  for (const e of REGIME_EDGES) assert.ok(layers.get(e.to)! <= layers.get(e.from)! + 1, `${e.from}->${e.to}`);
});

test("全景欄位:建國起點 3 個在第 0 欄;終點 7 個(紅2/黑2/穩3)在第 2 欄;其餘是中繼;每個政體恰好一欄", () => {
  const t = buildFocusTree("absolute_monarchy", null);
  const by = (st: number) => t.nodes.filter((n) => n.stage === st).map((n) => n.slug).sort();
  assert.deepEqual(by(0), [...FOUNDING_GOVERNMENT_SLUGS].sort());
  const term = t.nodes.filter((n) => n.stage === 2);
  assert.equal(term.length, 7);
  assert.deepEqual(["red", "black", "stable"].map((l) => term.filter((n) => n.line === l).length), [2, 2, 3]);
  assert.ok(t.nodes.filter((n) => n.stage !== 2).every((n) => n.line === null));
  assert.equal(by(0).length + by(1).length + term.length, GOVERNMENTS.length);
});

test("以我為根:目前=0、抽到的分支=1、沒抽到的不在範圍內;第 2 層只來自抽到的分支", () => {
  const all = edgesFrom("absolute_monarchy").map((e) => e.to);
  const mine = new Set(all.slice(0, 3));
  const t = buildFocusTree("absolute_monarchy", mine);
  const d = (s: string) => t.nodes.find((n) => n.slug === s)!.depth;
  assert.equal(d("absolute_monarchy"), 0);
  for (const s of mine) assert.equal(d(s), 1);
  for (const s of all.slice(3)) assert.notEqual(d(s), 1, `${s} 沒抽到不該是第 1 層`);
  assert.equal(t.nodes.filter((n) => n.isCurrent).length, 1);
  assert.equal(t.limited, true);
});

test("邊的標記:只有從目前政體出發且抽到的 walkable;從目前出發但沒抽到的 notDrawn;其餘兩者皆 false", () => {
  const all = edgesFrom("absolute_monarchy").map((e) => e.to);
  const mine = new Set(all.slice(0, 3));
  const t = buildFocusTree("absolute_monarchy", mine);
  for (const e of t.edges) {
    if (e.from !== "absolute_monarchy") { assert.equal(e.walkable, false); assert.equal(e.notDrawn, false); continue; }
    assert.equal(e.walkable, mine.has(e.to));
    assert.equal(e.notDrawn, !mine.has(e.to));
  }
});

test("降級(myBranches = null):不套用限制,出邊全部 walkable,limited=false", () => {
  const t = buildFocusTree("theocracy", null);
  assert.equal(t.limited, false);
  const out = t.edges.filter((e) => e.from === "theocracy");
  assert.ok(out.length > 0 && out.every((e) => e.walkable && !e.notDrawn));
});

test("共產革命是單獨分支:不在政體邊裡、不佔分支名額;除了紅線終點以外每個政體都有;打贏變委員會制", () => {
  for (const g of GOVERNMENTS) {
    const t = buildFocusTree(g.slug, new Set());
    if (["council_system", "socialist_council"].includes(g.slug)) { assert.equal(t.revolution, null, g.slug); continue; }
    assert.equal(t.revolution?.focusId, "regime.communist_revolution", g.slug);
    assert.equal(t.revolution?.winGovernment, "council_system");
  }
  assert.ok(!REGIME_EDGES.some((e) => e.focusId === "regime.communist_revolution"));
  // 就算一條分支都沒抽到,革命分支仍在
  assert.ok(buildFocusTree("theocracy", new Set()).revolution);
});

test("未知政體(標籤對不上):不炸,沒有目前節點", () => {
  const t = buildFocusTree(null, null);
  assert.equal(t.nodes.filter((n) => n.isCurrent).length, 0);
  assert.ok(t.edges.every((e) => !e.walkable));
  assert.equal(t.revolution, null);
});
