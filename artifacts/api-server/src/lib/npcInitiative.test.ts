import { strict as assert } from "node:assert";
import test from "node:test";
import {
  initiativeCaps,
  pairKey,
  sanitizeInitiatives,
  coerceNpcToNpcDecision,
  extractNpcInitiatives,
  type RawNpcInitiative,
  type SanitizeInitiativesContext,
} from "./npcInitiative";
import { hasRecentEndedWar, WAR_REDECLARE_COOLDOWN_MS } from "./treatyPropose";
import type { NpcTreatyDecision } from "./diplomacyAi";

// ── initiativeCaps ────────────────────────────────────────────

test("initiativeCaps scales treaties with intensity, wars always ≤1", () => {
  assert.deepEqual(initiativeCaps(1), { maxTreaties: 2, maxWars: 1 });
  assert.deepEqual(initiativeCaps(2), { maxTreaties: 4, maxWars: 1 });
  assert.deepEqual(initiativeCaps(3), { maxTreaties: 6, maxWars: 1 });
  // 未知強度回退到低強度上限。
  assert.deepEqual(initiativeCaps(99), { maxTreaties: 2, maxWars: 1 });
  assert.deepEqual(initiativeCaps(0), { maxTreaties: 2, maxWars: 1 });
});

// ── pairKey ───────────────────────────────────────────────────

test("pairKey is canonical (order-independent)", () => {
  assert.equal(pairKey("a", "b"), pairKey("b", "a"));
  assert.equal(pairKey("a", "b"), "a:b");
});

// ── hasRecentEndedWar ─────────────────────────────────────────

test("hasRecentEndedWar ignores nulls and honours the cooldown window", () => {
  const now = new Date("2026-07-04T00:00:00Z");
  // 交戰中（null）不算。
  assert.equal(hasRecentEndedWar([null, null], now), false);
  assert.equal(hasRecentEndedWar([], now), false);
  // 剛結束（1 天前）→ 在 7 天窗內 → true。
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  assert.equal(hasRecentEndedWar([oneDayAgo], now), true);
  // 8 天前 → 超出窗 → false。
  const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  assert.equal(hasRecentEndedWar([eightDaysAgo], now), false);
  // 剛好等於窗邊界（不小於 → false）。
  const exactly = new Date(now.getTime() - WAR_REDECLARE_COOLDOWN_MS);
  assert.equal(hasRecentEndedWar([exactly], now), false);
  // 多筆中只要一筆在窗內即 true。
  assert.equal(hasRecentEndedWar([eightDaysAgo, oneDayAgo], now), true);
});

// ── coerceNpcToNpcDecision ────────────────────────────────────

test("coerceNpcToNpcDecision downgrades counter to reject, leaves others", () => {
  const counter: NpcTreatyDecision = {
    decision: "counter",
    note: "希望縮短年限",
    relationDelta: 0,
    counter: { durationDays: 30, demandMoney: 0, demandTechPoints: 0 },
  };
  const coerced = coerceNpcToNpcDecision(counter);
  assert.equal(coerced.decision, "reject");
  assert.equal(coerced.counter, null);
  assert.equal(coerced.note, "希望縮短年限");

  const accept: NpcTreatyDecision = {
    decision: "accept",
    note: "同意",
    counter: null,
    relationDelta: 0,
  };
  assert.deepEqual(coerceNpcToNpcDecision(accept), accept);

  const reject: NpcTreatyDecision = {
    decision: "reject",
    note: "拒絕",
    counter: null,
    relationDelta: 0,
  };
  assert.deepEqual(coerceNpcToNpcDecision(reject), reject);
});

// ── extractNpcInitiatives ─────────────────────────────────────

test("extractNpcInitiatives strips code fence and parses", () => {
  const raw =
    '```json\n{"initiatives":[{"actorId":"n1","targetId":"p1","kind":"treaty","treatyType":"guarantee","durationDays":30}]}\n```';
  const out = extractNpcInitiatives(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "treaty");
  assert.equal(out[0]!.treatyType, "guarantee");
});

test("extractNpcInitiatives parses kind=alliance", () => {
  const raw = '{"initiatives":[{"actorId":"n1","targetId":"n2","kind":"alliance"}]}';
  const out = extractNpcInitiatives(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "alliance");
});

test("extractNpcInitiatives throws on invalid JSON / shape", () => {
  assert.throws(() => extractNpcInitiatives("not json"));
  assert.throws(() =>
    extractNpcInitiatives('{"initiatives":[{"actorId":"n1"}]}'),
  );
});

// ── sanitizeInitiatives ───────────────────────────────────────

/** 建立一個標準脈絡：NPC n1/n2；玩家 p1；無主 u1（不在任何集合）。 */
function baseCtx(
  overrides: Partial<SanitizeInitiativesContext> = {},
): SanitizeInitiativesContext {
  return {
    actorIds: new Set(["n1", "n2"]),
    treatyTargetIds: new Set(["n1", "n2", "p1"]),
    playerIds: new Set(["p1"]),
    relationScores: new Map(),
    pendingPairs: new Set(),
    activeWarPairs: new Set(),
    hostileToPlayers: false,
    caps: { maxTreaties: 6, maxWars: 1 },
    ...overrides,
  };
}

test("sanitize drops non-actor, self, and pending pairs", () => {
  const raw: RawNpcInitiative[] = [
    { actorId: "p1", targetId: "n1", kind: "treaty" }, // p1 非行動者
    { actorId: "n1", targetId: "n1", kind: "treaty" }, // 自己
    { actorId: "n1", targetId: "n2", kind: "treaty" }, // 已有提案
  ];
  const out = sanitizeInitiatives(raw, {
    ...baseCtx(),
    pendingPairs: new Set([pairKey("n1", "n2")]),
  });
  assert.equal(out.length, 0);
});

test("sanitize treaty: default type, targetIsPlayer flag, dedupe pair", () => {
  const raw: RawNpcInitiative[] = [
    { actorId: "n1", targetId: "p1", kind: "treaty", treatyType: "bogus" },
    { actorId: "n1", targetId: "p1", kind: "treaty", treatyType: "guarantee" }, // 同 pair → 丟
    { actorId: "n1", targetId: "n2", kind: "treaty", treatyType: "guarantee" },
  ];
  const out = sanitizeInitiatives(raw, baseCtx());
  assert.equal(out.length, 2);
  const toPlayer = out.find((o) => o.targetId === "p1")!;
  assert.equal(toPlayer.treatyType, "nonaggression"); // 非法類型→預設
  assert.equal(toPlayer.targetIsPlayer, true);
  const toNpc = out.find((o) => o.targetId === "n2")!;
  assert.equal(toNpc.treatyType, "guarantee");
  assert.equal(toNpc.targetIsPlayer, false);
});

test("sanitize treaty: target not in list, or at war, dropped", () => {
  const raw: RawNpcInitiative[] = [
    { actorId: "n1", targetId: "u1", kind: "treaty" }, // 無主，不在 treatyTargetIds
    { actorId: "n1", targetId: "p1", kind: "treaty" }, // 交戰中 pair
  ];
  const out = sanitizeInitiatives(raw, {
    ...baseCtx(),
    activeWarPairs: new Set([pairKey("n1", "p1")]),
  });
  assert.equal(out.length, 0);
});

test("sanitize treaty cap respected", () => {
  const raw: RawNpcInitiative[] = [
    { actorId: "n1", targetId: "p1", kind: "treaty" },
    { actorId: "n1", targetId: "n2", kind: "treaty" },
  ];
  const out = sanitizeInitiatives(raw, {
    ...baseCtx(),
    caps: { maxTreaties: 1, maxWars: 1 },
  });
  assert.equal(out.length, 1);
});

test("sanitize war requires hostile flag + player target + relation<0 + not at war", () => {
  const war = (over: Partial<SanitizeInitiativesContext>) =>
    sanitizeInitiatives([{ actorId: "n1", targetId: "p1", kind: "war" }], {
      ...baseCtx({
        hostileToPlayers: true,
        relationScores: new Map([[pairKey("n1", "p1"), -10]]),
      }),
      ...over,
    });

  // 敵對關閉 → 丟。
  assert.equal(war({ hostileToPlayers: false }).length, 0);
  // 關係 ≥ 0 → 丟。
  assert.equal(war({ relationScores: new Map([[pairKey("n1", "p1"), 5]]) }).length, 0);
  // 已交戰 → 丟。
  assert.equal(war({ activeWarPairs: new Set([pairKey("n1", "p1")]) }).length, 0);
  // 一切滿足 → 保留一筆宣戰。
  const ok = war({});
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.kind, "war");
  assert.equal(ok[0]!.targetIsPlayer, true);
});

test("sanitize war: NPC target (non-player) is dropped even when hostile", () => {
  const out = sanitizeInitiatives(
    [{ actorId: "n1", targetId: "n2", kind: "war" }],
    baseCtx({
      hostileToPlayers: true,
      relationScores: new Map([[pairKey("n1", "n2"), -50]]),
    }),
  );
  assert.equal(out.length, 0);
});

test("sanitize war cap ≤1 even with multiple hostile targets", () => {
  const out = sanitizeInitiatives(
    [
      { actorId: "n1", targetId: "p1", kind: "war" },
      { actorId: "n2", targetId: "p1", kind: "war" },
    ],
    baseCtx({
      hostileToPlayers: true,
      relationScores: new Map([
        [pairKey("n1", "p1"), -10],
        [pairKey("n2", "p1"), -10],
      ]),
    }),
  );
  assert.equal(out.filter((o) => o.kind === "war").length, 1);
});

test("sanitize alliance: NPC target + relation>0 kept; player/无主/relation≤0 dropped", () => {
  // 對象為玩家 → 丟。
  assert.equal(
    sanitizeInitiatives(
      [{ actorId: "n1", targetId: "p1", kind: "alliance" }],
      baseCtx({ relationScores: new Map([[pairKey("n1", "p1"), 20]]) }),
    ).length,
    0,
  );
  // 對象非候選（無主 u1）→ 丟。
  assert.equal(
    sanitizeInitiatives(
      [{ actorId: "n1", targetId: "u1", kind: "alliance" }],
      baseCtx({ relationScores: new Map([[pairKey("n1", "u1"), 20]]) }),
    ).length,
    0,
  );
  // 關係 ≤ 0 → 丟。
  assert.equal(
    sanitizeInitiatives(
      [{ actorId: "n1", targetId: "n2", kind: "alliance" }],
      baseCtx({ relationScores: new Map([[pairKey("n1", "n2"), 0]]) }),
    ).length,
    0,
  );
  // NPC 對象 + 關係 > 0 → 保留。
  const ok = sanitizeInitiatives(
    [{ actorId: "n1", targetId: "n2", kind: "alliance" }],
    baseCtx({ relationScores: new Map([[pairKey("n1", "n2"), 15]]) }),
  );
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.kind, "alliance");
  assert.equal(ok[0]!.targetIsPlayer, false);
});

test("sanitize alliance: at-war pair dropped, counts under maxTreaties cap", () => {
  // 交戰中 pair → 丟。
  assert.equal(
    sanitizeInitiatives(
      [{ actorId: "n1", targetId: "n2", kind: "alliance" }],
      baseCtx({
        relationScores: new Map([[pairKey("n1", "n2"), 15]]),
        activeWarPairs: new Set([pairKey("n1", "n2")]),
      }),
    ).length,
    0,
  );
  // 聯盟與條約共用 maxTreaties 上限。
  const out = sanitizeInitiatives(
    [
      { actorId: "n1", targetId: "n2", kind: "alliance" },
      { actorId: "n1", targetId: "p1", kind: "treaty" },
    ],
    baseCtx({
      relationScores: new Map([[pairKey("n1", "n2"), 15]]),
      caps: { maxTreaties: 1, maxWars: 1 },
    }),
  );
  assert.equal(out.length, 1);
});

// ── Task #380：一次性交換（金錢／領土） ───────────────────────

import {
  resolveInitiativeRegions,
  clampInitiativeMoney,
  type InitiativeTerritoryContext,
} from "./npcInitiative";

function baseTerritory(): InitiativeTerritoryContext {
  return {
    regionIdByName: new Map([
      ["北原", 1],
      ["南灣", 2],
      ["東港", 3],
    ]),
    heldByNation: new Map([
      ["n1", new Map([[1, 80]])],
      ["n2", new Map([[2, 100], [3, 40]])],
    ]),
    moneyByNation: new Map([
      ["n1", 500],
      ["n2", 0],
    ]),
  };
}

test("resolveInitiativeRegions resolves valid names within held share", () => {
  const terr = baseTerritory();
  const out = resolveInitiativeRegions({
    regions: [{ name: " 北原 ", percent: 50 }],
    regionIdByName: terr.regionIdByName,
    held: terr.heldByNation.get("n1"),
  });
  assert.deepEqual(out.regionIds, [1]);
  assert.equal(out.regionPercents["1"], 50);
});

test("resolveInitiativeRegions: unknown name / over-held percent / not-held region → whole side empty", () => {
  const terr = baseTerritory();
  // 名稱不存在。
  assert.deepEqual(
    resolveInitiativeRegions({
      regions: [{ name: "不存在", percent: 10 }],
      regionIdByName: terr.regionIdByName,
      held: terr.heldByNation.get("n1"),
    }).regionIds,
    [],
  );
  // 百分比超過實際掌控（n2 只掌控東港 40%）。
  assert.deepEqual(
    resolveInitiativeRegions({
      regions: [{ name: "東港", percent: 60 }],
      regionIdByName: terr.regionIdByName,
      held: terr.heldByNation.get("n2"),
    }).regionIds,
    [],
  );
  // 地區不屬於該側國家（n1 未掌控南灣），一筆失敗 → 整側清空。
  assert.deepEqual(
    resolveInitiativeRegions({
      regions: [
        { name: "北原", percent: 10 },
        { name: "南灣", percent: 10 },
      ],
      regionIdByName: terr.regionIdByName,
      held: terr.heldByNation.get("n1"),
    }).regionIds,
    [],
  );
  // 沒有 held（該國無領土）→ 空。
  assert.deepEqual(
    resolveInitiativeRegions({
      regions: [{ name: "北原" }],
      regionIdByName: terr.regionIdByName,
      held: undefined,
    }).regionIds,
    [],
  );
});

test("resolveInitiativeRegions: omitted percent means whole held share", () => {
  const terr = baseTerritory();
  const out = resolveInitiativeRegions({
    regions: [{ name: "東港", percent: null }],
    regionIdByName: terr.regionIdByName,
    held: terr.heldByNation.get("n2"),
  });
  assert.deepEqual(out.regionIds, [3]);
});

test("clampInitiativeMoney clamps to [0, treasury] and zeroes invalid input", () => {
  assert.equal(clampInitiativeMoney(300, 500), 300);
  assert.equal(clampInitiativeMoney(900, 500), 500);
  assert.equal(clampInitiativeMoney(0, 500), 0);
  assert.equal(clampInitiativeMoney(-5, 500), 0);
  assert.equal(clampInitiativeMoney(1.5, 500), 0);
  assert.equal(clampInitiativeMoney(undefined, 500), 0);
  assert.equal(clampInitiativeMoney(100, 0), 0);
});

test("sanitize treaty attaches validated exchange when territory ctx present", () => {
  const raw: RawNpcInitiative[] = [
    {
      actorId: "n1",
      targetId: "n2",
      kind: "treaty",
      treatyType: "nonaggression",
      offerMoney: 9999, // clamp 到 n1 國庫 500
      requestMoney: 100, // n2 國庫 0 → 0
      offerRegions: [{ name: "北原", percent: 30 }],
      requestRegions: [{ name: "東港", percent: 60 }], // 超過 n2 掌控 40% → request 側清空
    },
  ];
  const out = sanitizeInitiatives(raw, {
    ...baseCtx(),
    territory: baseTerritory(),
  });
  assert.equal(out.length, 1);
  const p = out[0]!;
  assert.equal(p.offerMoney, 500);
  assert.equal(p.requestMoney, 0);
  assert.deepEqual(p.offerRegionIds, [1]);
  assert.equal(p.offerRegionPercents["1"], 30);
  assert.deepEqual(p.requestRegionIds, []);
});

test("sanitize without territory ctx strips all exchange fields", () => {
  const raw: RawNpcInitiative[] = [
    {
      actorId: "n1",
      targetId: "n2",
      kind: "treaty",
      offerMoney: 100,
      offerRegions: [{ name: "北原", percent: 10 }],
    },
  ];
  const out = sanitizeInitiatives(raw, baseCtx());
  assert.equal(out.length, 1);
  assert.equal(out[0]!.offerMoney, 0);
  assert.deepEqual(out[0]!.offerRegionIds, []);
});

test("sanitize war/alliance always carry zero exchange", () => {
  const out = sanitizeInitiatives(
    [
      {
        actorId: "n1",
        targetId: "n2",
        kind: "alliance",
        offerMoney: 100,
        offerRegions: [{ name: "北原", percent: 10 }],
      },
    ],
    baseCtx({
      relationScores: new Map([[pairKey("n1", "n2"), 15]]),
      territory: baseTerritory(),
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.offerMoney, 0);
  assert.deepEqual(out[0]!.offerRegionIds, []);
});
