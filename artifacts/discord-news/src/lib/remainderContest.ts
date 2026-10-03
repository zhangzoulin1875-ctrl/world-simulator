/**
 * Task #502 — 無人剩餘同區爭奪判定（純函式，供 war-orders-tab 與單元測試共用）。
 *
 * 一個地區屬於「無人剩餘爭奪」目標的條件：
 * 1. 我方在該地區持有控制權（id 來自 myRegionIds）；
 * 2. 無交戰敵國同在此地（有敵國 → 走既有同區爭奪流程）；
 * 3. 「比例最高的其他持有者」是無主國家，或根本無其他持有者且 Σ(percent) < 100。
 *
 * 與後端 initiateCampaign 的同區分支同一套規則：後端也是取比例最高的
 * 非攻擊方持有者判定可否升格為 NPC 應戰。
 */
export interface RegionControlShare {
  nationId: string;
  percent: number;
}

export function computeRemainderContestRegionIds(params: {
  myNationId: string | null | undefined;
  myRegionIds: Iterable<number>;
  /** 有交戰敵國持分的地區 id 集合（Map 或 Set 皆可，只用 has）。 */
  enemyRegionIds: { has(id: number): boolean };
  /** 各地區完整控制列，需已按 percent 高→低排序。 */
  controlsByRegion: ReadonlyMap<number, RegionControlShare[]>;
  /** 無主國家 id 集合（未綁定玩家且非 NPC）。 */
  unownedNationIds: ReadonlySet<string>;
}): Set<number> {
  const {
    myNationId,
    myRegionIds,
    enemyRegionIds,
    controlsByRegion,
    unownedNationIds,
  } = params;
  const s = new Set<number>();
  if (!myNationId) return s;
  for (const id of myRegionIds) {
    if (enemyRegionIds.has(id)) continue; // 有交戰敵國 → 走既有同區爭奪
    const controls = controlsByRegion.get(id) ?? [];
    const others = controls.filter((c) => c.nationId !== myNationId);
    if (others.length > 0) {
      // 後端以比例最高的其他持有者判定：必須是無主國家才可就地升格應戰。
      if (unownedNationIds.has(others[0]!.nationId)) s.add(id);
    } else {
      const total = controls.reduce((sum, c) => sum + c.percent, 0);
      if (total < 100) s.add(id);
    }
  }
  return s;
}
