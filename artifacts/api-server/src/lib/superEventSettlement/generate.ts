import { eq } from "drizzle-orm";
import {
  db,
  superEventsTable,
  superEventRegionsTable,
  superEventSettingsTable,
  regionControlsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { generateSuperEvent } from "../superEventAi";
import { buildNationGeoCultureContext } from "../nationGeoCulture";
import type { SuperEventSettlementSummary } from "./types";

/**
 * 每回合自動生成：依 chancePct 擲骰，命中則 AI 生成一則新的全球事件並寫入。
 * best-effort：失敗只記 log，不中斷結算。命中並成功建立時累加 summary.generated。
 */
export async function maybeAutoGenerateSuperEvent(params: {
  chancePct: number;
  aiGenerationPrompt: string | null;
  currentEra: string;
  summary: SuperEventSettlementSummary;
}): Promise<void> {
  const { chancePct, aiGenerationPrompt, currentEra, summary } = params;
  if (chancePct > 0 && Math.random() * 100 < chancePct) {
    try {
      const gen = await generateSuperEvent({
        eraSlug: currentEra,
        extraPrompt: aiGenerationPrompt ?? null,
      });
      const [created] = await db
        .insert(superEventsTable)
        .values({
          title: gen.title,
          summary: gen.summary,
          narrative: gen.narrative,
          category: gen.category,
          scope: "global",
          kind: gen.kind,
          cause: "ai",
          status: "active",
          severity: gen.severity,
        })
        .returning({ id: superEventsTable.id });
      if (created) {
        summary.generated += 1;
        logger.info({ eventId: created.id }, "super event auto-generated");
      }
    } catch (err) {
      logger.error({ err }, "super event auto-generation failed");
    }
  }
}

/** 政治決策以極低機率（0.5%）觸發一則超事件。 */
export const POLITICS_SUPER_EVENT_CHANCE_PCT = 0.5;

/**
 * Task #333 — 政治決策觸發超事件：於內政結算判定政策／決策後呼叫，以
 * POLITICS_SUPER_EVENT_CHANCE_PCT 機率生成一則 regional 超事件（範圍為該國掌控
 * 地區，成因 player_decision）。best-effort：未命中或失敗皆為 no-op（回傳 false）。
 */
export async function maybeTriggerPoliticalSuperEvent(params: {
  nationId: string;
  nationName: string | null;
  currentEra: string;
  decisionSummary: string;
}): Promise<boolean> {
  if (Math.random() * 100 >= POLITICS_SUPER_EVENT_CHANCE_PCT) return false;
  try {
    const [settings] = await db
      .select()
      .from(superEventSettingsTable)
      .where(eq(superEventSettingsTable.id, 1))
      .limit(1);
    const basePrompt = settings?.aiGenerationPrompt?.trim() ?? "";
    const trigger = `此事件由「${params.nationName ?? "某國"}」近期的政治決策間接引發：${params.decisionSummary}`;
    // regional 政治決策事件：生成敘事貼合該國掌控地區的地理人文（查詢失敗回空字串）。
    const geoContext = await buildNationGeoCultureContext(params.nationId);
    const gen = await generateSuperEvent({
      eraSlug: params.currentEra,
      extraPrompt: basePrompt ? `${basePrompt}\n${trigger}` : trigger,
      geoContext,
    });
    const [created] = await db
      .insert(superEventsTable)
      .values({
        title: gen.title,
        summary: gen.summary,
        narrative: gen.narrative,
        category: gen.category,
        scope: "regional",
        kind: gen.kind,
        cause: "player_decision",
        status: "active",
        severity: gen.severity,
      })
      .returning({ id: superEventsTable.id });
    if (!created) return false;
    const regions = await db
      .select({ regionId: regionControlsTable.regionId })
      .from(regionControlsTable)
      .where(eq(regionControlsTable.nationId, params.nationId));
    if (regions.length > 0) {
      await db
        .insert(superEventRegionsTable)
        .values(regions.map((r) => ({ eventId: created.id, regionId: r.regionId })))
        .onConflictDoNothing();
    }
    logger.info(
      { eventId: created.id, nationId: params.nationId },
      "super event triggered by political decision",
    );
    return true;
  } catch (err) {
    logger.error({ err }, "political super event trigger failed");
    return false;
  }
}
