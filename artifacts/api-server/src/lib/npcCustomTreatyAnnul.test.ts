import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planNpcCustomTreatyAnnulments,
  NPC_CUSTOM_ANNUL_RELATION_THRESHOLD,
  type ActiveCustomTreatyRef,
} from "./npcCustomTreatyAnnul";

// canonicalPair 排序後 key 為 `low:high`（字串字典序）。
function relKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

test("NPC annuls custom treaty when relation is below threshold", () => {
  const treaties: ActiveCustomTreatyRef[] = [
    { id: 1, proposerNationId: "npc1", targetNationId: "player1" },
  ];
  const planned = planNpcCustomTreatyAnnulments(treaties, {
    npcIds: new Set(["npc1"]),
    relationScores: new Map([[relKey("npc1", "player1"), -50]]),
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0]!.treatyId, 1);
  assert.equal(planned[0]!.annullerNationId, "npc1");
});

test("NPC keeps treaty when relation at or above threshold", () => {
  const treaties: ActiveCustomTreatyRef[] = [
    { id: 1, proposerNationId: "npc1", targetNationId: "player1" },
  ];
  const planned = planNpcCustomTreatyAnnulments(treaties, {
    npcIds: new Set(["npc1"]),
    relationScores: new Map([
      [relKey("npc1", "player1"), NPC_CUSTOM_ANNUL_RELATION_THRESHOLD],
    ]),
  });
  assert.equal(planned.length, 0);
});

test("treaties with no NPC party are ignored (player↔player)", () => {
  const treaties: ActiveCustomTreatyRef[] = [
    { id: 1, proposerNationId: "player1", targetNationId: "player2" },
  ];
  const planned = planNpcCustomTreatyAnnulments(treaties, {
    npcIds: new Set(["npc1"]),
    relationScores: new Map([[relKey("player1", "player2"), -80]]),
  });
  assert.equal(planned.length, 0);
});

test("annuller is the NPC party when target is the NPC", () => {
  const treaties: ActiveCustomTreatyRef[] = [
    { id: 7, proposerNationId: "player1", targetNationId: "npc2" },
  ];
  const planned = planNpcCustomTreatyAnnulments(treaties, {
    npcIds: new Set(["npc2"]),
    relationScores: new Map([[relKey("player1", "npc2"), -60]]),
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0]!.annullerNationId, "npc2");
});

test("NPC↔NPC treaty annulled once, proposer is annuller", () => {
  const treaties: ActiveCustomTreatyRef[] = [
    { id: 3, proposerNationId: "npc1", targetNationId: "npc2" },
  ];
  const planned = planNpcCustomTreatyAnnulments(treaties, {
    npcIds: new Set(["npc1", "npc2"]),
    relationScores: new Map([[relKey("npc1", "npc2"), -90]]),
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0]!.annullerNationId, "npc1");
});

test("missing relation defaults to 0 → not annulled", () => {
  const treaties: ActiveCustomTreatyRef[] = [
    { id: 1, proposerNationId: "npc1", targetNationId: "player1" },
  ];
  const planned = planNpcCustomTreatyAnnulments(treaties, {
    npcIds: new Set(["npc1"]),
    relationScores: new Map(),
  });
  assert.equal(planned.length, 0);
});

test("custom threshold override respected", () => {
  const treaties: ActiveCustomTreatyRef[] = [
    { id: 1, proposerNationId: "npc1", targetNationId: "player1" },
  ];
  const planned = planNpcCustomTreatyAnnulments(treaties, {
    npcIds: new Set(["npc1"]),
    relationScores: new Map([[relKey("npc1", "player1"), -10]]),
    threshold: 0,
  });
  assert.equal(planned.length, 1);
});
