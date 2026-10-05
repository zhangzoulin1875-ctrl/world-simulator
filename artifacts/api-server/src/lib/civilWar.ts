import { and, eq, isNull } from "drizzle-orm";
import { db, diplomacyWarsTable } from "@workspace/db";

/**
 * 奪權內戰(2026-10-05 定案):
 *  - 內戰中雙方無法停戰,也不能用條約(含附條件停戰)結束,只能有一方被完全消滅。
 *  - 所有「結束戰爭」的路徑都必須經過這裡,或在原子 UPDATE 的 WHERE 加 `notCivilWar()`。
 */
export const CIVIL_WAR_NO_CEASEFIRE_MESSAGE = "這是一場奪權內戰:雙方無法停戰,必須有一方被完全消滅";

/** 給原子 UPDATE 的 WHERE 條件:內戰不可被結束。 */
export const notCivilWar = () => eq(diplomacyWarsTable.isCivilWar, false);

/** 這場戰爭是不是進行中的內戰(唯讀,用於提案階段提早擋下並回報原因)。 */
export async function isActiveCivilWar(warId: number): Promise<boolean> {
  const [w] = await db
    .select({ c: diplomacyWarsTable.isCivilWar })
    .from(diplomacyWarsTable)
    .where(and(eq(diplomacyWarsTable.id, warId), isNull(diplomacyWarsTable.endedAt)))
    .limit(1);
  return !!w?.c;
}

/** 兩國之間是否正在打內戰(任一方向)。 */
export async function civilWarBetween(a: string, b: string): Promise<boolean> {
  const [low, high] = a < b ? [a, b] : [b, a];
  const [w] = await db
    .select({ id: diplomacyWarsTable.id })
    .from(diplomacyWarsTable)
    .where(
      and(
        eq(diplomacyWarsTable.nationAId, low),
        eq(diplomacyWarsTable.nationBId, high),
        eq(diplomacyWarsTable.isCivilWar, true),
        isNull(diplomacyWarsTable.endedAt),
      ),
    )
    .limit(1);
  return !!w;
}
