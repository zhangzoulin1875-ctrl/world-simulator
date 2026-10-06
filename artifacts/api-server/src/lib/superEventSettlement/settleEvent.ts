import { eq } from "drizzle-orm";
import {
  db,
  superEventsTable,
  superEventRegionsTable,
  superEventTurnLogsTable,
  type SuperEvent,
  type SuperEventKind,
} from "@workspace/db";
import { logger } from "../logger";
import { judgeSuperEventTurn } from "../superEventAi";
import {
  stageSeverityFactor,
  isSuperEventStage,
  restrictEffectToTargetStats,
  DEFAULT_LOSS_BOUNDS,
  type SuperEventLossBounds,
} from "../superEventImpact";
import { buildRegionSetGeoCultureContext } from "../nationGeoCulture";
import { notifySuperEvent } from "../gameNotify";
import { addDeltas, ZERO_DELTAS, type AppliedDeltas } from "./types";
import { loadAffectedNations } from "./affectedNations";
import {
  applyEffectToNation,
  buildEffectSummary,
  recordNationImpacts,
} from "./applyEffect";
import { judgePendingResponses, buildResponseSummary } from "./responses";
import { grantCrossEraTech, triggerNpcHostility } from "./techGrant";
import { spreadContagion } from "./contagion";
import { isRevolutionWave, stepRevolutionPressure, triggerWaveRevolts } from "./revolutionWave";

export async function settleEvent(
  event: SuperEvent,
  globalImpactPct: number,
  statsEra: string,
  currentEra: string,
  lossBounds: SuperEventLossBounds = DEFAULT_LOSS_BOUNDS,
): Promise<{ ended: boolean; techGranted: boolean; responsesJudged: number; responsesFailedAi: number }> {
  const affected = await loadAffectedNations(event, statsEra);
  const affectedById = new Map(affected.map((n) => [n.id, n]));
  const affectedContext =
    affected
      .slice(0, 12)
      .map((n) => `${n.name ?? "未命名"}（${n.government ?? "未知政體"}${n.isNpc ? "，NPC" : ""}）`)
      .join("、") || undefined;

  const kind = (event.kind as SuperEventKind) ?? "disaster";
  const turnNumber = event.turnsElapsed + 1;

  // 先判定玩家應對（取得本回合契合度），供主效果差異化與 AI 判定的應對摘要。
  // 應對本身的 effect 以基礎 mult（含全域倍率＋階段）套用。
  // 人口倍率（popMult）只含管理員的明確旋鈕（事件 impactPct × 全域倍率），
  // 不含階段嚴重度——人口是「直接扣除幾 %」。
  const popMult = (event.impactPct / 100) * (globalImpactPct / 100);
  const baseMult =
    (event.impactPct / 100) *
    (globalImpactPct / 100) *
    stageSeverityFactor(event.stage);
  const respResult = await judgePendingResponses(
    event,
    affectedById,
    baseMult,
    popMult,
    currentEra,
    statsEra,
    lossBounds,
  );
  const responseSummary = buildResponseSummary(respResult.fitByNation);

  // 本回合發展敘事貼合受影響地區的地理人文：regional 用事件受影響地區、targeted 用
  // 目標國家掌控地區、global 不注入（走中性導引）。查詢失敗回空字串，絕不中斷結算。
  let turnGeoContext = "";
  if (event.scope === "regional") {
    const regionRows = await db
      .select({ regionId: superEventRegionsTable.regionId })
      .from(superEventRegionsTable)
      .where(eq(superEventRegionsTable.eventId, event.id));
    turnGeoContext = await buildRegionSetGeoCultureContext(
      regionRows.map((r) => r.regionId),
    );
  } else if (event.scope === "targeted") {
    const targetRegionIds = affected.flatMap((n) => n.scopedRegionIds);
    turnGeoContext = await buildRegionSetGeoCultureContext(targetRegionIds);
  }

  const judgement = await judgeSuperEventTurn({
    eraSlug: currentEra,
    title: event.title,
    category: event.category,
    severity: event.severity,
    turnsElapsed: event.turnsElapsed,
    kind,
    currentStage: event.stage,
    narrative: event.narrative,
    affectedContext,
    responseSummary,
    aiContext: event.aiContext,
    grantedTechNames: event.grantedTechs.map((g) => g.name),
    geoContext: turnGeoContext,
    targetStats: event.targetStats,
  });

  // 管理員有指定目標數據時，非目標欄位一律歸零（雙重防護；提示詞已先要求 AI）。
  const turnEffect = restrictEffectToTargetStats(
    judgement.effect,
    event.targetStats,
  );

  const reachedMax = event.maxTurns !== null && turnNumber >= event.maxTurns;
  const ended = judgement.end || reachedMax;
  const newStage = ended
    ? "ended"
    : isSuperEventStage(judgement.stage)
      ? judgement.stage
      : event.stage;

  // 主效果 mult 以「本回合推進到的階段」計嚴重度倍率。
  const mult =
    (event.impactPct / 100) *
    (globalImpactPct / 100) *
    stageSeverityFactor(newStage);

  // 套用本回合主效果到每個受影響國家，並累計本回合實際變動（含應對效果）。
  const impactByNation = new Map<string, AppliedDeltas>(
    respResult.deltasByNation,
  );
  for (const nation of affected) {
    try {
      const fit = respResult.fitByNation.get(nation.id) ?? null;
      const applied = await applyEffectToNation(
        nation,
        turnEffect,
        mult,
        popMult,
        statsEra,
        event.scope,
        kind,
        fit,
        lossBounds,
      );
      const prev = impactByNation.get(nation.id) ?? ZERO_DELTAS();
      impactByNation.set(nation.id, addDeltas(prev, applied));
    } catch (err) {
      logger.error(
        { err, eventId: event.id, nationId: nation.id },
        "super event effect application failed for nation",
      );
    }
  }

  // 寫入每國本回合實際套用的影響紀錄（供管理員檢視與累計）。
  await recordNationImpacts(event.id, turnNumber, impactByNation);

  // 跨時代關鍵科技。
  let techGranted = false;
  if (judgement.grantTech) {
    techGranted = await grantCrossEraTech(
      event,
      affected,
      judgement.grantTech,
      currentEra,
    );
  }

  // NPC 敵對行動。
  if (judgement.npcHostility !== "none") {
    await triggerNpcHostility(
      event,
      affected,
      judgement.npcHostility === "aggressive",
    );
  }

  // 傳染擴散：可蔓延的區域型事件在非消退／落幕階段，機率擴散至相鄰地區。
  let spreadRegionIds: number[] = [];
  if (event.canSpread && event.scope === "regional" && !ended) {
    try {
      spreadRegionIds = await spreadContagion(event, newStage);
    } catch (err) {
      logger.error(
        { err, eventId: event.id },
        "super event contagion spread failed",
      );
    }
  }

  // 革命浪潮:逐地區更新革命壓力;到線的地區依原掌控國分組,合併成一個叛軍國開內戰。
  let waveNote = "";
  if (isRevolutionWave(event)) {
    try {
      const wave = await stepRevolutionPressure({
        event,
        newStage,
        impactMult: (event.impactPct / 100) * (globalImpactPct / 100),
        affected,
        fitByNation: respResult.fitByNation,
      });
      if (wave.pressures.length > 0) {
        const max = Math.max(...wave.pressures.map((p) => p.pressure));
        const revolt = await triggerWaveRevolts({
          event,
          readyRegionIds: wave.readyRegionIds,
          tick: event.turnsElapsed + 1,
        });
        waveNote = `革命壓力最高 ${max}/100` +
          (revolt.revoltedRegionIds.length > 0
            ? `，${revolt.revoltedRegionIds.length} 個地區脫離並開出 ${revolt.civilWars} 場內戰`
            : wave.readyRegionIds.length > 0
              ? `，${wave.readyRegionIds.length} 個地區在爆發線上(暫緩)`
              : "");
      }
    } catch (err) {
      logger.error({ err, eventId: event.id }, "revolution pressure step failed");
    }
  }

  const effectSummary = buildEffectSummary(turnEffect, mult, popMult, lossBounds);

  await db.insert(superEventTurnLogsTable).values({
    eventId: event.id,
    turnNumber,
    narrative: judgement.narrative,
    effectSummary: waveNote ? `${effectSummary}${effectSummary ? "；" : ""}${waveNote}` : effectSummary,
    stage: newStage,
    spreadRegionIds,
  });

  await db
    .update(superEventsTable)
    .set({
      narrative: judgement.narrative,
      turnsElapsed: turnNumber,
      stage: newStage,
      status: ended ? "ended" : "active",
      endedAt: ended ? new Date() : null,
    })
    .where(eq(superEventsTable.id, event.id));

  // 通知受影響玩家。
  for (const nation of affected) {
    if (!nation.discordUserId) continue;
    notifySuperEvent({
      discordUserId: nation.discordUserId,
      eventId: event.id,
      title: event.title,
      kind: ended ? "ended" : "update",
      detail: ended
        ? `「${event.title}」已落幕。前往超事件頁面查看最終發展與結果。`
        : `「${event.title}」有新進展（第 ${turnNumber} 回合）。前往超事件頁面查看本回合發展與影響。`,
    });
  }

  return {
    ended,
    techGranted,
    responsesJudged: respResult.judged,
    responsesFailedAi: respResult.failedAi,
  };
}
