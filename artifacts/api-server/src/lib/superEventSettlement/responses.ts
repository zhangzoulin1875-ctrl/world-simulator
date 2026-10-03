import { and, eq } from "drizzle-orm";
import {
  db,
  superEventResponsesTable,
  playerNationsTable,
  type SuperEvent,
  type SuperEventKind,
} from "@workspace/db";
import { judgeSuperEventResponse } from "../superEventAi";
import {
  restrictEffectToTargetStats,
  DEFAULT_LOSS_BOUNDS,
  type SuperEventLossBounds,
} from "../superEventImpact";
import { buildNationGeoCultureContext } from "../nationGeoCulture";
import { notifySuperEvent } from "../gameNotify";
import { logger } from "../logger";
import type { AffectedNation, AppliedDeltas } from "./types";
import { applyEffectToNation } from "./applyEffect";

/**
 * 判定某事件的所有待判定玩家應對。回傳每國本回合的契合度（供主效果差異化）與
 * 應對本身帶來的實際套用變動（供影響紀錄累計）。
 */
export async function judgePendingResponses(
  event: SuperEvent,
  affectedById: Map<string, AffectedNation>,
  mult: number,
  popMult: number,
  currentEra: string,
  statsEra: string,
  lossBounds: SuperEventLossBounds = DEFAULT_LOSS_BOUNDS,
): Promise<{
  judged: number;
  failedAi: number;
  fitByNation: Map<string, number>;
  deltasByNation: Map<string, AppliedDeltas>;
}> {
  const pending = await db
    .select()
    .from(superEventResponsesTable)
    .where(
      and(
        eq(superEventResponsesTable.eventId, event.id),
        eq(superEventResponsesTable.status, "pending"),
      ),
    );
  let judged = 0;
  let failedAi = 0;
  const fitByNation = new Map<string, number>();
  const deltasByNation = new Map<string, AppliedDeltas>();

  for (const resp of pending) {
    const [nation] = await db
      .select({
        id: playerNationsTable.id,
        name: playerNationsTable.name,
        government: playerNationsTable.government,
        discordUserId: playerNationsTable.discordUserId,
      })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, resp.nationId))
      .limit(1);
    if (!nation) continue;
    try {
      // 應對判定貼合該國實際掌控地區的地理人文（查詢失敗回空字串 → 走中性導引）。
      const geoContext = await buildNationGeoCultureContext(nation.id);
      const result = await judgeSuperEventResponse({
        eraSlug: currentEra,
        eventTitle: event.title,
        eventCategory: event.category,
        eventNarrative: event.narrative,
        government: nation.government,
        nationName: nation.name,
        responseText: resp.responseText,
        geoContext,
        targetStats: event.targetStats,
      });
      fitByNation.set(nation.id, result.fitScore);
      // 套用應對帶來的額外效果（用該國目前受影響地區基準）。應對本身的 effect
      // 已由 AI 依契合度給出，這裡不再乘契合度修正（fitScore=null）以免重複折算。
      // 管理員有指定目標數據時，非目標欄位一律歸零（雙重防護）。
      const affected = affectedById.get(nation.id);
      if (affected) {
        const applied = await applyEffectToNation(
          affected,
          restrictEffectToTargetStats(result.effect, event.targetStats),
          mult,
          popMult,
          statsEra,
          event.scope,
          event.kind as SuperEventKind,
          null,
          lossBounds,
        );
        deltasByNation.set(nation.id, applied);
      }
      await db
        .update(superEventResponsesTable)
        .set({
          status: "judged",
          resultTitle: result.title,
          resultDescription: result.description,
          judgedAt: new Date(),
        })
        .where(eq(superEventResponsesTable.id, resp.id));
      judged += 1;
      if (nation.discordUserId) {
        notifySuperEvent({
          discordUserId: nation.discordUserId,
          eventId: event.id,
          title: result.title,
          kind: "response",
          detail: `你對「${event.title}」的應對已判定：${result.title}。`,
        });
      }
    } catch (err) {
      failedAi += 1;
      logger.error(
        { err, eventId: event.id, responseId: resp.id },
        "super event response judgement failed",
      );
    }
  }
  return { judged, failedAi, fitByNation, deltasByNation };
}

/** 把本回合玩家應對的契合度整理成給 AI 的一句摘要。 */
export function buildResponseSummary(
  fitByNation: Map<string, number>,
): string | undefined {
  if (fitByNation.size === 0) return undefined;
  const vals = [...fitByNation.values()];
  const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  const quality = avg >= 70 ? "普遍得當" : avg >= 40 ? "成效不一" : "多半不佳";
  return `本回合有 ${vals.length} 國提出應對，平均契合度約 ${avg}/100（${quality}）。`;
}
