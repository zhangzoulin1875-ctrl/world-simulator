import { eq, inArray } from "drizzle-orm";
import {
  db,
  superEventRegionsTable,
  mapRegionAdjacenciesTable,
  type SuperEvent,
} from "@workspace/db";
import {
  contagionSpreadChance,
  selectContagionTargets,
} from "../superEventImpact";
import { logger } from "../logger";

/**
 * 傳染擴散：把可蔓延的區域型事件依機率擴散到目前受影響地區的相鄰地區。
 * 回傳本回合新增的地區 id 清單。純選取邏輯在 superEventImpact.selectContagionTargets。
 */
export async function spreadContagion(
  event: SuperEvent,
  stage: string,
): Promise<number[]> {
  const spreadChance = contagionSpreadChance(event.severity, stage);
  if (spreadChance <= 0) return [];

  const currentRows = await db
    .select({ regionId: superEventRegionsTable.regionId })
    .from(superEventRegionsTable)
    .where(eq(superEventRegionsTable.eventId, event.id));
  const currentRegionIds = currentRows.map((r) => r.regionId);
  if (currentRegionIds.length === 0) return [];

  const adjRows = await db
    .select({
      regionId: mapRegionAdjacenciesTable.regionId,
      adjacentRegionId: mapRegionAdjacenciesTable.adjacentRegionId,
    })
    .from(mapRegionAdjacenciesTable)
    .where(inArray(mapRegionAdjacenciesTable.regionId, currentRegionIds));
  const adjacency = new Map<number, number[]>();
  for (const a of adjRows) {
    const arr = adjacency.get(a.regionId) ?? [];
    arr.push(a.adjacentRegionId);
    adjacency.set(a.regionId, arr);
  }

  const added = selectContagionTargets({
    currentRegionIds,
    adjacency,
    spreadChance,
  });
  if (added.length === 0) return [];

  await db
    .insert(superEventRegionsTable)
    .values(added.map((regionId) => ({ eventId: event.id, regionId })))
    .onConflictDoNothing();
  logger.info(
    { eventId: event.id, added: added.length },
    "super event contagion spread to adjacent regions",
  );
  return added;
}
