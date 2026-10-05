import { and, eq } from "drizzle-orm";
import { db, constitutionsTable, parliamentStateTable } from "@workspace/db";
import {
  validateDraft, canEditDraft, type ConstitutionStatus,
} from "./core";

export type ConstitutionRow = typeof constitutionsTable.$inferSelect;

export async function loadConstitution(nationId: string): Promise<ConstitutionRow | null> {
  const [row] = await db.select().from(constitutionsTable).where(eq(constitutionsTable.nationId, nationId));
  return row ?? null;
}

export function statusOf(row: ConstitutionRow | null): ConstitutionStatus {
  return row ? (row.status as ConstitutionStatus) : "none";
}

/**
 * 存草稿。原子：只有「尚未通過、且不在審議中」的列才會被更新，
 * 所以並發的送審/通過不可能被草稿覆蓋（條件在 UPDATE 的 WHERE，不靠先讀後寫）。
 */
export async function saveDraft(
  nationId: string, text: unknown,
): Promise<{ ok: true; row: ConstitutionRow } | { ok: false; error: string; code: 400 | 409 }> {
  const v = validateDraft(text);
  if (!v.ok) return { ok: false, error: v.error, code: 400 };

  const existing = await loadConstitution(nationId);
  const gate = canEditDraft(statusOf(existing));
  if (!gate.ok) return { ok: false, error: gate.error, code: 409 };

  if (!existing) {
    // 首次存檔：onConflictDoNothing 處理並發雙擊，之後走下面的條件更新。
    await db.insert(constitutionsTable).values({ nationId, status: "draft", draftText: v.text }).onConflictDoNothing();
  }
  const updated = await db.update(constitutionsTable)
    .set({ draftText: v.text, status: "draft" })
    .where(and(eq(constitutionsTable.nationId, nationId), eq(constitutionsTable.status, "draft")))
    .returning();
  if (updated.length === 0) {
    // 列存在但不是 draft：期間被送審或通過了。
    const now = await loadConstitution(nationId);
    const g2 = canEditDraft(statusOf(now));
    return { ok: false, error: g2.ok ? "草稿儲存失敗，請重試" : g2.error, code: 409 };
  }
  return { ok: true, row: updated[0]! };
}

/** 讀取議會 tick（冷卻用）；沒有議會狀態視為 0。 */
export async function currentParliamentTick(nationId: string): Promise<number> {
  const [s] = await db.select({ tick: parliamentStateTable.tick })
    .from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  return s?.tick ?? 0;
}
