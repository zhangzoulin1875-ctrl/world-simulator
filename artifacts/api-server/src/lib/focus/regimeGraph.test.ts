import test from "node:test";
import assert from "node:assert/strict";
import { AUTOCRACY_RED_REVOLUTION_LAND_SHARE, REGIME_EDGES, edgesFrom, findEdge, reachableFrom, validateRegimeGraph } from "./regimeGraph";
import { buildRegimeFocuses, COMMUNIST_REVOLUTION_ID, REVOLUTION_EXCLUDED_GOVERNMENTS } from "./regimeFocuses";
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
  assert.equal(fs.length, REGIME_EDGES.length + 1, "每條邊一個轉型國策,再加上獨立的共產革命");
  assert.equal(new Set(fs.map((f) => f.id)).size, fs.length);
  assert.equal(fs.filter((f) => f.id !== COMMUNIST_REVOLUTION_ID).length, REGIME_EDGES.length);
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

test("共產革命是獨立於政體圖的單一入口:圖上沒有任何革命邊,革命方只佔 35% 土地", () => {
  assert.equal(AUTOCRACY_RED_REVOLUTION_LAND_SHARE, 0.35);
  assert.ok(!REGIME_EDGES.some((e) => (e as { revolution?: unknown }).revolution), "圖上不應再有革命邊");
  assert.ok(!REGIME_EDGES.some((e) => e.focusId.endsWith("_red_revolution")));
  const all = buildRegimeFocuses();
  const revs = all.filter((f) => f.effects.some((e) => e.kind === "revolution"));
  assert.equal(revs.length, 1, "全系統只有一條革命國策");
  const rev = revs[0]!;
  assert.equal(rev.id, COMMUNIST_REVOLUTION_ID);
  assert.equal(rev.governments, undefined, "不限政體:任何政體的樹上都看得到");
  const eff = rev.effects.find((e) => e.kind === "revolution") as { ideology: string; landShare: number };
  assert.equal(eff.ideology, "red");
  assert.equal(eff.landShare, 0.35);
  assert.ok(!rev.effects.some((e) => e.kind === "transition"), "革命不是和平轉型,沒有 transition 效果");
});

test("共產革命比任何和平轉型都更貴更慢、門檻更高、代價更重", () => {
  const fs = buildRegimeFocuses();
  const rev = fs.find((f) => f.id === COMMUNIST_REVOLUTION_ID)!;
  const dem = fs.find((f) => f.id === findEdge("parliamentary", "council_system")!.focusId)!;
  for (const f of fs.filter((x) => x.id !== rev.id)) {
    assert.ok(rev.cost > f.cost && rev.turns > f.turns, `${f.id} 應比革命便宜且快`);
  }
  const lean = (f: typeof rev) => (f.conditions!.find((c) => c.kind === "leanAtLeast") as any).value;
  assert.ok(lean(rev) > lean(dem), "紅線傾向門檻更高");
  const loss = (f: typeof rev, stat: string) =>
    f.effects.filter((e) => e.kind === "grant" && e.stat === stat).reduce((a, e: any) => a + e.value, 0);
  assert.ok(loss(rev, "stability") < loss(dem, "stability"), "穩定度損失更大");
  assert.ok(loss(rev, "money") < loss(dem, "money"), "金錢損失更大");
  assert.ok(rev.description.includes("35%") && rev.description.includes("內戰"));
});

test("革命與和平轉型分開:革命國策已開放推行;紅線終點不顯示革命", () => {
  assert.ok(buildRegimeFocuses().every((f) => !f.unavailableReason), "全部已開放");
  assert.deepEqual([...REVOLUTION_EXCLUDED_GOVERNMENTS].sort(), ["council_system", "socialist_council"]);
  // 革命國策不佔政體圖的出邊名額:每個政體的轉型出邊都沒有被革命擠掉
  for (const g of ["absolute_monarchy", "military_dictatorship", "theocracy"]) {
    assert.ok(edgesFrom(g).every((e) => e.to !== "council_system" || e.track !== "red"), g);
  }
});
