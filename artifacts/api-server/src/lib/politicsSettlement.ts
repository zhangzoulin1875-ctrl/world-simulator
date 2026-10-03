import { and, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  db,
  diplomacyWarsTable,
  playerArmiesTable,
  playerNationsTable,
  politicsEntriesTable,
  politicsHistoryTable,
  politicsPendingDecisionsTable,
  politicsPendingIdeasTable,
  type PlayerNation,
  type PoliticsEntry,
  type PoliticsModifier,
  type PoliticsPendingDecision,
  type PoliticsPendingIdea,
} from "@workspace/db";
import { logger } from "./logger";
import { computeNationStats, getCurrentEraSlug, getStatsEraSlug } from "./nationStats";
import {
  computeNationMilitaryAggregates,
  type NationMilitaryAggregate,
} from "./militarySnapshots";
import {
  armyPopulationRatioPct,
  desertionRatioPct,
  isMilitaryCoup,
  militaryUnrestChancePct,
  overreachChancePct,
  MILITARY_RECOVERY_DELTA,
  OVERREACH_SATISFACTION_PENALTY,
  OVERREACH_UNREST_INCREASE,
} from "./militaryPolitics";
import { buildNationGeoCultureContext } from "./nationGeoCulture";
import {
  POLITICS_DIRECTIONS,
  acceptanceTick,
  clampPct,
  computePoliticsState,
  counterEventChancePct,
  coupChancePct,
  effectiveMilitaryObedience,
  decisionSuccessChance,
  enabledPoliticsDirections,
  GENERAL_DIRECTION,
  goodEventProbabilityPct,
  isPoliticsDirection,
  pickCoupGovernment,
  policySuccessChance,
  restrictModifiersToEnabledDirections,
  supportDriftTick,
  unrestTick,
  type NationPoliticsState,
  type PoliticsDirection,
  type PoliticsSettings,
} from "./politics";
import {
  COUP_GOVERNMENT_SLUGS,
  governmentDecisionDifficulty,
  governmentLabel,
  governmentSlugByLabel,
} from "./governments";
import { aggregateSocialEffectsByUser } from "./socialTechData";
import {
  loadSatisfactionBuffsByUser,
  type SatisfactionOffsets,
} from "./productionTechData";
import type { AggregatedSocialEffects } from "./socialTech";
import { getPoliticsSettings } from "./politicsSettings";
import {
  clampAiModifiers,
  clampDuration,
  generateCoupNarrative,
  generatePoliticalNote,
  generateRandomEvent,
  judgeGovernmentDecision,
  judgePolicyIdea,
  type PolicyJudgement,
} from "./politicsAi";
import {
  PREGEN_KIND_POLITICS,
  buildPoliticsJudgeInput,
  takePregenResult,
} from "./aiPregenCache";
import { notePregenWork } from "./aiPregenWorker";
import {
  notifyCoup,
  notifyGovernmentChange,
  notifyGovernmentDecision,
  notifyMilitaryPoliticsEvent,
  notifyPolicyJudged,
  notifyPoliticsEvent,
} from "./gameNotify";
import {
  emptyPoliticsDigest,
  sendPoliticsSettlementDm,
  type PoliticsNationDigest,
} from "./politicsDm";
import { maybeTriggerPoliticalSuperEvent } from "./superEventSettlement";
import {
  applyModifierSource,
  getGameBalanceSettings,
  recordAiAbuse,
} from "./gameBalance";

/**
 * Task #43 — 內政回合結算掛勾。
 *
 * 回合引擎（Task #32）尚未建置：本模組把整個結算流程封裝成
 * `runPoliticsSettlement()`，未來回合引擎在每回合結算時直接呼叫；
 * 目前先由管理端 `POST /api/politics/settle`（requireAdmin）手動觸發。
 *
 * 每國流程：
 * 1. AI 判定待判定政策想法（成功→政策/傳統/變革；失敗→負面淡化條目；不直接動國庫金錢）。
 * 2. 變革與事件淡化（remaining−1，0 → expired）；短暫政策到期。
 * 3. 依（更新後）有效滿意度做暴動度／穩定度每回合判定。
 * 4. 隨機好壞事件（依有效穩定度決定好壞，AI 產生、政體風格）。
 * 5. 暴動度 > 門檻時政變／叛亂判定；成功時套用重設制後果（政局打回原點＋倒數）＋AI 敘事。
 *
 * AI 失敗一律記錄並跳過（想法保留到下回合重試），絕不讓結算中斷。
 */

export interface PoliticsSettlementSummary {
  nations: number;
  ideasJudged: number;
  ideasFailedAi: number;
  entriesExpired: number;
  eventsCreated: number;
  coups: number;
  decisionsJudged: number;
  decisionsFailedAi: number;
  governmentChanges: number;
}

let settlementInFlight = false;

export async function runPoliticsSettlement(options?: {
  /** Task #402 — 本回合有維護費缺口（欠餉）的國家 id 集合：暫停軍方和平回升。 */
  upkeepShortfallNationIds?: ReadonlySet<string>;
}): Promise<PoliticsSettlementSummary> {
  // 同步佔鎖（先佔再 await，避免 TOCTOU）。
  if (settlementInFlight) {
    throw new Error("內政回合結算正在進行中，請稍候");
  }
  settlementInFlight = true;
  try {
    return await settleAllNations(undefined, options?.upkeepShortfallNationIds);
  } finally {
    settlementInFlight = false;
  }
}

/**
 * 逐一結算所有國家。單一國家出錯（含 AI 失敗）只記錄並跳過，不影響其他國家。
 *
 * @param nationsOverride 測試用：僅結算指定國家清單（避免掃描整個資料庫並對每個
 *   真實國家呼叫 AI）。未提供時（正式回合）結算資料庫中所有國家。
 */
export async function settleAllNations(
  nationsOverride?: PlayerNation[],
  upkeepShortfallNationIds?: ReadonlySet<string>,
): Promise<PoliticsSettlementSummary> {
  const [
    settings,
    eraSlug,
    allNations,
    socialByUser,
    satisfactionByUser,
    militaryAggregates,
    statsEra,
  ] = await Promise.all([
    getPoliticsSettings(),
    getCurrentEraSlug(),
    nationsOverride
      ? Promise.resolve(nationsOverride)
      : db.select().from(playerNationsTable),
    aggregateSocialEffectsByUser(),
    loadSatisfactionBuffsByUser(),
    // Task #402 — 軍方結算：全體國家軍力聚合值（人口口徑）一次載入。
    computeNationMilitaryAggregates(),
    getStatsEraSlug(),
  ]);
  const nations = allNations;

  const summary: PoliticsSettlementSummary = {
    nations: nations.length,
    ideasJudged: 0,
    ideasFailedAi: 0,
    entriesExpired: 0,
    eventsCreated: 0,
    coups: 0,
    decisionsJudged: 0,
    decisionsFailedAi: 0,
    governmentChanges: 0,
  };

  for (const nation of nations) {
    try {
      await settleNation(
        nation,
        settings,
        eraSlug,
        socialByUser,
        summary,
        satisfactionByUser,
        militaryAggregates,
        statsEra,
        upkeepShortfallNationIds,
      );
    } catch (err) {
      // 單一國家出錯不影響其他國家。
      logger.error(
        { err, nationId: nation.id },
        "politics settlement failed for nation",
      );
    }
  }

  logger.info({ ...summary }, "politics settlement complete");
  return summary;
}

async function loadActiveEntries(nationId: string): Promise<PoliticsEntry[]> {
  return db
    .select()
    .from(politicsEntriesTable)
    .where(
      and(
        eq(politicsEntriesTable.nationId, nationId),
        eq(politicsEntriesTable.status, "active"),
      ),
    );
}

/**
 * 該國本回合「有效」政治方向：法律、文化、軍方恆有效（Task #521 文化開局
 * 即啟用）；宗教／權利需社會關鍵科技解鎖。
 * NPC（無主）不受科技進度限制，全方向皆有效以維持既有平衡。
 */
function enabledDirectionsFor(
  nation: PlayerNation,
  socialByUser: Map<string, AggregatedSocialEffects>,
): PoliticsDirection[] {
  if (nation.discordUserId === null) return [...POLITICS_DIRECTIONS];
  const eff = socialByUser.get(nation.discordUserId);
  return enabledPoliticsDirections({
    religionEnabled: eff?.religionSatisfactionEnabled ?? false,
    rightsEnabled: eff?.rightsSatisfactionEnabled ?? false,
  });
}

/** 寫入一筆政治歷史（時間軸）。 */
async function recordHistory(
  nationId: string,
  eventType: string,
  title: string,
  description: string,
): Promise<void> {
  await db.insert(politicsHistoryTable).values({
    nationId,
    eventType,
    title,
    description,
  });
}

async function settleNation(
  nation: PlayerNation,
  settings: PoliticsSettings,
  eraSlug: string,
  socialByUser: Map<string, AggregatedSocialEffects>,
  summary: PoliticsSettlementSummary,
  satisfactionByUser?: Map<string, SatisfactionOffsets>,
  militaryAggregates?: Map<string, NationMilitaryAggregate>,
  statsEra?: string,
  upkeepShortfallNationIds?: ReadonlySet<string>,
): Promise<void> {
  // Task #355 — 管理員發放的限回合數滿意度暫時偏移；僅有主國家會有 buff。
  const satisfactionOffsets = nation.discordUserId
    ? satisfactionByUser?.get(nation.discordUserId)
    : undefined;
  // 本回合事件彙整：結算完成後一次性私訊玩家（Task #55）。
  const digest = emptyPoliticsDigest(nation.name);
  const enabledDirs = enabledDirectionsFor(nation, socialByUser);

  // 地理人文脈絡：本回合此國所有政治 AI 判定共用一次，讓政策／事件／政變敘事／
  // 政治註記貼合實際掌控地區的文化，而非一律預設中華風格（見 nationGeoCulture）。
  const geoContext = await buildNationGeoCultureContext(nation.id);

  // ── 1. 判定待判定政策想法（只有有主國家會有想法） ──
  const ideas = await db
    .select()
    .from(politicsPendingIdeasTable)
    .where(eq(politicsPendingIdeasTable.nationId, nation.id));

  for (const idea of ideas) {
    const handled = await judgeIdea(
      nation,
      idea,
      settings,
      eraSlug,
      digest,
      geoContext,
      enabledDirs,
    );
    if (handled) summary.ideasJudged += 1;
    else summary.ideasFailedAi += 1;
  }

  // ── 1b. 判定待判定政府決策（Task #127） ──
  const [pendingDecision] = await db
    .select()
    .from(politicsPendingDecisionsTable)
    .where(eq(politicsPendingDecisionsTable.nationId, nation.id))
    .limit(1);
  if (pendingDecision) {
    const handled = await judgeGovernmentDecisionForNation(
      nation,
      pendingDecision,
      settings,
      eraSlug,
      digest,
      geoContext,
    );
    if (handled) summary.decisionsJudged += 1;
    else summary.decisionsFailedAi += 1;
  }

  // ── 2. 淡化／到期：所有帶 remaining_turns 的 active 條目 −1 ──
  const expired = await db
    .update(politicsEntriesTable)
    .set({
      remainingTurns: sql`${politicsEntriesTable.remainingTurns} - 1`,
      status: sql`CASE WHEN ${politicsEntriesTable.remainingTurns} - 1 <= 0 THEN 'expired' ELSE 'active' END`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(politicsEntriesTable.nationId, nation.id),
        eq(politicsEntriesTable.status, "active"),
        isNotNull(politicsEntriesTable.remainingTurns),
      ),
    )
    .returning({ status: politicsEntriesTable.status });
  summary.entriesExpired += expired.filter((r) => r.status === "expired").length;

  // ── 3. 暴動度／穩定度每回合判定（用更新後的有效滿意度） ──
  const [freshNation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nation.id))
    .limit(1);
  if (!freshNation) return;

  let entries = await loadActiveEntries(nation.id);
  let state = computePoliticsState(
    freshNation,
    entries,
    settings,
    satisfactionOffsets,
  );
  // 暴動度／穩定度只計入「已解鎖」方向的滿意度（宗教／權利需科技解鎖）。
  const effectiveSatisfactions = enabledDirs.map((d) => state.satisfactions[d]);
  // Task #451 — 修正來源閘門：politicsEntries（每回合暴動／穩定 tick）與
  // supportDrift（支持度漂移）都以「delta」在套用點夾限（compute helpers 不動）。
  const balanceSettings = await getGameBalanceSettings();
  const tick = unrestTick(effectiveSatisfactions, settings);
  const gatedUnrestDelta = applyModifierSource(
    "politicsEntries",
    tick.unrestDelta,
    balanceSettings,
  );
  const gatedStabilityDelta = applyModifierSource(
    "politicsEntries",
    tick.stabilityDelta,
    balanceSettings,
  );
  const newUnrest = clampPct(freshNation.unrest + gatedUnrestDelta);
  const newStability = clampPct(freshNation.stability + gatedStabilityDelta);
  // ── 3b. 政治支持度朝有效滿意度平均漂移（Task #127） ──
  const driftedSupport = supportDriftTick(
    freshNation.politicalSupport,
    effectiveSatisfactions,
    settings,
  );
  const newSupport = clampPct(
    freshNation.politicalSupport +
      applyModifierSource(
        "supportDrift",
        driftedSupport - freshNation.politicalSupport,
        balanceSettings,
      ),
  );
  await db
    .update(playerNationsTable)
    .set({
      unrest: newUnrest,
      stability: newStability,
      politicalSupport: newSupport,
    })
    .where(eq(playerNationsTable.id, nation.id));
  freshNation.unrest = newUnrest;
  freshNation.stability = newStability;
  freshNation.politicalSupport = newSupport;
  state = computePoliticsState(
    freshNation,
    entries,
    settings,
    satisfactionOffsets,
  );

  // ── 3c. 政體變更接受度累積／消退（達 100 後由玩家主動改制，Task #127） ──
  await settleAcceptance(freshNation, settings);

  // ── 4. 隨機事件（僅有主國家，控制 AI 成本） ──
  if (freshNation.discordUserId !== null) {
    if (Math.random() * 100 < settings.eventChancePct) {
      await applyRandomEvent(
        freshNation,
        settings,
        eraSlug,
        state,
        enabledDirs,
        digest,
        summary,
        geoContext,
      );
    }
  }

  // ── 5. 政變／叛亂判定 ──
  entries = await loadActiveEntries(nation.id);
  state = computePoliticsState(
    freshNation,
    entries,
    settings,
    satisfactionOffsets,
  );
  const chance = coupChancePct(state.unrest, state.stability, settings);
  if (chance > 0 && Math.random() * 100 < chance) {
    await applyCoup(freshNation, settings, eraSlug, digest, summary, geoContext);
    summary.coups += 1;
  }
  const coupFiredThisTurn = digest.coup !== null;

  // ── 5b. 軍方結算（Task #402；僅真人玩家，NPC 不觸發軍方事件） ──
  if (freshNation.discordUserId !== null && !freshNation.isNpc) {
    try {
      await settleMilitaryPolitics(
        freshNation,
        settings,
        eraSlug,
        state.satisfactions["military"] ?? freshNation.satisfactionMilitary,
        effectiveMilitaryObedience(freshNation.militaryObedience, entries),
        militaryAggregates,
        statsEra,
        digest,
        summary,
        geoContext,
        coupFiredThisTurn,
        upkeepShortfallNationIds?.has(freshNation.id) ?? false,
      );
    } catch (err) {
      logger.error(
        { err, nationId: nation.id },
        "politics settlement: military step failed",
      );
    }
  }

  // Task #592 — 政治註記不再每回合 AI 演進：平時沿用現有內容，只在政變
  // （applyCoup 一律重生）與玩家主動改制（applyPlayerGovernmentChange）時全新重生。

  // ── 7. 私訊摘要（Task #55）：有主國家且本回合有事才發，一國一則 ──
  if (freshNation.discordUserId !== null) {
    sendPoliticsSettlementDm(freshNation.discordUserId, digest);
  }
}

/**
 * Task #402 — 軍方結算（僅真人玩家；NPC 不觸發軍方事件）。
 *
 * 規則（機率與損失數量全部由 militaryPolitics.ts 純函式決定，AI 不參與）：
 * 1. 軍隊占人口比 > 10% → 依機率觸發「軍隊越權」：五項滿意度 −5、暴動度 +10。
 * 2. 軍方滿意度＋服從度皆 < 30 → 依機率觸發逃兵（各兵種依伺服器比例逃兵）；
 *    兩者皆 < 15 時升級為軍事政變（沿用 applyCoup；本回合已有政變則不重複）。
 * 3. 和平（無進行中戰爭）且本回合無軍方事件 → 兩數值各 +2 回升（夾 0–100）。
 */
export async function settleMilitaryPolitics(
  nation: PlayerNation,
  settings: PoliticsSettings,
  eraSlug: string,
  effectiveMilitarySatisfaction: number,
  /** 有效服從度（基底 + militaryObedience 政策偏移，夾 0–100；Task #402）。 */
  effectiveObedience: number,
  militaryAggregates: Map<string, NationMilitaryAggregate> | undefined,
  statsEra: string | undefined,
  digest: PoliticsNationDigest,
  summary: PoliticsSettlementSummary,
  geoContext: string,
  coupAlreadyFired: boolean,
  /** 本回合有維護費缺口（欠餉）→ 暫停和平回升（Task #402 code review）。 */
  upkeepShortfallThisTurn: boolean = false,
  rand: () => number = Math.random,
): Promise<void> {
  if (!nation.discordUserId || nation.isNpc) return;

  const aggregates =
    militaryAggregates ?? (await computeNationMilitaryAggregates());
  const era = statsEra ?? (await getStatsEraSlug());
  const agg = aggregates.get(nation.id);
  const armyPopulation = agg?.armyPopulation ?? 0;
  const stats = await computeNationStats(nation.id, era);
  const ratioPct = armyPopulationRatioPct(armyPopulation, stats.population);
  const obedience = effectiveObedience;
  const satisfaction = effectiveMilitarySatisfaction;

  let eventFired = false;

  // ── 軍隊越權/暴動：占比超過門檻 ──
  const overreachChance = overreachChancePct(ratioPct);
  if (overreachChance > 0 && rand() * 100 < overreachChance) {
    eventFired = true;
    const title = "軍隊越權";
    const description = `軍隊規模已達人口的 ${Math.round(ratioPct * 10) / 10}%，軍方勢力凌駕文官體制，各界不滿升溫（五項滿意度各 −${OVERREACH_SATISFACTION_PENALTY}%、暴動度 +${OVERREACH_UNREST_INCREASE}%）。`;
    await db
      .update(playerNationsTable)
      .set({
        satisfactionFarmers: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionFarmers} - ${OVERREACH_SATISFACTION_PENALTY}))`,
        satisfactionWorkers: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionWorkers} - ${OVERREACH_SATISFACTION_PENALTY}))`,
        satisfactionNobles: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionNobles} - ${OVERREACH_SATISFACTION_PENALTY}))`,
        satisfactionClergy: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionClergy} - ${OVERREACH_SATISFACTION_PENALTY}))`,
        satisfactionMilitary: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionMilitary} - ${OVERREACH_SATISFACTION_PENALTY}))`,
        unrest: sql`LEAST(100, GREATEST(0, ${playerNationsTable.unrest} + ${OVERREACH_UNREST_INCREASE}))`,
      })
      .where(eq(playerNationsTable.id, nation.id));
    await db.insert(politicsEntriesTable).values({
      nationId: nation.id,
      direction: "military",
      entryType: "event",
      title,
      description,
      modifiers: [],
      durationTurns: null,
      remainingTurns: null,
    });
    await recordHistory(nation.id, "military_overreach", title, description);
    notifyMilitaryPoliticsEvent({
      discordUserId: nation.discordUserId,
      title: `⚠️ ${title}`,
      body: description,
    });
    digest.event ??= { title, good: false };
  }

  // ── 逃兵／軍事政變：兩數值皆低 ──
  const unrestChance = militaryUnrestChancePct(satisfaction, obedience);
  if (unrestChance > 0 && rand() * 100 < unrestChance) {
    eventFired = true;
    if (isMilitaryCoup(satisfaction, obedience) && !coupAlreadyFired) {
      await applyCoup(nation, settings, eraSlug, digest, summary, geoContext);
      summary.coups += 1;
      await recordHistory(
        nation.id,
        "military_coup",
        "軍事政變",
        "軍方對政府徹底失望，發動政變奪權。",
      );
    } else {
      const ratio = desertionRatioPct(satisfaction, obedience);
      const title = "軍中逃兵潮";
      const description = `軍方士氣崩潰（滿意度 ${Math.round(satisfaction)}%、服從度 ${Math.round(obedience)}%），各兵種約 ${ratio}% 士兵逃離軍隊。`;
      // 逃兵扣減 + 政治條目一 tx 內寫入（code review：避免部分副作用）。
      const deserted = await db.transaction(async (tx) => {
        const rows = await tx
          .update(playerArmiesTable)
          .set({
            quantity: sql`${playerArmiesTable.quantity} - FLOOR(${playerArmiesTable.quantity} * ${ratio} / 100)`,
          })
          .where(
            and(
              eq(playerArmiesTable.discordUserId, nation.discordUserId!),
              sql`${playerArmiesTable.quantity} > 0`,
            ),
          )
          .returning({ quantity: playerArmiesTable.quantity });
        await tx.insert(politicsEntriesTable).values({
          nationId: nation.id,
          direction: "military",
          entryType: "event",
          title,
          description,
          modifiers: [],
          durationTurns: null,
          remainingTurns: null,
        });
        return rows;
      });
      await recordHistory(nation.id, "military_desertion", title, description);
      notifyMilitaryPoliticsEvent({
        discordUserId: nation.discordUserId,
        title: `🏃 ${title}`,
        body: description,
      });
      digest.event ??= { title, good: false };
      logger.info(
        { nationId: nation.id, ratio, rows: deserted.length },
        "military desertion applied",
      );
    }
  }

  // ── 和平回升：無進行中戰爭、本回合無軍方事件、且未欠餉 → 兩數值 +2 ──
  if (!eventFired && !upkeepShortfallThisTurn) {
    const [activeWar] = await db
      .select({ id: diplomacyWarsTable.id })
      .from(diplomacyWarsTable)
      .where(
        and(
          isNull(diplomacyWarsTable.endedAt),
          or(
            eq(diplomacyWarsTable.nationAId, nation.id),
            eq(diplomacyWarsTable.nationBId, nation.id),
          ),
        ),
      )
      .limit(1);
    if (!activeWar) {
      await db
        .update(playerNationsTable)
        .set({
          satisfactionMilitary: sql`LEAST(100, ${playerNationsTable.satisfactionMilitary} + ${MILITARY_RECOVERY_DELTA})`,
          militaryObedience: sql`LEAST(100, ${playerNationsTable.militaryObedience} + ${MILITARY_RECOVERY_DELTA})`,
        })
        .where(eq(playerNationsTable.id, nation.id));
    }
  }
}

/** 條目描述附上玩家原始政策想法，方便對照判定結果與當初的提案。 */
function withSourceIdea(description: string, idea: string): string {
  const trimmed = idea.trim();
  if (trimmed.length === 0) return description;
  return `${description}\n\n💡 原始政策想法：「${trimmed}」`;
}

/**
 * 判定單一想法。回傳 true = 已判定（成功或失敗結果已入庫、想法已刪除）。
 * Task #393 — 新制想法（direction 非四方向之一）走「綜合」判定：AI 用指定方向
 * 滿意度目標，伺服器端再把未解鎖方向的滿意度加減成強制移除（enabledDirs）。
 * 舊制帶方向的遺留列維持原本逐方向判定。
 */
export async function judgeIdea(
  nation: PlayerNation,
  idea: PoliticsPendingIdea,
  settings: PoliticsSettings,
  eraSlug: string,
  digest: PoliticsNationDigest,
  geoContext: string = "",
  enabledDirs: readonly PoliticsDirection[] = POLITICS_DIRECTIONS,
): Promise<boolean> {
  const legacyDirection = isPoliticsDirection(idea.direction)
    ? idea.direction
    : null;
  const direction = legacyDirection ?? GENERAL_DIRECTION;
  let judgement;
  try {
    // v3 閒時預產：先以輸入雜湊比對背景預產快取，命中就直接用（不打 AI、
    // 取用即消耗）；未命中（沒預產過／玩家改過想法／輸入已變）照舊現場判定。
    const { hash } = await buildPoliticsJudgeInput(nation, idea, settings);
    judgement =
      (await takePregenResult<PolicyJudgement>(
        PREGEN_KIND_POLITICS,
        nation.id,
        hash,
      )) ??
      (await judgePolicyIdea({
        government: nation.government,
        direction: legacyDirection,
        eraSlug,
        idea: idea.idea,
        politicalNote: nation.politicalNote,
        geoContext,
        settings,
      }));
  } catch (err) {
    // AI 失敗：記錄並保留想法，下回合重試；順便讓預產 worker 待命重試。
    notePregenWork();
    logger.error(
      { err, nationId: nation.id, direction },
      "politics idea judgement failed — kept for next settlement",
    );
    return false;
  }

  // Task #451 — 濫用旗標：強制走失敗結果、歸零失敗結果中的正面加成並記錄
  // 稽核（暴政合法、不在此列；審查停用時忽略旗標）。
  const balance = await getGameBalanceSettings();
  const abuseFlagged =
    balance.interior.reviewEnabled && judgement.abuseReason !== null;

  // AI 偶爾把「不適用」的分支填 null（schema 容忍單側 null，至少一側非 null）：
  // 缺 success → 強制走失敗；缺 failure → 強制走成功。過去這裡整筆解析失敗，
  // 想法會永遠卡在待判定重試（正式站實際發生過）。
  const successOutcome = judgement.success;
  let failureOutcome = judgement.failure;
  if (successOutcome === null || failureOutcome === null) {
    // 觀測：bulk 模型違反「兩側都要完整物件」prompt 規則的頻率。
    logger.warn(
      {
        nationId: nation.id,
        direction,
        missingSide: successOutcome === null ? "success" : "failure",
      },
      "politics idea judgement single-side null tolerated",
    );
  }

  if (abuseFlagged) {
    // 強制走失敗；AI 連 failure 都沒給時，以 abuseReason 合成最小失敗結果。
    const base = failureOutcome ?? {
      title: "政策遭駁回",
      description: judgement.abuseReason ?? "政策想法未通過審查。",
      modifiers: [],
      durationTurns: settings.reformDurationTurns,
    };
    failureOutcome = {
      ...base,
      modifiers: base.modifiers.map((m) => ({
        ...m,
        value: Math.min(0, m.value),
      })),
    };
    await recordAiAbuse({
      domain: "interior_policy",
      verdict: "forced_failure",
      discordUserId: nation.discordUserId,
      nationId: nation.id,
      nationName: nation.name,
      inputText: idea.idea,
      reason: judgement.abuseReason ?? "",
      context: { direction },
    });
  }

  const entries = await loadActiveEntries(nation.id);
  const state = computePoliticsState(nation, entries, settings);
  const successPct = policySuccessChance(
    state.stability,
    judgement.fitScore,
    settings,
  );
  const succeeded =
    !abuseFlagged &&
    successOutcome !== null &&
    (failureOutcome === null || Math.random() * 100 < successPct);

  if (succeeded && successOutcome !== null) {
    const outcome = successOutcome;
    const entryType = judgement.resultType;
    // reform 一定要有持續回合（淡化）；policy/tradition 可永久或短暫。
    let duration = clampDuration(outcome.durationTurns, settings, judgement.resultType);
    if (entryType === "reform" && duration === null) {
      duration = settings.reformDurationTurns;
    }
    await db.insert(politicsEntriesTable).values({
      nationId: nation.id,
      direction,
      entryType,
      title: outcome.title,
      description: withSourceIdea(outcome.description, idea.idea),
      modifiers: restrictModifiersToEnabledDirections(
        clampAiModifiers(outcome.modifiers as PoliticsModifier[], settings),
        enabledDirs,
      ),
      durationTurns: duration,
      remainingTurns: duration,
    });
    digest.policies.push({ title: outcome.title, succeeded: true });
    if (nation.discordUserId) {
      notifyPolicyJudged({
        discordUserId: nation.discordUserId,
        title: outcome.title,
        idea: idea.idea,
        succeeded: true,
      });
    }
  } else {
    const outcome = failureOutcome;
    if (outcome === null) {
      // 防禦：schema refine 保證至少一側非 null、abuse 路徑已合成 failure，
      // 理論上到不了這裡；萬一發生就保留想法下回合重試。
      logger.error(
        { nationId: nation.id, direction },
        "politics idea judgement missing failure outcome — kept for next settlement",
      );
      return false;
    }
    const duration =
      clampDuration(outcome.durationTurns, settings, "reform") ??
      settings.reformDurationTurns;
    // 內政政策禁止直接獲得或扣除金錢：失敗只留負面 modifiers，不再賠款。
    await db.insert(politicsEntriesTable).values({
      nationId: nation.id,
      direction,
      entryType: "reform",
      title: `【失敗】${outcome.title}`,
      description: withSourceIdea(outcome.description, idea.idea),
      modifiers: restrictModifiersToEnabledDirections(
        clampAiModifiers(outcome.modifiers as PoliticsModifier[], settings),
        enabledDirs,
      ),
      durationTurns: duration,
      remainingTurns: duration,
    });
    digest.policies.push({ title: outcome.title, succeeded: false });
    if (nation.discordUserId) {
      notifyPolicyJudged({
        discordUserId: nation.discordUserId,
        title: outcome.title,
        idea: idea.idea,
        succeeded: false,
      });
    }
  }

  await db
    .delete(politicsPendingIdeasTable)
    .where(eq(politicsPendingIdeasTable.id, idea.id));
  return true;
}

/**
 * 產生一則隨機內政事件（AI 生成，僅有主國家）。AI 失敗時記錄並跳過本回合事件，
 * 不寫入條目、不更新彙整、不中斷結算。事件發生機率由呼叫端把關（此處必定嘗試）。
 */
export async function applyRandomEvent(
  nation: PlayerNation,
  settings: PoliticsSettings,
  eraSlug: string,
  state: NationPoliticsState,
  enabledDirs: PoliticsDirection[],
  digest: PoliticsNationDigest,
  summary: PoliticsSettlementSummary,
  geoContext: string = "",
): Promise<void> {
  const good =
    Math.random() * 100 < goodEventProbabilityPct(state.stability, settings);
  const direction =
    enabledDirs[Math.floor(Math.random() * enabledDirs.length)] ?? "law";
  try {
    const event = await generateRandomEvent({
      government: nation.government,
      direction,
      eraSlug,
      good,
      politicalNote: nation.politicalNote,
      geoContext,
      settings,
    });
    const duration =
      clampDuration(event.durationTurns, settings, "event") ??
      settings.eventDurationTurns;
    await db.insert(politicsEntriesTable).values({
      nationId: nation.id,
      direction,
      entryType: "event",
      title: event.title,
      description: event.description,
      modifiers: restrictModifiersToEnabledDirections(
        clampAiModifiers(event.modifiers, settings),
        enabledDirs,
      ),
      durationTurns: duration,
      remainingTurns: duration,
    });
    summary.eventsCreated += 1;
    digest.event = { title: event.title, good };
    if (nation.discordUserId) {
      notifyPoliticsEvent({
        discordUserId: nation.discordUserId,
        title: event.title,
        good,
      });
    }
  } catch (err) {
    logger.error(
      { err, nationId: nation.id },
      "politics random event generation failed — skipped",
    );
  }
}

/** 政變成功：套用設定懲罰＋AI 敘事事件（AI 失敗時用預設文字，不中斷）。 */
export async function applyCoup(
  nation: PlayerNation,
  settings: PoliticsSettings,
  eraSlug: string,
  digest: PoliticsNationDigest,
  summary: PoliticsSettlementSummary,
  geoContext: string = "",
): Promise<void> {
  // 政變被動改變政體：從政變常見政體中挑一個（排除現制）。
  const currentSlug = governmentSlugByLabel(nation.government);
  const nextGovSlug = pickCoupGovernment(currentSlug, COUP_GOVERNMENT_SLUGS);
  const nextGovLabel = nextGovSlug ? governmentLabel(nextGovSlug) : null;

  let title = "政變爆發";
  let description =
    "累積的民怨終於爆發——反對勢力發動政變奪取權力，全國政局被打回原點：民心、穩定與政府威信全數重置，短期內政令難行、軍心浮動。";
  try {
    const narrative = await generateCoupNarrative({
      government: nation.government,
      eraSlug,
      nationName: nation.name,
      newGovernment: nextGovLabel,
      politicalNote: nation.politicalNote,
      geoContext,
    });
    title = narrative.title;
    description = narrative.description;
  } catch (err) {
    logger.error(
      { err, nationId: nation.id },
      "coup narrative generation failed — using fallback text",
    );
  }

  // Task #584 — 政變後果重設制：不再扣錢／扣滿意度，而是把政局「打回原點」：
  // 五項滿意度＋服從度＋穩定度＋支持度重設、暴動度歸零，並啟動政策封鎖與
  // 士氣懲罰倒數（每回合 −1）。
  const resetSat = clampPct(settings.coupResetSatisfaction);
  const resetValues = {
    stability: clampPct(settings.coupResetStability),
    unrest: clampPct(settings.coupResetUnrest),
    satisfactionFarmers: resetSat,
    satisfactionWorkers: resetSat,
    satisfactionNobles: resetSat,
    satisfactionClergy: resetSat,
    satisfactionMilitary: resetSat,
    militaryObedience: clampPct(settings.coupResetObedience),
    politicalSupport: clampPct(settings.coupResetSupport),
    coupPolicyLockTurns: Math.max(0, Math.floor(settings.coupPolicyLockTurns)),
    coupMoralePenaltyTurns: Math.max(
      0,
      Math.floor(settings.coupMoralePenaltyTurns),
    ),
  };
  await db
    .update(playerNationsTable)
    .set({
      ...resetValues,
      // 政變改制：政體更換、接受度歸零（支持度已由重設值統一套用）。
      ...(nextGovLabel
        ? {
            government: nextGovLabel,
            governmentChangeAcceptance: 0,
          }
        : {}),
    })
    .where(eq(playerNationsTable.id, nation.id));
  // 同步記憶體內國家物件：本回合後續結算步驟（支持度漂移、接受度、事件）
  // 都以傳入的 nation 為準。
  nation.stability = resetValues.stability;
  nation.unrest = resetValues.unrest;
  nation.satisfactionFarmers = resetValues.satisfactionFarmers;
  nation.satisfactionWorkers = resetValues.satisfactionWorkers;
  nation.satisfactionNobles = resetValues.satisfactionNobles;
  nation.satisfactionClergy = resetValues.satisfactionClergy;
  nation.satisfactionMilitary = resetValues.satisfactionMilitary;
  nation.militaryObedience = resetValues.militaryObedience;
  nation.politicalSupport = resetValues.politicalSupport;
  nation.coupPolicyLockTurns = resetValues.coupPolicyLockTurns;
  nation.coupMoralePenaltyTurns = resetValues.coupMoralePenaltyTurns;
  if (nextGovLabel) nation.governmentChangeAcceptance = 0;

  const govChangeText = nextGovLabel
    ? `、政體變更為「${nextGovLabel}」`
    : "";
  const lockText =
    resetValues.coupPolicyLockTurns > 0
      ? `、${resetValues.coupPolicyLockTurns} 回合內無法推行政策與設計兵種`
      : "";
  const moraleText =
    resetValues.coupMoralePenaltyTurns > 0
      ? `、軍隊士氣低落 ${resetValues.coupMoralePenaltyTurns} 回合`
      : "";
  await db.insert(politicsEntriesTable).values({
    nationId: nation.id,
    direction: "law",
    entryType: "event",
    title,
    description: `${description}（政局重整：滿意度／穩定度／支持度重設為中間值、暴動度歸零${lockText}${moraleText}${govChangeText}）`,
    modifiers: [],
    durationTurns: null,
    remainingTurns: null,
  });

  await recordHistory(
    nation.id,
    "coup",
    title,
    `${description}（政局重整：滿意度／穩定度／支持度重設為中間值、暴動度歸零${lockText}${moraleText}${govChangeText}）`,
  );

  if (nextGovLabel) {
    const fromGovernment = nation.government;
    nation.government = nextGovLabel;
    summary.governmentChanges += 1;
    if (nation.discordUserId) {
      notifyGovernmentChange({
        discordUserId: nation.discordUserId,
        fromGovernment,
        toGovernment: nextGovLabel,
        viaCoup: true,
      });
    }
  }

  // Task #592 — 玩家國家政變一律全新重生政治註記（不論是否同時改制）：政局
  // 重整後的治理氛圍與政變前截然不同，沿用舊註記會失真。NPC 維持既有行為
  // （僅改制時清空，其餘沿用外交懶惰生成的快取註記）。
  if (nation.discordUserId !== null || nextGovLabel) {
    await regeneratePoliticalNote(nation, geoContext);
  }

  digest.coup = { title };
  if (nation.discordUserId) {
    notifyCoup({ discordUserId: nation.discordUserId, title });
  }
}

/**
 * 改制或建國後重新產生政治註記（僅有主國家；AI 失敗時清空為 null，供 overview
 * 之後再懶惰重生，不中斷結算）。同步更新傳入的 nation 物件。
 */
async function regeneratePoliticalNote(
  nation: PlayerNation,
  geoContext: string = "",
): Promise<void> {
  if (nation.discordUserId === null) {
    // NPC 不產生註記。
    await db
      .update(playerNationsTable)
      .set({ politicalNote: null })
      .where(eq(playerNationsTable.id, nation.id));
    nation.politicalNote = null;
    return;
  }
  let note: string | null = null;
  try {
    note = await generatePoliticalNote({
      government: nation.government,
      eraSlug: await getCurrentEraSlug(),
      nationName: nation.name,
      leaderName: nation.leaderName,
      geoContext,
    });
  } catch (err) {
    logger.error(
      { err, nationId: nation.id },
      "political note regeneration failed — cleared for lazy retry",
    );
  }
  await db
    .update(playerNationsTable)
    .set({ politicalNote: note })
    .where(eq(playerNationsTable.id, nation.id));
  nation.politicalNote = note;
}

/**
 * 政體變更接受度每回合結算（Task #127）：支持度低於門檻累積、否則消退（夾 0–100）。
 * 達 100 後由玩家主動改制（POST /api/politics/government-change），此處不自動更換政體。
 */
async function settleAcceptance(
  nation: PlayerNation,
  settings: PoliticsSettings,
): Promise<void> {
  const newAcceptance = acceptanceTick(
    nation.politicalSupport,
    nation.governmentChangeAcceptance,
    settings,
  );

  // Task #127：接受度只累積／消退（夾 0–100），達 100 後由玩家主動改制
  // （POST /api/politics/government-change），此處不自動更換政體。政變才是被動改制。
  if (newAcceptance !== nation.governmentChangeAcceptance) {
    await db
      .update(playerNationsTable)
      .set({ governmentChangeAcceptance: newAcceptance })
      .where(eq(playerNationsTable.id, nation.id));
    nation.governmentChangeAcceptance = newAcceptance;
  }
}

/**
 * Task #127 — 玩家主動政體變更：接受度達 100 時，改為玩家指定（且已解鎖）的政體。
 * 以條件式 UPDATE（WHERE 接受度 ≥ 100）搶佔，避免競態；成功後重設支持度、接受度歸零、
 * 寫入條目與歷史、重生政治註記並通知。回傳 false = 條件已不成立（例如接受度已被消耗）。
 */
export async function applyPlayerGovernmentChange(
  nation: PlayerNation,
  targetLabel: string,
): Promise<boolean> {
  const settings = await getPoliticsSettings();
  const fromGovernment = nation.government;
  const claimed = await db
    .update(playerNationsTable)
    .set({
      government: targetLabel,
      politicalSupport: settings.governmentChangeSupportReset,
      governmentChangeAcceptance: 0,
    })
    .where(
      and(
        eq(playerNationsTable.id, nation.id),
        gte(playerNationsTable.governmentChangeAcceptance, 100),
      ),
    )
    .returning();
  if (claimed.length === 0) return false;

  nation.government = targetLabel;
  nation.politicalSupport = settings.governmentChangeSupportReset;
  nation.governmentChangeAcceptance = 0;

  const title = "政體變更";
  const description = `在累積的政治壓力下，國家順應民意，政體由「${fromGovernment}」主動變更為「${targetLabel}」。`;
  await db.insert(politicsEntriesTable).values({
    nationId: nation.id,
    direction: "law",
    entryType: "event",
    title,
    description,
    modifiers: [],
    durationTurns: null,
    remainingTurns: null,
  });
  await recordHistory(nation.id, "government_change", title, description);

  const geoContext = await buildNationGeoCultureContext(nation.id);
  await regeneratePoliticalNote(nation, geoContext);

  if (nation.discordUserId) {
    notifyGovernmentChange({
      discordUserId: nation.discordUserId,
      fromGovernment,
      toGovernment: targetLabel,
      viaCoup: false,
    });
  }
  return true;
}

/**
 * 判定單一政府決策（Task #127）。回傳 true = 已判定（結果已入庫、待判定已刪除）。
 * AI 失敗回傳 false（待判定保留到下回合重試）。
 */
export async function judgeGovernmentDecisionForNation(
  nation: PlayerNation,
  pending: PoliticsPendingDecision,
  settings: PoliticsSettings,
  eraSlug: string,
  digest: PoliticsNationDigest,
  geoContext: string = "",
): Promise<boolean> {
  let judgement;
  try {
    judgement = await judgeGovernmentDecision({
      government: nation.government,
      eraSlug,
      politicalSupport: nation.politicalSupport,
      politicalNote: nation.politicalNote,
      decision: pending.decision,
      geoContext,
    });
  } catch (err) {
    logger.error(
      { err, nationId: nation.id },
      "government decision judgement failed — kept for retry",
    );
    return false;
  }

  const difficulty = governmentDecisionDifficulty(nation.government);
  const successChance = decisionSuccessChance(
    nation.politicalSupport,
    difficulty,
    judgement.fitScore,
    settings,
  );
  // AI 偶爾把「不適用」的分支填 null（schema 容忍單側 null，至少一側非 null）：
  // 缺 success → 強制走失敗；缺 failure → 強制走成功。
  if (judgement.success === null || judgement.failure === null) {
    // 觀測：bulk 模型違反「兩側都要完整物件」prompt 規則的頻率。
    logger.warn(
      {
        nationId: nation.id,
        missingSide: judgement.success === null ? "success" : "failure",
      },
      "government decision judgement single-side null tolerated",
    );
  }
  const succeeded =
    judgement.success !== null &&
    (judgement.failure === null || Math.random() * 100 < successChance);
  const outcome = succeeded ? judgement.success : judgement.failure;
  if (outcome === null) {
    // 防禦：schema refine 保證至少一側非 null，理論上到不了這裡；
    // 萬一發生就保留決策下回合重試。
    logger.error(
      { nationId: nation.id },
      "government decision judgement missing outcome — kept for retry",
    );
    return false;
  }

  // 低支持度反制事件：失敗時且支持度低於門檻，額外扣穩定度懲罰。
  let counterPenalty = 0;
  if (!succeeded) {
    const counterChance = counterEventChancePct(nation.politicalSupport, settings);
    if (counterChance > 0 && Math.random() * 100 < counterChance) {
      counterPenalty = settings.counterEventStabilityPenalty;
    }
  }

  const supportDelta = succeeded
    ? settings.decisionSuccessSupportDelta
    : -settings.decisionFailureSupportDelta;
  const newSupport = clampPct(nation.politicalSupport + supportDelta);
  const newStability = clampPct(
    nation.stability + outcome.stabilityDelta - counterPenalty,
  );
  const acceptanceDelta = outcome.acceptanceDelta;
  const newAcceptance = clampPct(
    nation.governmentChangeAcceptance + acceptanceDelta,
  );

  await db
    .update(playerNationsTable)
    .set({
      politicalSupport: newSupport,
      stability: newStability,
      governmentChangeAcceptance: newAcceptance,
    })
    .where(eq(playerNationsTable.id, nation.id));
  nation.politicalSupport = newSupport;
  nation.stability = newStability;
  nation.governmentChangeAcceptance = newAcceptance;

  const counterText =
    counterPenalty > 0
      ? `\n\n⚠️ 低支持度反制：政壇動盪加劇，穩定度額外 −${counterPenalty}%。`
      : "";
  const description = `${outcome.description}（支持度 ${supportDelta >= 0 ? "+" : ""}${supportDelta}、穩定度 ${outcome.stabilityDelta >= 0 ? "+" : ""}${outcome.stabilityDelta}%、政體變更接受度 ${acceptanceDelta >= 0 ? "+" : ""}${acceptanceDelta}）${counterText}\n\n🏛️ 政府決策：「${pending.decision.trim()}」`;

  await db.insert(politicsEntriesTable).values({
    nationId: nation.id,
    direction: "law",
    entryType: "event",
    title: outcome.title,
    description,
    modifiers: [],
    durationTurns: null,
    remainingTurns: null,
  });

  await recordHistory(
    nation.id,
    succeeded ? "decision_success" : "decision_failure",
    outcome.title,
    description,
  );

  // 刪除待判定決策。
  await db
    .delete(politicsPendingDecisionsTable)
    .where(eq(politicsPendingDecisionsTable.id, pending.id));

  digest.event = { title: outcome.title, good: succeeded };
  if (nation.discordUserId) {
    notifyGovernmentDecision({
      discordUserId: nation.discordUserId,
      title: outcome.title,
      decision: pending.decision,
      succeeded,
    });
  }

  // Task #333 — 政治決策以極低機率（0.5%）觸發一則超事件（fire-and-forget；
  // 內部自行 try/catch，未命中或失敗皆為 no-op，絕不影響內政結算）。
  void maybeTriggerPoliticalSuperEvent({
    nationId: nation.id,
    nationName: nation.name,
    currentEra: eraSlug,
    decisionSummary: pending.decision,
  });
  return true;
}
