/**
 * 憲法危機觸發(DB 編排)。規則在 core.ts(shouldRollCrisis / nextUntriggeredFlaw);
 * 事件的選項與效果數字來自 domesticEvents/core 的 CONSTITUTIONAL_CRISIS_DEF,永遠固定。
 *
 * 一個漏洞只會引爆一次:建立事件與「標記 triggered」在同一個交易內,事件建立失敗(例如該國已有待處理事件)
 * 則整筆回滾,漏洞不會被白白用掉。
 */
import { and, eq } from "drizzle-orm";
import { db, constitutionsTable, domesticEventsTable, type ConstitutionFlawRow } from "@workspace/db";
import { logger } from "../logger";
import { CONSTITUTIONAL_CRISIS_DEF, EVENT_DEADLINE_TURNS } from "../domesticEvents/core";
import { CRISIS_CHANCE, nextUntriggeredFlaw, shouldRollCrisis, type ConstitutionStatus } from "./core";
import { loadConstitution, statusOf } from "./service";
import { scanFlaws } from "./submit";

/** 引爆一個漏洞:建立危機事件 + 標記 triggered。成功回傳事件 id;該國已有待處理事件或漏洞已被用掉則回 null。 */
export async function triggerCrisis(nationId: string, tick: number): Promise<string | null> {
  return db.transaction(async (tx) => {
    // 鎖住憲法列,避免兩個並發結算挑到同一個漏洞。
    const [row] = await tx.select().from(constitutionsTable).where(eq(constitutionsTable.nationId, nationId)).for("update");
    if (!row || row.status !== "ratified") return null;
    const flaws = (row.flaws ?? []) as ConstitutionFlawRow[];
    const flaw = nextUntriggeredFlaw(flaws);
    if (!flaw) return null;

    const def = CONSTITUTIONAL_CRISIS_DEF;
    const inserted = await tx.insert(domesticEventsTable).values({
      nationId, kind: def.kind, title: flaw.title, body: flaw.description,
      choices: def.choices.map((c) => ({ id: c.id, label: c.label, hint: c.hint })),
      createdTick: tick, dueTick: tick + EVENT_DEADLINE_TURNS,
      aiRewritten: 1, // 文字已是漏洞本身,不要讓改寫把它換掉
    }).onConflictDoNothing().returning({ id: domesticEventsTable.id });
    if (inserted.length === 0) return null; // 該國已有待處理事件,漏洞保留到下次

    const next = flaws.map((f) => (f.id === flaw.id ? { ...f, triggered: true, triggeredTick: tick } : f));
    await tx.update(constitutionsTable).set({ flaws: next })
      .where(and(eq(constitutionsTable.nationId, nationId), eq(constitutionsTable.status, "ratified")));
    return inserted[0]!.id;
  });
}

/**
 * 擲骰回合呼叫:先補掃(通過時掃描失敗的),再依規則擲骰決定是否引爆。
 * 回傳建立的事件 id;沒發生回 null。rand 可注入供測試。
 */
export async function maybeTriggerCrisis(
  nationId: string, tick: number, rand: () => number = Math.random,
): Promise<string | null> {
  const row = await loadConstitution(nationId);
  const status: ConstitutionStatus = statusOf(row);
  if (status !== "ratified") return null;

  // 通過時掃描失敗的補掃(scanFlaws 冪等,已有清單就不會重掃)。
  if (!Array.isArray(row!.flaws) || row!.flaws.length === 0) {
    await scanFlaws(nationId).catch((err) => logger.warn({ err, nationId }, "constitution flaw rescan failed"));
  }
  const fresh = (await loadConstitution(nationId))!;
  const ok = shouldRollCrisis({
    status: statusOf(fresh), tick, ratifiedTick: fresh.ratifiedTick,
    flaws: (fresh.flaws ?? null) as ConstitutionFlawRow[] | null,
  });
  if (!ok) return null;
  if (!(rand() < CRISIS_CHANCE)) return null;
  return triggerCrisis(nationId, tick);
}

