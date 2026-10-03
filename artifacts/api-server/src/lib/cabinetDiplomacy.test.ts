import { test } from "node:test";
import assert from "node:assert/strict";
import type { CabinetStyle } from "@workspace/db";
import {
  diplomatIntensity,
  diplomatActionBudget,
  concessionAutonomyFraction,
  concessionThresholds,
  isMajorConcession,
  extractDiplomatActions,
  sanitizeDiplomatActions,
  type RawDiplomatAction,
} from "./cabinet/domains/diplomacyPlanning";

// Task #245 — 外交官代理純函式單元測試（不觸 DB／IO／AI）。

function style(overreach: number, timidity: number): CabinetStyle {
  return { overreach, timidity, description: "" };
}

test("diplomatIntensity：代理程度為基準，越權高 +1、膽小高 −1，夾在 1..3", () => {
  const neutral = style(50, 50);
  assert.equal(diplomatIntensity("conservative", neutral), 1);
  assert.equal(diplomatIntensity("balanced", neutral), 2);
  assert.equal(diplomatIntensity("aggressive", neutral), 3);
  // 越權高（≥67）拉高，但積極已達上限 3。
  assert.equal(diplomatIntensity("aggressive", style(80, 10)), 3);
  assert.equal(diplomatIntensity("balanced", style(80, 10)), 3);
  // 膽小高（≥67）壓低，保守已達下限 1。
  assert.equal(diplomatIntensity("conservative", style(10, 80)), 1);
  assert.equal(diplomatIntensity("balanced", style(10, 80)), 1);
  // 越權與膽小同高 → 抵銷。
  assert.equal(diplomatIntensity("balanced", style(80, 80)), 2);
  assert.equal(diplomatActionBudget("balanced", neutral), 2);
});

test("concessionAutonomyFraction：代理基準 + 越權 − 膽小，夾在 0.01..0.5", () => {
  const neutral = style(0, 0);
  assert.ok(
    Math.abs(concessionAutonomyFraction("conservative", neutral) - 0.05) < 1e-9,
  );
  assert.ok(
    Math.abs(concessionAutonomyFraction("balanced", neutral) - 0.12) < 1e-9,
  );
  assert.ok(
    Math.abs(concessionAutonomyFraction("aggressive", neutral) - 0.25) < 1e-9,
  );
  // 膽小 100 把均衡壓到下限 0.01（0.12 - 0.15 < 0.01）。
  assert.equal(concessionAutonomyFraction("balanced", style(0, 100)), 0.01);
  // 越權 100 拉高積極 → 0.25 + 0.15 = 0.40。
  assert.ok(
    Math.abs(concessionAutonomyFraction("aggressive", style(100, 0)) - 0.4) <
      1e-9,
  );
});

test("concessionThresholds：門檻為持有量 × 比例（floor），負值視為 0", () => {
  const t = concessionThresholds(1000, 500, "balanced", style(0, 0));
  assert.equal(t.maxAutoMoney, 120); // floor(1000 * 0.12)
  assert.equal(t.maxAutoTech, 60); // floor(500 * 0.12)
  const z = concessionThresholds(-10, -10, "aggressive", style(0, 0));
  assert.equal(z.maxAutoMoney, 0);
  assert.equal(z.maxAutoTech, 0);
});

test("isMajorConcession：割地一律大額；金錢／科技超門檻為大額", () => {
  const th = { maxAutoMoney: 100, maxAutoTech: 50 };
  assert.equal(
    isMajorConcession(
      { offerMoney: 100, offerTechPoints: 50, offerRegionIds: [] },
      th,
    ),
    false,
  );
  assert.equal(
    isMajorConcession(
      { offerMoney: 101, offerTechPoints: 0, offerRegionIds: [] },
      th,
    ),
    true,
  );
  assert.equal(
    isMajorConcession(
      { offerMoney: 0, offerTechPoints: 51, offerRegionIds: [] },
      th,
    ),
    true,
  );
  // 割地一律大額，即使金額為 0。
  assert.equal(
    isMajorConcession(
      { offerMoney: 0, offerTechPoints: 0, offerRegionIds: [7] },
      th,
    ),
    true,
  );
});

test("extractDiplomatActions：去 code fence → JSON → zod 驗證", () => {
  const raw =
    '```json\n{"actions":[{"targetId":"npc-1","kind":"chat","message":"你好","reason":"睦鄰"}]}\n```';
  const actions = extractDiplomatActions(raw);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.targetId, "npc-1");
  assert.equal(actions[0]!.kind, "chat");
  // 格式錯誤丟例外。
  assert.throws(() => extractDiplomatActions("not json"));
});

const sanitizeCtx = {
  npcTargetIds: new Set(["npc-1", "npc-2", "npc-3"]),
  enabledActionKeys: new Set([
    "chat",
    "propose_treaty",
    "send_gift",
    "declare_war",
  ]),
  pendingTargetIds: new Set<string>(["npc-2"]),
  atWarTargetIds: new Set<string>(["npc-3"]),
  relationScores: new Map<string, number>([
    ["npc-1", 40],
    ["npc-2", 10],
    ["npc-3", -50],
  ]),
  budget: 3,
};

test("sanitizeDiplomatActions：只對 NPC、每對象至多一項、依 budget 截斷", () => {
  const raw: RawDiplomatAction[] = [
    { targetId: "player-x", kind: "chat", message: "hi" }, // 非 NPC → 丟棄
    { targetId: "npc-1", kind: "chat", message: "你好" },
    { targetId: "npc-1", kind: "treaty", treatyType: "nonaggression" }, // 同對象第二項 → 丟棄
    { targetId: "npc-2", kind: "chat", message: "嗨" },
  ];
  const out = sanitizeDiplomatActions(raw, sanitizeCtx);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((a) => a.targetId),
    ["npc-1", "npc-2"],
  );
});

test("sanitizeDiplomatActions：條約需未交戰且無進行中提案；自訂降為互不侵犯", () => {
  const raw: RawDiplomatAction[] = [
    { targetId: "npc-2", kind: "treaty", treatyType: "nonaggression" }, // 進行中提案 → 丟棄
    { targetId: "npc-3", kind: "treaty", treatyType: "nonaggression" }, // 交戰 → 丟棄
    { targetId: "npc-1", kind: "treaty", treatyType: "custom" }, // custom → 降為 nonaggression
  ];
  const out = sanitizeDiplomatActions(raw, sanitizeCtx);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.targetId, "npc-1");
  assert.equal(out[0]!.treatyType, "nonaggression");
});

test("sanitizeDiplomatActions：宣戰需授權、關係 < 0 且未交戰", () => {
  const raw: RawDiplomatAction[] = [
    { targetId: "npc-1", kind: "war" }, // 關係 40 ≥ 0 → 丟棄
    { targetId: "npc-3", kind: "war" }, // 交戰中 → 丟棄
  ];
  assert.equal(sanitizeDiplomatActions(raw, sanitizeCtx).length, 0);

  const okCtx = {
    ...sanitizeCtx,
    atWarTargetIds: new Set<string>(),
    relationScores: new Map<string, number>([["npc-3", -50]]),
  };
  const warOk: RawDiplomatAction[] = [{ targetId: "npc-3", kind: "war" }];
  const out = sanitizeDiplomatActions(warOk, okCtx);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "war");
});

test("sanitizeDiplomatActions：未授權 send_gift 時清零附帶讓步", () => {
  const noGiftCtx = {
    ...sanitizeCtx,
    enabledActionKeys: new Set(["propose_treaty"]),
  };
  const raw: RawDiplomatAction[] = [
    {
      targetId: "npc-1",
      kind: "treaty",
      treatyType: "nonaggression",
      offerMoney: 500,
      offerTechPoints: 200,
    },
  ];
  const out = sanitizeDiplomatActions(raw, noGiftCtx);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.offerMoney, 0);
  assert.equal(out[0]!.offerTechPoints, 0);
});

test("sanitizeDiplomatActions：未授權的 kind 一律丟棄", () => {
  const chatOnly = { ...sanitizeCtx, enabledActionKeys: new Set(["chat"]) };
  const raw: RawDiplomatAction[] = [
    { targetId: "npc-1", kind: "treaty", treatyType: "nonaggression" },
    { targetId: "npc-3", kind: "war" },
    { targetId: "npc-1", kind: "chat", message: "你好" },
  ];
  const out = sanitizeDiplomatActions(raw, chatOnly);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "chat");
});
