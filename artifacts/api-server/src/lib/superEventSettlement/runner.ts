import { eq } from "drizzle-orm";
import {
  db,
  superEventsTable,
  superEventSettingsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { normalizeLossBounds } from "../superEventImpact";
import type { SuperEventSettlementSummary } from "./types";
import { maybeAutoGenerateSuperEvent } from "./generate";
import { settleEvent } from "./settleEvent";

let settlementInFlight = false;

export async function runSuperEventSettlement(params: {
  statsEra: string;
  currentEra: string;
}): Promise<SuperEventSettlementSummary> {
  if (settlementInFlight) {
    throw new Error("超事件回合結算正在進行中，請稍候");
  }
  settlementInFlight = true;
  try {
    return await settleAll(params.statsEra, params.currentEra);
  } finally {
    settlementInFlight = false;
  }
}

const EMPTY_SUMMARY = (): SuperEventSettlementSummary => ({
  generated: 0,
  eventsProcessed: 0,
  eventsEnded: 0,
  eventsFailedAi: 0,
  responsesJudged: 0,
  responsesFailedAi: 0,
  techGranted: 0,
});

async function settleAll(
  statsEra: string,
  currentEra: string,
): Promise<SuperEventSettlementSummary> {
  const summary = EMPTY_SUMMARY();

  const [settings] = await db
    .select()
    .from(superEventSettingsTable)
    .where(eq(superEventSettingsTable.id, 1))
    .limit(1);
  const chancePct = settings?.autoGenerateChancePct ?? 0;
  const globalImpactPct = settings?.globalImpactPct ?? 100;
  // 管理員設定的損失上下限（每回合負面影響的最低／最高幅度）。
  const lossBounds = normalizeLossBounds(
    settings?.lossMinPct ?? 0,
    settings?.lossMaxPct ?? 100,
  );

  // 1) 每回合自動生成
  await maybeAutoGenerateSuperEvent({
    chancePct,
    aiGenerationPrompt: settings?.aiGenerationPrompt ?? null,
    currentEra,
    summary,
  });

  // 2) 處理所有進行中事件
  const active = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.status, "active"));

  for (const event of active) {
    try {
      const result = await settleEvent(
        event,
        globalImpactPct,
        statsEra,
        currentEra,
        lossBounds,
      );
      summary.eventsProcessed += 1;
      if (result.ended) summary.eventsEnded += 1;
      if (result.techGranted) summary.techGranted += 1;
      summary.responsesJudged += result.responsesJudged;
      summary.responsesFailedAi += result.responsesFailedAi;
    } catch (err) {
      summary.eventsFailedAi += 1;
      logger.error(
        { err, eventId: event.id },
        "super event settlement failed for event",
      );
    }
  }

  return summary;
}
