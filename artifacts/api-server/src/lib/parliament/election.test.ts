import test from "node:test";
import assert from "node:assert/strict";
import {
  ELECTION_INTERVAL, CAMPAIGN_TURNS, MAX_ACTIONS_PER_PARTY, MAX_ACTIONS_PER_ELECTION,
  hasElections, nextElectionTick, electionPhase, actionCost, caughtChance, actionEffect,
  checkActionAllowed, rollCaught, holdElection, rollOpinionNoise, type CampaignAction,
} from "./election";
import type { SeatedParty } from "./core";

const P = (id: string, seats: number, weight = seats): SeatedParty =>
  ({ id, name: `黨${id}`, stance: "welfare", weight, seats });
const THREE = [P("a", 50), P("b", 30), P("c", 20)];
const total = (ps: readonly SeatedParty[]) => ps.reduce((n, p) => n + p.seats, 0);

test("專制沒有選舉，民主與半專制有", () => {
  assert.equal(hasElections("autocracy"), false);
  assert.equal(hasElections("semi"), true);
  assert.equal(hasElections("democracy"), true);
  assert.equal(electionPhase("autocracy", 999, null), "none");
});

test("階段邊界：遠離=none、競選期、到期=polling", () => {
  const due = nextElectionTick(null);
  assert.equal(due, ELECTION_INTERVAL);
  assert.equal(electionPhase("democracy", due - CAMPAIGN_TURNS - 1, null), "none");
  assert.equal(electionPhase("democracy", due - CAMPAIGN_TURNS, null), "campaign");
  assert.equal(electionPhase("democracy", due - 1, null), "campaign");
  assert.equal(electionPhase("democracy", due, null), "polling");
  assert.equal(electionPhase("democracy", due + 5, null), "polling");
  // 選過之後以最近一次選舉為基準
  assert.equal(electionPhase("democracy", due + 1, due), "none");
  assert.equal(nextElectionTick(due), due + ELECTION_INTERVAL);
});

test("花費：半專制折半、隨國力係數縮放、壞係數退回 1", () => {
  assert.equal(actionCost("bribe", "democracy", 1), 3000);
  assert.equal(actionCost("bribe", "semi", 1), 1500);
  assert.equal(actionCost("canvass", "democracy", 2), 2000);
  assert.equal(actionCost("canvass", "democracy", Number.NaN), 1000);
  assert.equal(actionCost("canvass", "democracy", -5), 1000);
});

test("被抓機率：拉票永遠合法；半專制低於民主；專制為 0", () => {
  assert.equal(caughtChance("canvass", "democracy"), 0);
  assert.ok(caughtChance("bribe", "semi") < caughtChance("bribe", "democracy"));
  assert.equal(caughtChance("bribe", "autocracy"), 0);
  assert.equal(rollCaught("canvass", "democracy", () => 0), false);
  assert.equal(rollCaught("bribe", "democracy", () => 0.39), true);
  assert.equal(rollCaught("bribe", "democracy", () => 0.4), false);
});

test("操作效果：正常時方向正確；被抓時反轉且打折", () => {
  assert.ok(actionEffect({ action: "canvass", caught: false }) > 0);
  assert.ok(actionEffect({ action: "bribe", caught: false }) > actionEffect({ action: "canvass", caught: false }));
  assert.ok(actionEffect({ action: "suppress", caught: false }) < 0);
  assert.ok(actionEffect({ action: "bribe", caught: true }) < 0, "買票被抓反扣");
  assert.ok(actionEffect({ action: "suppress", caught: true }) > 0, "打壓被抓反而同情票");
  assert.ok(Math.abs(actionEffect({ action: "bribe", caught: true })) < Math.abs(actionEffect({ action: "bribe", caught: false })));
});

test("操作次數上限：同黨不重複同招、每黨 3 次、整場 8 次", () => {
  const A = (partyId: string, action: CampaignAction["action"]): CampaignAction => ({ partyId, action, caught: false });
  assert.equal(checkActionAllowed([], "a", "bribe"), null);
  assert.match(checkActionAllowed([A("a", "bribe")], "a", "bribe")!, /已經/);
  assert.equal(checkActionAllowed([A("a", "bribe")], "a", "canvass"), null);
  const three = [A("a", "bribe"), A("a", "canvass"), A("a", "suppress")];
  assert.equal(three.length, MAX_ACTIONS_PER_PARTY);
  assert.match(checkActionAllowed(three, "a", "bribe")!, /最多/);
  const many: CampaignAction[] = Array.from({ length: MAX_ACTIONS_PER_ELECTION }, (_, i) => A(`x${i}`, "canvass"));
  assert.match(checkActionAllowed(many, "new", "canvass")!, /本屆/);
});

test("開票：席次總和恆為 100、每黨至少 1 席、無操作無擾動則大致維持", () => {
  const r = holdElection(THREE, [], "democracy");
  assert.equal(total(r.parties), 100);
  assert.ok(r.parties.every((p) => p.seats >= 1));
  assert.equal(r.rulingId, "a");
  assert.equal(r.turnover, false);
});

test("開票：買票讓小黨翻盤→輪替；swings 記錄前後席次", () => {
  const acts: CampaignAction[] = [
    { partyId: "c", action: "bribe", caught: false },
    { partyId: "c", action: "canvass", caught: false },
    { partyId: "c", action: "bribe", caught: false },
  ];
  const noisy = holdElection(THREE, acts, "democracy", { c: 60 });
  assert.equal(total(noisy.parties), 100);
  assert.equal(noisy.rulingId, "c");
  assert.equal(noisy.turnover, true);
  const swing = noisy.swings.find((s) => s.partyId === "c")!;
  assert.equal(swing.before, 20);
  assert.ok(swing.after > swing.before);
});

test("開票：對最大黨被抓的買票會讓它掉票", () => {
  const clean = holdElection(THREE, [], "democracy");
  const caught = holdElection(THREE, [{ partyId: "a", action: "bribe", caught: true }], "democracy");
  assert.ok(caught.parties.find((p) => p.id === "a")!.seats < clean.parties.find((p) => p.id === "a")!.seats);
});

test("半專制：現任優勢讓同樣操作下現任黨席次更多", () => {
  const dem = holdElection(THREE, [], "democracy").parties.find((p) => p.id === "a")!.seats;
  const semi = holdElection(THREE, [], "semi").parties.find((p) => p.id === "a")!.seats;
  assert.ok(semi > dem);
});

test("極端輸入：負權重/巨大擾動/NaN 擾動不會讓席次壞掉", () => {
  const r = holdElection(THREE, [], "democracy", { a: -9999, b: 1e9, c: Number.NaN });
  assert.equal(total(r.parties), 100);
  assert.ok(r.parties.every((p) => p.seats >= 1 && Number.isFinite(p.seats)));
});

test("民意擾動：範圍受限、可注入 rng", () => {
  assert.deepEqual(rollOpinionNoise(["a", "b"], 10, () => 0.5), { a: 0, b: 0 });
  assert.deepEqual(rollOpinionNoise(["a"], 10, () => 1), { a: 10 });
  assert.deepEqual(rollOpinionNoise(["a"], 10, () => 0), { a: -10 });
});
