import { eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  db,
  playerNationsTable,
  financePendingIdeasTable,
  financeEntriesTable,
  type PlayerNation,
  type FinancePendingIdea,
  type FinanceEntryDetails,
} from "@workspace/db";
import { logger } from "./logger";
import { getCurrentEraSlug } from "./nationStats";
import { clampTaxRate, effectiveTaxEfficiencyPct } from "./economy";
import { judgeFiscalPolicyIdea, type FiscalPolicyJudgement } from "./financeAi";
import { notePregenWork } from "./aiPregenWorker";
import {
  PREGEN_KIND_FISCAL,
  buildFiscalJudgeInput,
  takePregenResult,
} from "./aiPregenCache";
import { buildNationGeoCultureContext } from "./nationGeoCulture";
import { loadActivePolicySummaries } from "./politicsActivePolicies";
import { buildNationContext } from "./nationContext";
import { notifyFiscalPolicyJudged } from "./gameNotify";
import {
  applyModifierSource,
  getGameBalanceSettings,
  recordAiAbuse,
} from "./gameBalance";

/**
 * 經濟系統（Task #117）— 財政政策回合結算掛勾。
 *
 * 每國若有一則待判定的「財政政策」自由文字，回合結算時交由 AI 判定，並把
 * 影響「一次性、永久」套用：稅率新值、四項滿意度整體偏移、穩定度偏移。
 * 財政政策完全不動國庫金錢（Task #564）——不更新 money、不寫財政流水。
 * 判定後寫入 finance_entries 歷史列並刪除想法。
 * AI 失敗一律記錄並保留想法（下回合重試），絕不讓結算中斷。
 *
 * 由回合引擎在每回合結算時呼叫（於內政結算之前）。
 */

export interface FinanceSettlementSummary {
  nations: number;
  ideasJudged: number;
  ideasFailedAi: number;
}

let settlementInFlight = false;

export async function runFinanceSettlement(): Promise<FinanceSettlementSummary> {
  // 同步佔鎖（先佔再 await，避免 TOCTOU）。
  if (settlementInFlight) {
    throw new Error("財政回合結算正在進行中，請稍候");
  }
  settlementInFlight = true;
  try {
    return await settleAllNations();
  } finally {
    settlementInFlight = false;
  }
}

async function settleAllNations(): Promise<FinanceSettlementSummary> {
  const [eraSlug, nations] = await Promise.all([
    getCurrentEraSlug(),
    db.select().from(playerNationsTable),
  ]);

  const summary: FinanceSettlementSummary = {
    nations: nations.length,
    ideasJudged: 0,
    ideasFailedAi: 0,
  };

  for (const nation of nations) {
    try {
      await settleNation(nation, eraSlug, summary);
    } catch (err) {
      // 單一國家出錯不影響其他國家。
      logger.error(
        { err, nationId: nation.id },
        "finance settlement failed for nation",
      );
    }
  }

  logger.info({ ...summary }, "finance settlement complete");
  return summary;
}

/** 單一國家的財政政策結算（匯出供整合測試直接呼叫，避免整庫 fan-out）。 */
export async function settleNation(
  nation: PlayerNation,
  eraSlug: string,
  summary: FinanceSettlementSummary,
): Promise<void> {
  const pending = await loadPendingIdea(nation.id);
  if (!pending) return;

  const geoContext = await buildNationGeoCultureContext(nation.id);

  const taxEfficiencyPct = effectiveTaxEfficiencyPct(
    eraSlug,
    nation.taxEfficiencyBonus,
  );

  let judgement;
  try {
    // 國情快照（2026-10）：戰爭／饑荒／現行制度貼合判定；預產雜湊與
    // 現場判定共用同一份資料，兩端一致。
    const activePolicies = await loadActivePolicySummaries(nation.id);
    const context = await buildNationContext(nation, eraSlug, { activePolicies });
    // v3 閒時預產：先以輸入雜湊比對背景預產快取，命中就直接用（不打 AI、
    // 取用即消耗）；未命中（沒預產過／玩家改過想法／輸入已變）照舊現場判定。
    const { hash } = await buildFiscalJudgeInput(nation, pending, {
      context,
      activePolicies,
    });
    judgement =
      (await takePregenResult<FiscalPolicyJudgement>(
        PREGEN_KIND_FISCAL,
        nation.id,
        hash,
      )) ??
      (await judgeFiscalPolicyIdea({
        government: nation.government,
        eraSlug,
        currentTaxRatePct: nation.taxRatePct,
        taxEfficiencyPct,
        idea: pending.idea,
        geoContext,
        context,
      }));
  } catch (err) {
    // AI 失敗：保留想法，下回合重試；順便讓預產 worker 待命重試。
    summary.ideasFailedAi += 1;
    notePregenWork();
    logger.error(
      { err, nationId: nation.id },
      "fiscal policy AI judgement failed; keeping idea for retry",
    );
    return;
  }

  const balance = await getGameBalanceSettings();

  // Task #451 — 濫用旗標：歸零正面效果、強制壞事件並記錄稽核（暴政不在此列）。
  const abuseReason = judgement.abuseReason;
  if (balance.interior.reviewEnabled && abuseReason) {
    judgement = {
      ...judgement,
      isGood: false,
      newRatePct: null,
      satisfactionDelta: Math.min(0, judgement.satisfactionDelta),
      stabilityDelta: Math.min(0, judgement.stabilityDelta),
    };
    await recordAiAbuse({
      domain: "fiscal_policy",
      verdict: "neutralized",
      discordUserId: nation.discordUserId,
      nationId: nation.id,
      nationName: nation.name,
      inputText: pending.idea,
      reason: abuseReason,
      context: { title: judgement.title },
    });
  }

  // Task #451 — 修正來源閘門：fiscalPolicy 停用時歸零、啟用時夾在 min/max。
  judgement = {
    ...judgement,
    satisfactionDelta: applyModifierSource(
      "fiscalPolicy",
      judgement.satisfactionDelta,
      balance,
    ),
    stabilityDelta: applyModifierSource(
      "fiscalPolicy",
      judgement.stabilityDelta,
      balance,
    ),
  };

  const taxRateBefore = nation.taxRatePct;
  const taxRateAfter =
    judgement.newRatePct === null
      ? taxRateBefore
      : clampTaxRate(judgement.newRatePct);
  // Task #564 — 財政政策完全不動國庫：details 不再寫 moneyDelta（新條目無金錢 chip）。
  const details: FinanceEntryDetails = {
    taxRateBefore,
    taxRateAfter,
    satisfactionDelta: judgement.satisfactionDelta,
    stabilityDelta: judgement.stabilityDelta,
  };

  await db.transaction(async (tx) => {
    // 一次性、永久套用：稅率、四項滿意度、穩定度（不動國庫金錢，Task #564）。
    await tx
      .update(playerNationsTable)
      .set({
        taxRatePct: taxRateAfter,
        stability: clampColumn(playerNationsTable.stability, judgement.stabilityDelta),
        satisfactionFarmers: clampColumn(
          playerNationsTable.satisfactionFarmers,
          judgement.satisfactionDelta,
        ),
        satisfactionWorkers: clampColumn(
          playerNationsTable.satisfactionWorkers,
          judgement.satisfactionDelta,
        ),
        satisfactionNobles: clampColumn(
          playerNationsTable.satisfactionNobles,
          judgement.satisfactionDelta,
        ),
        satisfactionClergy: clampColumn(
          playerNationsTable.satisfactionClergy,
          judgement.satisfactionDelta,
        ),
      })
      .where(eq(playerNationsTable.id, nation.id));

    // 歷史紀錄（純顯示）。
    await tx.insert(financeEntriesTable).values({
      nationId: nation.id,
      title: judgement.title,
      description: judgement.description,
      isGood: judgement.isGood,
      details,
    });

    // 刪除待判定想法（已處理）。
    await tx
      .delete(financePendingIdeasTable)
      .where(eq(financePendingIdeasTable.id, pending.id));
  });

  summary.ideasJudged += 1;

  if (nation.discordUserId) {
    notifyFiscalPolicyJudged({
      discordUserId: nation.discordUserId,
      title: judgement.title,
      idea: pending.idea,
      isGood: judgement.isGood,
    });
  }
}

async function loadPendingIdea(
  nationId: string,
): Promise<FinancePendingIdea | undefined> {
  const rows = await db
    .select()
    .from(financePendingIdeasTable)
    .where(eq(financePendingIdeasTable.nationId, nationId))
    .limit(1);
  return rows[0];
}

/** 對某欄位套用有號偏移並夾在 [0, 100]（回傳 SQL 片段）。 */
function clampColumn(column: AnyPgColumn, delta: number) {
  return sql`LEAST(100, GREATEST(0, ${column} + ${delta}))`;
}
