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
