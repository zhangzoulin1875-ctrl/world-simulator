import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import {
  aiAbuseRecordsTable,
  db,
  playerNationsTable,
  playerNotificationsTable,
  politicsEntriesTable,
  politicsHistoryTable,
  politicsPendingDecisionsTable,
  politicsPendingIdeasTable,
  pool,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getGameBalanceSettings } from "./gameBalance";
import { runGameMigrations } from "./gameMigrations";
import { runPoliticsMigrations } from "./politicsMigrations";
import {
  applyCoup,
  applyRandomEvent,
  judgeGovernmentDecisionForNation,
  judgeIdea,
  settleAllNations,
  type PoliticsSettlementSummary,
} from "./politicsSettlement";
import { getPoliticsSettings } from "./politicsSettings";
import { computePoliticsState } from "./politics";
import { emptyPoliticsDigest } from "./politicsDm";
import { ERAS } from "./mapRegionEras";

/**
 * Task #209 — 內政結算裡「其他 AI 路徑」在單次 AI 失敗下的整合測試。
 *
 * 單一國家內政結算的四條 AI 路徑（政治註記演進已於 Task #592 移除——註記只在
 * 政變／改制時全新重生）——隨機事件（generateRandomEvent）、政策想法判定（judgePolicyIdea）、
 * 政變敘事（generateCoupNarrative）、政府決策判定（judgeGovernmentDecision）——過去
 * 只以「讀程式碼確認會記錄並跳過」佐證，缺少整合測試證明單次 AI 失敗不會中斷
 * 整國結算、也不會造成部分（partial）金錢／數值變動。
 *
 * 測試策略：對照 evolveNote 測試，直接呼叫已匯出的各路徑函式（只動測試國家，
 * 避免整個 dev DB 全量結算）。以覆寫 anthropic.messages.create 拋錯精確模擬 AI
 * 失敗，並斷言：
 * - 判定型路徑（想法／政府決策）：函式回傳 false（未判定），待判定保留供下回合
 *   重試，且金錢／政治數值完全不變。
 * - 隨機事件：不寫入任何條目、彙整不記事件，且函式不拋錯。
 * - 政變敘事：以預設文字完成政變（不拋錯），數值懲罰照常套用（懲罰為設定值、
 *   與 AI 無關），敘事失敗不阻斷政變。
 * 「不拋錯」即證明 settleAllNations 的逐國迴圈會繼續結算其他國家。
 *
 * 測試自我清理：以名稱前綴標記測試國家，結束時刪除（cascade 帶走子表）。
 */

const TEST_TAG = "__aifail_test__";
const ERA_SLUG = ERAS[0]!.slug;

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

/** 覆寫 AI 呼叫使其拋錯（模擬 AI 失敗）。回傳還原函式。 */
function stubAiThrow(): () => void {
  const fn = (async () => {
    throw new Error("模擬 AI 失敗");
  }) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  return () => {
    anthropic.messages.create = realMessagesCreate;
  };
}

/** 覆寫 AI 呼叫回傳固定 JSON 文字（模擬 AI 回應形狀邊界案例）。回傳還原函式。 */
function stubAiJson(payload: unknown): () => void {
  const fn = (async () => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
  })) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  return () => {
    anthropic.messages.create = realMessagesCreate;
  };
}

function emptySummary(): PoliticsSettlementSummary {
  return {
    nations: 0,
    ideasJudged: 0,
    ideasFailedAi: 0,
    entriesExpired: 0,
    eventsCreated: 0,
    coups: 0,
    decisionsJudged: 0,
    decisionsFailedAi: 0,
    governmentChanges: 0,
  };
}

async function createNation(opts: {
  suffix: string;
  money?: number;
  stability?: number;
  unrest?: number;
  politicalSupport?: number;
  governmentChangeAcceptance?: number;
}): Promise<string> {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}${opts.suffix}`,
      leaderName: TEST_TAG,
      government: "君主制",
      discordUserId: `${TEST_TAG}${opts.suffix}`,
      isNpc: false,
      money: opts.money ?? 10_000,
      stability: opts.stability ?? 50,
      unrest: opts.unrest ?? 10,
      politicalSupport: opts.politicalSupport ?? 50,
      governmentChangeAcceptance: opts.governmentChangeAcceptance ?? 0,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function loadNation(nationId: string) {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  assert.ok(row, "nation not found");
  return row;
}

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
  // 判定完成路徑會 fireNotify（keyed by discordUserId，無 FK cascade）與寫入
  // 濫用稽核列（inputText = 想法原文）——一併以前綴清理。
  await db
    .delete(playerNotificationsTable)
    .where(sql`${playerNotificationsTable.discordUserId} LIKE ${TEST_TAG + "%"}`);
  await db
    .delete(aiAbuseRecordsTable)
    .where(sql`${aiAbuseRecordsTable.inputText} LIKE ${TEST_TAG + "%"}`);
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await cleanup();
});

afterEach(() => {
  // 每個測試結束一律還原真實 AI，避免測試互相污染。
  anthropic.messages.create = realMessagesCreate;
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  await pool.end();
});

test("政策想法判定 AI 失敗：回傳 false、想法保留、金錢不變、不拋錯", async () => {
  const id = await createNation({ suffix: "-idea", money: 12_345 });
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();

  const [idea] = await db
    .insert(politicsPendingIdeasTable)
    .values({ nationId: id, direction: "law", idea: `${TEST_TAG}測試政策想法` })
    .returning();
  assert.ok(idea, "pending idea insert failed");

  const digest = emptyPoliticsDigest(nation.name);
  const restore = stubAiThrow();
  let handled: boolean;
  try {
    handled = await judgeIdea(nation, idea, settings, ERA_SLUG, digest);
  } finally {
    restore();
  }

  assert.equal(handled, false, "AI 失敗時 judgeIdea 應回傳 false（未判定）");

  // 待判定想法仍在（保留供下回合重試）。
  const remainingIdeas = await db
    .select()
    .from(politicsPendingIdeasTable)
    .where(eq(politicsPendingIdeasTable.nationId, id));
  assert.equal(remainingIdeas.length, 1, "想法應保留供下回合重試");

  // 無任何部分變動：金錢不變、未產生政策條目、彙整未記事。
  const after = await loadNation(id);
  assert.equal(after.money, 12_345, "AI 失敗不應扣款");
  const entries = await db
    .select()
    .from(politicsEntriesTable)
    .where(eq(politicsEntriesTable.nationId, id));
  assert.equal(entries.length, 0, "AI 失敗不應寫入任何政策條目");
  assert.equal(digest.policies.length, 0, "AI 失敗彙整不應記錄政策");
});

test("政府決策判定 AI 失敗：回傳 false、決策保留、數值不變、不拋錯", async () => {
  const id = await createNation({
    suffix: "-decision",
    stability: 44,
    politicalSupport: 55,
    governmentChangeAcceptance: 20,
  });
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();

  const [pending] = await db
    .insert(politicsPendingDecisionsTable)
    .values({ nationId: id, decision: `${TEST_TAG}測試政府決策` })
    .returning();
  assert.ok(pending, "pending decision insert failed");

  const digest = emptyPoliticsDigest(nation.name);
  const restore = stubAiThrow();
  let handled: boolean;
  try {
    handled = await judgeGovernmentDecisionForNation(
      nation,
      pending,
      settings,
      ERA_SLUG,
      digest,
    );
  } finally {
    restore();
  }

  assert.equal(handled, false, "AI 失敗時應回傳 false（未判定）");

  // 待判定決策仍在。
  const remaining = await db
    .select()
    .from(politicsPendingDecisionsTable)
    .where(eq(politicsPendingDecisionsTable.nationId, id));
  assert.equal(remaining.length, 1, "決策應保留供下回合重試");

  // 政治數值完全不變、無條目、彙整未記事件。
  const after = await loadNation(id);
  assert.equal(after.stability, 44, "AI 失敗不應改動穩定度");
  assert.equal(after.politicalSupport, 55, "AI 失敗不應改動政治支持度");
  assert.equal(
    after.governmentChangeAcceptance,
    20,
    "AI 失敗不應改動政體變更接受度",
  );
  const entries = await db
    .select()
    .from(politicsEntriesTable)
    .where(eq(politicsEntriesTable.nationId, id));
  assert.equal(entries.length, 0, "AI 失敗不應寫入任何條目");
  assert.equal(digest.event, null, "AI 失敗彙整不應記錄事件");
});

test("隨機事件 AI 失敗：不寫入條目、彙整不記事件、不拋錯", async () => {
  const id = await createNation({ suffix: "-event" });
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();
  const state = computePoliticsState(nation, [], settings);
  const digest = emptyPoliticsDigest(nation.name);
  const summary = emptySummary();

  const restore = stubAiThrow();
  try {
    // 直接呼叫（略過機率把關）以確保必定嘗試 AI；AI 失敗必須被吞掉。
    await applyRandomEvent(
      nation,
      settings,
      ERA_SLUG,
      state,
      ["law"],
      digest,
      summary,
    );
  } finally {
    restore();
  }

  const entries = await db
    .select()
    .from(politicsEntriesTable)
    .where(eq(politicsEntriesTable.nationId, id));
  assert.equal(entries.length, 0, "AI 失敗不應寫入事件條目");
  assert.equal(summary.eventsCreated, 0, "AI 失敗不應累加事件計數");
  assert.equal(digest.event, null, "AI 失敗彙整不應記錄事件");
});

test("政變敘事 AI 失敗：以預設文字完成政變、不拋錯、重置後果照常套用", async () => {
  const startMoney = 20_000;
  const startStability = 60;
  const id = await createNation({
    suffix: "-coup",
    money: startMoney,
    stability: startStability,
  });
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();
  const digest = emptyPoliticsDigest(nation.name);
  const summary = emptySummary();

  const restore = stubAiThrow();
  try {
    // 不應拋錯：敘事 AI 失敗時 applyCoup 用預設標題／描述完成政變。
    await applyCoup(nation, settings, ERA_SLUG, digest, summary);
  } finally {
    restore();
  }

  // 政變已完成：彙整記錄政變、寫入政變條目與歷史。
  assert.ok(digest.coup, "政變彙整應被記錄");
  const coupEntries = await db
    .select()
    .from(politicsEntriesTable)
    .where(eq(politicsEntriesTable.nationId, id));
  assert.ok(
    coupEntries.length >= 1,
    "應寫入政變事件條目（即使敘事 AI 失敗）",
  );
  const coupHistory = await db
    .select()
    .from(politicsHistoryTable)
    .where(eq(politicsHistoryTable.nationId, id));
  assert.ok(
    coupHistory.some((h) => h.eventType === "coup"),
    "應寫入一筆政變歷史",
  );

  // Task #584 — 重置模型：各項數值重置為設定值（與 AI 無關），金錢不再懲罰。
  const after = await loadNation(id);
  assert.equal(after.stability, settings.coupResetStability, "穩定度應重置");
  assert.equal(after.unrest, settings.coupResetUnrest, "暴動度應重置");
  assert.equal(
    after.politicalSupport,
    settings.coupResetSupport,
    "政治支持度應重置",
  );
  assert.equal(
    after.militaryObedience,
    settings.coupResetObedience,
    "軍方服從度應重置",
  );
  assert.equal(
    after.satisfactionMilitary,
    settings.coupResetSatisfaction,
    "軍方滿意度應重置",
  );
  for (const key of [
    "satisfactionFarmers",
    "satisfactionWorkers",
    "satisfactionNobles",
    "satisfactionClergy",
  ] as const) {
    assert.equal(
      after[key],
      settings.coupResetSatisfaction,
      `${key} 應重置為設定值`,
    );
  }
  assert.equal(after.money, startMoney, "政變不再有金錢懲罰");
  assert.equal(
    after.coupPolicyLockTurns,
    settings.coupPolicyLockTurns,
    "政策封鎖倒數應被設定",
  );
  assert.equal(
    after.coupMoralePenaltyTurns,
    settings.coupMoralePenaltyTurns,
    "士氣懲罰倒數應被設定",
  );
});

// ── Task #592 — 政治註記只在政變／改制後重生（每回合演進已移除） ──

test("政變不再強制更換政體：政體不變、不計入改制、政策鎖 3 回合", async () => {
  const id = await createNation({ suffix: "-coup-nogov", money: 20_000, stability: 60 });
  const nation = await loadNation(id);
  const govBefore = nation.government;
  const settings = await getPoliticsSettings();
  const digest = emptyPoliticsDigest(nation.name);
  const summary = emptySummary();

  const restore = stubAiThrow();
  try {
    await applyCoup(nation, settings, ERA_SLUG, digest, summary);
  } finally {
    restore();
  }

  const after = await loadNation(id);
  assert.equal(after.government, govBefore, "政變後政體必須維持原樣");
  assert.equal(nation.government, govBefore, "記憶體內國家物件政體也不得變動");
  assert.equal(summary.governmentChanges, 0, "不應計入政體變更");
  assert.equal(after.governmentChangeAcceptance, nation.governmentChangeAcceptance, "政體變更接受度不應被歸零");
  assert.equal(after.coupPolicyLockTurns, 3, "政策鎖定預設 3 回合");
  assert.ok(digest.coup, "政變本身仍要記錄");
});

test("政變成功：玩家國家的政治註記全新重生（覆蓋舊註記）", async () => {
  const oldNote = "舊版政治註記：政局長期平穩，治理風格保守務實。";
  const newNote = "政變後的新政治註記：強人掌權、軍方主導決策，政局進入高壓重整期。";
  const id = await createNation({ suffix: "-coup-note" });
  await db
    .update(playerNationsTable)
    .set({ politicalNote: oldNote })
    .where(eq(playerNationsTable.id, id));
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();
  const digest = emptyPoliticsDigest(nation.name);
  const summary = emptySummary();

  // 同一份 stub 同時滿足兩條 AI 路徑：政變敘事讀 title/description、註記重生讀 note。
  const restore = stubAiJson({
    title: "軍方政變成功",
    description: "軍方勢力發動政變奪權，政局全面重整。",
    note: newNote,
  });
  try {
    await applyCoup(nation, settings, ERA_SLUG, digest, summary);
  } finally {
    restore();
  }

  const after = await loadNation(id);
  assert.equal(
    after.politicalNote,
    newNote,
    "政變後政治註記應被全新重生內容覆蓋",
  );
  assert.equal(nation.politicalNote, newNote, "記憶體物件應同步新註記");
});

test("政變成功但註記重生 AI 失敗：註記清空為 null，供懶惰生成重試", async () => {
  const oldNote = "舊版政治註記：即將被政變推翻的政權氛圍。";
  const id = await createNation({ suffix: "-coup-note-fail" });
  await db
    .update(playerNationsTable)
    .set({ politicalNote: oldNote })
    .where(eq(playerNationsTable.id, id));
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();
  const digest = emptyPoliticsDigest(nation.name);
  const summary = emptySummary();

  const restore = stubAiThrow();
  try {
    await applyCoup(nation, settings, ERA_SLUG, digest, summary);
  } finally {
    restore();
  }

  // 政變本身照常完成（見上一個測試組），註記則清空等待 ensurePoliticalNote 重試。
  assert.ok(digest.coup, "政變彙整應被記錄");
  const after = await loadNation(id);
  assert.equal(
    after.politicalNote,
    null,
    "註記重生失敗時應清空為 null（懶惰生成重試路徑）",
  );
});

test("整國迴圈：某國 AI 判定失敗不會中斷同回合其他國家的結算", async () => {
  // 建立兩個測試國家，各自都有一筆待判定政策想法（AI 會失敗）與一筆本回合到期
  // 的政治條目（純資料處理、與 AI 無關）。若某國的 AI 失敗會中斷結算，則其到期
  // 步驟不會執行；反之若逐國迴圈韌性正確，兩國都應完成到期處理。
  const idA = await createNation({ suffix: "-loopA" });
  const idB = await createNation({ suffix: "-loopB" });
  const nationA = await loadNation(idA);
  const nationB = await loadNation(idB);

  for (const id of [idA, idB]) {
    await db.insert(politicsPendingIdeasTable).values({
      nationId: id,
      direction: "law",
      idea: `${TEST_TAG} 想法`,
    });
    await db.insert(politicsEntriesTable).values({
      nationId: id,
      direction: "law",
      entryType: "policy",
      title: `${TEST_TAG} 到期條目`,
      description: `${TEST_TAG}`,
      durationTurns: 1,
      remainingTurns: 1,
      status: "active",
    });
  }

  let summary: PoliticsSettlementSummary;
  const restore = stubAiThrow();
  try {
    // 只結算這兩個測試國家（不掃描整個 dev DB、不對真實國家呼叫 AI）。
    summary = await settleAllNations([nationA, nationB]);
  } finally {
    restore();
  }

  // 兩國的 AI 想法判定都失敗（未判定），想法保留供下回合重試。
  assert.equal(summary.nations, 2, "應結算兩個國家");
  assert.equal(summary.ideasJudged, 0, "AI 失敗不應判定任何想法");
  assert.equal(summary.ideasFailedAi, 2, "兩國的想法判定都應記為 AI 失敗");
  for (const id of [idA, idB]) {
    const ideas = await db
      .select()
      .from(politicsPendingIdeasTable)
      .where(eq(politicsPendingIdeasTable.nationId, id));
    assert.equal(ideas.length, 1, "AI 失敗後待判定想法應保留");
  }

  // 關鍵：AI 失敗發生在到期步驟之前。兩國的到期條目都轉為 expired，證明單一
  // 國家的 AI 失敗沒有中斷該國後續步驟，也沒有中斷另一個國家的整體結算。
  assert.equal(summary.entriesExpired, 2, "兩國的到期條目都應被處理");
  for (const id of [idA, idB]) {
    const [entry] = await db
      .select()
      .from(politicsEntriesTable)
      .where(eq(politicsEntriesTable.nationId, id))
      .limit(1);
    assert.ok(entry, "到期條目應存在");
    assert.equal(entry.status, "expired", "本回合到期條目應轉為 expired");
  }
});

// ── Task #570 — AI 回應形狀邊界：success/failure 單側 null 的容錯判定 ──
// 過去 schema 要求兩側都是完整物件，AI 填 null 會整筆解析失敗，
// 想法/決策永遠卡在待判定重試（正式站實際發生過）。

test("政策想法 AI 回 success:null：強制走失敗、想法結案不卡住", async () => {
  const id = await createNation({ suffix: "-nullsucc" });
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();

  const [idea] = await db
    .insert(politicsPendingIdeasTable)
    .values({ nationId: id, direction: "law", idea: `${TEST_TAG}不可行的想法` })
    .returning();
  assert.ok(idea, "pending idea insert failed");

  const digest = emptyPoliticsDigest(nation.name);
  const restore = stubAiJson({
    fitScore: 5,
    resultType: "policy",
    success: null,
    failure: {
      title: "空想政策遭全面否決",
      description: "此想法在當前時代毫無可行性，朝野一致反對，推行未果。",
      modifiers: [{ target: "stability", value: -3 }],
      durationTurns: 3,
    },
    abuseReason: null,
  });
  let handled: boolean;
  try {
    handled = await judgeIdea(nation, idea, settings, ERA_SLUG, digest);
  } finally {
    restore();
  }

  assert.equal(handled, true, "單側 null 應被容忍並完成判定");
  const remaining = await db
    .select()
    .from(politicsPendingIdeasTable)
    .where(eq(politicsPendingIdeasTable.nationId, id));
  assert.equal(remaining.length, 0, "想法應結案，不再卡在待判定");
  const entries = await db
    .select()
    .from(politicsEntriesTable)
    .where(eq(politicsEntriesTable.nationId, id));
  assert.equal(entries.length, 1, "應寫入一筆失敗條目");
  assert.equal(entries[0]!.title, "【失敗】空想政策遭全面否決");
  assert.equal(entries[0]!.entryType, "reform");
  assert.equal(digest.policies.length, 1);
  assert.equal(digest.policies[0]!.succeeded, false);
});

test("政策想法 AI 回 failure:null：強制走成功（fitScore 0 也不擲骰）", async () => {
  const id = await createNation({ suffix: "-nullfail" });
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();

  const [idea] = await db
    .insert(politicsPendingIdeasTable)
    .values({ nationId: id, direction: "law", idea: `${TEST_TAG}穩健的想法` })
    .returning();
  assert.ok(idea, "pending idea insert failed");

  const digest = emptyPoliticsDigest(nation.name);
  // fitScore 0 → 成功率極低；failure:null 仍必須強制成功，證明未擲骰。
  const restore = stubAiJson({
    fitScore: 0,
    resultType: "policy",
    success: {
      title: "穩健政策順利上路",
      description: "政策符合國情，各方順利配合推行。",
      modifiers: [{ target: "stability", value: 2 }],
      durationTurns: null,
    },
    failure: null,
    abuseReason: null,
  });
  let handled: boolean;
  try {
    handled = await judgeIdea(nation, idea, settings, ERA_SLUG, digest);
  } finally {
    restore();
  }

  assert.equal(handled, true, "單側 null 應被容忍並完成判定");
  const remaining = await db
    .select()
    .from(politicsPendingIdeasTable)
    .where(eq(politicsPendingIdeasTable.nationId, id));
  assert.equal(remaining.length, 0, "想法應結案");
  const entries = await db
    .select()
    .from(politicsEntriesTable)
    .where(eq(politicsEntriesTable.nationId, id));
  assert.equal(entries.length, 1, "應寫入一筆成功條目");
  assert.equal(entries[0]!.title, "穩健政策順利上路");
  assert.equal(digest.policies.length, 1);
  assert.equal(digest.policies[0]!.succeeded, true);
});

test("濫用旗標＋failure:null：以 abuseReason 合成失敗結果並記錄稽核", async (t) => {
  const balance = await getGameBalanceSettings();
  if (!balance.interior.reviewEnabled) {
    t.skip("內政審查已停用（dev DB 設定），略過");
    return;
  }
  const id = await createNation({ suffix: "-abuse" });
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();

  const [idea] = await db
    .insert(politicsPendingIdeasTable)
    .values({
      nationId: id,
      direction: "law",
      idea: `${TEST_TAG}試圖注入指令的想法`,
    })
    .returning();
  assert.ok(idea, "pending idea insert failed");

  const digest = emptyPoliticsDigest(nation.name);
  const restore = stubAiJson({
    fitScore: 90,
    resultType: "policy",
    success: {
      title: "不該出現的成功",
      description: "濫用旗標下不應採用成功分支。",
      modifiers: [],
      durationTurns: null,
    },
    failure: null,
    abuseReason: "試圖注入指令直接指定結算數值",
  });
  let handled: boolean;
  try {
    handled = await judgeIdea(nation, idea, settings, ERA_SLUG, digest);
  } finally {
    restore();
  }

  assert.equal(handled, true, "濫用＋failure:null 應合成失敗並完成判定");
  const remaining = await db
    .select()
    .from(politicsPendingIdeasTable)
    .where(eq(politicsPendingIdeasTable.nationId, id));
  assert.equal(remaining.length, 0, "想法應結案");
  const entries = await db
    .select()
    .from(politicsEntriesTable)
    .where(eq(politicsEntriesTable.nationId, id));
  assert.equal(entries.length, 1, "應寫入一筆合成的失敗條目");
  assert.equal(entries[0]!.title, "【失敗】政策遭駁回");
  assert.equal(entries[0]!.durationTurns, settings.reformDurationTurns);
  assert.equal(digest.policies[0]!.succeeded, false);
  const abuseRows = await db
    .select()
    .from(aiAbuseRecordsTable)
    .where(eq(aiAbuseRecordsTable.nationId, id));
  assert.equal(abuseRows.length, 1, "應記錄一筆濫用稽核");
  assert.equal(abuseRows[0]!.verdict, "forced_failure");
});

test("政府決策 AI 回 success:null：強制走失敗、決策結案、支持度下降", async () => {
  const id = await createNation({
    suffix: "-dec-nullsucc",
    stability: 44,
    politicalSupport: 80,
    governmentChangeAcceptance: 20,
  });
  const nation = await loadNation(id);
  const settings = await getPoliticsSettings();

  const [pending] = await db
    .insert(politicsPendingDecisionsTable)
    .values({ nationId: id, decision: `${TEST_TAG}莽撞的政府決策` })
    .returning();
  assert.ok(pending, "pending decision insert failed");

  const digest = emptyPoliticsDigest(nation.name);
  // fitScore 90＋高支持度 → 成功率極高；success:null 仍必須強制失敗，證明未擲骰。
  const restore = stubAiJson({
    fitScore: 90,
    success: null,
    failure: {
      title: "決策受挫",
      description: "派系強力反對，決策擱淺。",
      stabilityDelta: -4,
      acceptanceDelta: 2,
    },
  });
  let handled: boolean;
  try {
    handled = await judgeGovernmentDecisionForNation(
      nation,
      pending,
      settings,
      ERA_SLUG,
      digest,
    );
  } finally {
    restore();
  }

  assert.equal(handled, true, "單側 null 應被容忍並完成判定");
  const remaining = await db
    .select()
    .from(politicsPendingDecisionsTable)
    .where(eq(politicsPendingDecisionsTable.nationId, id));
  assert.equal(remaining.length, 0, "決策應結案，不再卡在待判定");

  const after = await loadNation(id);
  assert.equal(
    after.politicalSupport,
    Math.max(0, Math.min(100, 80 - settings.decisionFailureSupportDelta)),
    "失敗應扣支持度",
  );
  assert.equal(after.governmentChangeAcceptance, 22, "接受度應套用 delta");
  // 穩定度 = 44 − 4 −（可能的低支持度反制懲罰；支持度 80 通常不觸發，但容忍）。
  assert.ok(
    after.stability === 40 ||
      after.stability === 40 - settings.counterEventStabilityPenalty,
    `穩定度應為 40（或再扣反制懲罰），實際 ${after.stability}`,
  );
  const entries = await db
    .select()
    .from(politicsEntriesTable)
    .where(eq(politicsEntriesTable.nationId, id));
  assert.equal(entries.length, 1, "應寫入一筆決策事件條目");
  assert.equal(entries[0]!.title, "決策受挫");
  assert.deepEqual(digest.event, { title: "決策受挫", good: false });
});
