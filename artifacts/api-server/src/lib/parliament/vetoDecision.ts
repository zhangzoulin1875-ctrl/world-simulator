/**
 * 被議會否決的政策:玩家決定「強行通過」或「接受否決」。
 *
 * 併發安全:決定時先用「條件刪除」原子搶佔那一列(只有一個請求刪得到),
 * 雙擊／重送不會重複套用政策或重複扣議會滿意度。
 */
import { and, eq } from "drizzle-orm";
import { db, politicsPendingIdeasTable, parliamentStateTable, playerNationsTable } from "@workspace/db";
import { logger } from "../logger";
import { getPoliticsSettings } from "../politicsSettings";
import { applyPolicyOutcome, type VetoedPayload } from "../politicsSettlement";
import type { PoliticsDirection } from "../politics";
import { clampSat } from "./core";
import { overridePenalty } from "./vote";

type Nation = typeof playerNationsTable.$inferSelect;
const GENERAL = "general" as const;

export interface PendingVetoView {
  ideaId: number;
  idea: string;
  votes: VetoedPayload["votes"];
  seatsFor: number;
  seatsAgainst: number;
  seatsAbstain: number;
  /** 強行通過預計扣的議會滿意度。 */
  overridePenalty: number;
  /** 政策若通過會是什麼(給玩家決策參考,不含數值細節)。 */
  successTitle: string;
  failureTitle: string;
}

function readPayload(raw: unknown): VetoedPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<VetoedPayload>;
  if (!p.success || !p.failure || !Array.isArray(p.votes)) return null;
  return p as VetoedPayload;
}

/** 該國目前等待玩家決定的被否決政策(沒有則 null)。 */
export async function loadPendingVeto(nationId: string): Promise<PendingVetoView | null> {
  const [row] = await db.select().from(politicsPendingIdeasTable)
    .where(and(eq(politicsPendingIdeasTable.nationId, nationId), eq(politicsPendingIdeasTable.voteState, "vetoed")))
    .limit(1);
  if (!row) return null;
  const p = readPayload(row.votePayload);
  if (!p) return null;
  return {
    ideaId: row.id, idea: row.idea, votes: p.votes,
    seatsFor: p.seatsFor, seatsAgainst: p.seatsAgainst, seatsAbstain: p.seatsAbstain,
    overridePenalty: overridePenalty(p.againstRatio),
    successTitle: p.success.title, failureTitle: p.failure.title,
  };
}

export type VetoDecision = "override" | "accept";

export type VetoResult =
  | { ok: true; decision: VetoDecision; title: string; satisfactionAfter?: number }
  | { ok: false; status: 404 | 409 | 500; error: string };

/** 玩家對被否決政策做決定。 */
export async function decideVeto(nation: Nation, decision: VetoDecision): Promise<VetoResult> {
  // 原子搶佔:只有刪到這一列的請求繼續往下。
  const [claimed] = await db.delete(politicsPendingIdeasTable)
    .where(and(eq(politicsPendingIdeasTable.nationId, nation.id), eq(politicsPendingIdeasTable.voteState, "vetoed")))
    .returning();
  if (!claimed) return { ok: false, status: 404, error: "目前沒有等待你決定的被否決政策" };
  const payload = readPayload(claimed.votePayload);
  if (!payload) return { ok: false, status: 409, error: "被否決的政策資料損毀,已清除" };

  const settings = await getPoliticsSettings();
  const override = decision === "override";
  const applied = await applyPolicyOutcome({
    nation, idea: claimed.idea, direction: (payload.direction as PoliticsDirection) ?? GENERAL, resultType: payload.resultType, succeeded: override,
    successOutcome: payload.success, failureOutcome: payload.failure, settings,
    enabledDirs: payload.enabledDirs ?? [],
  });
  if (!applied) {
    // 理論上到不了(兩側都在)。把想法放回去,讓玩家可再試。
    await db.insert(politicsPendingIdeasTable).values({
      nationId: nation.id, direction: claimed.direction, idea: claimed.idea,
      voteState: claimed.voteState, votePayload: claimed.votePayload,
    }).onConflictDoNothing();
    logger.error({ nationId: nation.id }, "veto decision could not apply outcome — restored");
    return { ok: false, status: 500, error: "套用政策失敗,請稍後再試" };
  }

  let satisfactionAfter: number | undefined;
  if (override) {
    const penalty = overridePenalty(payload.againstRatio);
    const [st] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nation.id));
    if (st) {
      satisfactionAfter = clampSat(st.satisfaction - penalty);
      await db.update(parliamentStateTable).set({ satisfaction: satisfactionAfter }).where(eq(parliamentStateTable.nationId, nation.id));
    }
  }
  return { ok: true, decision, title: override ? payload.success.title : payload.failure.title, satisfactionAfter };
}

/**
 * 結算時處理「玩家整回合都沒決定」的被否決政策:視同接受否決(套用失敗版)。
 * 由政治結算在判定新想法前呼叫。
 */
export async function expireStaleVetoes(nation: Nation): Promise<number> {
  const rows = await db.select({ id: politicsPendingIdeasTable.id }).from(politicsPendingIdeasTable)
    .where(and(eq(politicsPendingIdeasTable.nationId, nation.id), eq(politicsPendingIdeasTable.voteState, "vetoed")));
  if (rows.length === 0) return 0;
  const r = await decideVeto(nation, "accept");
  return r.ok ? 1 : 0;
}
