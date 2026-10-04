import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  politicsPendingIdeasTable,
  politicsPendingDecisionsTable,
  regionControlsTable,
  superEventsTable,
  superEventRegionsTable,
  superEventNationsTable,
  superEventResponsesTable,
  type PlayerNation,
} from "@workspace/db";
import { callGameAi } from "./gameAi";
import { logger } from "./logger";
import { ERAS, getEraIndex } from "./mapRegionEras";
import { GENERAL_DIRECTION } from "./politics";
import { getPoliticsSettings } from "./politicsSettings";
import { loadActivePolicySummaries } from "./politicsActivePolicies";
import { buildNationContext } from "./nationContext";
import { nationAffected } from "../routes/superEvents";
import { styleProfile, buildAutopilotDirective } from "./autopilot";

/**
 * AI 託管：政治與事件層（內閣沒涵蓋的三塊）。
 *
 * 一次 AI 呼叫（bulk）同時產出：政策想法、政府決策、各影響本國的超級事件應對文字。
 * AI 只負責「寫文字」；寫入的資料表、字數上限、覆寫規則與玩家手動提交完全相同，
 * 實際判定仍由回合結算的既有 AI 判定流程處理（政變封鎖、每國一筆待判定都照舊）。
 */

export const EXTRAS_EVENT_LIMIT = 3;

export interface ExtrasEventInput {
  id: string;
  title: string;
  summary: string;
  kind: string;
  stage: string;
}

export interface ExtrasPlan {
  policyIdea: string | null;
  governmentDecision: string | null;
  eventResponses: Array<{ eventId: string; text: string }>;
}

const planSchema = z.object({
  policyIdea: z.string().trim().max(2000).nullable().catch(null),
  governmentDecision: z.string().trim().max(2000).nullable().catch(null),
  eventResponses: z
    .array(z.object({ eventId: z.string().trim().min(1), text: z.string().trim().min(1).max(2000) }))
    .catch([])
    .default([]),
});

function parseAiJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

/** 解析並正規化 AI 輸出：事件只保留白名單 id、文字依上限截斷、空字串視為 null。純函式。 */
export function normalizeExtrasPlan(
  raw: unknown,
  allowedEventIds: ReadonlySet<string>,
  limits: { idea: number; decision: number; response: number },
): ExtrasPlan {
  const parsed = planSchema.parse(raw);
  const cut = (s: string | null, n: number) => {
    const t = (s ?? "").trim().slice(0, n);
    return t.length > 0 ? t : null;
  };
  const seen = new Set<string>();
  const eventResponses: ExtrasPlan["eventResponses"] = [];
  for (const r of parsed.eventResponses) {
    if (!allowedEventIds.has(r.eventId) || seen.has(r.eventId)) continue;
    seen.add(r.eventId);
    eventResponses.push({ eventId: r.eventId, text: r.text.slice(0, limits.response) });
  }
  return {
    policyIdea: cut(parsed.policyIdea, limits.idea),
    governmentDecision: cut(parsed.governmentDecision, limits.decision),
    eventResponses,
  };
}

/** 該國受影響、進行中、且尚未提交應對的超級事件（最多 EXTRAS_EVENT_LIMIT 筆，新到舊）。 */
export async function loadRespondableEvents(nation: PlayerNation): Promise<ExtrasEventInput[]> {
  const active = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.status, "active"));
  if (active.length === 0) return [];
  const ids = active.map((e) => e.id);
  const [regionRows, nationRows, controlRows, responded] = await Promise.all([
    db.select().from(superEventRegionsTable).where(inArray(superEventRegionsTable.eventId, ids)),
    db.select().from(superEventNationsTable).where(inArray(superEventNationsTable.eventId, ids)),
    db
      .select({ regionId: regionControlsTable.regionId })
      .from(regionControlsTable)
      .where(eq(regionControlsTable.nationId, nation.id)),
    db
      .select({ eventId: superEventResponsesTable.eventId })
      .from(superEventResponsesTable)
      .where(and(eq(superEventResponsesTable.nationId, nation.id), inArray(superEventResponsesTable.eventId, ids))),
  ]);
  const nationRegionIds = new Set(controlRows.map((r) => r.regionId));
  const respondedIds = new Set(responded.map((r) => r.eventId));
  const out: ExtrasEventInput[] = [];
  for (const e of [...active].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (respondedIds.has(e.id)) continue;
    const affected = nationAffected(e, {
      eventRegionIds: regionRows.filter((r) => r.eventId === e.id).map((r) => r.regionId),
      nationRegionIds,
      eventNationIds: nationRows.filter((r) => r.eventId === e.id).map((r) => r.nationId),
      nationId: nation.id,
    });
    if (!affected) continue;
    out.push({ id: e.id, title: e.title, summary: e.summary, kind: e.kind, stage: e.stage });
    if (out.length >= EXTRAS_EVENT_LIMIT) break;
  }
  return out;
}

export interface ExtrasResult {
  idea: boolean;
  decision: boolean;
  events: number;
  notes: string[];
}

/** 政治與事件層：單次 AI 呼叫 → 依護欄寫入待判定資料。失敗只拋出，由呼叫端 catch 記 log。 */
export async function runAutopilotExtras(
  nation: PlayerNation,
  style: string,
  userDirective: string,
  era: string,
): Promise<ExtrasResult> {
  const result: ExtrasResult = { idea: false, decision: false, events: 0, notes: [] };
  if (!nation.discordUserId) return result;

  const settings = await getPoliticsSettings();
  const coupLocked = nation.coupPolicyLockTurns > 0;

  const [pendingIdea, pendingDecision, events] = await Promise.all([
    db.select({ id: politicsPendingIdeasTable.id }).from(politicsPendingIdeasTable).where(eq(politicsPendingIdeasTable.nationId, nation.id)).limit(1),
    db.select({ id: politicsPendingDecisionsTable.id }).from(politicsPendingDecisionsTable).where(eq(politicsPendingDecisionsTable.nationId, nation.id)).limit(1),
    loadRespondableEvents(nation),
  ]);
  const wantIdea = !coupLocked && pendingIdea.length === 0;
  const wantDecision = !coupLocked && pendingDecision.length === 0;
  if (!wantIdea && !wantDecision && events.length === 0) return result;

  const [policies, context] = await Promise.all([
    loadActivePolicySummaries(nation.id).catch(() => []),
    buildNationContext(nation, era, {}).catch(() => ""),
  ]);
  const profile = styleProfile(style);
  const eraLabel = ERAS[getEraIndex(era)]?.label ?? era;
  const policyLine = policies.length
    ? `現行制度：${policies.map((p) => p.title).join("、")}`
    : "現行制度：（無）";

  const system = [
    "你是一款架空世界戰略遊戲中，代替玩家全權治國的 AI 總管。玩家不在線，請以國家利益為先，提出具體、合乎時代的做法。",
    `治國風格：${profile.label}。${profile.goalHint}`,
    "僅回覆 JSON 物件（不要 code fence、不要前後文字）。欄位：",
    wantIdea
      ? `- policyIdea：一項政策想法（字串，≤${settings.ideaMaxLength} 字；具體、可執行、延續現行制度；不需要則 null）`
      : "- policyIdea：固定 null",
    wantDecision
      ? `- governmentDecision：一項政府決策（字串，≤${settings.decisionMaxLength} 字；不需要則 null）`
      : "- governmentDecision：固定 null",
    events.length
      ? "- eventResponses：陣列，對下列每個超級事件各給一則應對 {eventId, text}（text ≤500 字，具體說明國家採取的措施）；eventId 必須取自提供清單"
      : "- eventResponses：固定 []",
    "不得編造世界上不存在的機制；敘事性建設只是一段敘事，不會憑空產生系統物件。",
  ].join("\n");

  const user = [
    `時代：${eraLabel}`,
    context,
    policyLine,
    `託管方針：${buildAutopilotDirective(style, userDirective)}`,
    events.length
      ? `需要應對的超級事件：\n${events
          .map((e) => `- id=${e.id}｜${e.kind === "disaster" ? "災難" : "機會"}｜${e.stage}｜${e.title}：${e.summary}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const message = await callGameAi("autopilot.extras", "bulk", {
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = message.content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text : "";
  const plan = normalizeExtrasPlan(parseAiJson(text), new Set(events.map((e) => e.id)), {
    idea: settings.ideaMaxLength,
    decision: settings.decisionMaxLength,
    response: 500,
  });

  if (wantIdea && plan.policyIdea) {
    const ins = await db
      .insert(politicsPendingIdeasTable)
      .values({ nationId: nation.id, direction: GENERAL_DIRECTION, idea: plan.policyIdea })
      .onConflictDoNothing()
      .returning({ id: politicsPendingIdeasTable.id });
    if (ins.length > 0) {
      result.idea = true;
      result.notes.push(`提出政策想法：${plan.policyIdea.slice(0, 60)}`);
    }
  }
  if (wantDecision && plan.governmentDecision) {
    const ins = await db
      .insert(politicsPendingDecisionsTable)
      .values({ nationId: nation.id, decision: plan.governmentDecision })
      .onConflictDoNothing()
      .returning({ id: politicsPendingDecisionsTable.id });
    if (ins.length > 0) {
      result.decision = true;
      result.notes.push(`提出政府決策：${plan.governmentDecision.slice(0, 60)}`);
    }
  }
  for (const r of plan.eventResponses) {
    const ev = events.find((e) => e.id === r.eventId);
    const ins = await db
      .insert(superEventResponsesTable)
      .values({
        eventId: r.eventId,
        nationId: nation.id,
        discordUserId: nation.discordUserId,
        responseText: r.text,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: superEventResponsesTable.id });
    if (ins.length > 0) {
      result.events++;
      result.notes.push(`應對事件「${ev?.title ?? r.eventId}」`);
    }
  }
  logger.info({ nationId: nation.id, ...result }, "autopilot extras done");
  return result;
}
