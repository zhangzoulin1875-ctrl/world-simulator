import { and, eq, gt, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  parliamentStateTable,
  parliamentPartiesTable,
  parliamentLogTable,
  domesticEventsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { applyRevolution, tierOfNation } from "../parliament/service";
import { partyColor } from "../parliament/parties";
import { rulingParty, clampSat, PARLIAMENT_SATISFACTION_START, effectiveParliamentTier, type ParliamentStance, type SeatedParty } from "../parliament/core";
import {
  EVENT_DEADLINE_TURNS,
  EVENT_REPEAT_COOLDOWN_TURNS,
  CONSTITUTION_ONLY_KINDS,
  getEventDef,
  isRollTurn,
  rollsEvent,
  pickEventKindWithCooldown,
  applyEffects,
  triggersCivilWar,
  type DomesticEventDef,
  type EventChoiceDef,
} from "./core";
import { shiftParliament } from "./parliamentShift";
import { queueEventRewrite } from "./text";
import { maybeTriggerCrisis } from "../constitution/crisis";

type Nation = typeof playerNationsTable.$inferSelect;
type EventRow = typeof domesticEventsTable.$inferSelect;

export interface AdminSendResult {
  sent: { nationId: string; nationName: string; eventId: string }[];
  skipped: { nationId: string; nationName: string; reason: "has_pending" | "npc" | "not_found" }[];
}

export interface SettlementSummary {
  nations: number;
  created: number;
  expired: number;
  failed: number;
}

export type ResolveResult =
  | { ok: true; outcome: string; civilWar: boolean }
  | { ok: false; reason: "no_event" | "already_resolved" | "unknown_choice"; message: string };

export async function getNationTick(nationId: string): Promise<number> {
  return currentTick(nationId);
}

async function currentTick(nationId: string): Promise<number> {
  await db.insert(parliamentStateTable).values({ nationId, satisfaction: PARLIAMENT_SATISFACTION_START }).onConflictDoNothing();
  const [s] = await db.select({ tick: parliamentStateTable.tick }).from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  return s?.tick ?? 0;
}

export async function getPendingEvent(nationId: string): Promise<EventRow | null> {
  const [row] = await db
    .select()
    .from(domesticEventsTable)
    .where(and(eq(domesticEventsTable.nationId, nationId), eq(domesticEventsTable.status, "pending")))
    .limit(1);
  return row ?? null;
}

export async function listRecentEvents(nationId: string, limit = 10): Promise<EventRow[]> {
  return db
    .select()
    .from(domesticEventsTable)
    .where(eq(domesticEventsTable.nationId, nationId))
    .orderBy(sql`${domesticEventsTable.createdAt} desc`)
    .limit(limit);
}

/**
 * 冷卻窗口內發生過的事件(只取 kind 與 createdTick)。
 * 不用「最近 N 筆」:事件種類增加或冷卻變長時,固定筆數會悄悄截掉仍在冷卻的事件,冷卻就失效。
 * 窗口 = 現在往前 cooldown 個回合內(createdTick > currentTick - cooldown)。
 */
export async function listCooldownHistory(
  nationId: string,
  currentTick: number,
  cooldown: number = EVENT_REPEAT_COOLDOWN_TURNS,
): Promise<{ kind: string; createdTick: number }[]> {
  return db
    .select({ kind: domesticEventsTable.kind, createdTick: domesticEventsTable.createdTick })
    .from(domesticEventsTable)
    .where(and(eq(domesticEventsTable.nationId, nationId), gt(domesticEventsTable.createdTick, currentTick - cooldown)));
}

/** 建立事件(模板文字先上線;唯一索引保證同一國不會同時有兩個 pending) */
export async function createEvent(nationId: string, def: DomesticEventDef, tick: number): Promise<EventRow | null> {
  const rows = await db
    .insert(domesticEventsTable)
    .values({
      nationId,
      kind: def.kind,
      title: def.title,
      body: def.body,
      choices: def.choices.map((c) => ({ id: c.id, label: c.label, hint: c.hint })),
      createdTick: tick,
      dueTick: tick + EVENT_DEADLINE_TURNS,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

async function loadParties(nationId: string): Promise<(SeatedParty & { dbId: number })[]> {
  const rows = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  return rows.map((r) => ({
    id: String(r.id), dbId: r.id, name: r.name, stance: r.stance as ParliamentStance, weight: r.weight, seats: r.seats,
  }));
}

/** 把事件造成的新席次寫回資料庫(整組取代,執政黨 = 席次最多的黨) */
async function writeParties(tx: Pick<typeof db, "delete" | "insert">, nationId: string, seated: readonly SeatedParty[]) {
  await tx.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  if (seated.length === 0) return;
  const ruling = rulingParty(seated);
  await tx.insert(parliamentPartiesTable).values(
    seated.map((p, i) => ({
      nationId,
      name: p.name,
      stance: p.stance,
      weight: Math.max(1, Math.round(p.weight)),
      seats: p.seats,
      color: partyColor(i),
      isRuling: ruling?.id === p.id,
      description: "",
    })),
  );
}

/**
 * 玩家(或逾時自動)選擇一個選項:套用固定效果、改議會席次、必要時引爆內戰。
 * 整個流程在交易內完成,且用「pending → resolved」條件更新搶占,避免雙擊重複套用。
 */
export async function resolveEvent(
  nation: Nation,
  eventId: string,
  choiceId: string,
  opts: { auto?: boolean; rand?: () => number } = {},
): Promise<ResolveResult> {
  const rand = opts.rand ?? Math.random;
  const [ev] = await db.select().from(domesticEventsTable).where(and(eq(domesticEventsTable.id, eventId), eq(domesticEventsTable.nationId, nation.id)));
  if (!ev) return { ok: false, reason: "no_event", message: "找不到這個事件" };
  if (ev.status !== "pending") return { ok: false, reason: "already_resolved", message: "這個事件已經處理過了" };
  const def = getEventDef(ev.kind);
  const choice: EventChoiceDef | undefined = def?.choices.find((c) => c.id === choiceId);
  if (!def || !choice) return { ok: false, reason: "unknown_choice", message: "沒有這個選項" };

  const { tier } = await tierOfNation(nation);
  const tick = await currentTick(nation.id);
  let civilWar = false;
  let claimed = false;

  await db.transaction(async (tx) => {
    // 搶占:只有仍是 pending 的那一次能往下走
    const grabbed = await tx
      .update(domesticEventsTable)
      .set({ status: opts.auto ? "expired" : "resolved", chosenId: choice.id, resolvedAt: new Date() })
      .where(and(eq(domesticEventsTable.id, ev.id), eq(domesticEventsTable.status, "pending")))
      .returning({ id: domesticEventsTable.id });
    if (grabbed.length === 0) return;
    claimed = true;

    // 1) 國家數值(以資料庫最新值為準)
    const [fresh] = await tx.select().from(playerNationsTable).where(eq(playerNationsTable.id, nation.id));
    const base = fresh ?? nation;
    const next = applyEffects(base, choice.effects);
    await tx
      .update(playerNationsTable)
      .set({
        stability: next.stability,
        money: next.money,
        politicalSupport: next.politicalSupport,
        satisfactionMilitary: next.satisfactionMilitary,
      })
      .where(eq(playerNationsTable.id, nation.id));

    // 2) 議會滿意度(橡皮圖章議會的滿意度固定,不受事件影響;
    //    但專制下議會已被社會黨過半時橡皮圖章失效,視同半專制,事件照常影響議會滿意度)
    const seatRows = await tx.select({ stance: parliamentPartiesTable.stance, seats: parliamentPartiesTable.seats })
      .from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
    const liveTier = effectiveParliamentTier(tier, seatRows.map((r) => ({ stance: r.stance as ParliamentStance, seats: r.seats })));
    if (next.parliamentDelta !== 0 && liveTier !== "autocracy") {
      await tx
        .update(parliamentStateTable)
        .set({ satisfaction: sql`LEAST(100, GREATEST(0, ${parliamentStateTable.satisfaction} + ${next.parliamentDelta}))` })
        .where(eq(parliamentStateTable.nationId, nation.id));
    }

    // 3) 議會席次(社會黨多數事件;君主制也適用)
    if (choice.effects.parliamentShift) {
      const rows = await tx.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
      const parties: SeatedParty[] = rows.map((r) => ({
        id: String(r.id), name: r.name, stance: r.stance as ParliamentStance, weight: r.weight, seats: r.seats,
      }));
      if (parties.length > 0) {
        await writeParties(tx, nation.id, shiftParliament(parties, choice.effects.parliamentShift));
      }
    }

    // 4) 事件紀錄寫進議會日誌,讓玩家在議會頁看得到來龍去脈
    await tx.insert(parliamentLogTable).values({
      nationId: nation.id,
      tick,
      kind: "judgement",
      summary: `【${def.title}】${opts.auto ? "逾期未處理,自動採取:" : "你選擇:"}${choice.label}`,
      satDelta: next.parliamentDelta,
    });

    // 5) 鎮壓引爆內戰?
    civilWar = triggersCivilWar(choice.effects, next.stability, rand);
    const outcome = `${opts.auto ? "逾期未處理,自動採取「" : "你選擇了「"}${choice.label}」。${choice.hint}${civilWar ? "。鎮壓失控,國內爆發內戰!" : ""}`;
    await tx.update(domesticEventsTable).set({ outcome }).where(eq(domesticEventsTable.id, ev.id));
  });

  if (!claimed) return { ok: false, reason: "already_resolved", message: "這個事件已經處理過了" };

  if (civilWar) {
    try {
      const [latest] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nation.id));
      await applyRevolution(latest ?? nation, tick, "military");
    } catch (err) {
      logger.error({ err, nationId: nation.id }, "domestic event: civil war start failed");
    }
  }

  const [done] = await db.select({ outcome: domesticEventsTable.outcome }).from(domesticEventsTable).where(eq(domesticEventsTable.id, ev.id));
  return { ok: true, outcome: done?.outcome ?? "", civilWar };
}

/**
 * 回合結算:
 *  1. 逾期的事件自動套用預設選項
 *  2. 擲骰回合(每 2 回合),對沒有待處理事件的玩家國擲 30%,中了就建立事件
 * NPC 不參與(避免 AI 與資料量暴增,也不需要人為回應)。
 */
export async function runDomesticEventSettlement(rand: () => number = Math.random): Promise<SettlementSummary> {
  const nations = await db.select().from(playerNationsTable).where(eq(playerNationsTable.isNpc, false));
  const summary: SettlementSummary = { nations: nations.length, created: 0, expired: 0, failed: 0 };

  for (const n of nations) {
    try {
      const tick = await currentTick(n.id);
      const pending = await getPendingEvent(n.id);

      if (pending) {
        if (tick >= pending.dueTick) {
          const def = getEventDef(pending.kind);
          if (def) {
            const r = await resolveEvent(n, pending.id, def.defaultChoiceId, { auto: true, rand });
            if (r.ok) summary.expired++;
          }
        }
        continue; // 有未處理事件的國家,這回合不再擲新事件
      }

      if (!isRollTurn(tick)) continue;

      // 憲法危機:通過後的憲法有漏洞時,擲骰回合獨立擲一次(與一般事件互斥,同回合最多一個新事件)。
      const crisisId = await maybeTriggerCrisis(n.id, tick, rand);
      if (crisisId) { summary.created++; continue; }

      if (!rollsEvent(rand)) continue;

      // 同一種事件 EVENT_REPEAT_COOLDOWN_TURNS 回合內不重發;全部種類都在冷卻就這回合不發事件。
      const history = await listCooldownHistory(n.id, tick);
      const kind = pickEventKindWithCooldown(rand, history, tick);
      if (!kind) continue;
      const def = getEventDef(kind);
      if (!def) continue;
      const created = await createEvent(n.id, def, tick);
      if (created) {
        summary.created++;
        queueEventRewrite(created.id); // 背景改寫文字;失敗保留模板
      }
    } catch (err) {
      summary.failed++;
      logger.error({ err, nationId: n.id }, "domestic event settlement failed for nation");
    }
  }
  return summary;
}

export { clampSat };


/**
 * 管理員投放事件給指定玩家國(2026-10-05)。
 *  - 已有待處理事件的國家一律略過,不覆蓋玩家正在面對的事件(唯一索引也會擋);
 *  - NPC 不接受事件(沒有人能回應);
 *  - 事件走和自然事件一樣的流程:同樣的期限、同樣的效果表、同樣可被 AI 改寫文字。
 */
export async function sendEventToNations(
  kind: string,
  nationIds: readonly string[],
  opts: { rewrite?: boolean } = {},
): Promise<AdminSendResult> {
  const def = getEventDef(kind);
  if (!def) throw new Error(`unknown event kind: ${kind}`);
  // 憲法危機只能由通過的憲法漏洞引爆(文字來自漏洞本身),管理員不能憑空投放。
  if ((CONSTITUTION_ONLY_KINDS as readonly string[]).includes(kind)) throw new Error(`event kind ${kind} cannot be sent manually`);
  const result: AdminSendResult = { sent: [], skipped: [] };
  for (const id of nationIds) {
    const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id));
    if (!n) { result.skipped.push({ nationId: id, nationName: "", reason: "not_found" }); continue; }
    const name = n.name ?? "";
    if (n.isNpc) { result.skipped.push({ nationId: id, nationName: name, reason: "npc" }); continue; }
    const tick = await currentTick(id);
    const created = await createEvent(id, def, tick);
    if (!created) { result.skipped.push({ nationId: id, nationName: name, reason: "has_pending" }); continue; }
    result.sent.push({ nationId: id, nationName: name, eventId: created.id });
    if (opts.rewrite !== false) queueEventRewrite(created.id);
  }
  return result;
}

/** 管理員撤回尚未處理的事件(已處理的不動,也不回滾效果)。回傳是否真的撤回 */
export async function cancelPendingEvent(eventId: string): Promise<boolean> {
  const rows = await db
    .update(domesticEventsTable)
    .set({ status: "expired", outcome: "管理員撤回了這個事件,沒有造成任何影響。", resolvedAt: new Date() })
    .where(and(eq(domesticEventsTable.id, eventId), eq(domesticEventsTable.status, "pending")))
    .returning({ id: domesticEventsTable.id });
  return rows.length > 0;
}

/** 後台總覽:各國目前待處理的事件 + 最近的事件紀錄 */
export async function adminOverview(limit = 40) {
  const rows = await db
    .select({
      id: domesticEventsTable.id,
      nationId: domesticEventsTable.nationId,
      nationName: playerNationsTable.name,
      kind: domesticEventsTable.kind,
      title: domesticEventsTable.title,
      status: domesticEventsTable.status,
      chosenId: domesticEventsTable.chosenId,
      outcome: domesticEventsTable.outcome,
      createdAt: domesticEventsTable.createdAt,
      resolvedAt: domesticEventsTable.resolvedAt,
    })
    .from(domesticEventsTable)
    .innerJoin(playerNationsTable, eq(playerNationsTable.id, domesticEventsTable.nationId))
    .orderBy(sql`${domesticEventsTable.createdAt} desc`)
    .limit(limit);
  return rows;
}
