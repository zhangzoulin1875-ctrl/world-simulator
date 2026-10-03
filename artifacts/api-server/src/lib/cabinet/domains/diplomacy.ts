import { z } from "zod";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  diplomacyMessagesTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  playerNationsTable,
  type DiplomacyTreaty,
  type PlayerNation,
} from "@workspace/db";
import type {
  CabinetDomainModule,
  DomainActionKey,
  ExecuteApprovedContext,
  RunDomainContext,
} from "../types";
import { logger } from "../../logger";
import { callGameAi } from "../../gameAi";
import { proposeApproval, recordCabinetAction } from "../index";
import { agencyLevelHint, styleToPromptFragment } from "../style";
import {
  autoJoinNationIds,
  canonicalPair,
  clampChatTalkRelationDelta,
  clampRelationScore,
  findActiveSuzerainId,
  findWarBlockingTreatyType,
  isTreatyType,
  npcReproposalCooldownRemainingMs,
  treatyTypeLabel,
  type TreatyType,
} from "../../diplomacy";
import { decideNpcChatReply, decideNpcTreatyResponse } from "../../diplomacyAi";
import { buildNationGeoCultureContext } from "../../nationGeoCulture";
import { applyNpcTreatyDecision } from "../../npcTreatyDecision";
import { HttpError } from "../../treatyActivation";
import { pgErrorCode } from "../../playerValidation";
import { ensurePoliticalNote } from "../../politicalNote";
import { getAiJudgmentDirective } from "../../aiDirective";
import { nationsInSameAlliance } from "../../alliances";
import { notifyWarDeclared } from "../../diplomacyNotify";
import {
  concessionThresholds,
  diplomatActionBudget,
  extractDiplomatActions,
  isMajorConcession,
  sanitizeDiplomatActions,
  type ConcessionThresholds,
  type RawDiplomatAction,
} from "./diplomacyPlanning";

/**
 * Task #245 — 外交官（外交）領域模組：每回合自動代理外交。
 *
 * 安全邊界（不可逾越）：
 * - 外交官只對「NPC 國家」（is_npc=true）行動；**絕不對真人玩家**（有 discordUserId）
 *   或無主國家（既有規則下不可對話、無法回覆條約，會懸置）行動。
 * - 玩家選擇「完整代理」：外交官可自動 聊天／改善關係／提議並簽訂條約（含小額善意
 *   讓步）。宣戰（declare_war）與「大額讓步」（金錢／科技超過門檻、或割地）一律不自動
 *   執行，改寫入 cabinet_approvals 待批准佇列，等玩家批准後才由 executeApproved 套用。
 * - 一律重用既有外交底層（NPC 對話 AI／NPC 條約回覆 AI／條約生效邏輯／宣戰語意），
 *   不新增外交玩法規則。
 *
 * 代理程度（agencyLevel）與大臣風格（越權／膽小）共同縮放：每回合動作上限與「可自動
 * 讓步」的金錢／科技門檻。越權高／積極 → 動作多、門檻高；膽小高／保守 → 動作少、門檻低
 * （更多事項進待批准）。
 */

export const actionKeys: DomainActionKey[] = [
  {
    key: "chat",
    label: "主動外交往來",
    description:
      "外交官主動與 NPC 國家對話往來，依 AI 判定改善或維繫邦交（亦即改善關係）。",
  },
  {
    key: "propose_treaty",
    label: "提議並簽訂條約",
    description:
      "外交官主動向 NPC 提出互不侵犯／軍事通行權／保障獨立等條約；NPC 接受即生效。",
  },
  {
    key: "send_gift",
    label: "締約附帶善意（送禮／讓步）",
    description:
      "允許提案附帶金錢／科技作為善意；小額自動附帶，大額讓步（超過門檻）需你批准。",
  },
  {
    key: "declare_war",
    label: "對 NPC 宣戰",
    description: "外交官可建議對 NPC 宣戰；宣戰一律需要你批准後才會執行。",
  },
];

// ── AI 規劃服務（bulk 模型） ───────────────────────────────────

interface DiplomatCandidate {
  id: string;
  name: string | null;
  relationScore: number;
  atWar: boolean;
  hasActiveTreaty: boolean;
  hasPendingProposal: boolean;
  diplomaticAttitude: string | null;
  politicalNote: string | null;
}

export interface GenerateDiplomatPlanInput {
  nationName: string | null;
  eraLabel: string;
  directive: string;
  agencyLevelHint: string;
  styleFragment: string;
  budget: number;
  thresholds: ConcessionThresholds;
  enabledActionKeys: string[];
  candidates: DiplomatCandidate[];
  adminDirective?: string | null;
}

function buildPlanSystemPrompt(): string {
  return [
    "你是一款架空世界戰略遊戲中，某個玩家國家的「外交官 AI」。你要替該國決定本回合是否主動對其他 NPC 國家發起外交行動。只回覆單一 JSON 物件（不要 code fence、不要任何前後說明文字）。",
    "",
    "JSON 結構：",
    '{"actions":[ ...行動陣列... ]}',
    "",
    "每個行動為：",
    '{"targetId":"對象 NPC 的 uuid","kind":"chat" / "treaty" / "war","message":"kind=chat 時我方主動送出的一句外交訊息","treatyType":"nonaggression|military_access|guarantee（kind=treaty 時必填）","durationDays":條約時效天數整數或 null,"offerMoney":附帶善意金錢整數或 0,"offerTechPoints":附帶善意科技點數整數或 0,"reason":"一句話理由（zh-TW）"}',
    "",
    "硬性規則（違反的行動會被系統丟棄）：",
    "1. targetId 必須是下方候選 NPC 清單中的 uuid（只能對 NPC 行動）。",
    "2. 只能輸出「已授權動作」清單內的 kind。kind=chat 對應授權 chat；kind=treaty 對應 propose_treaty；kind=war 對應 declare_war。附帶 offerMoney／offerTechPoints 需 send_gift 授權，否則會被清零。",
    "3. 不要對「已有進行中提案＝是」或「交戰＝是」的對象提議條約；kind=war 只能對關係值 < 0 且未交戰的對象發起。",
    "4. 數量上限：actions 總數 ≤ budget。寧缺勿濫，只在合理時行動。",
    "5. 決策貼合關係值：關係佳→締約／軍事通行權／保障獨立或友好對話；關係普通→互不侵犯或睦鄰對話；關係惡劣且授權→（建議）宣戰。宣戰一律需玩家批准，不會立即開戰。",
    "6. 附帶讓步要節制：offerMoney ≤ 可自動金錢門檻、offerTechPoints ≤ 可自動科技門檻時系統會自動執行；超過門檻則整筆提案改為送交玩家批准。",
    "7. 若對象標註「外交態度」或「治理風格」，行動傾向需貼合之。",
    "8. 若列出「玩家常駐方針」或「世界管理員方針」，須在合理範圍內盡量遵循；衝突時以管理員方針為最高優先。",
  ].join("\n");
}

function buildPlanUserPrompt(input: GenerateDiplomatPlanInput): string {
  const lines: string[] = [
    `我方國家：${input.nationName ?? "（未命名）"}　時代：${input.eraLabel}`,
    `代理程度：${input.agencyLevelHint}`,
    `大臣${input.styleFragment}`,
    `本回合動作上限（budget）：${input.budget}`,
    `可自動附帶金錢門檻：${input.thresholds.maxAutoMoney}；可自動附帶科技門檻：${input.thresholds.maxAutoTech}`,
    `已授權動作：${input.enabledActionKeys.join("、") || "（無）"}`,
  ];
  if (input.directive) {
    lines.push("", `玩家常駐方針：${input.directive}`);
  }
  if (input.adminDirective) {
    lines.push("", `世界管理員方針（最高優先，務必遵循）：${input.adminDirective}`);
  }
  lines.push("", "候選 NPC（targetId 從中挑選）：");
  if (input.candidates.length === 0) {
    lines.push("（無）");
  } else {
    for (const c of input.candidates) {
      lines.push(
        `- ${c.name ?? "(未命名)"} | id=${c.id} | 關係=${c.relationScore} | 交戰=${
          c.atWar ? "是" : "否"
        } | 已有條約=${c.hasActiveTreaty ? "是" : "否"} | 進行中提案=${
          c.hasPendingProposal ? "是" : "否"
        }`,
      );
      if (c.diplomaticAttitude) lines.push(`    外交態度：${c.diplomaticAttitude}`);
      if (c.politicalNote) lines.push(`    治理風格：${c.politicalNote}`);
    }
  }
  lines.push("", "僅回覆單一 JSON 物件。");
  return lines.join("\n");
}

/** 產生外交官行動清單（bulk 模型）。解析失敗一律丟例外（呼叫端記錄後略過本回合）。 */
export async function generateDiplomatPlan(
  input: GenerateDiplomatPlanInput,
): Promise<RawDiplomatAction[]> {
  const message = await callGameAi("cabinet.diplomacy", "bulk", {
    system: buildPlanSystemPrompt(),
    messages: [{ role: "user", content: buildPlanUserPrompt(input) }],
  });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  try {
    return extractDiplomatActions(raw);
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 800) },
      "cabinet diplomat plan parse failed",
    );
    throw new Error("外交官 AI 回覆格式不正確");
  }
}

// ── 執行底層（重用既有外交邏輯） ───────────────────────────────

/** 我方主動與某 NPC 對話：AI 產生 NPC 回覆＋關係增減，寫入訊息與關係事件。 */
async function executeChatWithNpc(
  nation: PlayerNation,
  target: PlayerNation,
  message: string,
): Promise<void> {
  const myId = nation.id;
  const { low, high } = canonicalPair(myId, target.id);

  const recent = await db
    .select({
      senderNationId: diplomacyMessagesTable.senderNationId,
      body: diplomacyMessagesTable.body,
    })
    .from(diplomacyMessagesTable)
    .where(
      or(
        and(
          eq(diplomacyMessagesTable.senderNationId, myId),
          eq(diplomacyMessagesTable.recipientNationId, target.id),
        ),
        and(
          eq(diplomacyMessagesTable.senderNationId, target.id),
          eq(diplomacyMessagesTable.recipientNationId, myId),
        ),
      ),
    )
    .orderBy(desc(diplomacyMessagesTable.id))
    .limit(8);
  const recentMessages = recent.map((m) => ({
    fromPlayer: m.senderNationId === myId,
    body: m.body,
  }));

  const [[relation], [war]] = await Promise.all([
    db
      .select({ score: diplomacyRelationsTable.score })
      .from(diplomacyRelationsTable)
      .where(
        and(
          eq(diplomacyRelationsTable.nationAId, low),
          eq(diplomacyRelationsTable.nationBId, high),
        ),
      )
      .limit(1),
    db
      .select({ id: diplomacyWarsTable.id })
      .from(diplomacyWarsTable)
      .where(
        and(
          eq(diplomacyWarsTable.nationAId, low),
          eq(diplomacyWarsTable.nationBId, high),
          isNull(diplomacyWarsTable.endedAt),
        ),
      )
      .limit(1),
  ]);

  const npcPoliticalNote = await ensurePoliticalNote(target, { allowNpc: true });
  // Task #369 — 讓 NPC 回覆用語貼合對話對方（我方國家）所在地區文化。
  const counterpartGeoContext = await buildNationGeoCultureContext(nation.id);
  const reply = await decideNpcChatReply({
    npcName: target.name ?? "NPC",
    playerName: nation.name ?? "（未命名）",
    playerMessage: message,
    relationScore: relation?.score ?? 0,
    atWar: war !== undefined,
    recentMessages,
    politicalNote: npcPoliticalNote,
    diplomaticAttitude: target.diplomaticAttitude,
    adminDirective: await getAiJudgmentDirective(),
    counterpartGeoContext,
  });

  // Task #499 — 純對話的正向關係值伺服器端硬性封頂（與玩家聊天路徑同規則）。
  const delta = clampChatTalkRelationDelta(reply.relationDelta);
  await db.transaction(async (tx) => {
    await tx.insert(diplomacyMessagesTable).values({
      senderNationId: myId,
      recipientNationId: target.id,
      body: message,
    });
    await tx.insert(diplomacyMessagesTable).values({
      senderNationId: target.id,
      recipientNationId: myId,
      body: reply.reply,
      readAt: new Date(),
    });
    await tx
      .insert(diplomacyRelationsTable)
      .values({ nationAId: low, nationBId: high })
      .onConflictDoNothing();
    const [rel] = await tx
      .select()
      .from(diplomacyRelationsTable)
      .where(
        and(
          eq(diplomacyRelationsTable.nationAId, low),
          eq(diplomacyRelationsTable.nationBId, high),
        ),
      )
      .for("update");
    const newScore = clampRelationScore((rel?.score ?? 0) + delta);
    await tx
      .update(diplomacyRelationsTable)
      .set({ score: newScore })
      .where(
        and(
          eq(diplomacyRelationsTable.nationAId, low),
          eq(diplomacyRelationsTable.nationBId, high),
        ),
      );
    await tx.insert(diplomacyRelationEventsTable).values({
      actorNationId: myId,
      targetNationId: target.id,
      action: "chat",
    });
  });
}

interface TreatyTerms {
  treatyType: TreatyType;
  durationDays: number | null;
  offerMoney: number;
  offerTechPoints: number;
}

/**
 * 我方向某 NPC 提議條約並由 NPC AI 即時裁決（重用既有 NPC 條約回覆／生效邏輯）。
 * - 重提冷卻／進行中提案／餘額不足時直接略過（回 false），不丟錯。
 * - AI 失敗時刪除懸置的 proposed 列（與玩家路由一致），回 false。
 */
async function proposeTreatyToNpc(
  nation: PlayerNation,
  target: PlayerNation,
  terms: TreatyTerms,
): Promise<boolean> {
  const myId = nation.id;

  // 餘額檢查（附帶讓步不可超過持有量）。
  if (terms.offerMoney > nation.money) return false;
  if (terms.offerTechPoints > nation.techPoints) return false;

  // 重提冷卻：同一 pair 最近一筆被拒／撤回的提案仍在冷卻內 → 略過。
  const [recentEnded] = await db
    .select({ updatedAt: diplomacyTreatiesTable.updatedAt })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        inArray(diplomacyTreatiesTable.status, ["rejected", "withdrawn"]),
        or(
          and(
            eq(diplomacyTreatiesTable.proposerNationId, myId),
            eq(diplomacyTreatiesTable.targetNationId, target.id),
          ),
          and(
            eq(diplomacyTreatiesTable.proposerNationId, target.id),
            eq(diplomacyTreatiesTable.targetNationId, myId),
          ),
        ),
      ),
    )
    .orderBy(desc(diplomacyTreatiesTable.updatedAt))
    .limit(1);
  if (
    recentEnded &&
    npcReproposalCooldownRemainingMs(recentEnded.updatedAt) > 0
  ) {
    return false;
  }

  // 插入 proposed 列（部分唯一索引 23505 → 已有進行中提案，略過）。
  let treaty: DiplomacyTreaty | null;
  try {
    const [row] = await db
      .insert(diplomacyTreatiesTable)
      .values({
        proposerNationId: myId,
        targetNationId: target.id,
        type: terms.treatyType,
        durationDays: terms.durationDays,
        offerMoney: terms.offerMoney,
        offerTechPoints: terms.offerTechPoints,
        offerRegionIds: [],
        status: "proposed",
        awaitingNationId: target.id,
      })
      .returning();
    treaty = row ?? null;
  } catch (err) {
    if (pgErrorCode(err) === "23505") return false;
    throw err;
  }
  if (!treaty) return false;

  const npcPoliticalNote = await ensurePoliticalNote(target, { allowNpc: true });
  // Task #369 — 讓 NPC 締約回覆用語貼合提案國（我方）所在地區文化。
  const counterpartGeoContext = await buildNationGeoCultureContext(nation.id);
  let decision;
  try {
    decision = await decideNpcTreatyResponse({
      npcName: target.name ?? "NPC",
      proposerName: nation.name ?? "（未命名）",
      treatyType: terms.treatyType,
      durationDays: terms.durationDays,
      offerMoney: terms.offerMoney,
      offerTechPoints: terms.offerTechPoints,
      offerRegionNames: [],
      relationScore: await relationScoreOf(myId, target.id),
      atWar: await atWarWith(myId, target.id),
      politicalNote: npcPoliticalNote,
      diplomaticAttitude: target.diplomaticAttitude,
      adminDirective: await getAiJudgmentDirective(),
      counterpartGeoContext,
    });
  } catch (err) {
    // AI 失敗：刪除懸置的 proposed 列（僅在仍為 proposed 時），回 false。
    await db
      .delete(diplomacyTreatiesTable)
      .where(
        and(
          eq(diplomacyTreatiesTable.id, treaty.id),
          eq(diplomacyTreatiesTable.status, "proposed"),
        ),
      );
    logger.error(
      { err, treatyId: treaty.id },
      "cabinet diplomat treaty decision failed",
    );
    return false;
  }

  try {
    await applyNpcTreatyDecision(treaty.id, decision);
  } catch (err) {
    // 併發下條約可能已被其他流程處理；記錄即可（不丟錯，避免中斷回合）。
    if (!(err instanceof HttpError)) throw err;
    logger.error(
      { err, treatyId: treaty.id },
      "cabinet diplomat treaty apply failed",
    );
    return false;
  }
  return true;
}

/**
 * 我方（真人玩家國家）對某 NPC 宣戰：完整重建玩家宣戰路由語意
 * （關係值 < 0、互不侵犯條約阻擋、同盟不可互戰、canonical 插入、宣戰關係事件、
 * 被宣戰方同盟／保障獨立夥伴自動參戰）。任一前置條件不符即安靜略過（不丟錯）。
 * 目標一律為 NPC，故不會踩到 NPC↔NPC 惰性戰爭（引擎仍會結算真人↔NPC 戰爭）。
 */
async function declareWarOnNpc(
  nation: PlayerNation,
  target: { id: string; name: string | null; discordUserId: string | null },
): Promise<boolean> {
  const myId = nation.id;
  const { low, high } = canonicalPair(myId, target.id);

  const [[relation], activeTreaties] = await Promise.all([
    db
      .select({ score: diplomacyRelationsTable.score })
      .from(diplomacyRelationsTable)
      .where(
        and(
          eq(diplomacyRelationsTable.nationAId, low),
          eq(diplomacyRelationsTable.nationBId, high),
        ),
      )
      .limit(1),
    db
      .select({
        type: diplomacyTreatiesTable.type,
        proposerNationId: diplomacyTreatiesTable.proposerNationId,
        targetNationId: diplomacyTreatiesTable.targetNationId,
        status: diplomacyTreatiesTable.status,
        expiresAt: diplomacyTreatiesTable.expiresAt,
        // 附庸條約方向（宗主自動參戰需要）。
        proposerIsVassal: diplomacyTreatiesTable.proposerIsVassal,
      })
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.status, "active")),
  ]);

  // 對 NPC 宣戰須關係值 < 0。
  if ((relation?.score ?? 0) >= 0) return false;
  // 生效中的互不侵犯條約擋下宣戰。
  if (findWarBlockingTreatyType(activeTreaties, myId, target.id) !== null) {
    return false;
  }
  // 附庸外交受限：附庸的內閣不自行宣戰（宣戰需宗主同意，由玩家親自走
  // 宣戰路由的同意流程），安靜略過。
  if (findActiveSuzerainId(activeTreaties, myId) !== null) return false;
  // 同屬一個聯盟不可互戰。
  if (await nationsInSameAlliance(myId, target.id)) return false;

  const inserted = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: low, nationBId: high, declaredByNationId: myId })
    .onConflictDoNothing()
    .returning({ id: diplomacyWarsTable.id });
  if (inserted.length === 0) return false; // 已交戰

  await db.insert(diplomacyRelationEventsTable).values({
    actorNationId: myId,
    targetNationId: target.id,
    action: "declare_war",
  });

  // 自動參戰：被宣戰方（NPC）的同盟／保障獨立夥伴對我方進入交戰。
  const joinerIds = autoJoinNationIds(activeTreaties, target.id, myId);
  if (joinerIds.length > 0) {
    for (const joinerId of joinerIds) {
      const pair = canonicalPair(joinerId, myId);
      await db
        .insert(diplomacyWarsTable)
        .values({
          nationAId: pair.low,
          nationBId: pair.high,
          declaredByNationId: joinerId,
        })
        .onConflictDoNothing();
    }
  }

  // 通知被宣戰方（NPC discordUserId=null → fire-and-forget no-op）。
  notifyWarDeclared({
    targetDiscordUserId: target.discordUserId,
    declarerNationName: nation.name,
  });
  return true;
}

async function relationScoreOf(a: string, b: string): Promise<number> {
  const { low, high } = canonicalPair(a, b);
  const [rel] = await db
    .select({ score: diplomacyRelationsTable.score })
    .from(diplomacyRelationsTable)
    .where(
      and(
        eq(diplomacyRelationsTable.nationAId, low),
        eq(diplomacyRelationsTable.nationBId, high),
      ),
    )
    .limit(1);
  return rel?.score ?? 0;
}

async function atWarWith(a: string, b: string): Promise<boolean> {
  const { low, high } = canonicalPair(a, b);
  const [war] = await db
    .select({ id: diplomacyWarsTable.id })
    .from(diplomacyWarsTable)
    .where(
      and(
        eq(diplomacyWarsTable.nationAId, low),
        eq(diplomacyWarsTable.nationBId, high),
        isNull(diplomacyWarsTable.endedAt),
      ),
    )
    .limit(1);
  return war !== undefined;
}

// ── 每回合代理 ─────────────────────────────────────────────────

export async function runDomain(ctx: RunDomainContext): Promise<void> {
  const enabled = new Set(ctx.enabledActionKeys);
  if (enabled.size === 0) return;

  const nation = ctx.nation;
  const myId = nation.id;

  // 候選對象：NPC（is_npc=true），排除自己。絕不含真人玩家／無主國家。
  const npcs = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.isNpc, true));
  const candidateNpcs = npcs.filter((n) => n.id !== myId);
  if (candidateNpcs.length === 0) return;
  const npcIds = new Set(candidateNpcs.map((n) => n.id));

  // 關係值、交戰、進行中提案、生效中條約（僅涉及我方的列）。
  const relations = await db
    .select({
      a: diplomacyRelationsTable.nationAId,
      b: diplomacyRelationsTable.nationBId,
      score: diplomacyRelationsTable.score,
    })
    .from(diplomacyRelationsTable)
    .where(
      or(
        eq(diplomacyRelationsTable.nationAId, myId),
        eq(diplomacyRelationsTable.nationBId, myId),
      ),
    );
  const relationScores = new Map<string, number>();
  for (const r of relations) {
    const other = r.a === myId ? r.b : r.a;
    relationScores.set(other, r.score);
  }

  const wars = await db
    .select({
      a: diplomacyWarsTable.nationAId,
      b: diplomacyWarsTable.nationBId,
    })
    .from(diplomacyWarsTable)
    .where(
      and(
        isNull(diplomacyWarsTable.endedAt),
        or(
          eq(diplomacyWarsTable.nationAId, myId),
          eq(diplomacyWarsTable.nationBId, myId),
        ),
      ),
    );
  const atWarTargetIds = new Set<string>();
  for (const w of wars) atWarTargetIds.add(w.a === myId ? w.b : w.a);

  const proposedRows = await db
    .select({
      proposer: diplomacyTreatiesTable.proposerNationId,
      target: diplomacyTreatiesTable.targetNationId,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.status, "proposed"),
        or(
          eq(diplomacyTreatiesTable.proposerNationId, myId),
          eq(diplomacyTreatiesTable.targetNationId, myId),
        ),
      ),
    );
  const pendingTargetIds = new Set<string>();
  for (const t of proposedRows) {
    pendingTargetIds.add(t.proposer === myId ? t.target : t.proposer);
  }

  const activeRows = await db
    .select({
      proposer: diplomacyTreatiesTable.proposerNationId,
      target: diplomacyTreatiesTable.targetNationId,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.status, "active"),
        or(
          eq(diplomacyTreatiesTable.proposerNationId, myId),
          eq(diplomacyTreatiesTable.targetNationId, myId),
        ),
      ),
    );
  const activeTreatyTargetIds = new Set<string>();
  for (const t of activeRows) {
    activeTreatyTargetIds.add(t.proposer === myId ? t.target : t.proposer);
  }

  const thresholds = concessionThresholds(
    Number(nation.money),
    Number(nation.techPoints),
    ctx.agencyLevel,
    ctx.minister.style,
  );
  const budget = diplomatActionBudget(ctx.agencyLevel, ctx.minister.style);

  const candidates: DiplomatCandidate[] = candidateNpcs.map((n) => ({
    id: n.id,
    name: n.name,
    relationScore: relationScores.get(n.id) ?? 0,
    atWar: atWarTargetIds.has(n.id),
    hasActiveTreaty: activeTreatyTargetIds.has(n.id),
    hasPendingProposal: pendingTargetIds.has(n.id),
    diplomaticAttitude: n.diplomaticAttitude,
    politicalNote: n.politicalNote,
  }));

  let raw: RawDiplomatAction[];
  try {
    raw = await generateDiplomatPlan({
      nationName: nation.name,
      eraLabel: ctx.era,
      directive: ctx.directive,
      agencyLevelHint: agencyLevelHint(ctx.agencyLevel),
      styleFragment: styleToPromptFragment(ctx.minister.style),
      budget,
      thresholds,
      enabledActionKeys: ctx.enabledActionKeys,
      candidates,
      adminDirective: await getAiJudgmentDirective(),
    });
  } catch (err) {
    logger.error(
      { err, nationId: myId },
      "cabinet diplomat plan generation failed; skipping turn",
    );
    return;
  }

  const planned = sanitizeDiplomatActions(raw, {
    npcTargetIds: npcIds,
    enabledActionKeys: enabled,
    pendingTargetIds,
    atWarTargetIds,
    relationScores,
    budget,
  });

  const npcById = new Map(candidateNpcs.map((n) => [n.id, n]));
  const ministerName = ctx.minister.name;

  for (const action of planned) {
    const npc = npcById.get(action.targetId);
    if (!npc) continue;
    try {
      if (action.kind === "chat") {
        await executeChatWithNpc(nation, npc, action.message ?? "");
        await recordCabinetAction({
          nationId: nation.id,
          domain: "diplomacy",
          actionKey: "chat",
          summary: `與 NPC「${npc.name ?? "（未命名）"}」外交交流`,
          mode: "auto",
        });
        continue;
      }

      if (action.kind === "war") {
        // 宣戰一律需玩家批准（never 自動執行）。
        await proposeApproval({
          nation,
          domain: "diplomacy",
          ministerName,
          actionKey: "declare_war",
          summary: `外交官建議對 NPC「${npc.name ?? "（未命名）"}」宣戰${
            action.reason ? `：${action.reason}` : ""
          }`,
          params: { targetId: npc.id },
        });
        continue;
      }

      // treaty
      const treatyType = action.treatyType ?? "nonaggression";
      const major = isMajorConcession(
        {
          offerMoney: action.offerMoney,
          offerTechPoints: action.offerTechPoints,
          offerRegionIds: [],
        },
        thresholds,
      );
      if (major) {
        const parts: string[] = [];
        if (action.offerMoney > 0) parts.push(`金錢 ${action.offerMoney}`);
        if (action.offerTechPoints > 0)
          parts.push(`科技點數 ${action.offerTechPoints}`);
        await proposeApproval({
          nation,
          domain: "diplomacy",
          ministerName,
          actionKey: "send_gift",
          summary: `外交官建議與 NPC「${npc.name ?? "（未命名）"}」締結${treatyTypeLabel(
            treatyType,
          )}，附帶大額讓步（${parts.join("、") || "資源"}）${
            action.reason ? `：${action.reason}` : ""
          }`,
          params: {
            targetId: npc.id,
            treatyType,
            durationDays: action.durationDays,
            offerMoney: action.offerMoney,
            offerTechPoints: action.offerTechPoints,
          },
          cost:
            action.offerMoney > 0
              ? { amount: action.offerMoney, kind: "money" }
              : action.offerTechPoints > 0
                ? { amount: action.offerTechPoints, kind: "tech" }
                : null,
        });
        continue;
      }

      await proposeTreatyToNpc(nation, npc, {
        treatyType,
        durationDays: action.durationDays,
        offerMoney: action.offerMoney,
        offerTechPoints: action.offerTechPoints,
      });
      await recordCabinetAction({
        nationId: nation.id,
        domain: "diplomacy",
        actionKey: "propose_treaty",
        summary: `向 NPC「${npc.name ?? "（未命名）"}」提議締結${treatyTypeLabel(
          treatyType,
        )}`,
        mode: "auto",
        cost:
          action.offerMoney > 0
            ? { amount: action.offerMoney, kind: "money" }
            : action.offerTechPoints > 0
              ? { amount: action.offerTechPoints, kind: "tech" }
              : null,
      });
    } catch (err) {
      logger.error(
        { err, nationId: myId, targetId: npc.id, kind: action.kind },
        "cabinet diplomat action failed",
      );
    }
  }
}

// ── 批准後套用 ─────────────────────────────────────────────────

const treatyApprovalParamsSchema = z.object({
  targetId: z.string().min(1),
  treatyType: z.string(),
  durationDays: z.number().int().min(1).max(3650).nullable().optional(),
  offerMoney: z.number().int().min(0).optional(),
  offerTechPoints: z.number().int().min(0).optional(),
});

const warApprovalParamsSchema = z.object({
  targetId: z.string().min(1),
});

export async function executeApproved(
  ctx: ExecuteApprovedContext,
): Promise<void> {
  const { nation, approval } = ctx;

  if (approval.actionKey === "declare_war") {
    const parsed = warApprovalParamsSchema.safeParse(approval.params);
    if (!parsed.success) {
      logger.error(
        { approvalId: approval.id },
        "cabinet diplomat war approval params invalid",
      );
      return;
    }
    const target = await loadNpcTarget(parsed.data.targetId);
    if (!target) return;
    await declareWarOnNpc(nation, target);
    return;
  }

  // 條約（含大額讓步）批准後套用。
  const parsed = treatyApprovalParamsSchema.safeParse(approval.params);
  if (!parsed.success) {
    logger.error(
      { approvalId: approval.id },
      "cabinet diplomat treaty approval params invalid",
    );
    return;
  }
  const target = await loadNpcTarget(parsed.data.targetId);
  if (!target) return;
  const treatyType: TreatyType =
    isTreatyType(parsed.data.treatyType) && parsed.data.treatyType !== "custom"
      ? parsed.data.treatyType
      : "nonaggression";
  await proposeTreatyToNpc(nation, target, {
    treatyType,
    durationDays: parsed.data.durationDays ?? null,
    offerMoney: parsed.data.offerMoney ?? 0,
    offerTechPoints: parsed.data.offerTechPoints ?? 0,
  });
}

/** 載入仍為 NPC 的對象；已不存在或已非 NPC（例如被玩家接手）→ null，放棄執行。 */
async function loadNpcTarget(targetId: string): Promise<PlayerNation | null> {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, targetId))
    .limit(1);
  if (!row) return null;
  if (!row.isNpc) return null; // 只對 NPC 行動
  return row;
}

export const diplomacyModule: CabinetDomainModule = {
  domain: "diplomacy",
  actionKeys,
  runDomain,
  executeApproved,
};
