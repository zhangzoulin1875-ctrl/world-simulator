import { strict as assert } from "node:assert";
import test from "node:test";
import {
  TREATY_TYPES,
  RELATION_ACTIONS,
  SYSTEM_RELATION_ACTIONS,
  TREATY_ANNUL_RELATION_PENALTY,
  describeRelationAction,
  RELATION_MIN,
  RELATION_MAX,
  autoJoinNationIds,
  bfsRegionDistances,
  canonicalPair,
  clampRelationScore,
  clampChatRelationDelta,
  clampChatTalkRelationDelta,
  CHAT_RELATION_DELTA_MIN,
  CHAT_RELATION_DELTA_MAX,
  CHAT_TALK_POSITIVE_DELTA_MAX,
  AI_CHAT_TURN_CAP,
  compareByDistance,
  findWarBlockingTreatyType,
  giftCost,
  isRelationAction,
  isTreatyType,
  isTreatyInEffect,
  nationDistance,
  npcReproposalCooldownMessage,
  npcReproposalCooldownRemainingMs,
  NPC_REPROPOSAL_COOLDOWN_MS,
  NPC_HISTORY_MAX_AGE_MS,
  NPC_HISTORY_MAX_ENTRIES,
  NPC_HISTORY_NOTE_MAX_CHARS,
  NPC_RELATION_EVENTS_MAX_AGE_MS,
  NPC_RELATION_EVENTS_MAX_ENTRIES,
  RELATION_EVENTS_RETENTION_MS,
  relationEventsPruneCutoff,
  summarizeNpcRelationEvents,
  summarizeNpcTreatyHistory,
  treatyTypeLabel,
  type NpcRelationEventRow,
  type NpcTreatyHistoryRow,
  type TreatyEffectView,
  parseTreatyRegionSelection,
  mergeNpcCounterDemandRegions,
  vassalPartiesOf,
  findActiveSuzerainId,
} from "./diplomacy";

test("TREATY_TYPES has unique types with labels (alliance removed)", () => {
  assert.equal(
    new Set(TREATY_TYPES.map((t) => t.slug)).size,
    TREATY_TYPES.length,
  );
  for (const t of TREATY_TYPES) {
    assert.ok(isTreatyType(t.slug));
    assert.equal(treatyTypeLabel(t.slug), t.label);
  }
  // alliance 已改制為「聯盟」，不再是可提案的條約類型。
  assert.equal(isTreatyType("alliance"), false);
  assert.equal(isTreatyType("trade"), false);
  assert.equal(isTreatyType(null), false);
  assert.equal(treatyTypeLabel("unknown"), "unknown");
});

test("clampRelationScore clamps to −100～100", () => {
  assert.equal(clampRelationScore(0), 0);
  assert.equal(clampRelationScore(150), RELATION_MAX);
  assert.equal(clampRelationScore(-150), RELATION_MIN);
  assert.equal(clampRelationScore(RELATION_MAX), RELATION_MAX);
  assert.equal(clampRelationScore(RELATION_MIN), RELATION_MIN);
});

test("clampChatRelationDelta clamps each AI chat delta to −20～+20", () => {
  assert.equal(CHAT_RELATION_DELTA_MIN, -20);
  assert.equal(CHAT_RELATION_DELTA_MAX, 20);
  assert.equal(clampChatRelationDelta(0), 0);
  assert.equal(clampChatRelationDelta(5), 5);
  assert.equal(clampChatRelationDelta(-5), -5);
  assert.equal(clampChatRelationDelta(20), 20);
  assert.equal(clampChatRelationDelta(-20), -20);
  assert.equal(clampChatRelationDelta(21), CHAT_RELATION_DELTA_MAX);
  assert.equal(clampChatRelationDelta(999), CHAT_RELATION_DELTA_MAX);
  assert.equal(clampChatRelationDelta(-21), CHAT_RELATION_DELTA_MIN);
  assert.equal(clampChatRelationDelta(-999), CHAT_RELATION_DELTA_MIN);
  // 非整數 delta 以 trunc 取整（避免產生小數關係值）。
  assert.equal(clampChatRelationDelta(4.6), 4);
  assert.equal(clampChatRelationDelta(-4.6), -4);
  // 非有限值視為 0（AI 亂回時安全落地）。
  assert.equal(clampChatRelationDelta(Number.NaN), 0);
  assert.equal(clampChatRelationDelta(Number.POSITIVE_INFINITY), 0);
});

test("AI_CHAT_TURN_CAP limits AI chat replies to 5 per turn", () => {
  assert.equal(AI_CHAT_TURN_CAP, 5);
});

// Task #499 — 純對話正向 delta 伺服器端硬封頂：嘴甜洗不出高關係值，嘴賤照樣扣。
test("clampChatTalkRelationDelta caps positive at +3, negative stays −20", () => {
  assert.equal(CHAT_TALK_POSITIVE_DELTA_MAX, 3);
  assert.equal(clampChatTalkRelationDelta(0), 0);
  assert.equal(clampChatTalkRelationDelta(2), 2);
  assert.equal(clampChatTalkRelationDelta(3), 3);
  assert.equal(clampChatTalkRelationDelta(4), CHAT_TALK_POSITIVE_DELTA_MAX);
  assert.equal(clampChatTalkRelationDelta(20), CHAT_TALK_POSITIVE_DELTA_MAX);
  assert.equal(clampChatTalkRelationDelta(999), CHAT_TALK_POSITIVE_DELTA_MAX);
  // 負向不受影響：挑釁與羞辱照常扣到 −20。
  assert.equal(clampChatTalkRelationDelta(-5), -5);
  assert.equal(clampChatTalkRelationDelta(-20), CHAT_RELATION_DELTA_MIN);
  assert.equal(clampChatTalkRelationDelta(-999), CHAT_RELATION_DELTA_MIN);
  // 非整數 trunc、非有限值視為 0（沿用 clampChatRelationDelta 的安全落地）。
  assert.equal(clampChatTalkRelationDelta(2.9), 2);
  assert.equal(clampChatTalkRelationDelta(Number.NaN), 0);
  assert.equal(clampChatTalkRelationDelta(Number.POSITIVE_INFINITY), 0);
});

test("SYSTEM_RELATION_ACTIONS are not player-triggerable actions", () => {
  // 系統衍生事件不可通過 isRelationAction，避免被 /action 端點直接呼叫亂扣分。
  assert.equal(isRelationAction("annul_treaty"), false);
  assert.equal(isRelationAction("declare_war"), false);
  assert.equal(
    SYSTEM_RELATION_ACTIONS.annul_treaty.delta,
    -TREATY_ANNUL_RELATION_PENALTY,
  );
  assert.equal(SYSTEM_RELATION_ACTIONS.declare_war.delta, 0);
});

test("describeRelationAction covers player + system actions with fallback", () => {
  assert.deepEqual(describeRelationAction("gift"), RELATION_ACTIONS.gift);
  assert.deepEqual(
    describeRelationAction("annul_treaty"),
    SYSTEM_RELATION_ACTIONS.annul_treaty,
  );
  assert.equal(describeRelationAction("declare_war")!.label, "宣戰");
  assert.equal(describeRelationAction("declare_war")!.delta, 0);
  assert.equal(describeRelationAction("parade"), null);
});

test("RELATION_ACTIONS deltas match spec", () => {
  assert.equal(RELATION_ACTIONS.embassy.delta, 10);
  assert.equal(RELATION_ACTIONS.gift.delta, 10);
  assert.equal(RELATION_ACTIONS.insult.delta, -20);
  assert.equal(RELATION_ACTIONS.withdraw.delta, -40);
  assert.ok(isRelationAction("gift"));
  assert.equal(isRelationAction("bribe"), false);
  assert.equal(isRelationAction(42), false);
});

test("giftCost is 5% of money floored, min 1", () => {
  assert.equal(giftCost(10000), 500);
  assert.equal(giftCost(10019), 500);
  assert.equal(giftCost(0), 1);
  assert.equal(giftCost(19), 1);
  assert.equal(giftCost(20), 1);
  assert.equal(giftCost(40), 2);
});

test("canonicalPair orders uuids lexicographically", () => {
  const a = "0a000000-0000-0000-0000-000000000000";
  const b = "0b000000-0000-0000-0000-000000000000";
  assert.deepEqual(canonicalPair(a, b), { low: a, high: b });
  assert.deepEqual(canonicalPair(b, a), { low: a, high: b });
});

test("bfsRegionDistances computes multi-source hops", () => {
  // 1—2—3—4, 5 isolated, sources {1}
  const adj = new Map<number, number[]>([
    [1, [2]],
    [2, [1, 3]],
    [3, [2, 4]],
    [4, [3]],
    [5, []],
  ]);
  const d = bfsRegionDistances([1], adj);
  assert.equal(d.get(1), 0);
  assert.equal(d.get(2), 1);
  assert.equal(d.get(3), 2);
  assert.equal(d.get(4), 3);
  assert.equal(d.get(5), undefined);

  // multi-source: {1, 4} — region 3 is 1 hop from 4
  const d2 = bfsRegionDistances([1, 4], adj);
  assert.equal(d2.get(3), 1);
  assert.equal(d2.get(2), 1);
});

test("nationDistance takes minimum over nation regions, null if unreachable", () => {
  const distances = new Map<number, number>([
    [1, 0],
    [2, 1],
    [3, 2],
  ]);
  assert.equal(nationDistance([3, 2], distances), 1);
  assert.equal(nationDistance([99], distances), null);
  assert.equal(nationDistance([], distances), null);
});

// ── 條約規則效果（Task #40） ───────────────────────────────────

const A = "aaaaaaaa-0000-0000-0000-000000000000";
const B = "bbbbbbbb-0000-0000-0000-000000000000";
const C = "cccccccc-0000-0000-0000-000000000000";
const D = "dddddddd-0000-0000-0000-000000000000";
const E = "eeeeeeee-0000-0000-0000-000000000000";

const NOW = new Date("2026-07-03T00:00:00Z");
const FUTURE = new Date("2026-08-01T00:00:00Z");
const PAST = new Date("2026-06-01T00:00:00Z");

function treaty(
  type: string,
  proposer: string,
  target: string,
  overrides: Partial<TreatyEffectView> = {},
): TreatyEffectView {
  return {
    type,
    proposerNationId: proposer,
    targetNationId: target,
    status: "active",
    expiresAt: null,
    ...overrides,
  };
}

test("isTreatyInEffect: active + not expired only", () => {
  assert.equal(isTreatyInEffect(treaty("nonaggression", A, B), NOW), true);
  assert.equal(
    isTreatyInEffect(treaty("nonaggression", A, B, { expiresAt: FUTURE }), NOW),
    true,
  );
  assert.equal(
    isTreatyInEffect(treaty("nonaggression", A, B, { expiresAt: PAST }), NOW),
    false,
  );
  for (const status of [
    "proposed",
    "rejected",
    "expired",
    "superseded",
    "annulled",
  ]) {
    assert.equal(
      isTreatyInEffect(treaty("nonaggression", A, B, { status }), NOW),
      false,
    );
  }
});

test("findWarBlockingTreatyType: only nonaggression blocks, both directions", () => {
  assert.equal(
    findWarBlockingTreatyType([treaty("nonaggression", A, B)], A, B, NOW),
    "nonaggression",
  );
  assert.equal(
    findWarBlockingTreatyType([treaty("nonaggression", B, A)], A, B, NOW),
    "nonaggression",
  );
  // 同盟已改制為「聯盟」，不再走條約層阻擋（改由聯盟成員關係判斷）。
  assert.equal(
    findWarBlockingTreatyType([treaty("alliance", A, B)], B, A, NOW),
    null,
  );
  // 軍事通行權／保障獨立不阻擋宣戰。
  assert.equal(
    findWarBlockingTreatyType(
      [treaty("military_access", A, B), treaty("guarantee", A, B)],
      A,
      B,
      NOW,
    ),
    null,
  );
});

test("findWarBlockingTreatyType: expired/other-pair/other-type treaties don't block", () => {
  assert.equal(
    findWarBlockingTreatyType(
      [treaty("nonaggression", A, B, { expiresAt: PAST })],
      A,
      B,
      NOW,
    ),
    null,
  );
  assert.equal(
    findWarBlockingTreatyType([treaty("nonaggression", A, C)], A, B, NOW),
    null,
  );
  assert.equal(
    findWarBlockingTreatyType(
      [treaty("military_access", A, B), treaty("guarantee", A, B)],
      A,
      B,
      NOW,
    ),
    null,
  );
});

test("findWarBlockingTreatyType: vassal blocks war both directions（強制和平）", () => {
  assert.equal(
    findWarBlockingTreatyType([treaty("vassal", A, B)], A, B, NOW),
    "vassal",
  );
  assert.equal(
    findWarBlockingTreatyType([treaty("vassal", A, B)], B, A, NOW),
    "vassal",
  );
  // 已過期或別的組合不擋
  assert.equal(
    findWarBlockingTreatyType(
      [treaty("vassal", A, B, { expiresAt: PAST })],
      A,
      B,
      NOW,
    ),
    null,
  );
  assert.equal(
    findWarBlockingTreatyType([treaty("vassal", A, C)], A, B, NOW),
    null,
  );
});

test("vassalPartiesOf: 依 proposerIsVassal 決定方向，未載入時視為 true", () => {
  assert.deepEqual(
    vassalPartiesOf(treaty("vassal", A, B, { proposerIsVassal: true })),
    { vassalId: A, suzerainId: B },
  );
  assert.deepEqual(
    vassalPartiesOf(treaty("vassal", A, B, { proposerIsVassal: false })),
    { vassalId: B, suzerainId: A },
  );
  // proposerIsVassal 未載入（undefined）→ 預設 true（提案方為附庸）
  assert.deepEqual(vassalPartiesOf(treaty("vassal", A, B)), {
    vassalId: A,
    suzerainId: B,
  });
});

test("findActiveSuzerainId: 只認生效中的附庸條約與正確方向", () => {
  // A 是 B 的附庸（A 提案、A 為附庸）
  assert.equal(
    findActiveSuzerainId(
      [treaty("vassal", A, B, { proposerIsVassal: true })],
      A,
      NOW,
    ),
    B,
  );
  // 宗主查自己 → null（B 是宗主不是附庸）
  assert.equal(
    findActiveSuzerainId(
      [treaty("vassal", A, B, { proposerIsVassal: true })],
      B,
      NOW,
    ),
    null,
  );
  // 反向：B 為附庸（A 提案但 proposerIsVassal=false）
  assert.equal(
    findActiveSuzerainId(
      [treaty("vassal", A, B, { proposerIsVassal: false })],
      B,
      NOW,
    ),
    A,
  );
  // 過期／非 active／非 vassal → null
  assert.equal(
    findActiveSuzerainId(
      [treaty("vassal", A, B, { proposerIsVassal: true, expiresAt: PAST })],
      A,
      NOW,
    ),
    null,
  );
  assert.equal(
    findActiveSuzerainId(
      [treaty("vassal", A, B, { proposerIsVassal: true, status: "proposed" })],
      A,
      NOW,
    ),
    null,
  );
  assert.equal(
    findActiveSuzerainId([treaty("nonaggression", A, B)], A, NOW),
    null,
  );
});

test("autoJoinNationIds: alliance treaties never auto-join (改制為聯盟)", () => {
  // 同盟已改制為「聯盟」，聯盟成員不會自動參戰（僅保障獨立會）。
  assert.deepEqual(
    autoJoinNationIds([treaty("alliance", B, C)], B, A, NOW),
    [],
  );
  assert.deepEqual(
    autoJoinNationIds([treaty("alliance", C, B)], B, A, NOW),
    [],
  );
});

test("autoJoinNationIds: guarantee only triggers when the guaranteed side is attacked", () => {
  // C 保障 B 的獨立：B 被攻擊 → C 參戰
  assert.deepEqual(
    autoJoinNationIds([treaty("guarantee", C, B)], B, A, NOW),
    [C],
  );
  // B 保障 C 的獨立：B 被攻擊 → C 不參戰（保障是單向的）
  assert.deepEqual(
    autoJoinNationIds([treaty("guarantee", B, C)], B, A, NOW),
    [],
  );
});

test("autoJoinNationIds: excludes aggressor/defender, dedupes, skips expired and military_access", () => {
  const treaties = [
    treaty("guarantee", A, B), // 保障者是侵略者本人 → 排除
    treaty("guarantee", C, B), // C 保障 B → 參戰
    treaty("guarantee", C, B), // 重複 → 去重
    treaty("guarantee", D, B, { expiresAt: PAST }), // 過期 → 不參戰
    treaty("military_access", E, B), // 軍事通行權不觸發參戰
  ];
  assert.deepEqual(autoJoinNationIds(treaties, B, A, NOW), [C]);
});

test("autoJoinNationIds: guarantor with nonaggression toward aggressor stays out", () => {
  // B 被 A 攻擊；C 保障 B 的獨立，但 C 與 A 有互不侵犯 → 條約優先，不自動參戰
  assert.deepEqual(
    autoJoinNationIds(
      [treaty("guarantee", C, B), treaty("nonaggression", C, A)],
      B,
      A,
      NOW,
    ),
    [],
  );
});

test("autoJoinNationIds: 附庸被宣戰 → 宗主自動參戰；宗主被宣戰附庸不參戰", () => {
  // B 是 C 的附庸（B 提案、proposerIsVassal=true）：B 被 A 攻擊 → 宗主 C 參戰
  assert.deepEqual(
    autoJoinNationIds(
      [treaty("vassal", B, C, { proposerIsVassal: true })],
      B,
      A,
      NOW,
    ),
    [C],
  );
  // 反向欄位：C 提案邀 B 當附庸（proposerIsVassal=false）→ 同樣 C 是宗主
  assert.deepEqual(
    autoJoinNationIds(
      [treaty("vassal", C, B, { proposerIsVassal: false })],
      B,
      A,
      NOW,
    ),
    [C],
  );
  // 宗主 C 被攻擊 → 附庸 B 不自動參戰（保護是單向的）
  assert.deepEqual(
    autoJoinNationIds(
      [treaty("vassal", B, C, { proposerIsVassal: true })],
      C,
      A,
      NOW,
    ),
    [],
  );
  // 宗主與侵略方有互不侵犯 → 條約優先，不參戰
  assert.deepEqual(
    autoJoinNationIds(
      [
        treaty("vassal", B, C, { proposerIsVassal: true }),
        treaty("nonaggression", C, A),
      ],
      B,
      A,
      NOW,
    ),
    [],
  );
});

test("compareByDistance sorts near first, null last, ties by name", () => {
  const list = [
    { distance: null, name: "乙" },
    { distance: 2, name: "丙" },
    { distance: 1, name: "丁" },
    { distance: 1, name: "甲" },
    { distance: null, name: "戊" },
  ];
  const sorted = [...list].sort(compareByDistance);
  assert.deepEqual(
    sorted.map((x) => x.name),
    ["丁", "甲", "丙", "乙", "戊"],
  );
});

test("npcReproposalCooldownRemainingMs counts down from 10 minutes", () => {
  assert.equal(NPC_REPROPOSAL_COOLDOWN_MS, 10 * 60 * 1000);
  const endedAt = new Date("2026-07-03T12:00:00Z");

  // 剛結束 → 剩整整 10 分鐘
  assert.equal(
    npcReproposalCooldownRemainingMs(endedAt, endedAt),
    NPC_REPROPOSAL_COOLDOWN_MS,
  );
  // 3 分鐘後 → 剩 7 分鐘
  assert.equal(
    npcReproposalCooldownRemainingMs(
      endedAt,
      new Date(endedAt.getTime() + 3 * 60 * 1000),
    ),
    7 * 60 * 1000,
  );
  // 剛好 10 分鐘 → 0（冷卻已過）
  assert.equal(
    npcReproposalCooldownRemainingMs(
      endedAt,
      new Date(endedAt.getTime() + NPC_REPROPOSAL_COOLDOWN_MS),
    ),
    0,
  );
  // 超過 10 分鐘 → 0，不會是負數
  assert.equal(
    npcReproposalCooldownRemainingMs(
      endedAt,
      new Date(endedAt.getTime() + 60 * 60 * 1000),
    ),
    0,
  );
});

test("npcReproposalCooldownMessage rounds minutes up, min 1", () => {
  // 7 分鐘整
  assert.ok(npcReproposalCooldownMessage(7 * 60 * 1000).includes("7 分鐘"));
  // 6 分 1 秒 → 進位到 7 分鐘
  assert.ok(
    npcReproposalCooldownMessage(6 * 60 * 1000 + 1000).includes("7 分鐘"),
  );
  // 30 秒 → 至少顯示 1 分鐘
  assert.ok(npcReproposalCooldownMessage(30 * 1000).includes("1 分鐘"));
  // 訊息為 zh-TW 且說明原因
  const msg = npcReproposalCooldownMessage(60 * 1000);
  assert.ok(msg.includes("拒絕") && msg.includes("撤回"));
});

// ── summarizeNpcTreatyHistory（Task #76） ──────────────────────

function historyRow(
  overrides: Partial<NpcTreatyHistoryRow> = {},
): NpcTreatyHistoryRow {
  return {
    type: "nonaggression",
    status: "rejected",
    durationDays: 30,
    offerMoney: 100,
    offerTechPoints: 5,
    offerRegionIds: [1, 2],
    proposedByNpc: false,
    responseNote: "誠意不足，拒絕。",
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

test("summarizeNpcTreatyHistory formats entries with type/offer/status/note", () => {
  const now = new Date("2026-07-03T00:00:00Z");
  const [line] = summarizeNpcTreatyHistory([historyRow()], now);
  assert.ok(line);
  assert.ok(line.includes("2 天前"));
  assert.ok(line.includes("互不侵犯"));
  assert.ok(line.includes("30 天"));
  assert.ok(line.includes("金錢 100"));
  assert.ok(line.includes("科技點數 5"));
  assert.ok(line.includes("領土 2 區"));
  assert.ok(line.includes("被拒絕"));
  assert.ok(line.includes("誠意不足"));
  assert.ok(line.includes("對方提案"));
});

test("summarizeNpcTreatyHistory status/direction/duration variants", () => {
  const now = new Date("2026-07-03T12:00:00Z");
  const lines = summarizeNpcTreatyHistory(
    [
      historyRow({
        status: "withdrawn",
        durationDays: null,
        responseNote: null,
        updatedAt: new Date("2026-07-03T10:00:00Z"),
      }),
      historyRow({
        status: "superseded",
        proposedByNpc: true,
        updatedAt: new Date("2026-07-02T00:00:00Z"),
      }),
    ],
    now,
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes("今天"));
  assert.ok(lines[0]!.includes("提案方撤回"));
  assert.ok(lines[0]!.includes("無期限"));
  assert.ok(!lines[0]!.includes("當時回覆"));
  assert.ok(lines[1]!.includes("NPC 提出對案取代"));
  assert.ok(lines[1]!.includes("我方（NPC）對案"));
});

test("summarizeNpcTreatyHistory caps entries, age, and note length; sorts new→old", () => {
  const now = new Date("2026-07-03T00:00:00Z");
  // 7 筆，其中 1 筆超過 7 天 → 只剩 6 筆，再截到 5 筆（新→舊）
  const rows = Array.from({ length: 6 }, (_, i) =>
    historyRow({
      offerMoney: i,
      updatedAt: new Date(now.getTime() - (i + 1) * 86_400_000),
    }),
  );
  rows.push(
    historyRow({
      offerMoney: 999,
      updatedAt: new Date(now.getTime() - NPC_HISTORY_MAX_AGE_MS - 1),
    }),
  );
  // 亂序輸入也要排序
  const shuffled = [rows[3]!, rows[6]!, rows[0]!, rows[5]!, rows[1]!, rows[2]!, rows[4]!];
  const lines = summarizeNpcTreatyHistory(shuffled, now);
  assert.equal(lines.length, NPC_HISTORY_MAX_ENTRIES);
  assert.ok(lines[0]!.includes("金錢 0"));
  assert.ok(lines[4]!.includes("金錢 4"));
  assert.ok(lines.every((l) => !l.includes("金錢 999")));

  // note 截斷
  const longNote = "很".repeat(NPC_HISTORY_NOTE_MAX_CHARS + 20);
  const [line] = summarizeNpcTreatyHistory(
    [historyRow({ responseNote: longNote, updatedAt: now })],
    now,
  );
  assert.ok(line!.includes("…"));
  assert.ok(!line!.includes(longNote));
});

// ── summarizeNpcRelationEvents（Task #84） ─────────────────────

function relationEventRow(
  overrides: Partial<NpcRelationEventRow> = {},
): NpcRelationEventRow {
  return {
    action: "gift",
    actedByNpc: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

test("summarizeNpcRelationEvents formats action/direction/time", () => {
  const now = new Date("2026-07-03T00:00:00Z");
  const lines = summarizeNpcRelationEvents(
    [
      relationEventRow({ action: "insult", createdAt: now }),
      relationEventRow({
        action: "gift",
        actedByNpc: true,
        createdAt: new Date("2026-07-01T00:00:00Z"),
      }),
      relationEventRow({
        action: "embassy",
        createdAt: new Date("2026-06-30T00:00:00Z"),
      }),
      relationEventRow({
        action: "withdraw",
        createdAt: new Date("2026-06-29T00:00:00Z"),
      }),
    ],
    now,
  );
  assert.equal(lines.length, 4);
  // 新→舊排序
  assert.ok(lines[0]!.startsWith("今天"));
  assert.ok(lines[0]!.includes("對方公開侮辱我國"));
  assert.ok(lines[1]!.startsWith("2 天前"));
  assert.ok(lines[1]!.includes("我方向對方送禮"));
  assert.ok(lines[2]!.includes("對方在我國設立大使館"));
  assert.ok(lines[3]!.includes("對方從我國撤回外交官"));
});

test("summarizeNpcRelationEvents formats system events (annul/war)", () => {
  const now = new Date("2026-07-03T00:00:00Z");
  const lines = summarizeNpcRelationEvents(
    [
      relationEventRow({ action: "declare_war", createdAt: now }),
      relationEventRow({
        action: "annul_treaty",
        actedByNpc: true,
        createdAt: now,
      }),
    ],
    now,
  );
  assert.ok(lines.some((l) => l.includes("對方向我國宣戰")));
  assert.ok(lines.some((l) => l.includes("我方廢除了與對方生效中的條約")));
});

test("summarizeNpcRelationEvents caps entries and age; unknown action degrades gracefully", () => {
  const now = new Date("2026-07-03T00:00:00Z");
  const rows = Array.from(
    { length: NPC_RELATION_EVENTS_MAX_ENTRIES + 2 },
    (_, i) =>
      relationEventRow({
        createdAt: new Date(now.getTime() - (i + 1) * 3_600_000),
      }),
  );
  rows.push(
    relationEventRow({
      action: "insult",
      createdAt: new Date(now.getTime() - NPC_RELATION_EVENTS_MAX_AGE_MS - 1),
    }),
  );
  const lines = summarizeNpcRelationEvents(rows, now);
  assert.equal(lines.length, NPC_RELATION_EVENTS_MAX_ENTRIES);
  assert.ok(lines.every((l) => !l.includes("侮辱")));

  // 未知動作不炸掉，仍標示方向
  const [unknown] = summarizeNpcRelationEvents(
    [relationEventRow({ action: "parade", actedByNpc: true, createdAt: now })],
    now,
  );
  assert.ok(unknown!.includes("我方"));
  assert.ok(unknown!.includes("parade"));
});

test("relation event retention window covers NPC lookback and cutoff is exact", () => {
  // 保留窗必須 ≥ NPC 回顧窗，否則 NPC 判斷會看不到應納入的紀錄
  assert.ok(RELATION_EVENTS_RETENTION_MS >= NPC_RELATION_EVENTS_MAX_AGE_MS);
  assert.equal(RELATION_EVENTS_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);

  const now = new Date("2026-07-03T12:00:00Z");
  const cutoff = relationEventsPruneCutoff(now);
  assert.equal(cutoff.getTime(), now.getTime() - RELATION_EVENTS_RETENTION_MS);
  assert.equal(cutoff.toISOString(), "2026-06-03T12:00:00.000Z");

  // 邊界：剛好在截止點上的紀錄不會被刪（DELETE 用嚴格小於）
  const boundary = new Date(cutoff.getTime());
  assert.ok(!(boundary.getTime() < cutoff.getTime()));
  const older = new Date(cutoff.getTime() - 1);
  assert.ok(older.getTime() < cutoff.getTime());
});

// ── Task #374 — parseTreatyRegionSelection（條約雙向交換的領土選擇驗證）──

const heldMap = new Map<number, number>([
  [1, 100],
  [2, 40],
  [3, 1],
]);

test("parseTreatyRegionSelection：合法選擇（缺項百分比＝整份轉移）＋去重", () => {
  const r = parseTreatyRegionSelection({
    rawRegionIds: [1, 2, 2],
    rawRegionPercents: { "2": 30 },
    held: heldMap,
    sideLabel: "我方提供",
  });
  assert.ok(r.ok);
  assert.deepEqual(r.regionIds, [1, 2]);
  assert.deepEqual(r.regionPercents, { "2": 30 });
});

test("parseTreatyRegionSelection：空選擇合法", () => {
  const r = parseTreatyRegionSelection({
    rawRegionIds: undefined,
    rawRegionPercents: undefined,
    held: heldMap,
    sideLabel: "我方提供",
  });
  assert.ok(r.ok);
  assert.deepEqual(r.regionIds, []);
  assert.deepEqual(r.regionPercents, {});
});

test("parseTreatyRegionSelection：超過 10 個地區 → 錯誤含側別標籤", () => {
  const r = parseTreatyRegionSelection({
    rawRegionIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    rawRegionPercents: {},
    held: heldMap,
    sideLabel: "要求對方提供",
  });
  assert.ok(!r.ok);
  assert.match(r.error, /要求對方提供/);
  assert.match(r.error, /最多 10 個地區/);
});

test("parseTreatyRegionSelection：非整數／非正 id → 錯誤", () => {
  for (const bad of [[1.5], ["2"], [0], [-3]]) {
    const r = parseTreatyRegionSelection({
      rawRegionIds: bad,
      rawRegionPercents: {},
      held: heldMap,
      sideLabel: "我方提供",
    });
    assert.ok(!r.ok, JSON.stringify(bad));
  }
});

test("parseTreatyRegionSelection：百分比包含未選擇地區 → 錯誤", () => {
  const r = parseTreatyRegionSelection({
    rawRegionIds: [1],
    rawRegionPercents: { "2": 30 },
    held: heldMap,
    sideLabel: "我方提供",
  });
  assert.ok(!r.ok);
  assert.match(r.error, /未選擇的地區/);
});

test("parseTreatyRegionSelection：百分比超出 1–100 或非整數 → 錯誤", () => {
  for (const bad of [0, 101, 30.5, "30"]) {
    const r = parseTreatyRegionSelection({
      rawRegionIds: [1],
      rawRegionPercents: { "1": bad },
      held: heldMap,
      sideLabel: "我方提供",
    });
    assert.ok(!r.ok, String(bad));
  }
});

test("parseTreatyRegionSelection：未掌控地區 → 錯誤", () => {
  const r = parseTreatyRegionSelection({
    rawRegionIds: [99],
    rawRegionPercents: {},
    held: heldMap,
    sideLabel: "我方提供",
  });
  assert.ok(!r.ok);
  assert.match(r.error, /掌控的地區/);
});

test("parseTreatyRegionSelection：百分比超過實際掌控份額 → 錯誤；等於則合法", () => {
  const over = parseTreatyRegionSelection({
    rawRegionIds: [2],
    rawRegionPercents: { "2": 41 },
    held: heldMap,
    sideLabel: "我方提供",
  });
  assert.ok(!over.ok);
  assert.match(over.error, /超過該國實際掌控份額/);

  const exact = parseTreatyRegionSelection({
    rawRegionIds: [2],
    rawRegionPercents: { "2": 40 },
    held: heldMap,
    sideLabel: "我方提供",
  });
  assert.ok(exact.ok);
});

test("parseTreatyRegionSelection：percents 非物件（陣列）→ 錯誤", () => {
  const r = parseTreatyRegionSelection({
    rawRegionIds: [1],
    rawRegionPercents: [30],
    held: heldMap,
    sideLabel: "我方提供",
  });
  assert.ok(!r.ok);
  assert.match(r.error, /格式不正確/);
});

// ── Task #376 — mergeNpcCounterDemandRegions（NPC 對案的領土索求）──

const demandNameMap = new Map<string, number>([
  ["東原", 1],
  ["西嶺", 2],
  ["南灣", 3],
]);
const demandHeld = new Map<number, number>([
  [1, 100],
  [2, 40],
  [3, 60],
]);

test("mergeNpcCounterDemandRegions：合法索求（新地區＋百分比）併入 offer 側", () => {
  const r = mergeNpcCounterDemandRegions({
    demands: [{ name: "西嶺", percent: 20 }],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [1],
    existingOfferPercents: {},
  });
  assert.ok(r.ok);
  assert.deepEqual(r.offerRegionIds, [1, 2]);
  assert.deepEqual(r.offerRegionPercents, { "2": 20 });
});

test("mergeNpcCounterDemandRegions：缺項百分比＝整份轉移", () => {
  const r = mergeNpcCounterDemandRegions({
    demands: [{ name: "南灣" }, { name: "西嶺", percent: null }],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [],
    existingOfferPercents: {},
  });
  assert.ok(r.ok);
  assert.deepEqual(r.offerRegionIds, [3, 2]);
  assert.deepEqual(r.offerRegionPercents, {});
});

test("mergeNpcCounterDemandRegions：已在 offer 的地區只會加碼、不會減碼", () => {
  // 原 offer 要 2 號區 30%；NPC 索求 10% → 保留 30%。
  const keep = mergeNpcCounterDemandRegions({
    demands: [{ name: "西嶺", percent: 10 }],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [2],
    existingOfferPercents: { "2": 30 },
  });
  assert.ok(keep.ok);
  assert.deepEqual(keep.offerRegionPercents, { "2": 30 });

  // NPC 索求 40%（＝掌控全額）→ 提高為 40%。
  const raise = mergeNpcCounterDemandRegions({
    demands: [{ name: "西嶺", percent: 40 }],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [2],
    existingOfferPercents: { "2": 30 },
  });
  assert.ok(raise.ok);
  assert.deepEqual(raise.offerRegionPercents, { "2": 40 });

  // NPC 索求整份（缺項）→ 移除百分比＝整份轉移。
  const full = mergeNpcCounterDemandRegions({
    demands: [{ name: "西嶺" }],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [2],
    existingOfferPercents: { "2": 30 },
  });
  assert.ok(full.ok);
  assert.deepEqual(full.offerRegionPercents, {});
  assert.deepEqual(full.offerRegionIds, [2]);
});

test("mergeNpcCounterDemandRegions：名稱不存在（AI 幻覺）→ 錯誤", () => {
  const r = mergeNpcCounterDemandRegions({
    demands: [{ name: "不存在的地區", percent: 10 }],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [],
    existingOfferPercents: {},
  });
  assert.ok(!r.ok);
  assert.match(r.error, /不存在/);
});

test("mergeNpcCounterDemandRegions：名稱前後空白可解析", () => {
  const r = mergeNpcCounterDemandRegions({
    demands: [{ name: "  東原 ", percent: 50 }],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [],
    existingOfferPercents: {},
  });
  assert.ok(r.ok);
  assert.deepEqual(r.offerRegionIds, [1]);
});

test("mergeNpcCounterDemandRegions：索求百分比超過提案國掌控份額 → 錯誤", () => {
  const r = mergeNpcCounterDemandRegions({
    demands: [{ name: "西嶺", percent: 41 }],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [],
    existingOfferPercents: {},
  });
  assert.ok(!r.ok);
  assert.match(r.error, /超過該國實際掌控份額/);
});

test("mergeNpcCounterDemandRegions：索求提案國未掌控的地區 → 錯誤", () => {
  const r = mergeNpcCounterDemandRegions({
    demands: [{ name: "東原" }],
    regionIdByName: demandNameMap,
    proposerHeld: new Map([[2, 40]]),
    existingOfferIds: [],
    existingOfferPercents: {},
  });
  assert.ok(!r.ok);
  assert.match(r.error, /掌控的地區/);
});

test("mergeNpcCounterDemandRegions：同名重複索求自動去重", () => {
  const r = mergeNpcCounterDemandRegions({
    demands: [
      { name: "東原", percent: 30 },
      { name: "東原", percent: 30 },
    ],
    regionIdByName: demandNameMap,
    proposerHeld: demandHeld,
    existingOfferIds: [],
    existingOfferPercents: {},
  });
  assert.ok(r.ok);
  assert.deepEqual(r.offerRegionIds, [1]);
});

test("mergeNpcCounterDemandRegions：合併後超過 10 區 → 錯誤", () => {
  const bigNameMap = new Map<string, number>([["新區", 11]]);
  const bigHeld = new Map<number, number>([[11, 100]]);
  const r = mergeNpcCounterDemandRegions({
    demands: [{ name: "新區" }],
    regionIdByName: bigNameMap,
    proposerHeld: bigHeld,
    existingOfferIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    existingOfferPercents: {},
  });
  assert.ok(!r.ok);
  assert.match(r.error, /10 個地區上限/);
});
