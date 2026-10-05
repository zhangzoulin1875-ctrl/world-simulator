import { CIVIL_WAR_NO_CEASEFIRE_MESSAGE, notCivilWar } from "./civilWar";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  diplomacyWarsTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  diplomacyTreatiesTable,
  regionControlsTable,
  mapRegionAdjacenciesTable,
  warRegionEngagementsTable,
  warRegionCooldownsTable,
  type PlayerNation,
} from "@workspace/db";
import type { ChatActionType, PlannedChatAction } from "./npcChatActions";
import {
  canonicalPair,
  clampRelationScore,
  RELATION_ACTIONS,
} from "./diplomacy";
import { declareWarByNpc, insertNpcTreatyProposal } from "./treatyPropose";
import {
  initiateCampaign,
  endCampaignsForWar,
  WarActionError,
} from "./warEngine";
import { resolveNpcToNpcTreaty, resolveNpcAlliance } from "./npcInitiative";
import { buildNationGeoCultureContext } from "./nationGeoCulture";
import {
  getNationAllianceIds,
  createAlliance,
  inviteToAlliance,
  defaultAllianceName,
} from "./alliances";
import {
  notifyTreatyProposal,
  notifyRelationAction,
  notifyAllianceInvited,
} from "./diplomacyNotify";
import { notifyCeasefireAccepted } from "./gameNotify";
import { ensurePoliticalNote } from "./politicalNote";
import { recordFinanceLedger } from "./financeLedger";
import { logger } from "./logger";

/**
 * Task #256 — 執行層：把 sanitizeChatActions 產出的可執行計畫真正落地。
 *
 * 每個動作各自 try/catch、互不影響；回傳每個動作的成敗與 zh-TW 說明，供
 * 呼叫端附加在 NPC 回覆末尾（並回傳給前端顯示行動晶片）。所有硬性條件
 * （關係值、阻擋條約、冷卻、餘額、地區掌控…）都由這裡呼叫的既有寫入層
 * 再次把關；本層只負責串接與轉譯結果，不放行任何未經檢查的副作用。
 *
 * 執行順序（固定）：停戰 → 送禮 → 締約 → 交換 → 結盟 → 宣戰 → 出兵。
 * 先做降溫／善意動作、再做締約結盟、最後才是升級衝突，避免同一則訊息內
 * 「剛送禮又馬上宣戰」這種順序造成的怪異中間狀態。
 */

export interface ExecutedChatAction {
  type: ChatActionType;
  targetId: string;
  targetName: string | null;
  ok: boolean;
  detail: string;
  /**
   * Task #341 — 若動作產生了一筆條約提案（附條件停戰／締約／土地資源交換），
   * 帶回提案 id 與提案對象國家 id，供前端把行動晶片變成「可點擊 → 跳到締約分頁並高亮」。
   * 其他動作為 null。
   */
  proposalId: number | null;
  proposalNationId: string | null;
}

const EXEC_ORDER: Record<ChatActionType, number> = {
  ceasefire: 0,
  gift: 1,
  propose_treaty: 2,
  exchange: 3,
  alliance: 4,
  declare_war: 5,
  initiate_campaign: 6,
};

export async function executeNpcChatActions(params: {
  actorId: string;
  counterpartId: string;
  planned: readonly PlannedChatAction[];
  adminDirective?: string | null;
}): Promise<ExecutedChatAction[]> {
  const { actorId, counterpartId, planned, adminDirective = null } = params;
  if (planned.length === 0) return [];

  const [actor] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, actorId))
    .limit(1);
  if (!actor) return [];

  const targetIds = [...new Set(planned.map((p) => p.targetId))];
  const targetRows = await db
    .select()
    .from(playerNationsTable)
    .where(inArray(playerNationsTable.id, targetIds));
  const targetById = new Map(targetRows.map((r) => [r.id, r]));

  const ordered = [...planned].sort(
    (a, b) => EXEC_ORDER[a.type] - EXEC_ORDER[b.type],
  );

  const results: ExecutedChatAction[] = [];
  for (const action of ordered) {
    const target = targetById.get(action.targetId);
    const targetName = target?.name ?? null;
    if (!target) {
      results.push({
        type: action.type,
        targetId: action.targetId,
        targetName,
        ok: false,
        detail: "找不到目標國家",
        proposalId: null,
        proposalNationId: null,
      });
      continue;
    }
    try {
      const detail = await runOne(action, {
        actor,
        target,
        counterpartId,
        adminDirective,
      });
      results.push({
        type: detail.type,
        targetId: action.targetId,
        targetName,
        ok: detail.ok,
        detail: detail.detail,
        proposalId: detail.proposalId ?? null,
        proposalNationId: detail.proposalNationId ?? null,
      });
    } catch (err) {
      logger.error(
        { err, type: action.type, actorId, targetId: action.targetId },
        "npc chat action execution failed",
      );
      results.push({
        type: action.type,
        targetId: action.targetId,
        targetName,
        ok: false,
        detail: "執行時發生錯誤，已略過此動作",
        proposalId: null,
        proposalNationId: null,
      });
    }
  }
  return results;
}

interface RunCtx {
  actor: PlayerNation;
  target: PlayerNation;
  counterpartId: string;
  adminDirective: string | null;
}

type RunOutcome = {
  type: ChatActionType;
  ok: boolean;
  detail: string;
  proposalId?: number | null;
  proposalNationId?: string | null;
};

async function runOne(
  action: PlannedChatAction,
  ctx: RunCtx,
): Promise<RunOutcome> {
  switch (action.type) {
    case "ceasefire":
      return execCeasefire(action, ctx);
    case "gift":
      return execGift(action, ctx);
    case "propose_treaty":
      return execProposeTreaty(action, ctx);
    case "exchange":
      return execExchange(action, ctx);
    case "alliance":
      return execAlliance(action, ctx);
    case "declare_war":
      return execDeclareWar(action, ctx);
    case "initiate_campaign":
      return execInitiateCampaign(action, ctx);
  }
}

// ── 停戰 ───────────────────────────────────────────────────────

async function execCeasefire(
  action: PlannedChatAction,
  ctx: RunCtx,
): Promise<RunOutcome> {
  const type = action.type;
  const { low, high } = canonicalPair(ctx.actor.id, ctx.target.id);
  const [war] = await db
    .select()
    .from(diplomacyWarsTable)
    .where(
      and(
        eq(diplomacyWarsTable.nationAId, low),
        eq(diplomacyWarsTable.nationBId, high),
        isNull(diplomacyWarsTable.endedAt),
      ),
    )
    .limit(1);
  if (!war) return { type, ok: false, detail: "目前並未與該國交戰" };
  if (war.isCivilWar) return { type, ok: false, detail: CIVIL_WAR_NO_CEASEFIRE_MESSAGE };

  // Task #341 — 附條件停戰：NPC 向「正在對話的玩家」索求金錢／科技／領土作為停戰條件，
  // 以一筆綁定本場戰爭（boundWarId）的條約提案落地；玩家接受後 activateTreaty 會轉移
  // 資源並結束該場戰爭。
  // Task #414 — 索求一律放 request* 側（Task #374 雙向語意：offer=提案方付、
  // request=對象付，custom 一次性不受 proposerIsPayer 影響）。舊寫法把索求放
  // offer* ＋ proposerIsPayer=false，在 custom 例外下會變成「NPC 付給玩家」，
  // 方向整條反掉（前端顯示與實際轉移皆錯）。
  const hasDemand =
    action.demandMoney > 0 ||
    action.demandTechPoints > 0 ||
    action.demandRegions.length > 0;
  if (hasDemand && ctx.target.id === ctx.counterpartId) {
    const percents: Record<string, number> = {};
    for (const r of action.demandRegions) percents[String(r.regionId)] = r.percent;
    const clauseParts: string[] = [];
    if (action.demandMoney > 0) clauseParts.push(`金錢 ${action.demandMoney}`);
    if (action.demandTechPoints > 0)
      clauseParts.push(`科技點數 ${action.demandTechPoints}`);
    if (action.demandRegions.length > 0)
      clauseParts.push(`割讓 ${action.demandRegions.length} 區領土`);
    const clause =
      clauseParts.length > 0
        ? `附條件停戰：貴國需交付 ${clauseParts.join("、")}，接受後本場戰爭立即結束。`
        : "附條件停戰：接受後本場戰爭立即結束。";
    const treaty = await insertNpcTreatyProposal({
      proposerNationId: ctx.actor.id,
      targetNationId: ctx.target.id,
      type: "custom",
      durationDays: null,
      requestMoney: action.demandMoney,
      requestTechPoints: action.demandTechPoints,
      requestRegionIds: action.demandRegions.map((r) => r.regionId),
      requestRegionPercents: percents,
      customClause: clause,
      proposerIsPayer: true,
      boundWarId: war.id,
    });
    if (!treaty) {
      return { type, ok: false, detail: "雙方已有待回覆的條約提案" };
    }
    notifyTreatyProposal({
      targetDiscordUserId: ctx.target.discordUserId,
      proposerNationName: ctx.actor.name,
      treatyType: "custom",
    });
    return {
      type,
      ok: true,
      detail: "已提出附條件停戰提案，等待對方接受",
      proposalId: treaty.id,
      proposalNationId: ctx.actor.id,
    };
  }

  if (war.ceasefireProposedBy === ctx.target.id) {
    const ended = await db
      .update(diplomacyWarsTable)
      .set({ endedAt: new Date(), ceasefireProposedBy: null })
      .where(
        and(eq(diplomacyWarsTable.id, war.id), isNull(diplomacyWarsTable.endedAt), notCivilWar()),
      )
      .returning({ id: diplomacyWarsTable.id });
    if (ended.length === 0) {
      return { type, ok: false, detail: "戰爭狀態已變更，請重新整理" };
    }
    // 與玩家端 ceasefire/accept 一致：結束戰爭後必須一併收束其進行中的戰役，
    // 否則 settleDueCampaigns 只看 status='active'，會在戰爭結束後仍持續結算
    // （繼續造成傷亡／領土轉移／厭戰），且 war_region_engagements 列被鎖死。
    try {
      await endCampaignsForWar(war.id, "ceasefire");
    } catch (err) {
      logger.error(
        { err, warId: war.id },
        "npc chat ceasefire: end campaigns failed",
      );
    }
    // 通知提議停戰的一方（對話中的玩家）其停戰已被接受。
    if (ctx.target.discordUserId) {
      notifyCeasefireAccepted({
        discordUserId: ctx.target.discordUserId,
        opponentName: ctx.actor.name ?? "未知國家",
      });
    }
    return { type, ok: true, detail: "已接受對方的停戰提議，戰爭結束" };
  }

  if (war.ceasefireProposedBy === ctx.actor.id) {
    return { type, ok: false, detail: "已向該國提議停戰，等待對方回覆" };
  }

  const proposed = await db
    .update(diplomacyWarsTable)
    .set({ ceasefireProposedBy: ctx.actor.id })
    .where(
      and(
        eq(diplomacyWarsTable.id, war.id),
        isNull(diplomacyWarsTable.endedAt),
        isNull(diplomacyWarsTable.ceasefireProposedBy),
      ),
    )
    .returning({ id: diplomacyWarsTable.id });
  return proposed.length > 0
    ? { type, ok: true, detail: "已向該國提議停戰，等待對方回覆" }
    : { type, ok: false, detail: "停戰狀態已變更，請重新整理" };
}

// ── 送禮（僅限對話中的玩家） ────────────────────────────────────

async function execGift(
  action: PlannedChatAction,
  ctx: RunCtx,
): Promise<RunOutcome> {
  const type = action.type;
  const money = Math.max(0, Math.trunc(action.offerMoney));
  const tech = Math.max(0, Math.trunc(action.offerTechPoints));
  if (money <= 0 && tech <= 0) {
    return { type, ok: false, detail: "沒有可致贈的資源" };
  }

  const { low, high } = canonicalPair(ctx.actor.id, ctx.target.id);
  const giftDelta = RELATION_ACTIONS.gift.delta;

  const applied = await db.transaction(async (tx) => {
    const deducted = await tx
      .update(playerNationsTable)
      .set({
        money: sql`${playerNationsTable.money} - ${money}`,
        techPoints: sql`${playerNationsTable.techPoints} - ${tech}`,
      })
      .where(
        and(
          eq(playerNationsTable.id, ctx.actor.id),
          sql`${playerNationsTable.money} >= ${money}`,
          sql`${playerNationsTable.techPoints} >= ${tech}`,
        ),
      )
      .returning({ id: playerNationsTable.id });
    if (deducted.length === 0) return false;

    await tx
      .update(playerNationsTable)
      .set({
        money: sql`${playerNationsTable.money} + ${money}`,
        techPoints: sql`${playerNationsTable.techPoints} + ${tech}`,
      })
      .where(eq(playerNationsTable.id, ctx.target.id));

    if (money > 0) {
      await recordFinanceLedger(tx, {
        nationId: ctx.actor.id,
        category: "gift",
        amount: -money,
        description: "對話中致贈金錢予對方",
      });
      await recordFinanceLedger(tx, {
        nationId: ctx.target.id,
        category: "gift",
        amount: money,
        description: "對話中收到對方致贈金錢",
      });
    }

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
    const newScore = clampRelationScore((rel?.score ?? 0) + giftDelta);
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
      actorNationId: ctx.actor.id,
      targetNationId: ctx.target.id,
      action: "gift",
    });
    return true;
  });

  if (!applied) return { type, ok: false, detail: "資源不足，無法送禮" };

  notifyRelationAction({
    targetDiscordUserId: ctx.target.discordUserId,
    actorNationId: ctx.actor.id,
    actorNationName: ctx.actor.name,
    action: "gift",
  });

  const parts: string[] = [];
  if (money > 0) parts.push(`金錢 ${money}`);
  if (tech > 0) parts.push(`科技點數 ${tech}`);
  return {
    type,
    ok: true,
    detail: `已致贈${parts.join("、")}，兩國關係提升`,
  };
}

// ── 締約 ───────────────────────────────────────────────────────

async function execProposeTreaty(
  action: PlannedChatAction,
  ctx: RunCtx,
): Promise<RunOutcome> {
  const type = action.type;
  const treatyType = action.treatyType ?? "nonaggression";
  const treaty = await insertNpcTreatyProposal({
    proposerNationId: ctx.actor.id,
    targetNationId: ctx.target.id,
    type: treatyType,
    durationDays: action.durationDays,
  });
  if (!treaty) {
    return { type, ok: false, detail: "雙方已有待回覆的條約提案" };
  }

  if (ctx.target.isNpc) {
    const targetNote = await ensurePoliticalNote(ctx.target, { allowNpc: true });
    const { low, high } = canonicalPair(ctx.actor.id, ctx.target.id);
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
    await resolveNpcToNpcTreaty(treaty.id, {
      npcName: ctx.target.name ?? "NPC",
      proposerName: ctx.actor.name ?? "NPC",
      treatyType,
      durationDays: action.durationDays,
      relationScore: rel?.score ?? 0,
      atWar: false,
      politicalNote: targetNote,
      diplomaticAttitude: ctx.target.diplomaticAttitude,
      adminDirective: ctx.adminDirective,
      // Task #369 — 提案國（actor）所在地區的地理人文脈絡，僅影響回覆用語。
      counterpartGeoContext: await buildNationGeoCultureContext(ctx.actor.id),
    });
    const [after] = await db
      .select({ status: diplomacyTreatiesTable.status })
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.id, treaty.id))
      .limit(1);
    const outcome =
      after?.status === "active"
        ? "對方接受了"
        : after?.status === "rejected"
          ? "對方婉拒了"
          : "已提出，對方將回覆";
    return {
      type,
      ok: true,
      detail: `已提出條約提案，${outcome}`,
      proposalId: treaty.id,
      proposalNationId: ctx.actor.id,
    };
  }

  notifyTreatyProposal({
    targetDiscordUserId: ctx.target.discordUserId,
    proposerNationName: ctx.actor.name,
    treatyType,
  });
  return {
    type,
    ok: true,
    detail: "已提出條約提案，等待對方回覆",
    proposalId: treaty.id,
    proposalNationId: ctx.actor.id,
  };
}

// ── 土地／資源交換（僅限對話中的玩家；以 custom 條約提案落地） ──────

async function execExchange(
  action: PlannedChatAction,
  ctx: RunCtx,
): Promise<RunOutcome> {
  const type = action.type;
  const treaty = await insertNpcTreatyProposal({
    proposerNationId: ctx.actor.id,
    targetNationId: ctx.target.id,
    type: "custom",
    durationDays: action.durationDays,
    offerMoney: Math.max(0, Math.trunc(action.offerMoney)),
    offerTechPoints: Math.max(0, Math.trunc(action.offerTechPoints)),
    offerRegionIds: action.offerRegionIds,
    customClause: action.clause,
  });
  if (!treaty) {
    return { type, ok: false, detail: "雙方已有待回覆的條約提案" };
  }
  notifyTreatyProposal({
    targetDiscordUserId: ctx.target.discordUserId,
    proposerNationName: ctx.actor.name,
    treatyType: "custom",
  });
  return {
    type,
    ok: true,
    detail: "已提出土地／資源交換提案，等待對方接受",
    proposalId: treaty.id,
    proposalNationId: ctx.actor.id,
  };
}

// ── 結盟 ───────────────────────────────────────────────────────

async function execAlliance(
  action: PlannedChatAction,
  ctx: RunCtx,
): Promise<RunOutcome> {
  const type = action.type;

  if (ctx.target.isNpc) {
    const formed = await resolveNpcAlliance(
      ctx.actor.id,
      ctx.target.id,
      ctx.actor.name,
    );
    return formed
      ? { type, ok: true, detail: "已與該 NPC 結為聯盟" }
      : { type, ok: false, detail: "雙方已各有聯盟，無法自動結盟" };
  }

  // 對真人玩家：確保 NPC 自己有聯盟（沒有就先建立），再送出邀請。
  let allianceId = (await getNationAllianceIds(ctx.actor.id))[0] ?? null;
  if (!allianceId) {
    const created = await createAlliance(
      ctx.actor.id,
      defaultAllianceName(ctx.actor.name),
    );
    if (created.ok) {
      allianceId = created.alliance.id;
    } else {
      allianceId = (await getNationAllianceIds(ctx.actor.id))[0] ?? null;
    }
  }
  if (!allianceId) {
    return { type, ok: false, detail: "無法建立聯盟，稍後再試" };
  }

  const invite = await inviteToAlliance(allianceId, ctx.actor.id, ctx.target.id);
  if (invite.ok) {
    notifyAllianceInvited({
      targetDiscordUserId: ctx.target.discordUserId,
      allianceName: invite.allianceName,
    });
    return { type, ok: true, detail: "已邀請對方加入聯盟，等待對方回覆" };
  }
  const reason =
    invite.code === "already_member"
      ? "對方已是本聯盟成員"
      : invite.code === "duplicate"
        ? "已送出過聯盟邀請，等待對方回覆"
        : "目前無法邀請對方加入聯盟";
  return { type, ok: false, detail: reason };
}

// ── 宣戰（僅限真人玩家） ────────────────────────────────────────

async function execDeclareWar(
  action: PlannedChatAction,
  ctx: RunCtx,
): Promise<RunOutcome> {
  const type = action.type;
  // 防禦性再確認：宣戰只能對真人玩家。NPC↔NPC 戰爭列永遠不會被戰爭引擎結算，
  // 會永久凍結該對的外交；declareWarByNpc 本身不驗證目標身分，故在此把關。
  if (ctx.target.isNpc || !ctx.target.discordUserId) {
    return { type, ok: false, detail: "只能對真人玩家宣戰" };
  }
  const result = await declareWarByNpc({
    declarerNationId: ctx.actor.id,
    declarerName: ctx.actor.name,
    target: {
      id: ctx.target.id,
      name: ctx.target.name,
      discordUserId: ctx.target.discordUserId,
    },
  });
  if (result.declared) {
    return { type, ok: true, detail: "已對該國宣戰" };
  }
  const reason =
    result.reason === "already_at_war"
      ? "雙方已在交戰中"
      : result.reason === "relation_non_negative"
        ? "關係尚未惡化到可宣戰"
        : result.reason === "blocking_treaty"
          ? "受既有條約約束，無法宣戰"
          : result.reason === "same_alliance"
            ? "雙方屬同一聯盟，無法宣戰"
            : result.reason === "recent_war_cooldown"
              ? "距上次停戰未滿冷卻期，暫不宣戰"
              : "目前無法宣戰";
  return { type, ok: false, detail: reason };
}

// ── 出兵發動戰役（僅限真人玩家；需已交戰） ──────────────────────

async function execInitiateCampaign(
  action: PlannedChatAction,
  ctx: RunCtx,
): Promise<RunOutcome> {
  const type = action.type;
  // 防禦性再確認：出兵發動戰役只能針對真人玩家（見 execDeclareWar 說明）。
  if (ctx.target.isNpc || !ctx.target.discordUserId) {
    return { type, ok: false, detail: "只能對真人玩家發動戰役" };
  }

  const npcRegions = await db
    .select({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.nationId, ctx.actor.id),
        gt(regionControlsTable.percent, 0),
      ),
    );
  const enemyRegions = await db
    .select({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.nationId, ctx.target.id),
        gt(regionControlsTable.percent, 0),
      ),
    );
  if (npcRegions.length === 0 || enemyRegions.length === 0) {
    return { type, ok: false, detail: "缺乏可用於進攻的相鄰地區" };
  }

  const now = new Date();
  const engaged = await db
    .select({ regionId: warRegionEngagementsTable.regionId })
    .from(warRegionEngagementsTable);
  const cooling = await db
    .select({ regionId: warRegionCooldownsTable.regionId })
    .from(warRegionCooldownsTable)
    .where(gt(warRegionCooldownsTable.expiresAt, now));
  const blocked = new Set<number>([
    ...engaged.map((r) => r.regionId),
    ...cooling.map((r) => r.regionId),
  ]);

  const adjacencies = await db
    .select()
    .from(mapRegionAdjacenciesTable)
    .where(
      and(
        inArray(
          mapRegionAdjacenciesTable.regionId,
          npcRegions.map((r) => r.regionId),
        ),
        inArray(
          mapRegionAdjacenciesTable.adjacentRegionId,
          enemyRegions.map((r) => r.regionId),
        ),
      ),
    );
  const pick = adjacencies.find(
    (a) => !blocked.has(a.regionId) && !blocked.has(a.adjacentRegionId),
  );
  if (!pick) {
    return { type, ok: false, detail: "找不到可進攻的相鄰地區" };
  }

  try {
    const campaign = await initiateCampaign({
      attackerNationId: ctx.actor.id,
      attackerRegionId: pick.regionId,
      defenderRegionId: pick.adjacentRegionId,
      initiatedByNpc: true,
    });
    return {
      type,
      ok: true,
      detail: `已發動戰役（戰役 #${campaign.id}）`,
    };
  } catch (err) {
    if (err instanceof WarActionError) {
      return { type, ok: false, detail: err.message };
    }
    throw err;
  }
}
