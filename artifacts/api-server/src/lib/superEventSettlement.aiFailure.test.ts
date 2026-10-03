import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionEraStatsTable,
  worldGameStateTable,
  superEventsTable,
  superEventRegionsTable,
  superEventResponsesTable,
  superEventTurnLogsTable,
  superEventNationImpactsTable,
  type SuperEvent,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations } from "./gameMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runMapRegionEraStatsSync } from "./mapRegionEraStats";
import { runSuperEventMigrations } from "./superEventMigrations";
import {
  runSuperEventSettlement,
  settleEvent,
} from "./superEventSettlement";
import { runTurnUpdate } from "./turnEngine";
import { logger } from "./logger";
import { ERAS } from "./mapRegionEras";

/**
 * Task #335 — 超事件每回合結算不會讓回合引擎「靜默地」崩掉的整合測試。
 *
 * 超事件結算由每日回合引擎呼叫（politics/economy 結算之後），內部逐事件呼叫 AI
 * （superEventAi.ts）。若 AI 判定拋錯或回傳格式不正確，絕不可中斷整個回合
 * （金錢／科技／人口／內政／經濟結算）。過去缺少測試佐證此隔離性。
 *
 * 測試策略（對照 politicsSettlement.aiFailure）：走真實 dev DB、以名稱前綴標記
 * 測試資料、跑前跑後自清。以覆寫 anthropic.messages.create 精準模擬 AI 行為：
 *
 * 案例一（AI 拋錯）：呼叫回合引擎實際呼叫的入口 runSuperEventSettlement，斷言：
 *   - 不拋錯（graceful degrade）→ 回合引擎的 try/catch 甚至不會觸發，回合續跑。
 *   - summary.eventsFailedAi ≥ 1（失敗被記錄為計數，非例外向上冒泡）。
 *   - 本測試事件無任何部分變動（turnsElapsed 不變、狀態仍 active、敘事不變、
 *     未寫入回合紀錄），受影響國家數值不變、待判定應對仍 pending。
 *   「不拋錯 + 無部分寫入」即證明本結算不會靜默地讓回合中斷或留下半套資料。
 *
 * 案例二（AI 回傳合法結果）：直接呼叫 settleEvent（僅動本測試事件，避免 settleAll
 * 對整個 dev DB 的其他 active 事件產生副作用），斷言：本回合數值變動、應對判定與
 * turnsElapsed 遞增皆落地，且達 maxTurns 時事件結束。
 *
 * 案例三（端對端：AI 拋錯 × 實際跑回合引擎 runTurnUpdate force）：這才是本任務的
 * 核心——超事件結算掛在每日回合引擎裡（政治／經濟結算之後）。以 AI 全數拋錯跑一次
 * 真實的每日回合，斷言：回合仍完成（ran=true、遊戲日期前進）、超事件之前的決定性
 * 結算照常推進（測試國家 techPoints 增加）、超事件失敗只被「記錄」而非「拋出」
 * （攔截 logger.error，確認出現本事件的失敗紀錄），且本測試超事件未被部分推進。
 */

const TEST_TAG = "__superevt_test__";
const runId = randomBytes(4).toString("hex");
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

/** 本回合判定用的合法回應（turnSchema）。 */
const TURN_JSON = {
  narrative: `${TEST_TAG}本回合疫情擴散，各地醫療吃緊。`,
  effect: {
    populationDeltaPct: -8,
    productivityDeltaPct: -8,
    satisfactionFarmersDelta: 0,
    satisfactionWorkersDelta: -20,
    satisfactionClergyDelta: 0,
    satisfactionNoblesDelta: 0,
    stabilityDelta: -20,
    unrestDelta: 20,
  },
  stage: "peak",
  grantTech: null,
  npcHostility: "none",
  end: false,
};

/** 應對判定用的合法回應（responseSchema）；effect 全 0，只驗證「判定落地」。 */
const RESPONSE_JSON = {
  title: `${TEST_TAG}封城與醫療動員`,
  description: `${TEST_TAG}迅速封鎖疫區並動員醫療資源，有效緩解衝擊。`,
  fitScore: 80,
  effect: {
    populationDeltaPct: 0,
    productivityDeltaPct: 0,
    satisfactionFarmersDelta: 0,
    satisfactionWorkersDelta: 0,
    satisfactionClergyDelta: 0,
    satisfactionNoblesDelta: 0,
    stabilityDelta: 0,
    unrestDelta: 0,
  },
};

/**
 * 覆寫 AI 呼叫使其回傳「合法」JSON。settleEvent 會做兩種不同 schema 的呼叫
 * （回合判定 turnSchema、應對判定 responseSchema），故依 system 提示詞分流。
 */
function stubAiWellFormed(): () => void {
  const fn = (async (args: { system?: string }) => {
    const system = String(args?.system ?? "");
    // 回合判定與應對判定共用 bulk 模型但 system 提示詞不同：只有「應對判定」提示詞
    // 含「超事件應對」字樣（回合判定為「『超事件』回合判定」，亦提及應對得當，故不能
    // 只用「應對」二字辨別）。
    const json = system.includes("超事件應對") ? RESPONSE_JSON : TURN_JSON;
    return { content: [{ type: "text", text: JSON.stringify(json) }] };
  }) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  return () => {
    anthropic.messages.create = realMessagesCreate;
  };
}

let nationId: string;
const discordUserId = `${TEST_TAG}${runId}`;
let regionIds: number[] = [];

async function deleteTestEvents() {
  await db
    .delete(superEventsTable)
    .where(sql`${superEventsTable.title} LIKE ${TEST_TAG + "%"}`);
}

async function cleanup() {
  await deleteTestEvents();
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
}

/** 重設測試國家數值與地區累積，讓各測試彼此獨立。 */
async function resetNation() {
  await db
    .update(playerNationsTable)
    .set({
      stability: 50,
      unrest: 0,
      satisfactionFarmers: 60,
      satisfactionWorkers: 60,
      satisfactionClergy: 60,
      satisfactionNobles: 60,
      productionBonus: 0,
    })
    .where(eq(playerNationsTable.id, nationId));
  await db
    .update(regionControlsTable)
    .set({ populationBonus: 0 })
    .where(eq(regionControlsTable.nationId, nationId));
}

async function loadNation() {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  assert.ok(row, "nation not found");
  return row;
}

/** 建立一則 regional 超事件（範圍限定測試國家的地區）＋一則待判定玩家應對。 */
async function seedEventWithResponse(opts: {
  maxTurns: number | null;
  turnsElapsed?: number;
}): Promise<SuperEvent> {
  const [event] = await db
    .insert(superEventsTable)
    .values({
      title: `${TEST_TAG}國際大瘟疫-${randomBytes(3).toString("hex")}`,
      summary: `${TEST_TAG}摘要`,
      narrative: `${TEST_TAG}初始敘事`,
      category: "疾病",
      scope: "regional",
      cause: "admin",
      status: "active",
      severity: 70,
      impactPct: 100,
      turnsElapsed: opts.turnsElapsed ?? 0,
      maxTurns: opts.maxTurns,
    })
    .returning();
  assert.ok(event, "super event insert failed");

  await db
    .insert(superEventRegionsTable)
    .values(regionIds.map((regionId) => ({ eventId: event.id, regionId })));

  await db.insert(superEventResponsesTable).values({
    eventId: event.id,
    nationId,
    discordUserId,
    responseText: `${TEST_TAG}我們封鎖疫區並動員醫療資源。`,
    status: "pending",
  });

  return event;
}

before(async () => {
  await runGameMigrations();
  await runMapRegionSync();
  await runMapRegionEraStatsSync();
  await runSuperEventMigrations();
  await cleanup();

  // 建立測試國家（真實玩家，可收應對／通知）。
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}${runId}`,
      leaderName: TEST_TAG,
      government: "君主制",
      discordUserId,
      isNpc: false,
      stability: 50,
      unrest: 0,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "test nation insert failed");
  nationId = nation.id;

  // 挑兩個「無人掌控」且該時代有數值的地區，指派 100% 給測試國家，確保本事件
  // 只影響測試國家、且不動到任何真實資料。
  const controlled = await db
    .select({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable);
  const controlledSet = new Set(controlled.map((r) => r.regionId));
  const eraRows = await db
    .select({
      regionId: mapRegionEraStatsTable.regionId,
      population: mapRegionEraStatsTable.population,
    })
    .from(mapRegionEraStatsTable)
    .where(eq(mapRegionEraStatsTable.era, ERA_SLUG))
    .orderBy(sql`${mapRegionEraStatsTable.population} DESC`);
  const free = eraRows
    .filter((r) => !controlledSet.has(r.regionId) && r.population > 0)
    .slice(0, 2);
  assert.ok(free.length === 2, "需要兩個無人掌控且有人口的地區");
  regionIds = free.map((r) => r.regionId);

  await db.insert(regionControlsTable).values(
    regionIds.map((regionId) => ({ regionId, nationId, percent: 100 })),
  );
});

afterEach(async () => {
  anthropic.messages.create = realMessagesCreate;
  await deleteTestEvents();
  await resetNation();
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  await pool.end();
});

test("AI 拋錯：runSuperEventSettlement 不拋錯、失敗計數、無部分變動（回合可續跑）", async () => {
  const event = await seedEventWithResponse({ maxTurns: null });

  const restore = stubAiThrow();
  let summary: Awaited<ReturnType<typeof runSuperEventSettlement>>;
  try {
    // 回合引擎實際呼叫的入口；AI 全數拋錯下必須 resolve（graceful degrade）。
    summary = await runSuperEventSettlement({
      statsEra: ERA_SLUG,
      currentEra: ERA_SLUG,
    });
  } finally {
    restore();
  }

  // 失敗被記錄為計數而非例外向上冒泡（本測試事件必在 active 集合內、必失敗）。
  assert.ok(
    summary.eventsFailedAi >= 1,
    "AI 失敗應累加 eventsFailedAi，而非拋出例外",
  );

  // 本測試事件：無任何部分變動。
  const [after] = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.id, event.id))
    .limit(1);
  assert.ok(after, "測試事件應仍存在");
  assert.equal(after.turnsElapsed, 0, "AI 失敗不應推進回合數");
  assert.equal(after.status, "active", "AI 失敗不應結束事件");
  assert.equal(after.narrative, `${TEST_TAG}初始敘事`, "AI 失敗不應改寫敘事");

  // 未寫入任何回合紀錄。
  const logs = await db
    .select()
    .from(superEventTurnLogsTable)
    .where(eq(superEventTurnLogsTable.eventId, event.id));
  assert.equal(logs.length, 0, "AI 失敗不應寫入回合紀錄");

  // 受影響國家數值完全不變。
  const nation = await loadNation();
  assert.equal(nation.stability, 50, "AI 失敗不應改動穩定度");
  assert.equal(nation.unrest, 0, "AI 失敗不應改動動亂度");
  assert.equal(nation.satisfactionWorkers, 60, "AI 失敗不應改動滿意度");
  assert.equal(nation.productionBonus, 0, "AI 失敗不應改動生產力加成");

  // 待判定應對仍 pending（保留供下回合重試）。
  const [resp] = await db
    .select()
    .from(superEventResponsesTable)
    .where(eq(superEventResponsesTable.eventId, event.id))
    .limit(1);
  assert.ok(resp, "應對應仍存在");
  assert.equal(resp.status, "pending", "AI 失敗不應判定應對");
  assert.equal(resp.resultTitle, null, "AI 失敗不應寫入應對結果");
});

test("AI 合法回應：本回合數值／應對判定落地、turnsElapsed 遞增、達 maxTurns 結束", async () => {
  // maxTurns=1：本回合結算後 turnNumber=1 ≥ maxTurns → 事件結束。
  const event = await seedEventWithResponse({ maxTurns: 1 });

  const restore = stubAiWellFormed();
  let result: Awaited<ReturnType<typeof settleEvent>>;
  try {
    // 只結算本測試事件（不掃描整個 dev DB、不影響其他事件）。
    result = await settleEvent(event, 100, ERA_SLUG, ERA_SLUG);
  } finally {
    restore();
  }

  assert.equal(result.ended, true, "達 maxTurns 應結束事件");
  assert.equal(result.techGranted, false, "本回合未賦予科技");
  assert.equal(result.responsesJudged, 1, "應判定一則應對");
  assert.equal(result.responsesFailedAi, 0, "應對判定不應失敗");

  // 事件狀態：turnsElapsed 遞增、狀態轉 ended、敘事更新。
  const [after] = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.id, event.id))
    .limit(1);
  assert.ok(after, "事件應仍存在");
  assert.equal(after.turnsElapsed, 1, "turnsElapsed 應遞增為 1");
  assert.equal(after.status, "ended", "達 maxTurns 事件應結束");
  assert.ok(after.endedAt, "結束事件應寫入 endedAt");
  assert.equal(after.narrative, TURN_JSON.narrative, "敘事應更新為本回合結果");

  // 回合紀錄已寫入。
  const logs = await db
    .select()
    .from(superEventTurnLogsTable)
    .where(eq(superEventTurnLogsTable.eventId, event.id));
  assert.equal(logs.length, 1, "應寫入一筆回合紀錄");
  assert.equal(logs[0]!.turnNumber, 1, "回合紀錄編號應為 1");

  // 本回合數值影響已套用。Task #356 起，齊頭數值（滿意度／穩定度／暴動度）不再是
  // AI 幅度的「直接套用」，而是再乘上差異化係數（暴露比例 × 政體修正 × 應對契合 ×
  // 階段嚴重度）。純係數已於 superEventImpact.test.ts 精確驗證；此處只斷言「方向正確、
  // 確有套用、未被夾出範圍」——災難事件（負向 effect）應使穩定度／文化下降、暴動度上升，
  // 未在 effect 觸及的欄位（law）維持不變。
  const nation = await loadNation();
  assert.ok(nation.stability < 50, "災難應使穩定度下降");
  assert.ok(nation.stability >= 0, "穩定度不得低於下限 0");
  assert.ok(nation.unrest > 0, "災難應使暴動度上升");
  assert.ok(nation.unrest <= 100, "暴動度不得高於上限 100");
  assert.ok(nation.satisfactionWorkers < 60, "災難應使工人滿意度下降");
  assert.equal(nation.satisfactionFarmers, 60, "未在 effect 觸及的滿意度應維持不變");

  // 差異化影響已逐國記錄（供管理員的每國影響檢視／累計）。方向與國家實際變動一致。
  const [impact] = await db
    .select()
    .from(superEventNationImpactsTable)
    .where(eq(superEventNationImpactsTable.eventId, event.id))
    .limit(1);
  assert.ok(impact, "應寫入本回合的每國影響紀錄");
  assert.equal(impact.turnNumber, 1, "影響紀錄回合編號應為 1");
  assert.equal(impact.nationId, nationId, "影響紀錄應對應測試國家");
  assert.ok(impact.stabilityDelta < 0, "影響紀錄的穩定度變動應為負");
  assert.ok(impact.unrestDelta > 0, "影響紀錄的暴動度變動應為正");
  assert.ok(
    impact.satisfactionWorkersDelta < 0,
    "影響紀錄的工人滿意度變動應為負",
  );

  // 應對已判定並寫回結果。
  const [resp] = await db
    .select()
    .from(superEventResponsesTable)
    .where(eq(superEventResponsesTable.eventId, event.id))
    .limit(1);
  assert.ok(resp, "應對應仍存在");
  assert.equal(resp.status, "judged", "應對應被判定");
  assert.equal(resp.resultTitle, RESPONSE_JSON.title, "應寫回應對結果標題");
  assert.ok(resp.judgedAt, "應寫入 judgedAt");
});

test("端對端：AI 拋錯下實際跑每日回合，回合仍完成、決定性結算推進、超事件失敗只記 log 不拋錯", async () => {
  const event = await seedEventWithResponse({ maxTurns: null });

  // 回合前快照：世界時鐘（供還原，避免污染整合測試套件中後續的測試）＋測試國家
  // 科技點（決定性累加，於任何 AI 結算之前執行）。
  const [worldBefore] = await db
    .select({
      currentEra: worldGameStateTable.currentEra,
      statsEra: worldGameStateTable.statsEra,
      gameDate: worldGameStateTable.gameDate,
      lastTurnDate: worldGameStateTable.lastTurnDate,
      lastTurnAt: worldGameStateTable.lastTurnAt,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  assert.ok(worldBefore, "world_game_state 應存在");
  const gameDateBefore = worldBefore.gameDate;
  const techBefore = (await loadNation()).techPoints;

  // 攔截 logger.error 以佐證「失敗被記錄而非拋出」；仍轉呼原本的 logger。
  const realError = logger.error.bind(logger);
  const errorCalls: Array<{ obj: unknown; msg: unknown }> = [];
  (logger as { error: unknown }).error = ((obj: unknown, msg?: unknown) => {
    errorCalls.push({ obj, msg });
    return (realError as (o: unknown, m?: unknown) => void)(obj, msg);
  }) as typeof logger.error;

  // AI 全數拋錯（超事件與其他 AI 結算皆然），驗證回合引擎逐段 try/catch 的隔離性。
  const restore = stubAiThrow();
  let summary: Awaited<ReturnType<typeof runTurnUpdate>>;
  try {
    // force=true 跳過「今日已執行」限制；回合引擎實際入口。
    summary = await runTurnUpdate(new Date(), { force: true });
  } finally {
    restore();
    (logger as { error: unknown }).error = realError;
    // 還原世界時鐘，避免這次 force 回合污染整合套件中後續的測試。
    await db
      .update(worldGameStateTable)
      .set({
        currentEra: worldBefore.currentEra,
        statsEra: worldBefore.statsEra,
        gameDate: worldBefore.gameDate,
        lastTurnDate: worldBefore.lastTurnDate,
        lastTurnAt: worldBefore.lastTurnAt,
      })
      .where(eq(worldGameStateTable.id, 1));
  }

  // 回合仍完成——AI 全掛也不阻斷每日回合。
  assert.equal(summary.ran, true, "AI 全數失敗回合仍應完成");
  assert.ok(summary.gameDate, "回合摘要應含新遊戲日期");
  assert.notEqual(
    summary.gameDate,
    gameDateBefore,
    "回合應推進遊戲日期",
  );

  // 超事件之前的決定性結算照常推進：科技累加段有跑（accrued 計數 > 0）。
  // Task #548 起自產科研點不再入庫（tech_points 只來自條約／送禮／admin），
  // 測試國家無進行中研發節點 → 庫存應維持不變。
  assert.ok(summary.nations, "回合摘要應含國家結算段");
  assert.ok(
    summary.nations.accrued > 0,
    `決定性累加結算應推進（accrued=${summary.nations.accrued}）`,
  );
  const techAfter = (await loadNation()).techPoints;
  assert.equal(
    techAfter,
    techBefore,
    `自產科研點不入庫：庫存應不變（before=${techBefore} after=${techAfter}）`,
  );

  // 超事件失敗只被「記錄」而非「拋出」：logger.error 有本事件的失敗紀錄。
  const superEventFailureLogged = errorCalls.some(
    (c) =>
      c.msg === "super event settlement failed for event" &&
      typeof c.obj === "object" &&
      c.obj !== null &&
      (c.obj as { eventId?: string }).eventId === event.id,
  );
  assert.ok(
    superEventFailureLogged,
    "超事件 AI 失敗應被 logger.error 記錄（含本事件 eventId），而非拋出中斷回合",
  );

  // 本測試超事件未被部分推進（AI 失敗）。
  const [after] = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.id, event.id))
    .limit(1);
  assert.ok(after, "測試事件應仍存在");
  assert.equal(after.turnsElapsed, 0, "AI 失敗不應推進本事件回合數");
  assert.equal(after.status, "active", "AI 失敗不應結束本事件");
  const logs = await db
    .select()
    .from(superEventTurnLogsTable)
    .where(eq(superEventTurnLogsTable.eventId, event.id));
  assert.equal(logs.length, 0, "AI 失敗不應寫入本事件回合紀錄");
});
