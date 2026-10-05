import test from "node:test";
import assert from "node:assert/strict";
import { groupByTrack, leanPct, progressPct, remainingText, type FocusCard } from "./focus";

const card = (id: string, track: FocusCard["track"]): FocusCard => ({
  id, title: id, description: "", domain: "regime", track, slot: "main", cost: 1, turns: 1, milestone: false,
  status: "available", lockedReason: null, permanentlyLocked: false, conditions: [], benefits: [], costs: [], transitionTo: null,
});

test("groupByTrack:固定順序 穩定→改革→黑→紅,空軌道不出現", () => {
  const g = groupByTrack([card("a", "red"), card("b", "stable"), card("c", "black"), card("d", "stable")]);
  assert.deepEqual(g.map((x) => x.track), ["stable", "black", "red"]);
  assert.deepEqual(g[0]!.items.map((x) => x.id), ["b", "d"]);
  assert.deepEqual(groupByTrack([]), []);
});

test("progressPct:正常/超出/負值/總回合為 0 都不會 NaN 或越界", () => {
  assert.equal(progressPct(2, 4), 50);
  assert.equal(progressPct(9, 4), 100);
  assert.equal(progressPct(-3, 4), 0);
  assert.equal(progressPct(1, 0), 0);
  assert.equal(progressPct(1.5, 4), 38);
});

test("remainingText:停擺/即將完成/回合數", () => {
  assert.ok(remainingText(null).includes("停擺"));
  assert.equal(remainingText(0), "即將完成");
  assert.equal(remainingText(-1), "即將完成");
  assert.equal(remainingText(5), "約 5 回合");
});

test("leanPct:夾在 0-100 並四捨五入", () => {
  assert.equal(leanPct(-5), 0);
  assert.equal(leanPct(130), 100);
  assert.equal(leanPct(49.6), 50);
});

// ---------- 政體樹排版 ----------
import { layoutTree, type FocusTreeData, type TreeNode } from "./focus";

const N = (slug: string, p: Partial<TreeNode> = {}): TreeNode =>
  ({ slug, label: slug, stage: 1, line: null, layer: null, isFounding: false, isCurrent: false, depth: null, ...p });
const E = (from: string, to: string, p: Partial<FocusTreeData["edges"][number]> = {}) =>
  ({ from, to, track: "stable" as const, focusId: `regime.${from}_to_${to}`, walkable: false, notDrawn: false, ...p });

const sample: FocusTreeData = {
  currentGovernment: "a",
  limited: true,
  nodes: [
    N("a", { stage: 0, isFounding: true, isCurrent: true, depth: 0 }),
    N("b", { stage: 1, depth: 1 }),
    N("c", { stage: 1, depth: 1 }),
    N("x", { stage: 1, depth: null }), // 沒抽到
    N("d", { stage: 2, line: "stable", depth: 2 }),
    N("y", { stage: 2, line: "red", depth: null }),
  ],
  edges: [
    E("a", "b", { walkable: true }), E("a", "c", { walkable: true }), E("a", "x", { notDrawn: true }),
    E("b", "d"), E("c", "a"), E("d", "a"), E("x", "y"),
  ],
};

test("layoutTree rooted:只放範圍內節點;沒抽到的不出現;欄 = 深度", () => {
  const l = layoutTree(sample, "rooted");
  assert.deepEqual(l.cols.map((c) => c.map((n) => n.slug).sort()), [["a"], ["b", "c"], ["d"]]);
  assert.ok(!l.nodes.some((n) => n.slug === "x" || n.slug === "y"));
});

test("layoutTree rooted:只畫往更深一層的邊;回邊(c->a、d->a)不畫;第 2 層的邊標為預覽", () => {
  const l = layoutTree(sample, "rooted");
  const key = (e: { from: string; to: string }) => `${e.from}>${e.to}`;
  assert.deepEqual(l.edges.map(key).sort(), ["a>b", "a>c", "b>d"]);
  assert.equal(l.edges.find((e) => key(e) === "a>b")!.preview, false);
  assert.equal(l.edges.find((e) => key(e) === "b>d")!.preview, true);
});

test("layoutTree full:欄 = 建國起點/中繼/終點;全部邊都畫;回邊標 back(有環不打亂層級)", () => {
  const l = layoutTree(sample, "full");
  assert.deepEqual(l.cols.map((c) => c.map((n) => n.slug).sort()), [["a"], ["b", "c", "x"], ["d", "y"]]);
  assert.equal(l.edges.length, sample.edges.length);
  assert.equal(l.edges.find((e) => e.from === "c" && e.to === "a")!.back, true);
  assert.equal(l.edges.find((e) => e.from === "a" && e.to === "b")!.back, false);
});

test("layoutTree:終點欄依路線分組(穩定→黑→紅)、row 連續、不會丟節點;rooted 目前政體排最前", () => {
  const t: FocusTreeData = { ...sample, nodes: [...sample.nodes, N("z", { stage: 2, line: "black" })] };
  const l = layoutTree(t, "full");
  assert.equal(l.nodes.length, t.nodes.length);
  assert.deepEqual(l.cols[2]!.map((n) => n.slug), ["d", "z", "y"]); // stable, black, red
  for (const c of l.cols) assert.deepEqual(c.map((n) => n.row), c.map((_, i) => i));
  assert.equal(layoutTree(sample, "rooted").cols[0]![0]!.isCurrent, true);
});
