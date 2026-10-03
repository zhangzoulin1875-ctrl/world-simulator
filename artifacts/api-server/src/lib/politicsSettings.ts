import { eq } from "drizzle-orm";
import { db, politicsSettingsTable } from "@workspace/db";
import {
  DEFAULT_POLITICS_SETTINGS,
  politicsSettingsSchema,
  type PoliticsSettings,
} from "./politics";
import { logger } from "./logger";

/**
 * Task #43 — 內政參數設定存取（單列 id=1）。
 * DB 只存「覆寫」；讀取時經 zod 合併預設值，未知鍵與超界值一律丟棄，
 * 保證讀出的設定永遠有效（管理後台調壞也不會炸結算）。
 */

export async function getPoliticsSettings(): Promise<PoliticsSettings> {
  const [row] = await db
    .select()
    .from(politicsSettingsTable)
    .where(eq(politicsSettingsTable.id, 1))
    .limit(1);
  if (!row) return DEFAULT_POLITICS_SETTINGS;
  const parsed = politicsSettingsSchema.safeParse(row.params);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues },
      "stored politics settings invalid — falling back to defaults",
    );
    return DEFAULT_POLITICS_SETTINGS;
  }
  return parsed.data;
}

/** 全量寫入（管理端 PUT 已先 zod 驗證）。 */
export async function savePoliticsSettings(
  settings: PoliticsSettings,
): Promise<void> {
  await db
    .insert(politicsSettingsTable)
    .values({ id: 1, params: settings })
    .onConflictDoUpdate({
      target: politicsSettingsTable.id,
      set: { params: settings, updatedAt: new Date() },
    });
}
