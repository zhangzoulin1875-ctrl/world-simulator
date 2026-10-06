import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  superEventsTable,
  superEventRegionsTable,
  superEventSettingsTable,
  regionControlsTable,
  playerNationsTable,
} from "@workspace/db";
import { REVOLUTION_CATEGORY, spawnChancePct } from "../revolutionWave";
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

/**
 * 革命浪潮專屬觸發(2026-10-06):每回合掃描所有「玩家」國家,依其不滿程度
 * (穩定度低、暴動度高)獨立擲骰;命中就為該國誕生一則 regional 革命浪潮事件,
 * 範圍為其掌控的全部地區。
 *  - NPC 一律不觸發(避免大量 NPC 同回合生成事件、燒 AI 額度)。
 *  - 同一國已有進行中的革命浪潮就不再生成(避免疊加)。
 *  - best-effort:單國失敗只記 log,不中斷結算。
 * 回傳本回合新生成的事件數。
 */
export async function maybeSpawnRevolutionWaves(params: {
  currentEra: string;
  aiGenerationPrompt: string | null;
}): Promise<number> {
  let spawned = 0;
  const nations = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      stability: playerNationsTable.stability,
      unrest: playerNationsTable.unrest,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.isNpc, false));

  // 先用機率篩,命中的才查「是否已有進行中的革命浪潮」(省查詢)。
  const rolled = nations.filter(
    (n) => Math.random() * 100 < spawnChancePct(n.stability, n.unrest),
  );
  if (rolled.length === 0) return 0;

  // 已有進行中革命浪潮的國家 = 其掌控地區與某進行中革命浪潮事件地區有交集者。
  const activeWaves = await db
    .select({ id: superEventsTable.id })
    .from(superEventsTable)
    .where(
      and(
        eq(superEventsTable.status, "active"),
        eq(superEventsTable.category, REVOLUTION_CATEGORY),
      ),
    );
  const busyRegionIds = new Set<number>();
  if (activeWaves.length > 0) {
    const rows = await db
      .select({ regionId: superEventRegionsTable.regionId })
      .from(superEventRegionsTable)
      .where(
        inArray(
          superEventRegionsTable.eventId,
          activeWaves.map((w) => w.id),
        ),
      );
    for (const r of rows) busyRegionIds.add(r.regionId);
  }

  for (const nation of rolled) {
    try {
      const regions = await db
        .select({ regionId: regionControlsTable.regionId })
        .from(regionControlsTable)
        .where(eq(regionControlsTable.nationId, nation.id));
      if (regions.length === 0) continue;
      if (regions.some((r) => busyRegionIds.has(r.regionId))) continue;

      const trigger =
        `此事件是「${nation.name ?? "某國"}」國內民怨累積引發的革命浪潮(穩定度 ${nation.stability}、暴動度 ${nation.unrest})。` +
        `category 必須字面完全等於「${REVOLUTION_CATEGORY}」,kind 必須是 disaster。`;
      const basePrompt = params.aiGenerationPrompt?.trim() ?? "";
      const geoContext = await buildNationGeoCultureContext(nation.id);
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
          // 不信任 AI 的類別字串:專屬觸發一律強制為革命浪潮/災難。
          category: REVOLUTION_CATEGORY,
          scope: "regional",
          kind: "disaster",
          cause: "ai",
          status: "active",
          severity: gen.severity,
          canSpread: true,
        })
        .returning({ id: superEventsTable.id });
      if (!created) continue;
      await db
        .insert(superEventRegionsTable)
        .values(regions.map((r) => ({ eventId: created.id, regionId: r.regionId })))
        .onConflictDoNothing();
      for (const r of regions) busyRegionIds.add(r.regionId);
      spawned += 1;
      logger.info(
        { eventId: created.id, nationId: nation.id },
        "revolution wave spawned from national discontent",
      );
    } catch (err) {
      logger.error({ err, nationId: nation.id }, "revolution wave spawn failed");
    }
  }
  return spawned;
}
