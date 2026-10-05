import {
  db,
  diplomacyRelationsTable,
  diplomacyWarsTable,
  mapCitiesTable,
  mapRegionAdjacenciesTable,
  mapRegionsTable,
  playerNationsTable,
  regionControlsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignParticipantsTable,
  warCampaignsTable,
  warRegionCooldownsTable,
  warRegionEngagementsTable,
  worldGameStateTable,
  cityWallsTable,
  type PlayerNation,
  type WallTier,
  type WarCampaign,
} from "@workspace/db";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  DEFAULT_CYCLE_HOURS,
  allocateProportionally,
  initialCityState,
  type LegionSlot,
} from "../war";
import {
  WALL_TIERS,
  isWallTier,
  maxNpcWallTierForEra,
  pickNpcWallTier,
  wallTierIndex,
} from "../wall";
import { generateTerrainBrief } from "../warAi";
import { buildRegionSetGeoCultureContext } from "../nationGeoCulture";
import { notifyCampaignStarted } from "../gameNotify";
import { ERAS, getEraIndex } from "../mapRegionEras";
import { classifyLanding, isSeaAdjacent } from "../navalLanding";
import { computeNationStats, getEraSlugs } from "../nationStats";
import {
  drawNpcTroopsInTx,
  ensureNpcUnitTemplates,
  loadNpcCombatTemplates,
  loadNpcMilitaryKeySlugs,
  type NpcDraw,
} from "../npcMilitary";
import { effectiveNpcTechEra } from "../npcTech";
import { logger } from "../logger";
import { canonicalPair } from "../diplomacy";
import { requireSuzerainConsent } from "../vassalConsent";
import { DEFAULT_GOVERNMENT_SLUG, governmentLabel } from "../governments";
import { REGION_CLAIM_LOCK_NS } from "../locks";
import { recordTerritoryChanges } from "../territoryHistory";
import {
  WarActionError,
  trackBackgroundWork,
  npcCampaignTroops,
  NPC_TROOP_MIN,
  NPC_TROOP_MAX,
  type Tx,
} from "./shared";
import { getNavalLandingProfile } from "./status";

// ── 發起戰役（玩家路由與 NPC 迴圈共用） ────────────────────────

/**
 * Task #250 — 攻打「無人領土」時即時建立 NPC 防守方並宣戰。
 *
 * 「無人領土」有二：完全無控制列的空地，或由「無主國家」
 * （is_npc=false 且未綁定 discord_user_id）掌控的地區。前者新建一個 NPC 國家
 * 並給予控制權；後者將該無主國家升格為 NPC（僅改 is_npc，不動 discord_user_id
 * 以免觸發子表 FK ON UPDATE 限制）。接著建立外交關係與戰爭。
 *
 * Task #502 — 同地區爭奪支援無人剩餘領土：`sameRegion=true` 時攻擊方本身在
 * 目標地區持有控制權，判定「無人剩餘」須先排除攻擊方自身持分；新建 NPC 只獲得
 * 該地區的剩餘比例（100 − 現有各國合計），不覆蓋、不稀釋既有持分（每區 Σ ≤ 100
 * 不變）。相鄰攻打無人領土的既有流程（sameRegion=false）行為完全不變——完全空地
 * 的剩餘比例即為 100。
 *
 * 全程在單一交易內以 `REGION_CLAIM_LOCK_NS` 對「目標地區」上鎖，與玩家建國、
 * AI 世界寫入序列化，避免同一空地被重複建國造成 Σ(percent) > 100。攻擊方必須是
 * 真實玩家，否則會產生永不結算的 NPC↔NPC 戰爭列（見記憶：npc-npc-inert-war）。
 */
async function foundOrPromoteUnownedDefender(params: {
  attacker: PlayerNation;
  /** 攻擊方出發地區 ID；若與 defenderRegionId 相同，判定無人剩餘時排除攻擊方自身持分。 */
  attackerRegionId: number;
  defenderRegionId: number;
  defenderRegionName: string;
  hasActiveWars: boolean;
  /**
   * Task #609 — 強制攻打空白（即使目標地區有其他持有者）。
   * 傳 true 時跳過「其他持有者 → 升格無主國家」分支，改為計算剩餘比例建立新 NPC；
   * 若剩餘 ≤ 0 則拋 400（該區已被各國完全佔滿）。
   */
  forceVoid?: boolean;
}): Promise<{ defender: PlayerNation; warId: number }> {
  const {
    attacker,
    attackerRegionId,
    defenderRegionId,
    defenderRegionName,
    hasActiveWars,
  } = params;

  // 僅真實玩家可觸發「攻打無人領土即時建國」。
  if (attacker.isNpc || !attacker.discordUserId) {
    throw new WarActionError(
      400,
      hasActiveWars
        ? `「${defenderRegionName}」不是交戰國控制的地區，無法作為目標`
        : "你目前沒有交戰中的國家，請先宣戰",
    );
  }

  return db.transaction(async (tx) => {
    // 目標地區認領鎖：與建國同一命名空間，序列化空地寫入。
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${REGION_CLAIM_LOCK_NS}, ${defenderRegionId})`,
    );
    // 鎖內重讀控制列，避免與其他建國／攻打競態。
    const controls = await tx
      .select()
      .from(regionControlsTable)
      .where(
        and(
          eq(regionControlsTable.regionId, defenderRegionId),
          gt(regionControlsTable.percent, 0),
        ),
      )
      .orderBy(desc(regionControlsTable.percent));

    // 同區攻擊時排除攻擊方自身持分再判定「無人剩餘」；
    // 相鄰攻打維持既有語意：任何控制列都算持有者。
    const otherControls = attackerRegionId === defenderRegionId
      ? controls.filter((c) => c.nationId !== attacker.id)
      : controls;

    let defender: PlayerNation;
    if (otherControls.length === 0 || params.forceVoid) {
      // 無其他持有者、或強制攻打空白 → 新建 NPC 國家，只授予剩餘比例
      // （100 − 現有各國合計；完全空地時即為 100）。鎖內重算，確保 Σ ≤ 100 不變。
      // Task #609：forceVoid=true 時即使有其他持有者（NPC/玩家/無主）也走此分支，
      // 目的是在「混合地區」搶奪空白部分，不干涉現有持分。
      const totalPercent = controls.reduce((s, c) => s + c.percent, 0);
      const remainder = 100 - totalPercent;
      if (remainder <= 0) {
        // 只可能發生在同區爭奪（攻擊方已 100% 掌控）、forceVoid 後各國合計已滿，
        // 或鎖內競態後。
        throw new WarActionError(
          400,
          otherControls.length === 0
            ? `你已完全掌控「${defenderRegionName}」，沒有可爭奪的剩餘領土`
            : `「${defenderRegionName}」已無可爭奪的空白領土（各國合計已達 100%）`,
        );
      }
      const [created] = await tx
        .insert(playerNationsTable)
        .values({
          name: `${defenderRegionName}王國`,
          government: governmentLabel(DEFAULT_GOVERNMENT_SLUG),
          isNpc: true,
        })
        .returning();
      if (!created) throw new WarActionError(500, "建立 NPC 防守方失敗");
      await tx.insert(regionControlsTable).values({
        regionId: defenderRegionId,
        nationId: created.id,
        percent: remainder,
      });
      // Task #392 — 同交易內記錄攻打無人領土時即時建立的 NPC 佔領。
      await recordTerritoryChanges(tx, [
        {
          nationId: created.id,
          regionId: defenderRegionId,
          percentBefore: 0,
          percentAfter: remainder,
          changeType: "war",
          reason: `攻打無人領土：即時建立 NPC「${created.name}」防守「${defenderRegionName}」（${remainder}% 掌控）`,
        },
      ]);
      defender = created;
    } else {
      const dominant = otherControls[0]!;
      const [nation] = await tx
        .select()
        .from(playerNationsTable)
        .where(eq(playerNationsTable.id, dominant.nationId))
        .limit(1);
      if (!nation) throw new WarActionError(404, "找不到防守方國家");
      if (nation.isNpc || nation.discordUserId) {
        // 已由 NPC 或真實玩家掌控 → 非無人領土，須先於外交介面宣戰。
        throw new WarActionError(
          400,
          `「${defenderRegionName}」已由其他國家掌控，請先於外交介面宣戰`,
        );
      }
      // 無主國家 → 升格為 NPC 應戰（僅改 is_npc）。
      const [promoted] = await tx
        .update(playerNationsTable)
        .set({ isNpc: true })
        .where(eq(playerNationsTable.id, nation.id))
        .returning();
      if (!promoted) throw new WarActionError(500, "升格 NPC 防守方失敗");
      defender = promoted;
    }

    // 建立外交關係（若無）＋宣戰（繞過關係值 < 0 限制）。
    const { low, high } = canonicalPair(attacker.id, defender.id);
    await tx
      .insert(diplomacyRelationsTable)
      .values({ nationAId: low, nationBId: high, score: 0 })
      .onConflictDoNothing();
    const [warRow] = await tx
      .insert(diplomacyWarsTable)
      .values({
        nationAId: low,
        nationBId: high,
        declaredByNationId: attacker.id,
      })
      .onConflictDoNothing()
      .returning({ id: diplomacyWarsTable.id });
    if (warRow) return { defender, warId: warRow.id };
    // 已存在進行中的戰爭（競態）→ 取回其 id。
    const [existing] = await tx
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
    if (!existing) throw new WarActionError(500, "建立戰爭狀態失敗");
    return { defender, warId: existing.id };
  });
}

/**
 * 防重複開戰:同一攻擊方、同一組(出發地→目標地)同時只能有一場進行中戰役。
 * 先用交易級 advisory lock 序列化(雙擊/並發請求會排隊),再查是否已有 active 戰役,
 * 有就丟 409。沒有這道檢查時,連點兩次「發動戰役」會建出兩場一模一樣的戰役(軍團重複出動)。
 * 不同攻擊方(多國混戰同一塊地)不受影響。必須在交易內、抽兵/建軍團之前呼叫。
 */
export async function assertNoDuplicateActiveCampaign(
  tx: Pick<typeof db, "execute" | "select">,
  p: {
    attackerNationId: string;
    attackerRegionId: number;
    defenderRegionId: number;
    attackerRegionName: string;
    defenderRegionName: string;
  },
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`campaign-init:${p.attackerNationId}:${p.attackerRegionId}:${p.defenderRegionId}`}))`,
  );
  const [dup] = await tx
    .select({ id: warCampaignsTable.id })
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.attackerNationId, p.attackerNationId),
        eq(warCampaignsTable.attackerRegionId, p.attackerRegionId),
        eq(warCampaignsTable.defenderRegionId, p.defenderRegionId),
        eq(warCampaignsTable.status, "active"),
      ),
    )
    .limit(1);
  if (dup) {
    throw new WarActionError(
      409,
      `你已經對「${p.defenderRegionName}」發動了一場進行中的戰役(從「${p.attackerRegionName}」出發),請先結束它再開新戰役`,
    );
  }
}

export async function initiateCampaign(params: {
  attackerNationId: string;
  attackerRegionId: number;
  defenderRegionId: number;
  /**
   * Task #353 — 多國混戰同區爭奪：目標地區同時有兩個以上交戰敵國佈控時，
   * 由玩家指定要爭奪的對象。未提供時沿用預設（比例最高的交戰敵國）。
   * Task #609 — 傳入 null 表示「明確要求攻打無人地帶（生成 NPC）」，跳過
   * 交戰敵國查找，直接進入 foundOrPromoteUnownedDefender（forceVoid=true）。
   */
  defenderNationId?: string | null;
  initiatedByNpc?: boolean;
}): Promise<WarCampaign> {
  const { attackerNationId, attackerRegionId, defenderRegionId } = params;
  const now = new Date();

  // Task #349 — 同區爭奪戰役：出發地＝目標地時，不再拒絕，而是視為在同一塊
  // 共享地區內對交戰敵國開戰（略過相鄰／海上登陸判定，要求雙方都在該地持有
  // >0%）。既有的「兩地區」戰役流程不受影響。
  const sameRegion = attackerRegionId === defenderRegionId;

  // Task #228 — 戰役週期長度改由管理員可調（world_game_state.war_cycle_hours）；
  // 讀取失敗或未設時退回程式預設 DEFAULT_CYCLE_HOURS。
  const [worldState] = await db
    .select({ warCycleHours: worldGameStateTable.warCycleHours })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  const cycleHours = worldState?.warCycleHours ?? DEFAULT_CYCLE_HOURS;

  const [attacker] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, attackerNationId))
    .limit(1);
  if (!attacker) throw new WarActionError(404, "找不到攻擊方國家");

  const regions = await db
    .select()
    .from(mapRegionsTable)
    .where(inArray(mapRegionsTable.id, [attackerRegionId, defenderRegionId]));
  const attackerRegion = regions.find((r) => r.id === attackerRegionId);
  const defenderRegion = regions.find((r) => r.id === defenderRegionId);
  if (!attackerRegion || !defenderRegion) {
    throw new WarActionError(404, "找不到指定的地區");
  }

  // Task #349 — 同區爭奪戰役略過相鄰／海上登陸判定（攻守在同一塊地區內）。
  let isSeaLanding = false;
  let landingAttackReductionPct: number | null = null;
  let seaLandingTroopCap: number | null = null;
  if (!sameRegion) {
    const [adjacency] = await db
      .select({ id: mapRegionAdjacenciesTable.id })
      .from(mapRegionAdjacenciesTable)
      .where(
        and(
          eq(mapRegionAdjacenciesTable.regionId, attackerRegionId),
          eq(mapRegionAdjacenciesTable.adjacentRegionId, defenderRegionId),
        ),
      )
      .limit(1);

    // Task #152 — 陸地不相鄰時判定海上登陸（近海需海戰、跨洋需指南針）。
    const landingKind = classifyLanding(
      !!adjacency,
      isSeaAdjacent(attackerRegion.name, defenderRegion.name),
    );
    if (landingKind !== "land") {
      const profile = await getNavalLandingProfile(attacker.discordUserId);
      if (!profile.naval) {
        throw new WarActionError(
          400,
          `「${attackerRegion.name}」與「${defenderRegion.name}」隔海相望，需先研發「海戰」才能發動海上登陸`,
        );
      }
      if (landingKind === "transOcean" && !profile.compass) {
        throw new WarActionError(
          400,
          `「${attackerRegion.name}」與「${defenderRegion.name}」相隔遠洋，需研發「指南針」才能跨洋登陸，否則請選擇近海相鄰的目標`,
        );
      }
      isSeaLanding = true;
      landingAttackReductionPct = profile.attackReductionPct;
      seaLandingTroopCap = profile.troopCapacity;
    }
  }

  const [attackerControl] = await db
    .select()
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, attackerRegionId),
        eq(regionControlsTable.nationId, attackerNationId),
        gt(regionControlsTable.percent, 0),
      ),
    )
    .limit(1);
  if (!attackerControl) {
    throw new WarActionError(400, "出發地區必須由你的國家控制");
  }

  // 交戰中的敵國（進行中的 diplomacy_wars）。
  const wars = await db
    .select()
    .from(diplomacyWarsTable)
    .where(
      and(
        isNull(diplomacyWarsTable.endedAt),
        or(
          eq(diplomacyWarsTable.nationAId, attackerNationId),
          eq(diplomacyWarsTable.nationBId, attackerNationId),
        ),
      ),
    );
  const warByEnemy = new Map<string, number>();
  for (const w of wars) {
    const enemyId =
      w.nationAId === attackerNationId ? w.nationBId : w.nationAId;
    warByEnemy.set(enemyId, w.id);
  }

  // 目標地區的控制者中，挑出交戰中的敵國。
  const targetControls = await db
    .select()
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, defenderRegionId),
        gt(regionControlsTable.percent, 0),
      ),
    )
    .orderBy(desc(regionControlsTable.percent));
  // Task #353 — 多國混戰：玩家可指定要爭奪的交戰敵國；未指定時取比例最高者。
  // Task #609 — defenderNationId === null 表示明確要求攻打無人地帶，跳過交戰敵國查找。
  const forceVoid = params.defenderNationId === null;
  let enemyControl: (typeof targetControls)[number] | undefined;
  if (!forceVoid && params.defenderNationId != null) {
    if (params.defenderNationId === attackerNationId) {
      throw new WarActionError(400, "無法對自己發起戰役");
    }
    const chosen = targetControls.find(
      (c) => c.nationId === params.defenderNationId,
    );
    if (!chosen) {
      throw new WarActionError(400, "指定的目標國家未在該地區持有控制權");
    }
    if (!warByEnemy.has(chosen.nationId)) {
      throw new WarActionError(
        400,
        "指定的目標國家並非與你交戰中，請先於外交介面宣戰",
      );
    }
    enemyControl = chosen;
  } else if (!forceVoid) {
    enemyControl = targetControls.find((c) => warByEnemy.has(c.nationId));
  }
  // forceVoid=true → enemyControl 保持 undefined，直接進入無人地帶路徑。

  let defender: PlayerNation;
  // 本次防守方是否為「攻打無人領土」就地建國/升格的空地 NPC(兵力採較低的動員比例)。
  let unclaimedDefender = false;
  if (enemyControl) {
    // 一般戰役：目標由交戰中的敵國控制。
    const [d] = await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, enemyControl.nationId))
      .limit(1);
    if (!d) throw new WarActionError(404, "找不到防守方國家");
    if (!d.isNpc && !d.discordUserId) {
      throw new WarActionError(400, "對方是無主國家、無法應戰，無法對其發起戰役");
    }
    defender = d;
  } else {
    // Task #609 — forceVoid=true 時跳過同區守門，直接以 forceVoid 呼叫
    // foundOrPromoteUnownedDefender，讓它在「有其他持有者但仍有剩餘比例」的
    // 情況下新建 NPC 持有剩餘空白。
    if (!forceVoid && attackerRegionId === defenderRegionId) {
      // 同區攻擊且無交戰敵國持有時，判斷該區是否有「無人剩餘」：
      // 合計 <100 的空地，或非攻擊方持有者為無主國家 → 沿用攻打無人領土的
      // 即時建國／升格 NPC 流程就地爭奪；其餘維持 400。
      const nonAttackerControls = targetControls.filter(
        (c) => c.nationId !== attackerNationId,
      );
      if (nonAttackerControls.length > 0) {
        // 有其他持有者：只有「無主國家」（非 NPC、無綁定玩家）可就地升格應戰。
        const holderIds = [...new Set(nonAttackerControls.map((c) => c.nationId))];
        const holders = await db
          .select({
            id: playerNationsTable.id,
            isNpc: playerNationsTable.isNpc,
            discordUserId: playerNationsTable.discordUserId,
          })
          .from(playerNationsTable)
          .where(inArray(playerNationsTable.id, holderIds));
        const dominantHolder = holders.find(
          (h) => h.id === nonAttackerControls[0]!.nationId,
        );
        if (
          !dominantHolder ||
          dominantHolder.isNpc ||
          dominantHolder.discordUserId
        ) {
          // 主要持有者是 NPC 或真實玩家但未與你交戰 → 維持既有行為。
          throw new WarActionError(
            400,
            "此地區沒有與你交戰中的敵國持有控制權，無法發起同區爭奪戰役",
          );
        }
      } else {
        const totalPercent = targetControls.reduce((s, c) => s + c.percent, 0);
        if (totalPercent >= 100) {
          // 玩家已 100% 掌控該地區：無剩餘、無其他持有者。
          throw new WarActionError(
            400,
            `你已完全掌控「${defenderRegion.name}」，沒有可爭奪的剩餘領土`,
          );
        }
      }
      // 有無人剩餘 → 往下走即時建國／升格 NPC 流程（含附庸宗主同意守門）。
    }
    // Task #250 — 目標不是交戰敵國控制：判斷是否為「無人領土」
    // （完全無主的空地，或由無主國家掌控），若是則即時建國成 NPC 應戰，
    // 並自動建立外交關係與戰爭（繞過關係值 < 0 的宣戰限制）。
    // 附庸外交受限：這條路徑會自動建立戰爭列，等同宣戰，附庸需先取得
    // 宗主同意（僅對真實玩家守門；NPC 攻擊方在下方本來就會被拒絕）。
    if (!attacker.isNpc && attacker.discordUserId) {
      // 目標＝該地區比例最高的「非攻擊方」控制國（無主國家）；完全空地 → null。
      const unownedHolderId =
        targetControls.find((c) => c.nationId !== attacker.id)?.nationId ??
        null;
      const consent = await requireSuzerainConsent({
        vassalNationId: attacker.id,
        vassalName: attacker.name,
        actionType: "declare_war",
        targetNationId: unownedHolderId,
        subjectName: defenderRegion.name,
      });
      if (!consent.ok) {
        throw new WarActionError(consent.status, consent.error);
      }
    }
    const result = await foundOrPromoteUnownedDefender({
      attacker,
      attackerRegionId,
      defenderRegionId,
      defenderRegionName: defenderRegion.name,
      hasActiveWars: wars.length > 0,
      forceVoid,
    });
    defender = result.defender;
    unclaimedDefender = true;
    warByEnemy.set(defender.id, result.warId);
  }

  // 地區冷卻檢查。
  const cooldowns = await db
    .select()
    .from(warRegionCooldownsTable)
    .where(
      and(
        inArray(warRegionCooldownsTable.regionId, [
          attackerRegionId,
          defenderRegionId,
        ]),
        gt(warRegionCooldownsTable.expiresAt, now),
      ),
    );
  if (cooldowns.length > 0) {
    const name =
      cooldowns[0]!.regionId === attackerRegionId
        ? attackerRegion.name
        : defenderRegion.name;
    throw new WarActionError(400, `「${name}」戰後冷卻中，暫時無法再發起戰役`);
  }

  // 城市防線快照（含各城城牆階級；未建列 = 木牆）。開戰即定格，戰役
  // 進行中城牆升級不影響本場（Task #150）。
  const cities = await db
    .select({
      id: mapCitiesTable.id,
      name: mapCitiesTable.name,
      regionId: mapCitiesTable.regionId,
      tier: cityWallsTable.tier,
    })
    .from(mapCitiesTable)
    .leftJoin(cityWallsTable, eq(cityWallsTable.cityId, mapCitiesTable.id))
    .where(
      inArray(mapCitiesTable.regionId, [attackerRegionId, defenderRegionId]),
    )
    .orderBy(asc(mapCitiesTable.id));
  // 時代與 NPC 國力（開戰快照、AI 城牆決策與兵力估算共用；交易外先算好）。
  const { statsEra, currentEra } = await getEraSlugs();
  const npcTroops = new Map<string, number>();
  const npcPopulation = new Map<string, number>();
  for (const side of [attacker, defender]) {
    if (!side.isNpc) continue;
    const stats = await computeNationStats(side.id, statsEra);
    npcPopulation.set(side.id, stats.population);
    // 防守方採本土動員比例（較高）；進攻方採基礎比例。空地 NPC 一律為防守方。
    let troops = npcCampaignTroops({
      population: stats.population,
      isDefender: side.id === defender.id,
      unclaimed: unclaimedDefender,
    });
    // 海上登陸戰役：攻擊方（含 NPC）兵力受容許量上限限制。
    if (isSeaLanding && side.id === attacker.id && seaLandingTroopCap !== null) {
      troops = Math.min(troops, seaLandingTroopCap);
    }
    npcTroops.set(side.id, troops);
  }

  // Task #549 — 預設兵種已全面移除：NPC 側開戰前必須有專屬兵種模板。
  // 沒有時就地請 AI 設計一次（ensureNpcUnitTemplates 失敗只記 log 不丟）；
  // 仍然沒有 → 409 延後開戰（NPC 排程與內閣/聊天行動路徑都會 catch
  // WarActionError 安全跳過），絕不建立空軍團戰役。
  for (const side of [attacker, defender]) {
    if (!side.isNpc) continue;
    const npcMilEra = effectiveNpcTechEra(side.techEraMilitary, currentEra);
    let templates = await loadNpcCombatTemplates(db, side.id, npcMilEra);
    if (templates.length === 0) {
      const keySlugs = await loadNpcMilitaryKeySlugs(db, side, currentEra);
      await ensureNpcUnitTemplates(side, npcMilEra, keySlugs);
      templates = await loadNpcCombatTemplates(db, side.id, npcMilEra);
    }
    if (templates.length === 0) {
      throw new WarActionError(
        409,
        `「${side.name ?? "NPC 國家"}」的兵種尚未設計完成，請稍後再試`,
      );
    }
  }

  // NPC 城牆由確定性純函式決定（Task #173 → 改 Task #616）：NPC 不研發科技、
  // 城牆永遠停在木牆守城形同虛設；改以時代上限 + 人口三段式選定城牆階級，
  // 不呼叫 AI。玩家側維持讀取 city_walls 既有值（未建列＝木牆）。
  // 快照定格後戰役進行中不再變動。
  const npcWallTierForSide = (
    side: typeof attacker,
    regionId: number,
  ): WallTier | null => {
    if (!side.isNpc) return null;
    const hasCities = cities.some((c) => c.regionId === regionId);
    if (!hasCities) return null;
    const cap = maxNpcWallTierForEra(currentEra);
    const allowed = WALL_TIERS.slice(0, wallTierIndex(cap) + 1);
    return pickNpcWallTier(npcPopulation.get(side.id) ?? 0, allowed);
  };
  // Task #349 — 同區爭奪：該地區的城市一律視為「防守方的守勢防線」，
  // 攻擊方在爭奪地區內沒有己方城牆可守。
  const attackerNpcWallTier = sameRegion
    ? null
    : npcWallTierForSide(attacker, attackerRegionId);
  const defenderNpcWallTier = npcWallTierForSide(defender, defenderRegionId);

  const toSnapshot = (regionId: number, npcTier: WallTier | null) =>
    cities
      .filter((c) => c.regionId === regionId)
      .map((c) => ({
        cityId: c.id,
        name: c.name,
        tier: npcTier ?? (isWallTier(c.tier) ? c.tier : ("wood" as const)),
      }));
  // Task #349 — 同區爭奪：城市全歸防守方，攻擊方無城市防線。
  const attackerCityState = sameRegion
    ? null
    : initialCityState(toSnapshot(attackerRegionId, attackerNpcWallTier));
  const defenderCityState = initialCityState(
    toSnapshot(defenderRegionId, defenderNpcWallTier),
  );

  const warId = warByEnemy.get(defender.id)!;

  const campaign = await db.transaction(async (tx) => {
      await assertNoDuplicateActiveCampaign(tx, {
        attackerNationId: attacker.id,
        attackerRegionId,
        defenderRegionId,
        attackerRegionName: attackerRegion.name,
        defenderRegionName: defenderRegion.name,
      });
      const npcDefends = defender.isNpc;
      const [row] = await tx
        .insert(warCampaignsTable)
        .values({
          warId,
          attackerNationId: attacker.id,
          defenderNationId: defender.id,
          attackerRegionId,
          defenderRegionId,
          status: "active",
          attackerCityState,
          defenderCityState:
            defenderCityState && npcDefends
              ? { ...defenderCityState, garrisoned: true }
              : defenderCityState,
          cycleHours,
          cycleNumber: 0,
          nextResolveAt: new Date(now.getTime() + cycleHours * 3_600_000),
          initiatedByNpc: params.initiatedByNpc ?? false,
          isSeaLanding,
          landingAttackReductionPct,
          seaLandingTroopCap,
        })
        .returning();
      if (!row) throw new Error("戰役建立失敗");

      // Task #453 — 種入攻守雙方主帥參戰列（多國參戰）。
      await tx.insert(warCampaignParticipantsTable).values([
        {
          campaignId: row.id,
          nationId: attacker.id,
          side: "attacker",
          isLead: true,
          joinWarId: warId,
        },
        {
          campaignId: row.id,
          nationId: defender.id,
          side: "defender",
          isLead: true,
          joinWarId: warId,
        },
      ]);

      // 地區交戰鎖：複合主鍵 (campaign_id, region_id)，同場戰役＋同地區才衝突。
      // 不同戰役可同時佔用同一地區（多對多開放）。同區爭奪只鎖單一地區。
      const engagementRegionIds = sameRegion
        ? [attackerRegionId]
        : [attackerRegionId, defenderRegionId];
      await tx.insert(warRegionEngagementsTable).values(
        engagementRegionIds.map((regionId) => ({
          regionId,
          campaignId: row.id,
        })),
      );

      // NPC 側自動組建軍團（Task #389 — 先從常備軍抽調，防守方不足時民兵補足）。
      for (const side of [attacker, defender]) {
        if (!side.isNpc) continue;
        const target = npcTroops.get(side.id) ?? NPC_TROOP_MIN;
        const isDefenderSide = side.id === defender.id;
        // NPC 軍事時代以 current_era 夾取（解鎖語義），與每回合兵種模板設計
        // （runNpcMilitaryTurn）同基準；用 statsEra 會在管理員把 stats_era 與
        // current_era 拆開時查不到專屬模板。
        const npcMilEra = effectiveNpcTechEra(side.techEraMilitary, currentEra);
        const draws = await drawNpcTroopsInTx(tx, side.id, target);
        const drawnTotal = draws.reduce((s, d) => s + d.drawn, 0);
        // 防守方保底：常備軍不足時以本土民兵補足到目標兵力（民兵戰後解散，
        // 不歸還常備軍）。進攻方原則上只用常備軍；完全無常備軍時（例如剛
        // 生成的 NPC）fallback 到舊制民兵，避免出現空軍團戰役。
        let militiaTroops = 0;
        if (isDefenderSide) {
          militiaTroops = Math.max(0, target - drawnTotal);
        } else if (drawnTotal === 0) {
          militiaTroops = target;
          logger.warn(
            { nationId: side.id, campaignId: row.id },
            "NPC attacker has no standing army; falling back to militia",
          );
        }
        await buildNpcLegionsInTx(tx, {
          campaignId: row.id,
          nationId: side.id,
          eraSlug: npcMilEra,
          draws,
          militiaTroops,
          garrisonCity:
            side.id === defender.id && defenderCityState !== null,
        });
      }
      return row;
  });

  // 通知防守方（玩家）。
  if (defender.discordUserId) {
    notifyCampaignStarted({
      discordUserId: defender.discordUserId,
      opponentName: attacker.name ?? "未知國家",
      regionName: defenderRegion.name,
      campaignId: campaign.id,
    });
  }

  // 地形簡報：開戰後背景生成一次（失敗不影響戰役，戰情室顯示生成中）。
  // 以 trackBackgroundWork 追蹤，測試可在 pool.end() 前等待完成（避免關閉後
  // 才落地的寫入噴出 "Cannot use a pool after calling end" 汙染日誌）。
  trackBackgroundWork(
    (async () => {
      try {
        const currentEra = (await getEraSlugs()).currentEra;
        // Task #369 — 戰場地區地理人文脈絡：讓地形敘述在地化（失敗回空字串不阻塞）。
        const geoContext = await buildRegionSetGeoCultureContext(
          sameRegion
            ? [attackerRegionId]
            : [attackerRegionId, defenderRegionId],
        );
        const brief = await generateTerrainBrief({
          eraLabel: ERAS[getEraIndex(currentEra)]!.label,
          attackerRegion: {
            name: attackerRegion.name,
            macroRegion: attackerRegion.macroRegion,
            cities: attackerCityState?.cities.map((c) => c.name) ?? [],
          },
          defenderRegion: {
            name: defenderRegion.name,
            macroRegion: defenderRegion.macroRegion,
            cities: defenderCityState?.cities.map((c) => c.name) ?? [],
          },
          geoContext,
        });
        await db
          .update(warCampaignsTable)
          .set({ terrainBrief: brief })
          .where(eq(warCampaignsTable.id, campaign.id));
      } catch (err) {
        logger.error(
          { err, campaignId: campaign.id },
          "terrain brief generation failed",
        );
      }
    })(),
  );

  return campaign;
}

async function buildNpcLegionsInTx(
  tx: Tx,
  params: {
    campaignId: number;
    nationId: string;
    eraSlug: string;
    /** 從常備軍抽調的兵種與數量（npc_drawn 快照、戰後結算歸還）。 */
    draws: readonly NpcDraw[];
    /** 民兵補足量（防守方保底／無常備軍 fallback；戰後解散不歸還）。 */
    militiaTroops: number;
    garrisonCity: boolean;
  },
): Promise<void> {
  // 每兵種的總量與抽調量：先放入常備軍抽調，民兵再補上。
  const pool = new Map<
    number,
    { templateId: number; total: number; drawn: number }
  >();
  for (const d of params.draws) {
    pool.set(d.template.id, {
      templateId: d.template.id,
      total: d.drawn,
      drawn: d.drawn,
    });
  }

  if (params.militiaTroops > 0) {
    // 民兵優先沿用抽調到的兵種組成；完全沒有常備軍時用該國專屬模板
    // （開戰前守門已保證存在，Task #549 起無預設兵種可退）。
    const weightByCategory: Record<string, number> = {
      infantry: 45,
      ranged: 25,
      armor: 20,
      artillery: 7,
      ship: 3,
    };
    const militiaTemplates =
      params.draws.length > 0
        ? params.draws.map((d) => d.template)
        : (
            await loadNpcCombatTemplates(tx, params.nationId, params.eraSlug)
          )
            .sort(
              (a, b) =>
                (weightByCategory[b.category] ?? 5) -
                (weightByCategory[a.category] ?? 5),
            )
            .slice(0, 5);
    if (militiaTemplates.length > 0) {
      const shares = allocateProportionally(
        militiaTemplates.map((t) => weightByCategory[t.category] ?? 5),
        params.militiaTroops,
      );
      militiaTemplates.forEach((t, i) => {
        const qty = shares[i] ?? 0;
        if (qty <= 0) return;
        const entry = pool.get(t.id) ?? {
          templateId: t.id,
          total: 0,
          drawn: 0,
        };
        entry.total += qty;
        pool.set(t.id, entry);
      });
    }
  }

  const units = [...pool.values()].filter((u) => u.total > 0);
  if (units.length === 0) return;

  const legionShares: { slot: LegionSlot; ratio: number; garrison: boolean }[] =
    [
      { slot: "A", ratio: 0.6, garrison: params.garrisonCity },
      { slot: "B", ratio: 0.4, garrison: false },
    ];
  // 每兵種先算 A/B 分割（quantity 與 npcDrawn 皆守恆、drawn ≤ quantity）。
  const splitByTemplate = units.map((u) => {
    const qtyA = Math.floor(u.total * 0.6);
    const qtyB = u.total - qtyA;
    let drawnA = Math.min(qtyA, Math.round(u.drawn * 0.6));
    let drawnB = u.drawn - drawnA;
    if (drawnB > qtyB) {
      drawnA += drawnB - qtyB;
      drawnB = qtyB;
    }
    return {
      templateId: u.templateId,
      A: { quantity: qtyA, drawn: drawnA },
      B: { quantity: qtyB, drawn: drawnB },
    };
  });

  for (const legionDef of legionShares) {
    const unitRows = splitByTemplate
      .map((u) => {
        const part = legionDef.slot === "A" ? u.A : u.B;
        return {
          templateId: u.templateId,
          quantity: part.quantity,
          wounded: 0,
          npcDrawn: part.drawn,
        };
      })
      .filter((u) => u.quantity > 0)
      .slice(0, 5);
    if (unitRows.length === 0) continue;
    const [legion] = await tx
      .insert(warCampaignLegionsTable)
      .values({
        campaignId: params.campaignId,
        nationId: params.nationId,
        slot: legionDef.slot,
        morale: 80,
        supply: 100,
        garrisoningCity: legionDef.garrison,
      })
      .returning();
    if (!legion) continue;
    await tx
      .insert(warCampaignLegionUnitsTable)
      .values(unitRows.map((u) => ({ ...u, legionId: legion.id })));
  }
}
