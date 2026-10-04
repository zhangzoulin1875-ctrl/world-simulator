import test from "node:test";
import assert from "node:assert/strict";
import { REGIME_EDGES, edgesFrom, findEdge, reachableFrom, validateRegimeGraph } from "./regimeGraph";
import { buildRegimeFocuses } from "./regimeFocuses";
import { FOCUS_CATALOG } from "./catalog";
import { validateCatalog } from "./validate";
import { FOUNDING_GOVERNMENT_SLUGS, GOVERNMENTS } from "../governments";

test("政體圖:結構合格,14 個政體全部可從建國三選一抵達", () => {
  assert.deepEqual(validateRegimeGraph(), []);
  assert.equal(reachableFrom(FOUNDING_GOVERNMENT_SLUGS).size, GOVERNMENTS.length);
});

test("政體圖:每個政體都有出口,沒有被困死的終點", () => {
  for (const g of GOVERNMENTS) assert.ok(edgesFrom(g.slug).length >= 1, g.slug);
});

test("政體圖:紅線終點與黑線終點確實存在", () => {
  assert.ok(findEdge("council_system", "socialist_council")?.track === "red");
  assert.ok(findEdge("absolute_monarchy", "military_dictatorship")?.track === "black");
  assert.ok(findEdge("absolute_monarchy", "theocracy")?.track === "black");
  assert.ok(findEdge("absolute_monarchy", "constitutional_monarchy")?.track === "reform");
});

test("政體圖:驗證器能抓到壞圖(自環/重複/無效政體)", () => {
  const bad = validateRegimeGraph([
    { from: "absolute_monarchy", to: "absolute_monarchy", track: "stable", focusId: "x.a" },
    { from: "absolute_monarchy", to: "nope", track: "stable", focusId: "x.b" },
    { from: "absolute_monarchy", to: "aristocracy", track: "stable", focusId: "x.c" },
    { from: "absolute_monarchy", to: "aristocracy", track: "stable", focusId: "x.d" },
  ]);
  assert.ok(bad.some((p) => p.includes("自環")));
  assert.ok(bad.some((p) => p.includes("不是有效政體")));
  assert.ok(bad.some((p) => p.includes("重複的邊")));
  assert.ok(bad.some((p) => p.includes("沒有任何出口")));
});

test("政體圖:驗證器能抓到「無法從建國政體抵達」的孤島", () => {
  // 拿掉所有指向 socialist_council 的邊,它就成了孤島(但它自己仍有出口)
  const cut = REGIME_EDGES.filter((e) => e.to !== "socialist_council");
  const bad = validateRegimeGraph(cut);
  assert.ok(bad.some((p) => p.includes("無法抵達:socialist_council")), bad.join("|"));
});

test("轉型國策:每條邊恰好一個,id 與圖一致,正式目錄通過全部驗證", () => {
  const fs = buildRegimeFocuses();
  assert.equal(fs.length, REGIME_EDGES.length);
  assert.equal(new Set(fs.map((f) => f.id)).size, fs.length);
  for (const e of REGIME_EDGES) {
    const f = fs.find((x) => x.id === e.focusId)!;
    assert.ok(f, e.focusId);
    assert.deepEqual(f.governments, [e.from], "只有起點政體能看見");
    const tr = f.effects.find((x) => x.kind === "transition");
    assert.equal(tr && tr.kind === "transition" ? tr.toGovernment : null, e.to);
    assert.ok(f.milestone);
    assert.ok((f.conditions?.length ?? 0) > 0, "轉型必須有客觀門檻(取代舊接受度)");
  }
  assert.deepEqual(validateCatalog(FOCUS_CATALOG), []);
});

test("轉型國策:極端路線比穩定路線更貴更慢,且黑/紅線要求傾向值", () => {
  const fs = buildRegimeFocuses();
  const get = (from: string, to: string) => fs.find((f) => f.id === findEdge(from, to)!.focusId)!;
  const stable = get("aristocracy", "elective_monarchy");
  const black = get("absolute_monarchy", "military_dictatorship");
  const red = get("parliamentary", "council_system");
  assert.ok(black.cost > stable.cost && black.turns > stable.turns);
  assert.ok(red.cost > stable.cost && red.turns > stable.turns);
  assert.ok(black.conditions!.some((c) => c.kind === "leanAtLeast" && c.side === "black"));
  assert.ok(red.conditions!.some((c) => c.kind === "leanAtLeast" && c.side === "red"));
});
