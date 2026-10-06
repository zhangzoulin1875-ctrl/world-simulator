import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  superEventsTable,
  superEventRegionsTable,
  superEventRegionPressureTable,
  regionControlsTable,
  playerNationsTable,
  type SuperEvent,
} from "@workspace/db";
import { logger } from "../logger";
import { startCivilWar } from "../civilWarEngine";
import { endCampaignsForNation } from "../warEngine/endCampaign";
import { notifySuperEvent } from "../gameNotify";
import {
  PRESSURE_START,
  REVOLUTION_CATEGORY,
  nextPressure,
  regionsReadyToRevolt,
} from "../revolutionWave";
import type { AffectedNation } from "./types";

/** 事件是否為革命浪潮。 */
export function isRevolutionWave(event: Pick<SuperEvent, "category">): boolean {
  return event.category === REVOLUTION_CATEGORY;
}

export interface WaveStepResult {
  /** 本回合到達爆發線、尚未處理的地區。 */
  readyRegionIds: number[];
  /** 本回合更新後各地區壓力(供敘事/紀錄)。 */
  pressures: { regionId: number; pressure: number }[];
}

/**
 * 革命浪潮的每回合壓力更新:
 *  1) 確保事件的每個波及地區都有壓力列(新蔓延到的地區從起始壓力開始);
 *  2) 依「該地區所屬國」的穩定度/暴動度與應對契合度,逐地區更新壓力;
 *  3) 回傳到線的地區(由呼叫端交給內戰引擎處理)。
 * 已脫離(revolted_at 非 null)的地區不再累積。
 */
export async function stepRevolutionPressure(params: {
  event: SuperEvent;
  newStage: string;
  /** 事件 impactPct × 全域倍率(1 = 100%)。 */
  impactMult: number;
  affected: AffectedNation[];
  fitByNation: Map<string, number>;
}): Promise<WaveStepResult> {
  const { event, newStage, impactMult, affected, fitByNation } = params;

  const eventRegions = await db
    .select({ regionId: superEventRegionsTable.regionId })
    .from(superEventRegionsTable)
    .where(eq(superEventRegionsTable.eventId, event.id));
  const regionIds = eventRegions.map((r) => r.regionId);
  if (regionIds.length === 0) return { readyRegionIds: [], pressures: [] };

  // 補齊尚未建立的壓力列。
  await db
    .insert(superEventRegionPressureTable)
    .values(
      regionIds.map((regionId) => ({
        eventId: event.id,
        regionId,
        pressure: PRESSURE_START,
      })),
    )
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(superEventRegionPressureTable)
    .where(
      and(
        eq(superEventRegionPressureTable.eventId, event.id),
        isNull(superEventRegionPressureTable.revoltedAt),
      ),
    );

  // 地區 → 目前掌控國(取控制度最高者)。
  const controls = await db
    .select({
      regionId: regionControlsTable.regionId,
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, regionIds));
  const ownerByRegion = new Map<number, { nationId: string; percent: number }>();
  for (const c of controls) {
    const cur = ownerByRegion.get(c.regionId);
    if (!cur || c.percent > cur.percent) {
      ownerByRegion.set(c.regionId, { nationId: c.nationId, percent: c.percent });
    }
  }

  const ownerIds = [...new Set([...ownerByRegion.values()].map((o) => o.nationId))];
  const nationRows = ownerIds.length
    ? await db
        .select({
          id: playerNationsTable.id,
          stability: playerNationsTable.stability,
          unrest: playerNationsTable.unrest,
        })
        .from(playerNationsTable)
        .where(inArray(playerNationsTable.id, ownerIds))
    : [];
  const natById = new Map(nationRows.map((n) => [n.id, n]));
  void affected; // 受影響國家清單目前只用來對齊範圍;壓力以「地區現任掌控國」為準

  const pressures: { regionId: number; pressure: number }[] = [];
  for (const row of rows) {
    const owner = ownerByRegion.get(row.regionId);
    const nat = owner ? natById.get(owner.nationId) : undefined;
    const fit = owner ? (fitByNation.get(owner.nationId) ?? null) : null;
    const next = Math.round(
      nextPressure({
        pressure: row.pressure,
        stage: newStage,
        severity: event.severity,
        impactMult,
        stability: nat?.stability ?? 50,
        unrest: nat?.unrest ?? 0,
        fit,
      }),
    );
    pressures.push({ regionId: row.regionId, pressure: next });
    if (next !== row.pressure) {
      await db
        .update(superEventRegionPressureTable)
        .set({ pressure: next })
        .where(eq(superEventRegionPressureTable.id, row.id));
    }
  }

  const readyRegionIds = regionsReadyToRevolt(pressures);
  if (readyRegionIds.length > 0) {
    logger.info(
      { eventId: event.id, readyRegionIds },
      "revolution wave: regions reached the revolt threshold",
    );
  }
  return { readyRegionIds, pressures };
}

/** 標記地區已爆發革命(不再累積壓力)。 */
export async function markRegionsRevolted(
  eventId: string,
  regionIds: number[],
): Promise<void> {
  if (regionIds.length === 0) return;
  await db
    .update(superEventRegionPressureTable)
    .set({ revoltedAt: new Date() })
    .where(
      and(
        eq(superEventRegionPressureTable.eventId, eventId),
        inArray(superEventRegionPressureTable.regionId, regionIds),
      ),
    );
}

export interface WaveRevoltResult {
  /** 實際爆發(成功開出內戰)的地區。 */
  revoltedRegionIds: number[];
  /** 開出的內戰場數(每個原政權一場)。 */
  civilWars: number;
}

/**
 * 革命浪潮爆發(選項 2:同一波合併):把到線地區依「現任掌控國」分組,
 * 每個掌控國把自己那些到線地區「整塊」切給一個新的 NPC 叛軍國,開一場內戰。
 *  - 只處理真人玩家掌控的地區(NPC 掌控者略過,壓力維持在線上不動)。
 *  - 至少要留一塊地給原政權,否則該國這波不爆發(避免一次把原政權滅掉)。
 *  - 同一原政權已有進行中內戰 → startCivilWar 會回 already_civil_war,地區維持在線上,
 *    等內戰結束後下個回合再爆發。
 *  - 每個原政權一個交易,單國失敗不影響其他國。
 */
export async function triggerWaveRevolts(params: {
  event: SuperEvent;
  readyRegionIds: number[];
  tick: number;
}): Promise<WaveRevoltResult> {
  const { event, readyRegionIds, tick } = params;
  const result: WaveRevoltResult = { revoltedRegionIds: [], civilWars: 0 };
  if (readyRegionIds.length === 0) return result;

  // 到線地區 → 現任掌控國(控制度最高者)
  const controls = await db
    .select({
      regionId: regionControlsTable.regionId,
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, readyRegionIds));
  const ownerByRegion = new Map<number, { nationId: string; percent: number }>();
  for (const c of controls) {
    const cur = ownerByRegion.get(c.regionId);
    if (!cur || c.percent > cur.percent) ownerByRegion.set(c.regionId, { nationId: c.nationId, percent: c.percent });
  }
  const byNation = new Map<string, number[]>();
  for (const [regionId, o] of ownerByRegion) {
    const arr = byNation.get(o.nationId) ?? [];
    arr.push(regionId);
    byNation.set(o.nationId, arr);
  }

  for (const [nationId, regionIds] of byNation) {
    try {
      const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)).limit(1);
      if (!nation || nation.isNpc) continue;

      // 至少留一塊地給原政權。
      const allOwned = await db
        .select({ regionId: regionControlsTable.regionId })
        .from(regionControlsTable)
        .where(eq(regionControlsTable.nationId, nationId));
      const keep = allOwned.filter((r) => !regionIds.includes(r.regionId));
      if (keep.length === 0) {
        logger.info({ eventId: event.id, nationId }, "revolution wave: would take all land, deferring revolt");
        continue;
      }

      let started: Awaited<ReturnType<typeof startCivilWar>> | null = null;
      await db.transaction(async (tx) => {
        started = await startCivilWar(
          tx, nation, "parliament", tick, `革命浪潮「${event.title}」`, "incumbent", regionIds,
        );
      });
      const r = started as Awaited<ReturnType<typeof startCivilWar>> | null;
      if (!r || !r.started) continue;

      result.civilWars += 1;
      result.revoltedRegionIds.push(...regionIds);
      try {
        await endCampaignsForNation(nationId);
      } catch (err) {
        logger.error({ err, nationId }, "revolution wave: failed to end campaigns after land split");
      }
      if (nation.discordUserId) {
        notifySuperEvent({
          discordUserId: nation.discordUserId,
          eventId: event.id,
          title: event.title,
          kind: "update",
          detail: `革命浪潮失控:${regionIds.length} 個地區脫離,叛軍已與你開戰,直到一方被完全消滅才會停火。`,
        });
      }
    } catch (err) {
      logger.error({ err, eventId: event.id, nationId }, "revolution wave: revolt failed for nation");
    }
  }

  await markRegionsRevolted(event.id, result.revoltedRegionIds);
  return result;
}
