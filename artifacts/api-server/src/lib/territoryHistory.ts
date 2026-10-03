import { db, territoryChangeHistoryTable } from "@workspace/db";

/**
 * Task #392 — 領土變更歷史的共用記錄層。
 *
 * 所有 region_controls 掌控 % 的寫入路徑，都必須在「同一個 transaction 內」
 * 呼叫 recordTerritoryChanges 追加紀錄，確保紀錄與實際領土狀態一致
 * （交易 rollback 時紀錄一併消失）。只記掌控 % 的變更；percentBefore ===
 * percentAfter 的項目會被自動略過。
 */

export type TerritoryChangeType =
  | "founding"
  | "war"
  | "treaty"
  | "admin_edit"
  | "admin_nation_replace"
  | "overfull_repair"
  | "world_sim";

/** 變更類型 → zh-TW 顯示名稱（後端 API 直接輸出，前端無需重複維護）。 */
export const TERRITORY_CHANGE_TYPE_LABELS: Record<TerritoryChangeType, string> =
  {
    founding: "建國佔領",
    war: "戰爭領土移轉",
    treaty: "條約割讓",
    admin_edit: "管理員手動編輯",
    admin_nation_replace: "國家管理領土替換",
    overfull_repair: "超額自動修復",
    world_sim: "世界模擬",
  };

export interface TerritoryChangeEntry {
  nationId: string;
  regionId: number;
  percentBefore: number;
  percentAfter: number;
  changeType: TerritoryChangeType;
  reason: string;
  warId?: number | null;
  treatyId?: number | null;
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 在既有 transaction（或 db）內追加領土變更紀錄。
 * 無實際變更（before === after）的項目自動略過；空陣列不發 SQL。
 */
export async function recordTerritoryChanges(
  executor: Executor,
  entries: TerritoryChangeEntry[],
): Promise<void> {
  const effective = entries.filter((e) => e.percentBefore !== e.percentAfter);
  if (effective.length === 0) return;
  await executor.insert(territoryChangeHistoryTable).values(
    effective.map((e) => ({
      nationId: e.nationId,
      regionId: e.regionId,
      percentBefore: e.percentBefore,
      percentAfter: e.percentAfter,
      changeType: e.changeType,
      reason: e.reason,
      warId: e.warId ?? null,
      treatyId: e.treatyId ?? null,
    })),
  );
}

export interface ControlShareLike {
  nationId: string;
  percent: number;
}

/**
 * 純函式：比對同一地區「替換前 / 替換後」的掌控清單，產出變更項目
 * （full-replace 路徑共用：admin 地區編輯、國家管理 regions 替換、世界模擬、
 * 超額修復）。消失的國家記為 after=0；新出現的記為 before=0；不變者略過。
 */
export function diffRegionControls(
  regionId: number,
  before: ControlShareLike[],
  after: ControlShareLike[],
  base: {
    changeType: TerritoryChangeType;
    reason: string;
    warId?: number | null;
    treatyId?: number | null;
  },
): TerritoryChangeEntry[] {
  const beforeBy = new Map(before.map((c) => [c.nationId, c.percent]));
  const afterBy = new Map(after.map((c) => [c.nationId, c.percent]));
  const nationIds = new Set([...beforeBy.keys(), ...afterBy.keys()]);
  const entries: TerritoryChangeEntry[] = [];
  for (const nationId of nationIds) {
    const b = beforeBy.get(nationId) ?? 0;
    const a = afterBy.get(nationId) ?? 0;
    if (b === a) continue;
    entries.push({
      nationId,
      regionId,
      percentBefore: b,
      percentAfter: a,
      ...base,
    });
  }
  return entries;
}
