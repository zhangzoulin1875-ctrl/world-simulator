import { asc, eq } from "drizzle-orm";
import {
  db,
  regionControlsTable,
  mapRegionsTable,
  playerNationsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { recordTerritoryChanges } from "./territoryHistory";

/**
 * Task #51 — region_controls 超額健檢。
 *
 * 管理員端點驗證每地區掌控加總 ≤ 100，但其他寫入路徑（未來的戰鬥、事件等）
 * 可能製造超額資料；條約合併雖以 LEAST(...,100) 夾住不炸，但被夾表示有
 * 百分比默默消失。本模組在啟動後與每小時掃描加總 > 100 的地區，記下
 * 完整明細（地區＋各國百分比）並按比例縮減回 100，讓超額資料被看見、
 * 被修正，而不是默默被夾掉。
 */

export type ControlShare = { nationId: string; percent: number };

const HEALTH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 按比例把一組掌控百分比縮減到加總恰為 100（純函式）：
 * - 加總 ≤ 100 → 原樣回傳（不需修正）。
 * - 每筆結果為整數、≥ 1（不會把小國縮到消失）、且不超過原始值。
 * - 先取 floor(percent × 100 ÷ total)（下限 1），剩餘點數依小數餘數
 *   由大到小補回（不超過原值），使加總盡量貼齊 100。
 * - 病態情況（筆數 > 100，min-1 下限塞不進 100）→ 回傳 null，由呼叫端記錯誤。
 */
export function scaleDownControls(
  controls: ControlShare[],
): ControlShare[] | null {
  const total = controls.reduce((sum, c) => sum + c.percent, 0);
  if (total <= 100) return controls.map((c) => ({ ...c }));
  if (controls.length > 100) return null;

  const scaled = controls.map((c) => {
    const exact = (c.percent * 100) / total;
    return {
      nationId: c.nationId,
      original: c.percent,
      remainder: exact - Math.floor(exact),
      percent: Math.max(1, Math.floor(exact)),
    };
  });

  let sum = scaled.reduce((s, c) => s + c.percent, 0);

  if (sum > 100) {
    // min-1 下限把加總推過 100 → 從最大的開始削（保留每筆 ≥ 1）。
    const byDesc = [...scaled].sort((a, b) => b.percent - a.percent);
    for (const c of byDesc) {
      if (sum <= 100) break;
      const cut = Math.min(c.percent - 1, sum - 100);
      c.percent -= cut;
      sum -= cut;
    }
    if (sum > 100) return null;
  } else if (sum < 100) {
    // floor 掉的點數依小數餘數大→小補回（不超過原值）。
    const byRemainder = [...scaled].sort(
      (a, b) =>
        b.remainder - a.remainder ||
        b.original - a.original ||
        a.nationId.localeCompare(b.nationId),
    );
    let leftover = 100 - sum;
    for (const c of byRemainder) {
      if (leftover === 0) break;
      if (c.percent < c.original) {
        c.percent += 1;
        leftover -= 1;
      }
    }
  }

  return scaled.map((c) => ({ nationId: c.nationId, percent: c.percent }));
}

export type OverfullRegion = {
  regionId: number;
  regionName: string;
  total: number;
  controls: { nationId: string; nationName: string | null; percent: number }[];
};

/** 掃描 region_controls，回傳每地區加總 > 100 的完整明細。 */
export async function findOverfullRegions(): Promise<OverfullRegion[]> {
  const rows = await db
    .select({
      regionId: regionControlsTable.regionId,
      regionName: mapRegionsTable.name,
      nationId: regionControlsTable.nationId,
      nationName: playerNationsTable.name,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, regionControlsTable.regionId),
    )
    .leftJoin(
      playerNationsTable,
      eq(playerNationsTable.id, regionControlsTable.nationId),
    )
    .orderBy(asc(regionControlsTable.regionId), asc(regionControlsTable.id));

  const byRegion = new Map<number, OverfullRegion>();
  for (const row of rows) {
    let region = byRegion.get(row.regionId);
    if (!region) {
      region = {
        regionId: row.regionId,
        regionName: row.regionName,
        total: 0,
        controls: [],
      };
      byRegion.set(row.regionId, region);
    }
    region.total += row.percent;
    region.controls.push({
      nationId: row.nationId,
      nationName: row.nationName,
      percent: row.percent,
    });
  }

  return [...byRegion.values()].filter((r) => r.total > 100);
}

export type RepairedRegion = OverfullRegion & {
  repaired: ControlShare[] | null;
};

/**
 * 找出所有加總 > 100 的地區，逐一在交易內（SELECT ... FOR UPDATE 後
 * 重新加總，避免掃描後資料已被改動）按比例縮減回 100，並以 warn log
 * 記下地區、各國原始百分比與修正後結果。無法自動修正的病態資料只記
 * error、不動資料。回傳每個超額地區的處理結果（供測試驗證）。
 */
export async function repairOverfullRegions(): Promise<RepairedRegion[]> {
  const overfull = await findOverfullRegions();
  const results: RepairedRegion[] = [];

  for (const region of overfull) {
    const repaired = await db.transaction(async (tx) => {
      const current = await tx
        .select({
          id: regionControlsTable.id,
          nationId: regionControlsTable.nationId,
          percent: regionControlsTable.percent,
        })
        .from(regionControlsTable)
        .where(eq(regionControlsTable.regionId, region.regionId))
        .orderBy(asc(regionControlsTable.id))
        .for("update");

      const total = current.reduce((sum, c) => sum + c.percent, 0);
      if (total <= 100) return null; // 已被其他路徑修正

      const scaled = scaleDownControls(
        current.map((c) => ({ nationId: c.nationId, percent: c.percent })),
      );
      if (scaled === null) return null;

      const byNation = new Map(scaled.map((c) => [c.nationId, c.percent]));
      for (const row of current) {
        const next = byNation.get(row.nationId);
        if (next !== undefined && next !== row.percent) {
          await tx
            .update(regionControlsTable)
            .set({ percent: next })
            .where(eq(regionControlsTable.id, row.id));
          // Task #392 — 同交易內記錄超額自動修復的等比縮減。
          await recordTerritoryChanges(tx, [
            {
              nationId: row.nationId,
              regionId: region.regionId,
              percentBefore: row.percent,
              percentAfter: next,
              changeType: "overfull_repair",
              reason: `超額自動修復：「${region.regionName}」掌控加總 ${total}% 超過 100%，等比縮減`,
            },
          ]);
        }
      }
      return scaled;
    });

    if (repaired === null) {
      logger.error(
        {
          regionId: region.regionId,
          regionName: region.regionName,
          total: region.total,
          controls: region.controls,
        },
        "region control total exceeds 100% but could not be auto-repaired (or was fixed concurrently)",
      );
    } else {
      logger.warn(
        {
          regionId: region.regionId,
          regionName: region.regionName,
          total: region.total,
          before: region.controls,
          after: repaired,
        },
        "region control total exceeded 100% — proportionally scaled down",
      );
    }
    results.push({ ...region, repaired });
  }

  return results;
}

/** 啟動後 ~30 秒先掃一次，之後每小時掃描。錯誤只記錄，不中斷。 */
export function startRegionControlHealthLoop(): void {
  const tick = () => {
    repairOverfullRegions().catch((err) =>
      logger.error({ err }, "region control health tick failed"),
    );
  };
  setTimeout(tick, 30 * 1000);
  setInterval(tick, HEALTH_INTERVAL_MS);
  logger.info("region control health loop started");
}
