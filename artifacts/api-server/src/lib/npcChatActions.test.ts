import { strict as assert } from "node:assert";
import test from "node:test";
import {
  chatActionCaps,
  sanitizeChatActions,
  CHAT_GIFT_MIN_RELATION,
  CHAT_GIFT_MAX_FRACTION,
  CHAT_EXCHANGE_MIN_RELATION,
  CHAT_EXCHANGE_MAX_FRACTION,
  CHAT_EXCHANGE_MAX_REGIONS,
  type ChatActionCandidate,
  type ChatActionContext,
  type ChatActionRejection,
  type RawChatAction,
} from "./npcChatActions";

const ACTOR = "npc-actor";
const PLAYER = "player-1"; // 對話對象
const PLAYER2 = "player-2"; // 另一位玩家
const NPC2 = "npc-2"; // 另一個 NPC

function candidate(over: Partial<ChatActionCandidate> = {}): ChatActionCandidate {
  return {
    kind: "player",
    relationScore: 0,
    atWar: false,
    hasPendingProposal: false,
    ...over,
  };
}

function ctx(over: Partial<ChatActionContext> = {}): ChatActionContext {
  const candidates = new Map<string, ChatActionCandidate>([
    [PLAYER, candidate()],
    [PLAYER2, candidate()],
    [NPC2, candidate({ kind: "npc" })],
  ]);
  return {
    actorId: ACTOR,
    counterpartId: PLAYER,
    candidates,
    npcMoney: 1000,
    npcTechPoints: 500,
    npcRegionIds: new Set<number>([10, 11, 12]),
    counterpartMoney: 1000,
    counterpartTechPoints: 500,
    counterpartRegionPercents: new Map<number, number>([
      [20, 100],
      [21, 100],
    ]),
    level: 3,
    ...over,
  };
}

function raw(over: Partial<RawChatAction> & Pick<RawChatAction, "type" | "targetId">): RawChatAction {
  return {
    treatyType: null,
    durationDays: null,
    offerMoney: null,
    offerTechPoints: null,
    offerRegionIds: null,
    clause: null,
    ...over,
  };
}

test("chatActionCaps：保守/中等/積極的上限與戰爭門檻", () => {
  assert.deepEqual(chatActionCaps(1), { maxActions: 1, warRelationThreshold: -40 });
  assert.deepEqual(chatActionCaps(2), { maxActions: 2, warRelationThreshold: -1 });
  assert.deepEqual(chatActionCaps(3), { maxActions: 2, warRelationThreshold: -1 });
  // 越界值退回積極設定。
  assert.deepEqual(chatActionCaps(99), { maxActions: 2, warRelationThreshold: -1 });
  assert.deepEqual(chatActionCaps(0), { maxActions: 2, warRelationThreshold: -1 });
});

test("目標不在候選集合 → 丟棄", () => {
  const out = sanitizeChatActions([raw({ type: "gift", targetId: "ghost", offerMoney: 10 })], ctx());
  assert.equal(out.length, 0);
});

test("目標是 NPC 自己 → 丟棄", () => {
  const out = sanitizeChatActions([raw({ type: "propose_treaty", targetId: ACTOR })], ctx());
  assert.equal(out.length, 0);
});

test("宣戰只能對真人玩家（NPC 目標丟棄）", () => {
  const out = sanitizeChatActions(
    [raw({ type: "declare_war", targetId: NPC2 })],
    ctx({
      candidates: new Map([[NPC2, candidate({ kind: "npc", relationScore: -80 })]]),
    }),
  );
  assert.equal(out.length, 0);
});

test("宣戰：積極(3) 關係為負可發動", () => {
  const out = sanitizeChatActions(
    [raw({ type: "declare_war", targetId: PLAYER })],
    ctx({ candidates: mapWith(PLAYER, candidate({ relationScore: -5 })) }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, "declare_war");
  assert.equal(out[0]!.targetIsPlayer, true);
});

test("宣戰：保守(1) 關係僅微負(>-40) → 丟棄；已交戰仍可（出兵）", () => {
  const mild = sanitizeChatActions(
    [raw({ type: "declare_war", targetId: PLAYER })],
    ctx({ level: 1, candidates: mapWith(PLAYER, candidate({ relationScore: -10 })) }),
  );
  assert.equal(mild.length, 0);

  const deep = sanitizeChatActions(
    [raw({ type: "declare_war", targetId: PLAYER })],
    ctx({ level: 1, candidates: mapWith(PLAYER, candidate({ relationScore: -50 })) }),
  );
  assert.equal(deep.length, 1);

  const atWar = sanitizeChatActions(
    [raw({ type: "initiate_campaign", targetId: PLAYER })],
    ctx({ level: 1, candidates: mapWith(PLAYER, candidate({ relationScore: 20, atWar: true })) }),
  );
  assert.equal(atWar.length, 1);
  assert.equal(atWar[0]!.type, "initiate_campaign");
});

test("每則訊息至多一個戰爭類動作", () => {
  const out = sanitizeChatActions(
    [
      raw({ type: "declare_war", targetId: PLAYER }),
      raw({ type: "initiate_campaign", targetId: PLAYER2 }),
    ],
    ctx({
      candidates: new Map([
        [PLAYER, candidate({ relationScore: -30 })],
        [PLAYER2, candidate({ relationScore: 10, atWar: true })],
      ]),
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, "declare_war");
});

test("停戰：需正在交戰；未交戰 → 丟棄", () => {
  const notAtWar = sanitizeChatActions([raw({ type: "ceasefire", targetId: PLAYER })], ctx());
  assert.equal(notAtWar.length, 0);

  const atWar = sanitizeChatActions(
    [raw({ type: "ceasefire", targetId: PLAYER })],
    ctx({ candidates: mapWith(PLAYER, candidate({ atWar: true })) }),
  );
  assert.equal(atWar.length, 1);
  assert.equal(atWar[0]!.type, "ceasefire");
});

test("締約：交戰中或已有待回覆提案 → 丟棄；否則預設互不侵犯", () => {
  const atWar = sanitizeChatActions(
    [raw({ type: "propose_treaty", targetId: PLAYER, treatyType: "nonaggression" })],
    ctx({ candidates: mapWith(PLAYER, candidate({ atWar: true })) }),
  );
  assert.equal(atWar.length, 0);

  const pending = sanitizeChatActions(
    [raw({ type: "propose_treaty", targetId: PLAYER })],
    ctx({ candidates: mapWith(PLAYER, candidate({ hasPendingProposal: true })) }),
  );
  assert.equal(pending.length, 0);

  const ok = sanitizeChatActions(
    [raw({ type: "propose_treaty", targetId: PLAYER, treatyType: "military_access", durationDays: 30 })],
    ctx(),
  );
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.treatyType, "military_access");
  assert.equal(ok[0]!.durationDays, 30);
});

test("締約：不允許的類型（custom/同盟/亂填）→ 退回互不侵犯", () => {
  for (const t of ["custom", "alliance", "garbage"]) {
    const out = sanitizeChatActions(
      [raw({ type: "propose_treaty", targetId: NPC2, treatyType: t })],
      ctx({ candidates: mapWith(NPC2, candidate({ kind: "npc" })) }),
    );
    assert.equal(out.length, 1, `type=${t}`);
    assert.equal(out[0]!.treatyType, "nonaggression", `type=${t}`);
    assert.equal(out[0]!.targetIsPlayer, false);
  }
});

test("結盟：關係需為正且未交戰", () => {
  const neutral = sanitizeChatActions([raw({ type: "alliance", targetId: PLAYER })], ctx());
  assert.equal(neutral.length, 0);

  const positive = sanitizeChatActions(
    [raw({ type: "alliance", targetId: PLAYER })],
    ctx({ candidates: mapWith(PLAYER, candidate({ relationScore: 40 })) }),
  );
  assert.equal(positive.length, 1);
  assert.equal(positive[0]!.type, "alliance");
});

test("送禮：只能對正在對話的玩家，且必須實際給資源", () => {
  const toOther = sanitizeChatActions(
    [raw({ type: "gift", targetId: PLAYER2, offerMoney: 100 })],
    ctx({
      candidates: new Map([
        [PLAYER2, candidate({ relationScore: CHAT_GIFT_MIN_RELATION })],
      ]),
    }),
  );
  assert.equal(toOther.length, 0);

  const empty = sanitizeChatActions(
    [raw({ type: "gift", targetId: PLAYER })],
    ctx({
      candidates: mapWith(
        PLAYER,
        candidate({ relationScore: CHAT_GIFT_MIN_RELATION }),
      ),
    }),
  );
  assert.equal(empty.length, 0);

  const ok = sanitizeChatActions(
    [raw({ type: "gift", targetId: PLAYER, offerMoney: 40, offerTechPoints: 20 })],
    ctx({
      candidates: mapWith(
        PLAYER,
        candidate({ relationScore: CHAT_GIFT_MIN_RELATION }),
      ),
    }),
  );
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.offerMoney, 40);
  assert.equal(ok[0]!.offerTechPoints, 20);
});

// Task #499 — 送禮＝無對價讓利：關係值不夠高一律剔除，且記 log 觀察操縱嘗試。
test("送禮：關係值低於門檻 → 剔除並回報 onReject（賣慘／恭維洗不出禮物）", () => {
  const rejections: ChatActionRejection[] = [];
  const out = sanitizeChatActions(
    [raw({ type: "gift", targetId: PLAYER, offerMoney: 100 })],
    ctx({
      candidates: mapWith(
        PLAYER,
        candidate({ relationScore: CHAT_GIFT_MIN_RELATION - 1 }),
      ),
    }),
    (r) => rejections.push(r),
  );
  assert.equal(out.length, 0);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]!.type, "gift");
  assert.equal(rejections[0]!.targetId, PLAYER);
  assert.match(rejections[0]!.reason, /門檻/);
});

test("送禮：金額以 NPC 現有資源的比例上限封頂（被騙也送不出家底）", () => {
  const out = sanitizeChatActions(
    [raw({ type: "gift", targetId: PLAYER, offerMoney: 999999, offerTechPoints: 999999 })],
    ctx({
      npcMoney: 200,
      npcTechPoints: 100,
      candidates: mapWith(PLAYER, candidate({ relationScore: 50 })),
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.offerMoney, Math.floor(200 * CHAT_GIFT_MAX_FRACTION));
  assert.equal(
    out[0]!.offerTechPoints,
    Math.floor(100 * CHAT_GIFT_MAX_FRACTION),
  );
});

test("送禮：比例上限夾限後歸零 → 剔除並回報 onReject", () => {
  const rejections: ChatActionRejection[] = [];
  const out = sanitizeChatActions(
    [raw({ type: "gift", targetId: PLAYER, offerMoney: 5, offerTechPoints: 3 })],
    ctx({
      // 5% 上限：floor(10×0.05)=0、floor(5×0.05)=0 → 沒東西可送。
      npcMoney: 10,
      npcTechPoints: 5,
      candidates: mapWith(PLAYER, candidate({ relationScore: 50 })),
    }),
    (r) => rejections.push(r),
  );
  assert.equal(out.length, 0);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]!.type, "gift");
});

test("交換：地區過濾為 NPC 實際掌控且去重", () => {
  const out = sanitizeChatActions(
    [
      raw({
        type: "exchange",
        targetId: PLAYER,
        offerRegionIds: [10, 10, 11, 999, 12],
        offerMoney: 100,
        clause: "以此換取和平",
      }),
    ],
    ctx(),
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.offerRegionIds, [10, 11, 12]);
  assert.equal(out[0]!.offerMoney, 100);
  assert.equal(out[0]!.clause, "以此換取和平");
});

test("交換：什麼都沒提供 → 丟棄", () => {
  const out = sanitizeChatActions([raw({ type: "exchange", targetId: PLAYER })], ctx());
  assert.equal(out.length, 0);
});

// Task #499 — 交換提案的反操縱守門。
test("交換：關係值為負 → 剔除並回報 onReject", () => {
  const rejections: ChatActionRejection[] = [];
  const out = sanitizeChatActions(
    [raw({ type: "exchange", targetId: PLAYER, offerMoney: 50 })],
    ctx({
      candidates: mapWith(
        PLAYER,
        candidate({ relationScore: CHAT_EXCHANGE_MIN_RELATION - 1 }),
      ),
    }),
    (r) => rejections.push(r),
  );
  assert.equal(out.length, 0);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]!.type, "exchange");
  assert.match(rejections[0]!.reason, /門檻/);
});

test("交換：出價以比例上限封頂、讓地至多 3 區", () => {
  const out = sanitizeChatActions(
    [
      raw({
        type: "exchange",
        targetId: PLAYER,
        offerMoney: 999999,
        offerTechPoints: 999999,
        offerRegionIds: [10, 11, 12, 13],
      }),
    ],
    ctx({ npcRegionIds: new Set<number>([10, 11, 12, 13]) }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.offerMoney, Math.floor(1000 * CHAT_EXCHANGE_MAX_FRACTION));
  assert.equal(
    out[0]!.offerTechPoints,
    Math.floor(500 * CHAT_EXCHANGE_MAX_FRACTION),
  );
  assert.equal(out[0]!.offerRegionIds.length, CHAT_EXCHANGE_MAX_REGIONS);
  assert.deepEqual(out[0]!.offerRegionIds, [10, 11, 12]);
});

test("動作總數受積極度上限；同一 (type,target) 去重", () => {
  // Task #499 起送禮需要關係值 ≥ CHAT_GIFT_MIN_RELATION，測試候選集合須帶高關係。
  const friendly = () =>
    new Map<string, ChatActionCandidate>([
      [PLAYER, candidate({ relationScore: 50 })],
      [PLAYER2, candidate()],
      [NPC2, candidate({ kind: "npc" })],
    ]);

  const overCap = sanitizeChatActions(
    [
      raw({ type: "gift", targetId: PLAYER, offerMoney: 10 }),
      raw({ type: "propose_treaty", targetId: PLAYER2 }),
      raw({ type: "propose_treaty", targetId: NPC2 }),
    ],
    ctx({ level: 2, candidates: friendly() }),
  );
  assert.equal(overCap.length, 2);

  const dup = sanitizeChatActions(
    [
      raw({ type: "gift", targetId: PLAYER, offerMoney: 10 }),
      raw({ type: "gift", targetId: PLAYER, offerMoney: 20 }),
    ],
    ctx({ candidates: friendly() }),
  );
  assert.equal(dup.length, 1);
  assert.equal(dup[0]!.offerMoney, 10);

  const level1 = sanitizeChatActions(
    [
      raw({ type: "gift", targetId: PLAYER, offerMoney: 10 }),
      raw({ type: "propose_treaty", targetId: PLAYER2 }),
    ],
    ctx({ level: 1, candidates: friendly() }),
  );
  assert.equal(level1.length, 1);
});

function mapWith(
  id: string,
  cand: ChatActionCandidate,
): Map<string, ChatActionCandidate> {
  return new Map([[id, cand]]);
}
