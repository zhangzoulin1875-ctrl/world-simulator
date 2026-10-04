import {
  db,
  diplomacyWarsTable,
  mapRegionEraStatsTable,
  mapRegionsTable,
  militaryUnitTemplatesTable,
  militaryWeaponsTable,
  playerNationsTable,
  regionControlsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignOrdersTable,
  warCampaignsTable,
  worldGameStateTable,
  type PlayerNation,
  type WarCampaign,
  type WarCityState,
} from "@workspace/db";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  MAX_AI_FAIL_COUNT,
  RESOLVE_RETRY_MINUTES,
  allocateProportionally,
  clampTerritoryCaptureBasePct,
  clampWarIntensityPct,
  computeLocalPopulationLossPct,
  type LegionSlot,
  type WarOrderType,
  WAR_ORDER_TYPES,
  type StalemateInput,
} from "../war";
import { MAP_REGION_AREAS_KM2 } from "../mapRegionAreas.generated";
import {
  WALL_TIER_LABELS,
  cityLineHoldoutPct,
  durabilityPct,
} from "../wall";
import {
  NPC_FALLBACK_ORDERS,
  EMPTY_UNIT_ANALYSIS,
  analyzeWarUnits,
  generateNpcOrders,
  resolveWarCycleAi,
  type WarCycleAiInput,
  type WarCycleAiResult,
  type WarCycleLegionInput,
  type WarCycleSideInput,
  type WarUnitAnalysis,
} from "../warAi";
import { buildRegionSetGeoCultureContext } from "../nationGeoCulture";
import { notifyCampaignReport, notifyWarOrderBacklash } from "../gameNotify";
import { ERAS, getEraIndex } from "../mapRegionEras";
import { getEraSlugs } from "../nationStats";
import { getAiJudgmentDirective } from "../aiDirective";
import { warWearinessAttackModifier } from "../politics";
import { getPoliticsSettings } from "../politicsSettings";
import { logger } from "../logger";
import { pgErrorCode } from "../playerValidation";
import { getRecoveryBonuses, type LoadedLegion, type Tx } from "./shared";
import { weaponCombatMods, type WeaponSkillEffect } from "../weapons";
import { loadParticipants, pruneStaleJoiners } from "./participants";
import { endCampaignById, endCampaignInTx, notifyEndForBoth } from "./endCampaign";
import { applyCycleResult } from "./applyCycleResult";
import { invalidateGlobalAveragePopulationCache } from "../researchCost";
import {
  applyWarOrderPenalties,
  getGameBalanceSettings,
  recordAiAbuse,
  WAR_ORDER_FLAG_LABELS,
  type WarOrderBacklash,
  type WarOrderFlag,
} from "../gameBalance";

// ── 結算 ───────────────────────────────────────────────────────

/** 同步佔鎖：同一戰役同時只有一個結算流程。 */
const settling = new Set<number>();

export interface SettleResult {
  settled: boolean;
  ended: boolean;
  message?: string;
}

export interface SettleOptions {
  /**
   * 到期重驗：settleCampaignInner 重新載入戰役後，若 next_resolve_at 尚未到期
   * 則跳過結算。到期迴圈（分鐘迴圈／AI 判定）的到期清單只是快照 —— 清單取出
   * 到實際結算之間，同一戰役可能已被另一個迴圈、另一個程序（部署多實例）或
   * 管理員手動結算過（cycle_number 已 +1、next_resolve_at 已推進），沒有這個
   * 重驗就會對「新週期」立刻再結算一次，造成一次結算兩次。
   * 管理員「立即判定」為刻意強制結算，不帶此選項。
   */
  requireDue?: boolean;
}

export async function settleDueCampaigns(now = new Date()): Promise<void> {
  const due = await db
    .select({ id: warCampaignsTable.id })
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.status, "active"),
        lte(warCampaignsTable.nextResolveAt, now),
      ),
    )
    .orderBy(asc(warCampaignsTable.nextResolveAt));
  for (const row of due) {
    try {
      await settleCampaign(row.id, { requireDue: true });
    } catch (err) {
      logger.error({ err, campaignId: row.id }, "war campaign settle failed");
    }
  }
}

/**
 * 強制結算「目前所有進行中的戰役」，不受 nextResolveAt 到期時間限制。
 * 供管理員「立即判定」使用；回傳成功結算的戰役數（含當下結束者）。
 */
export async function settleAllActiveCampaigns(): Promise<{
  settledCount: number;
}> {
  const active = await db
    .select({ id: warCampaignsTable.id })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.status, "active"))
    .orderBy(asc(warCampaignsTable.nextResolveAt));
  let settledCount = 0;
  for (const row of active) {
    try {
      const result = await settleCampaign(row.id);
      if (result.settled) settledCount += 1;
    } catch (err) {
      logger.error({ err, campaignId: row.id }, "war campaign settle failed");
    }
  }
  return { settledCount };
}

/**
 * 把「所有進行中戰役」的結算週期統一改為 cycleHours，並依新頻率重算 next_resolve_at
 * （= now + 新週期），讓「AI 世界模擬」頁調整後的節奏即時套用到既有戰役。
 * 回傳受影響（active）的戰役數。
 */
export async function applyGlobalWarCycleHours(
  cycleHours: number,
  now = new Date(),
  executor: typeof db | Tx = db,
): Promise<number> {
  const updated = await executor
    .update(warCampaignsTable)
    .set({
      cycleHours,
      nextResolveAt: new Date(now.getTime() + cycleHours * 3_600_000),
    })
    .where(eq(warCampaignsTable.status, "active"))
    .returning({ id: warCampaignsTable.id });
  return updated.length;
}

export async function settleCampaign(
  campaignId: number,
  options: SettleOptions = {},
): Promise<SettleResult> {
  if (settling.has(campaignId)) {
    return { settled: false, ended: false, message: "該戰役正在結算中" };
  }
  settling.add(campaignId);
  try {
    return await settleCampaignInner(campaignId, options);
  } finally {
    settling.delete(campaignId);
  }
}

async function loadLegions(campaignId: number): Promise<Map<string, LoadedLegion[]>> {
  const rows = await db
    .select({
      legionId: warCampaignLegionsTable.id,
      nationId: warCampaignLegionsTable.nationId,
      slot: warCampaignLegionsTable.slot,
      morale: warCampaignLegionsTable.morale,
      supply: warCampaignLegionsTable.supply,
      garrisoningCity: warCampaignLegionsTable.garrisoningCity,
      unitRowId: warCampaignLegionUnitsTable.id,
      templateId: warCampaignLegionUnitsTable.templateId,
      quantity: warCampaignLegionUnitsTable.quantity,
      wounded: warCampaignLegionUnitsTable.wounded,
      templateName: militaryUnitTemplatesTable.name,
      templateCategory: militaryUnitTemplatesTable.category,
      templateAttack: militaryUnitTemplatesTable.attack,
      templateDefense: militaryUnitTemplatesTable.defense,
      templateHp: militaryUnitTemplatesTable.hp,
      templateSpeed: militaryUnitTemplatesTable.speed,
      templateAccuracy: militaryUnitTemplatesTable.accuracy,
      templateRange: militaryUnitTemplatesTable.range,
      templateAntiCavalryPct: militaryUnitTemplatesTable.antiCavalryPct,
      templateAntiRangedPct: militaryUnitTemplatesTable.antiRangedPct,
      templateSiegePct: militaryUnitTemplatesTable.siegePct,
      templateEraSlug: militaryUnitTemplatesTable.eraSlug,
      equippedWeaponId: militaryUnitTemplatesTable.equippedWeaponId,
      weaponName: militaryWeaponsTable.name,
      weaponCompatibleCategories: militaryWeaponsTable.compatibleCategories,
      weaponAttackPct: militaryWeaponsTable.attackPct,
      weaponDefensePct: militaryWeaponsTable.defensePct,
      weaponSkillName: militaryWeaponsTable.skillName,
      weaponSkillEffect: militaryWeaponsTable.skillEffect,
      weaponSkillBonusPct: militaryWeaponsTable.skillBonusPct,
    })
    .from(warCampaignLegionsTable)
    .leftJoin(
      warCampaignLegionUnitsTable,
      eq(warCampaignLegionUnitsTable.legionId, warCampaignLegionsTable.id),
    )
    .leftJoin(
      militaryUnitTemplatesTable,
      eq(militaryUnitTemplatesTable.id, warCampaignLegionUnitsTable.templateId),
    )
    .leftJoin(
      militaryWeaponsTable,
      eq(militaryWeaponsTable.id, militaryUnitTemplatesTable.equippedWeaponId),
    )
    .where(eq(warCampaignLegionsTable.campaignId, campaignId))
    .orderBy(asc(warCampaignLegionsTable.slot));

  const byNation = new Map<string, LoadedLegion[]>();
  const legionIndex = new Map<number, LoadedLegion>();
  for (const row of rows) {
    let legion = legionIndex.get(row.legionId);
    if (!legion) {
      legion = {
        id: row.legionId,
        nationId: row.nationId,
        slot: row.slot as LegionSlot,
        morale: row.morale,
        supply: row.supply,
        garrisoningCity: row.garrisoningCity,
        units: [],
      };
      legionIndex.set(row.legionId, legion);
      const list = byNation.get(row.nationId) ?? [];
      list.push(legion);
      byNation.set(row.nationId, list);
    }
    if (row.unitRowId !== null && row.templateId !== null) {
      legion.units.push({
        unitRowId: row.unitRowId,
        templateId: row.templateId,
        name: row.templateName ?? "未知兵種",
        category: row.templateCategory ?? "infantry",
        quantity: row.quantity ?? 0,
        wounded: row.wounded ?? 0,
        attack: row.templateAttack ?? 0,
        defense: row.templateDefense ?? 0,
        hp: row.templateHp ?? 0,
        speed: row.templateSpeed ?? 0,
        accuracy: row.templateAccuracy ?? 0,
        range: row.templateRange ?? "melee",
        antiCavalryPct: row.templateAntiCavalryPct ?? 0,
        antiRangedPct: row.templateAntiRangedPct ?? 0,
        siegePct: row.templateSiegePct ?? 0,
        eraSlug: row.templateEraSlug ?? undefined,
        ...(row.weaponName
          ? (() => {
              const compatible = (row.weaponCompatibleCategories ?? []).includes(
                row.templateCategory ?? "",
              );
              const mods = weaponCombatMods({
                equipped: true,
                compatible,
                attackPct: row.weaponAttackPct ?? 0,
                defensePct: row.weaponDefensePct ?? 0,
                skillEffect: (row.weaponSkillEffect ?? "versatile") as WeaponSkillEffect,
                skillBonusPct: row.weaponSkillBonusPct ?? 0,
              });
              return {
                weaponName: row.weaponName,
                weaponSkillName: row.weaponSkillName ?? undefined,
                weaponCompatible: compatible,
                weaponOffenseMult: mods.offenseMult,
                weaponDefenseMult: mods.defenseMult,
              };
            })()
          : {}),
      });
    }
  }
  return byNation;
}

function toAiLegions(
  legions: LoadedLegion[],
  nationNameOf?: (nationId: string) => string,
): WarCycleLegionInput[] {
  return legions.map((l) => ({
    slot: l.slot,
    ...(nationNameOf ? { nationName: nationNameOf(l.nationId) } : {}),
    morale: l.morale,
    supply: l.supply,
    garrisoningCity: l.garrisoningCity,
    units: l.units.map((u) => ({
      name: u.name,
      category: u.category,
      quantity: u.quantity,
      wounded: u.wounded,
      attack: u.attack,
      defense: u.defense,
      hp: u.hp,
      speed: u.speed,
      accuracy: u.accuracy,
      range: u.range,
      antiCavalryPct: u.antiCavalryPct,
      antiRangedPct: u.antiRangedPct,
      siegePct: u.siegePct,
      eraSlug: u.eraSlug,
      ...(u.weaponName
        ? {
            weaponName: u.weaponName,
            weaponSkillName: u.weaponSkillName,
            weaponCompatible: u.weaponCompatible,
          }
        : {}),
    })),
  }));
}

/**
 * AI 失敗達上限時的確定性「僵持」結算。
 *
 * 此路徑完全不依賴 AI 輸出：aggressionPct 固定低值使雙方傷亡自然壓低，
 * 士氣／補給由 applyCycleResult 依 `stalemate:true` 旗標套用固定常數
 * （STALEMATE_MORALE_DELTA / STALEMATE_SUPPLY_DELTA），不再假裝是 AI 給值。
 */
function stalemateResult(
  hasAttackerCity: boolean,
  hasDefenderCity: boolean,
): StalemateInput {
  const text =
    "（自動結算）本週期戰況陷入僵持：雙方隔線對峙、零星交火，均未取得實質進展。前線傳回的損失輕微，但補給與士氣持續消耗，參謀部建議儘快調整部署與指令。";
  return {
    stalemate: true,
    // 僵持＝保守蓄力：低作戰積極度，傷亡由伺服器依戰力對比自然壓低。
    aggressionPct: 20,
    warWearinessDelta: 1,
    attackerSiegeIntensityPct: hasDefenderCity ? 0 : null,
    defenderSiegeIntensityPct: hasAttackerCity ? 0 : null,
    attackerReport: text,
    defenderReport: text,
    localPopulationLossPct: 0,
    orderFlags: [],
  };
}

/**
 * 結算後三項安全閘（防卡死）。在 applyCycleResult 完成後、通知前呼叫。
 * 1. 母戰爭已結束（停戰/結束）→ ceasefire 終止。
 * 2. 任一方在戰役兩地區的持分均為 0 → territory 終止。
 * 3. NPC 在當地健全兵力（quantity，不含 wounded）< 10 →
 *    移轉 NPC 全部當地領土給玩家並以 annihilation 終止。
 * 回傳已終止的 WarCampaign；未觸發時回傳 null。
 */
async function postSettleEndCheck(
  campaignId: number,
  warId: number,
  attacker: PlayerNation,
  defender: PlayerNation,
  attackerRegionId: number,
  defenderRegionId: number,
  now: Date,
): Promise<WarCampaign | null> {
  // 判定 1：母戰爭已結束
  const [freshWar] = await db
    .select({ endedAt: diplomacyWarsTable.endedAt })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, warId))
    .limit(1);
  if (!freshWar || freshWar.endedAt) {
    return endCampaignById(campaignId, { reason: "ceasefire", winnerNationId: null, now });
  }

  // 判定 2：任一方在兩地區持分均為 0
  const regionIds = [...new Set([attackerRegionId, defenderRegionId])];
  const freshControls = await db
    .select()
    .from(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, regionIds));
  const freshPct = (rId: number, nId: string): number =>
    freshControls.find((c) => c.regionId === rId && c.nationId === nId)?.percent ?? 0;
  const sameRegion = attackerRegionId === defenderRegionId;
  const atkLostAll = sameRegion
    ? freshPct(defenderRegionId, attacker.id) === 0
    : freshPct(attackerRegionId, attacker.id) === 0 &&
      freshPct(defenderRegionId, attacker.id) === 0;
  const defLostAll = sameRegion
    ? freshPct(defenderRegionId, defender.id) === 0
    : freshPct(attackerRegionId, defender.id) === 0 &&
      freshPct(defenderRegionId, defender.id) === 0;
  if (atkLostAll || defLostAll) {
    const winnerNationId = defLostAll ? attacker.id : defender.id;
    return endCampaignById(campaignId, { reason: "territory", winnerNationId, now });
  }

  // 判定 3：NPC 在當地健全兵力 < 10 → 移轉領土並結束
  const npcSide =
    defender.isNpc && !attacker.isNpc
      ? "defender"
      : attacker.isNpc && !defender.isNpc
        ? "attacker"
        : null;
  if (!npcSide) return null;
  const npcNation = npcSide === "defender" ? defender : attacker;
  const playerNation = npcSide === "defender" ? attacker : defender;

  const npcTroopRows = await db
    .select({ quantity: warCampaignLegionUnitsTable.quantity })
    .from(warCampaignLegionUnitsTable)
    .innerJoin(
      warCampaignLegionsTable,
      eq(warCampaignLegionsTable.id, warCampaignLegionUnitsTable.legionId),
    )
    .where(
      and(
        eq(warCampaignLegionsTable.campaignId, campaignId),
        eq(warCampaignLegionsTable.nationId, npcNation.id),
      ),
    );
  const npcHealthy = npcTroopRows.reduce((s, r) => s + (r.quantity ?? 0), 0);
  if (npcHealthy >= 10) return null;

  // NPC 兵力不足 10：移轉當地全部 NPC 領土給玩家，以 annihilation 結束。
  return db.transaction(async (tx) => {
    const npcCtrl = await tx
      .select()
      .from(regionControlsTable)
      .where(
        and(
          eq(regionControlsTable.nationId, npcNation.id),
          inArray(regionControlsTable.regionId, regionIds),
        ),
      );
    for (const ctrl of npcCtrl) {
      if (ctrl.percent <= 0) continue;
      await tx
        .insert(regionControlsTable)
        .values({ regionId: ctrl.regionId, nationId: playerNation.id, percent: ctrl.percent })
        .onConflictDoUpdate({
          target: [regionControlsTable.regionId, regionControlsTable.nationId],
          set: {
            percent: sql`LEAST(100, ${regionControlsTable.percent} + EXCLUDED.percent)`,
          },
        });
      await tx
        .delete(regionControlsTable)
        .where(
          and(
            eq(regionControlsTable.regionId, ctrl.regionId),
            eq(regionControlsTable.nationId, npcNation.id),
          ),
        );
    }
    return endCampaignInTx(tx, campaignId, {
      reason: "annihilation",
      winnerNationId: playerNation.id,
      now,
    });
  });
}

async function settleCampaignInner(
  campaignId: number,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const now = new Date();
  const [campaign] = await db
    .select()
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaignId))
    .limit(1);
  if (!campaign) {
    return { settled: false, ended: false, message: "找不到戰役" };
  }
  if (campaign.status !== "active") {
    return { settled: false, ended: false, message: "戰役已結束" };
  }
  // 到期重驗（見 SettleOptions.requireDue）：到期清單快照取出後、輪到本戰役前，
  // 它可能已被其他流程結算過（next_resolve_at 已推進到未來）。此處以「最新」
  // 資料重驗，避免對新週期立刻重複結算。與 applyCycleResult 的 cycle_number
  // 樂觀鎖互補：載到舊週期 → 樂觀鎖擋；載到新週期 → 這裡擋。
  if (options.requireDue && campaign.nextResolveAt.getTime() > now.getTime()) {
    logger.info(
      { campaignId, nextResolveAt: campaign.nextResolveAt },
      "campaign no longer due, skipping settlement (already settled elsewhere)",
    );
    return {
      settled: false,
      ended: false,
      message: "戰役尚未到期（可能已由其他流程結算），跳過",
    };
  }

  const [war] = await db
    .select()
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, campaign.warId))
    .limit(1);

  const [attacker] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, campaign.attackerNationId))
    .limit(1);
  const [defender] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, campaign.defenderNationId))
    .limit(1);

  const regions = await db
    .select()
    .from(mapRegionsTable)
    .where(
      inArray(mapRegionsTable.id, [
        campaign.attackerRegionId,
        campaign.defenderRegionId,
      ]),
    );
  const attackerRegion = regions.find((r) => r.id === campaign.attackerRegionId);
  const defenderRegion = regions.find((r) => r.id === campaign.defenderRegionId);
  const targetRegionName = defenderRegion?.name ?? "未知地區";

  // 戰爭已結束（停戰）或一方國家消失 → 戰役直接終止。
  if (!war || war.endedAt || !attacker || !defender) {
    const reason = !war || war.endedAt ? "ceasefire" : "nation_removed";
    const ended = await endCampaignById(campaignId, {
      reason,
      winnerNationId: null,
      now,
    });
    if (ended) {
      notifyEndForBoth({
        campaign: ended,
        attacker: attacker ?? null,
        defender: defender ?? null,
        regionName: targetRegionName,
        reason,
        winnerNationId: null,
      });
    }
    return { settled: false, ended: true, message: "戰爭已結束，戰役終止" };
  }

  // Task #453 — 結算前先清理「參戰依據戰爭已結束」的晚加入者（軍團返還）。
  try {
    await pruneStaleJoiners(campaignId);
  } catch (err) {
    logger.error({ err, campaignId }, "prune stale campaign joiners failed");
  }

  // Task #453 — 參戰國（每邊可能多國；主帥列在建立/回填時已種入）。
  const participants = await loadParticipants(campaignId);
  const participantNationIds = [
    ...new Set([
      attacker.id,
      defender.id,
      ...participants.map((p) => p.nationId),
    ]),
  ];
  const participantNationRows = await db
    .select()
    .from(playerNationsTable)
    .where(inArray(playerNationsTable.id, participantNationIds));
  const nationById = new Map(participantNationRows.map((n) => [n.id, n]));
  const sideNations = (side: "attacker" | "defender"): PlayerNation[] => {
    const leadId = side === "attacker" ? attacker.id : defender.id;
    const ids = participants
      .filter((p) => p.side === side)
      .map((p) => p.nationId);
    const ordered = [leadId, ...ids.filter((id) => id !== leadId)];
    return ordered
      .map((id) => nationById.get(id))
      .filter((n): n is PlayerNation => n !== undefined);
  };
  const attackerNations = sideNations("attacker");
  const defenderNations = sideNations("defender");
  const multiNation = attackerNations.length > 1 || defenderNations.length > 1;
  const nationNameOf = (nationId: string): string =>
    nationById.get(nationId)?.name ?? "未知國家";

  const legionsByNation = await loadLegions(campaignId);
  // 該邊全部參戰國的軍團加總（主帥在前）。
  const attackerLegions = attackerNations.flatMap(
    (n) => legionsByNation.get(n.id) ?? [],
  );
  const defenderLegions = defenderNations.flatMap(
    (n) => legionsByNation.get(n.id) ?? [],
  );

  // 本週期指令；NPC 側沒有指令時自動生成（bulk AI，失敗用罐頭）。
  const orders = await db
    .select()
    .from(warCampaignOrdersTable)
    .where(
      and(
        eq(warCampaignOrdersTable.campaignId, campaignId),
        eq(warCampaignOrdersTable.cycleNumber, campaign.cycleNumber),
      ),
    );

  const { currentEra, statsEra } = await getEraSlugs();
  const eraLabel = ERAS[getEraIndex(currentEra)]!.label;
  // Task #233 — 讀取管理員干預指令，注入 NPC 戰役指令 AI。
  const adminDirective = await getAiJudgmentDirective();

  const sideInput = (
    nation: PlayerNation,
    legions: LoadedLegion[],
    cityState: WarCityState | null,
    landingReductionPct = 0,
    sideAllNations?: PlayerNation[],
  ): WarCycleSideInput => ({
    nationName:
      sideAllNations && sideAllNations.length > 1
        ? `${nation.name ?? "未知國家"} 聯軍（${sideAllNations.map((n) => n.name ?? "未知國家").join("、")}）`
        : (nation.name ?? "未知國家"),
    isNpc: nation.isNpc,
    warWeariness: nation.warWeariness,
    attackModifierPct:
      Math.round((warWearinessAttackModifier(nation.warWeariness) - 1) * 100) -
      landingReductionPct,
    seaLandingReductionPct: landingReductionPct > 0 ? landingReductionPct : null,
    cityState: cityState
      ? {
          cities: cityState.cities.map((c) => ({
            name: c.name,
            wallTierLabel: WALL_TIER_LABELS[c.wallTier],
            durabilityPct: durabilityPct(c),
          })),
          holdoutPct: cityLineHoldoutPct(cityState) ?? 0,
          garrisoned: cityState.garrisoned,
        }
      : null,
    legions: toAiLegions(legions, multiNation ? nationNameOf : undefined),
    orders: orders
      .filter((o) =>
        sideAllNations
          ? sideAllNations.some((n) => n.id === o.nationId)
          : o.nationId === nation.id,
      )
      .map((o) => ({ orderType: o.orderType as WarOrderType, body: o.body })),
  });

  // Task #369／#371 — 戰場地區地理人文脈絡：讓雙方戰報敘事與 NPC 指令敘述在地化
  // （失敗回空字串不阻塞結算）。同區戰役時兩個 ID 相同，取唯一值避免重複查詢。
  const geoContext = await buildRegionSetGeoCultureContext(
    [...new Set([campaign.attackerRegionId, campaign.defenderRegionId])],
  );

  // Task #613 — 階段一：兵種分析（fail-open，失敗記 log 繼續，不阻塞結算）。
  let unitAnalysis: WarUnitAnalysis = EMPTY_UNIT_ANALYSIS;
  try {
    unitAnalysis = await analyzeWarUnits({
      eraLabel,
      currentEraSlug: currentEra,
      attackerUnits: attackerLegions.flatMap((l) =>
        l.units.map((u) => ({
          name: u.name,
          category: u.category,
          quantity: u.quantity,
          wounded: u.wounded,
          attack: u.attack,
          defense: u.defense,
          hp: u.hp,
          speed: u.speed,
          accuracy: u.accuracy,
          range: u.range,
          antiCavalryPct: u.antiCavalryPct,
          antiRangedPct: u.antiRangedPct,
          siegePct: u.siegePct,
          eraSlug: u.eraSlug,
        })),
      ),
      defenderUnits: defenderLegions.flatMap((l) =>
        l.units.map((u) => ({
          name: u.name,
          category: u.category,
          quantity: u.quantity,
          wounded: u.wounded,
          attack: u.attack,
          defense: u.defense,
          hp: u.hp,
          speed: u.speed,
          accuracy: u.accuracy,
          range: u.range,
          antiCavalryPct: u.antiCavalryPct,
          antiRangedPct: u.antiRangedPct,
          siegePct: u.siegePct,
          eraSlug: u.eraSlug,
        })),
      ),
    });
  } catch (err) {
    logger.warn({ err, campaignId }, "phase 1 unit analysis failed (continuing)");
  }

  // Task #613 — 階段二：NPC 指令生成（已有指令時跳過）。
  // Task #625 — NPC 士氣加成（moraleBonus）用於確定性領土/人口計算。
  let attackerMoraleBonus = 0;
  let defenderMoraleBonus = 0;
  for (const side of [
    { nation: attacker, legions: attackerLegions, isDefender: false, cityState: campaign.attackerCityState },
    { nation: defender, legions: defenderLegions, isDefender: true, cityState: campaign.defenderCityState },
  ]) {
    if (!side.nation.isNpc) continue;
    if (orders.some((o) => o.nationId === side.nation.id)) continue;
    let npcOrders = NPC_FALLBACK_ORDERS;
    try {
      const opponentLegions = side.isDefender ? attackerLegions : defenderLegions;
      const ownTroops = side.legions
        .flatMap((l) => l.units)
        .reduce((s, u) => s + u.quantity, 0);
      const opponentTroops = opponentLegions
        .flatMap((l) => l.units)
        .reduce((s, u) => s + u.quantity, 0);
      const powerRatio = ownTroops / Math.max(1, opponentTroops);
      npcOrders = await generateNpcOrders({
        eraLabel,
        isDefenderSide: side.isDefender,
        ownSide: sideInput(side.nation, side.legions, side.cityState),
        powerRatio,
        adminDirective,
      });
    } catch (err) {
      logger.warn({ err, campaignId }, "NPC order generation failed, using fallback");
    }
    // Task #625 — 捕捉士氣加成（攻守各自的 NPC 指令對士氣的預期影響）。
    if (side.isDefender) {
      defenderMoraleBonus = npcOrders.moraleBonus;
    } else {
      attackerMoraleBonus = npcOrders.moraleBonus;
    }
    for (const orderType of WAR_ORDER_TYPES) {
      try {
        const inserted = await db
          .insert(warCampaignOrdersTable)
          .values({
            campaignId,
            nationId: side.nation.id,
            cycleNumber: campaign.cycleNumber,
            orderType,
            body: npcOrders.command,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted[0]) orders.push(inserted[0]);
      } catch (err) {
        // Task #448 — 結算途中戰役被收尾（停戰 endCampaignsForWar／cascade 刪除）
        // 會讓 war_campaign_orders 的 campaign FK 違反（23503）。視為戰役已收尾
        // 安全跳過，不再讓結算迴圈對同一戰役反覆噴 ERROR。
        if (pgErrorCode(err) === "23503") {
          logger.info(
            { campaignId },
            "campaign ended mid-settle, skipping settlement",
          );
          return {
            settled: false,
            ended: true,
            message: "戰役已收尾，跳過結算",
          };
        }
        throw err;
      }
    }
  }

  // 地區控制（AI 輸入用快照；套用時交易內再讀一次 FOR UPDATE）。
  const controls = await db
    .select()
    .from(regionControlsTable)
    .where(
      inArray(regionControlsTable.regionId, [
        campaign.attackerRegionId,
        campaign.defenderRegionId,
      ]),
    );
  const pctOf = (regionId: number, nationId: string) =>
    controls.find((c) => c.regionId === regionId && c.nationId === nationId)
      ?.percent ?? 0;

  const aiInput: WarCycleAiInput = {
    eraLabel,
    cycleNumber: campaign.cycleNumber,
    cycleHours: campaign.cycleHours,
    terrainBrief: campaign.terrainBrief,
    geoContext,
    attackerRegion: {
      regionName: attackerRegion?.name ?? "未知地區",
      attackerPct: pctOf(campaign.attackerRegionId, attacker.id),
      defenderPct: pctOf(campaign.attackerRegionId, defender.id),
    },
    defenderRegion: {
      regionName: defenderRegion?.name ?? "未知地區",
      attackerPct: pctOf(campaign.defenderRegionId, attacker.id),
      defenderPct: pctOf(campaign.defenderRegionId, defender.id),
    },
    attacker: sideInput(
      attacker,
      attackerLegions,
      campaign.attackerCityState,
      campaign.isSeaLanding ? (campaign.landingAttackReductionPct ?? 0) : 0,
      attackerNations,
    ),
    defender: sideInput(
      defender,
      defenderLegions,
      campaign.defenderCityState,
      0,
      defenderNations,
    ),
  };

  let result: WarCycleAiResult | StalemateInput;
  if (campaign.failCount >= MAX_AI_FAIL_COUNT) {
    result = stalemateResult(
      campaign.attackerCityState !== null,
      campaign.defenderCityState !== null,
    );
  } else {
    try {
      result = await resolveWarCycleAi(aiInput, unitAnalysis);
    } catch (err) {
      logger.error({ err, campaignId }, "war cycle AI resolution failed");
      await db
        .update(warCampaignsTable)
        .set({
          failCount: campaign.failCount + 1,
          nextResolveAt: new Date(
            Date.now() + RESOLVE_RETRY_MINUTES * 60_000,
          ),
        })
        .where(
          and(
            eq(warCampaignsTable.id, campaignId),
            eq(warCampaignsTable.status, "active"),
            eq(warCampaignsTable.cycleNumber, campaign.cycleNumber),
          ),
        );
      return {
        settled: false,
        ended: false,
        message: "AI 結算失敗，已排定稍後重試",
      };
    }
  }

  // Task #451 — 濫用指令懲罰：AI 只回報旗標，伺服器在既有 clamp 界內確定性
  // 打折被標旗一方的積極度（exploit 再夾掉其有利領土移轉）並記錄稽核。
  // Task #547 — 反噬：另計算被標旗方的額外傷亡／領土反噬／國家數值懲罰
  // （管理員可調，預設 0；exploit 加倍），交由 applyCycleResult 在交易內套用。
  // 本次結算共用一份平衡設定快照（反噬懲罰與厭戰度上升倍率共用）。
  const balance = await getGameBalanceSettings();
  const orderFlags: WarOrderFlag[] = result.orderFlags ?? [];
  let orderBacklash: Partial<
    Record<"attacker" | "defender", WarOrderBacklash>
  > = {};
  let penalizedSidesForNotify: ("attacker" | "defender")[] = [];
  if (orderFlags.length > 0 && 'attacker' in result) {
    try {
      const { penalizedSides, backlash } = applyWarOrderPenalties(
        result,
        orderFlags,
        balance,
      );
      orderBacklash = backlash;
      penalizedSidesForNotify = penalizedSides;
      for (const side of penalizedSides) {
        const nation = side === "attacker" ? attacker : defender;
        const sideFlags = orderFlags.filter((f) => f.side === side);
        const sideOrders = orders
          .filter((o) => o.nationId === nation.id)
          .map((o) => `【${o.orderType}】${o.body}`)
          .join("\n");
        const bl = backlash[side];
        await recordAiAbuse({
          domain: "war_order",
          verdict: "penalized",
          discordUserId: nation.discordUserId,
          nationId: nation.id,
          nationName: nation.name,
          inputText: sideOrders || "（無指令原文）",
          reason: sideFlags.map((f) => `[${f.kind}] ${f.reason}`).join("；"),
          context: {
            campaignId,
            cycleNumber: campaign.cycleNumber,
            side,
            // Task #547 — 實際套用的反噬懲罰明細（確定性設定值；額外傷亡
            // 實際量另受戰力硬上限與剩餘兵力封頂）。
            ...(bl
              ? {
                  penalty: {
                    extraCasualtyPct: bl.extraCasualtyPct,
                    territoryBacklashPct: Math.min(
                      15,
                      balance.war.backlashTerritoryPct * (bl.exploit ? 2 : 1),
                    ),
                    stabilityDrop: bl.stabilityDrop,
                    unrestRise: bl.unrestRise,
                    warWearinessRise: bl.warWearinessRise,
                    exploit: bl.exploit,
                  },
                }
              : {}),
          },
        });
      }
      if (penalizedSides.length > 0) {
        logger.info(
          { campaignId, penalizedSides, flags: orderFlags, backlash },
          "war order abuse penalties applied",
        );
      }
    } catch (err) {
      logger.error({ err, campaignId }, "war order penalty step failed");
    }
  }

  // 傷亡地區人口損失（statsEra 的地區人口 × 雙方控制比例加權）。
  const eraStats = await db
    .select()
    .from(mapRegionEraStatsTable)
    .where(
      and(
        inArray(mapRegionEraStatsTable.regionId, [
          campaign.attackerRegionId,
          campaign.defenderRegionId,
        ]),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    );
  const popOf = (regionId: number) =>
    eraStats.find((s) => s.regionId === regionId)?.population ?? 0;
  // 同區爭奪時攻守共處同一地區，只計一次以免人口損失被重複加倍。
  const popInRegion = (nationId: string) =>
    campaign.attackerRegionId === campaign.defenderRegionId
      ? (popOf(campaign.defenderRegionId) *
          pctOf(campaign.defenderRegionId, nationId)) /
        100
      : (popOf(campaign.attackerRegionId) *
          pctOf(campaign.attackerRegionId, nationId)) /
          100 +
        (popOf(campaign.defenderRegionId) *
          pctOf(campaign.defenderRegionId, nationId)) /
          100;
  const attackerCombinedPop = popInRegion(attacker.id);
  const defenderCombinedPop = popInRegion(defender.id);
  // Task #625 — 人口損失改為確定性公式（不依賴 AI 欄位）。
  // 僵持路徑（StalemateInput）沿用 localPopulationLossPct:0 的語義：零人口損失。
  // 不可直接把 stalemate.aggressionPct(20) 代入 computeLocalPopulationLossPct，
  // 那樣會錯誤產生約 1% 的人口損耗。
  const totalPopulationLoss =
    !("attacker" in result)
      ? 0
      : Math.floor(
          ((attackerCombinedPop + defenderCombinedPop) *
            computeLocalPopulationLossPct(
              result.attacker.legions.length > 0
                ? result.attacker.legions.reduce(
                    (s: number, l: { aggressionPct?: number }) =>
                      s + (l.aggressionPct ?? 50),
                    0,
                  ) / result.attacker.legions.length
                : 50,
              unitAnalysis.tacticalEdge,
              unitAnalysis.tacticalBonus,
              attackerMoraleBonus,
            )) /
            100,
        );
  const [attackerPopLoss, defenderPopLoss] = allocateProportionally(
    [attackerCombinedPop, defenderCombinedPop],
    totalPopulationLoss,
  ) as [number, number];

  // Task #453 — 每個參戰國各自的復原加成。
  const recoveryBonuses: Record<
    string,
    { speedPct: number; ratePct: number }
  > = {};
  for (const n of [...attackerNations, ...defenderNations]) {
    recoveryBonuses[n.id] = await getRecoveryBonuses(n.discordUserId);
  }

  // Task #412 — 全域戰爭參數（管理員可調）＋戰場地區面積（名稱對照，查無
  // 面積 → null，applyCycleResult 內以中性係數 1 處理）。
  const [worldState] = await db
    .select({
      warIntensityPct: worldGameStateTable.warIntensityPct,
      territoryCaptureBasePct: worldGameStateTable.territoryCaptureBasePct,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  const areaOf = (name: string | undefined): number | null =>
    name !== undefined ? (MAP_REGION_AREAS_KM2[name] ?? null) : null;

  // Task #584 — 政變後士氣懲罰：coup_morale_penalty_turns > 0 的參戰國，
  // 本次結算全軍士氣以政治設定 coupMoralePenalty 扣減（純計算層，不落地）。
  const coupMoralePenaltyByNation: Record<string, number> = {};
  const nationsWithCoupPenalty = participantNationRows.filter(
    (n) => n.coupMoralePenaltyTurns > 0,
  );
  if (nationsWithCoupPenalty.length > 0) {
    const politicsSettings = await getPoliticsSettings();
    for (const n of nationsWithCoupPenalty) {
      coupMoralePenaltyByNation[n.id] = politicsSettings.coupMoralePenalty;
    }
  }

  const applied = await applyCycleResult({
    campaign,
    attacker,
    defender,
    attackerNations,
    defenderNations,
    attackerLegions,
    defenderLegions,
    result,
    recoveryBonuses,
    populationLoss: { attacker: attackerPopLoss, defender: defenderPopLoss },
    statsEra,
    now,
    warIntensityPct: clampWarIntensityPct(worldState?.warIntensityPct),
    territoryCaptureBasePct: clampTerritoryCaptureBasePct(
      worldState?.territoryCaptureBasePct,
    ),
    attackerRegionAreaKm2: areaOf(attackerRegion?.name),
    defenderRegionAreaKm2: areaOf(defenderRegion?.name),
    tacticalEdge: unitAnalysis.tacticalEdge,
    tacticalBonus: unitAnalysis.tacticalBonus,
    attackerMoraleBonus,
    defenderMoraleBonus,
    orderBacklash,
    warWearinessGainMultiplierPct: balance.war.warWearinessGainMultiplierPct,
    coupMoralePenaltyByNation,
  });
  if (!applied) {
    return { settled: false, ended: false, message: "戰役已由其他流程結算" };
  }

  // Task #387 — 戰役結算改變領土掌控與地區人口，全球平均人口快取立即失效，
  // 避免玩家在 30 秒 TTL 內被舊平均計算的研發成本倍率扣點。
  invalidateGlobalAveragePopulationCache();

  // 通知：戰報（所有真人參戰國）＋結束（若已分勝負）。
  const settledCycle = campaign.cycleNumber + 1;
  for (const side of [...attackerNations, ...defenderNations]) {
    if (!side.discordUserId) continue;
    notifyCampaignReport({
      discordUserId: side.discordUserId,
      regionName: targetRegionName,
      cycleNumber: settledCycle,
      campaignId,
    });
  }
  // Task #547 — 被標旗方（限有主玩家國家）收到反噬懲罰站內通知。
  for (const side of penalizedSidesForNotify) {
    const nation = side === "attacker" ? attacker : defender;
    if (nation.isNpc || !nation.discordUserId) continue;
    const bl = orderBacklash[side];
    const sideFlags = orderFlags.filter((f) => f.side === side);
    const reason = [
      ...new Set(sideFlags.map((f) => WAR_ORDER_FLAG_LABELS[f.kind])),
    ].join("、");
    const detailParts = ["軍團積極度折減"];
    if (bl) {
      if (bl.extraCasualtyPct > 0)
        detailParts.push(`額外傷亡 ${bl.extraCasualtyPct}%`);
      if (bl.stabilityDrop > 0) detailParts.push(`穩定度 −${bl.stabilityDrop}`);
      if (bl.unrestRise > 0) detailParts.push(`暴動值 +${bl.unrestRise}`);
      if (bl.warWearinessRise > 0)
        detailParts.push(`厭戰度 +${bl.warWearinessRise}`);
    }
    notifyWarOrderBacklash({
      discordUserId: nation.discordUserId,
      regionName: targetRegionName,
      campaignId,
      reason: reason || "濫用指令",
      detail: detailParts.join("、"),
    });
  }
  // 結算後安全閘（防卡死）：再次判定戰爭結束、領土歸零、NPC 兵力崩潰。
  let postEndedCampaign: WarCampaign | null = null;
  if (!applied.endedCampaign) {
    try {
      postEndedCampaign = await postSettleEndCheck(
        campaignId,
        campaign.warId,
        attacker,
        defender,
        campaign.attackerRegionId,
        campaign.defenderRegionId,
        now,
      );
    } catch (err) {
      logger.error({ err, campaignId }, "post-settle end check failed");
    }
  }

  const endedCampaign = applied.endedCampaign ?? postEndedCampaign;
  if (endedCampaign) {
    notifyEndForBoth({
      campaign: endedCampaign,
      attacker,
      defender,
      regionName: targetRegionName,
      reason:
        endedCampaign.endReason === "annihilation"
          ? "annihilation"
          : endedCampaign.endReason === "ceasefire"
            ? "ceasefire"
            : "territory",
      winnerNationId: endedCampaign.winnerNationId,
    });
  }

  return { settled: true, ended: endedCampaign !== null };
}
