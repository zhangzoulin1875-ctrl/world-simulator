import test from "node:test";
import assert from "node:assert/strict";
import {
  decideNpcFocus, eligibleCandidates, npcRadicalCap, weightOf, isRadicalFocus,
  NPC_DECISION_CHANCE, NPC_TRACK_WEIGHT, NPC_REVOLUTION_WEIGHT, type NpcDecisionInput, type NpcCandidate,
} from "./npcDecision";
import type { FocusDef } from "./types";

const def = (id: string, track: FocusDef["track"], over: Partial<FocusDef> = {}): FocusDef => ({
  id, domain: "regime", track, slot: "main", title: id, description: "", cost: 30, turns: 8,
  requires: [], effects: [], ...over,
} as FocusDef);

const stable = def("s", "stable");
const reform = def("r", "reform");
const black = def("b", "black");
const red = def("d", "red");
const rev = def("v", "red");

const cands: NpcCandidate[] = [
  { def: stable, isRevolution: false }, { def: reform, isRevolution: false },
  { def: black, isRevolution: false }, { def: red, isRevolution: false }, { def: rev, isRevolution: true },
];
const facts = { politicalSupport: 50, stability: 50, militarySatisfaction: 50, parliamentSatisfaction: 50, blackLean: 0, redLean: 0 };
const base = (over: Partial<NpcDecisionInput> = {}): NpcDecisionInput => ({
  candidates: cands, points: 100, facts, radicalInFlight: 0, radicalCap: 5,
  inCivilWar: false, hasActiveRegimeFocus: false, rand: () => 0, ...over,
});

// 可重現的亂數(mulberry32)
function seeded(seed: number): () => number {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("權重:穩定/改革遠高於黑紅線,革命最低", () => {
  assert.ok(NPC_TRACK_WEIGHT.stable! > NPC_TRACK_WEIGHT.black!);
  assert.ok(NPC_TRACK_WEIGHT.black! > NPC_REVOLUTION_WEIGHT);
  assert.equal(weightOf({ def: rev, isRevolution: true }), NPC_REVOLUTION_WEIGHT);
  assert.equal(weightOf({ def: black, isRevolution: false }), NPC_TRACK_WEIGHT.black);
});

test("只有 6% 的機率會考慮動作;擲骰沒過就維持現狀", () => {
  assert.equal(decideNpcFocus(base({ rand: () => NPC_DECISION_CHANCE + 0.001 })), null);
  assert.notEqual(decideNpcFocus(base({ rand: () => 0 })), null);
});

test("大量抽樣:奪權線(黑/紅/革命)佔比遠低於穩定+改革", () => {
  const rand = seeded(12345);
  const n: Record<string, number> = {};
  let acted = 0;
  for (let i = 0; i < 200000; i++) {
    const d = decideNpcFocus(base({ rand }));
    if (d) { acted++; n[d.id] = (n[d.id] ?? 0) + 1; }
  }
  const radical = (n.b ?? 0) + (n.d ?? 0) + (n.v ?? 0);
  const calm = (n.s ?? 0) + (n.r ?? 0);
  assert.ok(acted > 8000, `約 6% 會行動,實際 ${acted}`);
  assert.ok(calm / acted > 0.78, `穩定+改革應 >78%,實際 ${(calm / acted).toFixed(3)}`);
  assert.ok(radical / acted < 0.22, `奪權線應 <22%,實際 ${(radical / acted).toFixed(3)}`);
  assert.ok((n.v ?? 0) < (n.b ?? 0), "革命比普通黑線更少");
});

test("內戰中或已有進行中的轉型 → 不動", () => {
  assert.equal(decideNpcFocus(base({ inCivilWar: true })), null);
  assert.equal(decideNpcFocus(base({ hasActiveRegimeFocus: true })), null);
});

test("點數不夠的候選被排除", () => {
  const cheap = def("c", "stable", { cost: 10 });
  const r = eligibleCandidates(base({ candidates: [{ def: cheap, isRevolution: false }, { def: stable, isRevolution: false }], points: 15 }));
  assert.deepEqual(r.map((c) => c.def.id), ["c"]);
  assert.equal(decideNpcFocus(base({ points: 5 })), null);
});

test("條件不過的候選被排除(例如紅線需要傾向值)", () => {
  const gated = def("g", "red", { conditions: [{ kind: "leanAtLeast", side: "red", value: 65 }] } as never);
  const pool = (red: number) => eligibleCandidates(base({ candidates: [{ def: gated, isRevolution: false }], facts: { ...facts, redLean: red } }));
  assert.equal(pool(10).length, 0);
  assert.equal(pool(70).length, 1);
});

test("全域奪權上限:額滿後奪權線候選全被排除,穩定線不受影響", () => {
  const full = eligibleCandidates(base({ radicalInFlight: 5, radicalCap: 5 }));
  assert.deepEqual(full.map((c) => c.def.id).sort(), ["r", "s"]);
  const rand = seeded(7);
  for (let i = 0; i < 20000; i++) {
    const d = decideNpcFocus(base({ rand, radicalInFlight: 5, radicalCap: 5 }));
    if (d) assert.ok(d.id === "s" || d.id === "r", `額滿後不可能抽到 ${d.id}`);
  }
  assert.equal(eligibleCandidates(base({ radicalInFlight: 4, radicalCap: 5 })).length, 5, "還有空位就都可選");
});

test("上限公式:至少 1,約 NPC 總數的 5%", () => {
  assert.equal(npcRadicalCap(0), 1);
  assert.equal(npcRadicalCap(10), 1);
  assert.equal(npcRadicalCap(40), 2);
  assert.equal(npcRadicalCap(100), 5);
});

test("isRadicalFocus:黑/紅/革命算奪權線,穩定/改革不算", () => {
  assert.equal(isRadicalFocus(black, false), true);
  assert.equal(isRadicalFocus(red, false), true);
  assert.equal(isRadicalFocus(stable, true), true);
  assert.equal(isRadicalFocus(stable, false), false);
  assert.equal(isRadicalFocus(reform, false), false);
});

test("沒有任何候選 → 維持現狀", () => {
  assert.equal(decideNpcFocus(base({ candidates: [] })), null);
});
