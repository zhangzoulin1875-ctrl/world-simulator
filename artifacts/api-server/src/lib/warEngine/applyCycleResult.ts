import {
  db,
  playerArmiesTable,
  playerNationsTable,
  regionControlsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignOrdersTable,
  warCampaignReportsTable,
  warCampaignsTable,
  type PlayerNation,
  type WarCampaign,
  type WarCityState,
  type WarReportCity,
  type WarReportSideSummary,
  type WarReportSummary,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  allocateProportionally,
  allocateLegionLosses,
  normalizeSplitWeights,
  applyTacticalBonus,
  applyTerritoryTransfer,
  areaCaptureSpeedFactor,
  capTransferForCity,
  clamp100,
  computeCounterattack,
  computeCycleCasualties,
  computeCycleMoraleDelta,
  type StalemateInput,
  computeCycleSupplyDelta,
  computeEffectivePower,
  coupAdjustedMorale,
  computeForceRatioTerritoryShift,
  computeMopUpShift,
  computeRecovery,
  computeSiegeIntensity,
  computeTerritoryShift,
  determineCampaignOutcome,
  reconLevelFromOrders,
  scaleTerritoryShift,
  shiftDeathsToWounded,
  STALEMATE_MORALE_DELTA,
  STALEMATE_SUPPLY_DELTA,
  TERRITORY_CAPTURE_BASE_DEFAULT_PCT,
  WOUNDED_SHARE_PCT,
  type ControlShare,
  type SidePowerInput,
} from "../war";
import {
  applySiegeToCities,
  bestStandingWallDefenseBonusPct,
  cityLineFallen,
  cityLineHoldoutPct,
  computeSiegeDamage,
  fallenCityLine,
} from "../wall";
import { applyRegionPopulationDelta } from "../regionPopulation";
import {
  computeBacklashExtraCasualties,
  type WarOrderBacklash,
} from "../gameBalance";
import {
  scaleWarWearinessGain,
  warWearinessAttackModifier,
} from "../politics";
import type { WarCycleAiResult } from "../warAi";
import type { LoadedLegion } from "./shared";
import { endCampaignInTx } from "./endCampaign";
import { recordTerritoryChanges } from "../territoryHistory";

interface ApplyContext {
  campaign: WarCampaign;
  attacker: PlayerNation;
  defender: PlayerNation;
  /** Task #453 — 該邊全部參戰國（主帥在前；單國戰役 = [lead]）。 */
  attackerNations: PlayerNation[];
  defenderNations: PlayerNation[];
  attackerLegions: LoadedLegion[];
  defenderLegions: LoadedLegion[];
  result: WarCycleAiResult | StalemateInput;
  recoveryBonuses: Record<string, { speedPct: number; ratePct: number }>;
  populationLoss: { attacker: number; defender: number };
  /** Task #322 — 人口損失依戰場地區權重分配到 region_controls 用的數據時代。 */
  statsEra: string;
  now: Date;
  /** Task #412 — 戰鬥激烈度倍率（%；10–500，預設 100）。呼叫端讀 world_game_state 傳入。 */
  warIntensityPct: number;
  /** Task #412 — 領土奪取基礎值（百分點；1–30，預設 15）。 */
  territoryCaptureBasePct: number;
  /** Task #412 — 攻擊方出發地區面積（km²）；查無面積時 null（中性係數 1）。 */
  attackerRegionAreaKm2: number | null;
  /** Task #412 — 防守方目標地區面積（km²）；查無面積時 null（中性係數 1）。 */
  defenderRegionAreaKm2: number | null;
  /** Task #625 — 兵種分析戰術優勢方向。 */
  tacticalEdge: "attacker" | "defender" | "neutral";
  /** Task #625 — 戰術優勢加成強度（0–15）。 */
  tacticalBonus: number;
  /** Task #625 — 攻擊方 NPC 士氣加成（0 表示無 NPC 指令或真人玩家）。 */
  attackerMoraleBonus: number;
  /** Task #625 — 防守方 NPC 士氣加成（0 表示無 NPC 指令或真人玩家）。 */
  defenderMoraleBonus: number;
  /**
   * Task #547 — 濫用指令反噬（applyWarOrderPenalties 計算；只對被標旗方）。
   * 額外傷亡在階段 C 疊加（仍受戰力硬上限與剩餘兵力封頂）；穩定−/暴動＋/
   * 厭戰＋ 在交易內對被標旗方「主帥國家」（限有主玩家國家）單條 UPDATE
   * SQL clamp 0–100 套用。
   */
  orderBacklash?: Partial<Record<"attacker" | "defender", WarOrderBacklash>>;
  /**
   * 厭戰度上升幅度倍率（%；gameBalance.war.warWearinessGainMultiplierPct）。
   * 只縮放本結算主厭戰度增量（非反噬）；100＝原幅度。呼叫端讀設定傳入。
   */
  warWearinessGainMultiplierPct: number;
  /**
   * Task #584 — 政變後士氣懲罰（nationId → 扣減點數）：戰力計算時該國全部
   * 軍團士氣扣減後再算戰力（純計算層，不寫回軍團 morale）。呼叫端依
   * coup_morale_penalty_turns > 0 的參戰國與政治設定 coupMoralePenalty 組成。
   */
  coupMoralePenaltyByNation?: Record<string, number>;
}

export async function applyCycleResult(
  ctx: ApplyContext,
): Promise<{ endedCampaign: WarCampaign | null } | null> {
  const { campaign, attacker, defender, result, now } = ctx;
  // Task #453 — 多國參戰：軍團傷亡/傷兵/軍力扣減依軍團所屬國家各自結算。
  const nationById = new Map<string, PlayerNation>(
    [...ctx.attackerNations, ...ctx.defenderNations].map((n) => [n.id, n]),
  );
  const ownerOf = (legion: LoadedLegion): PlayerNation =>
    nationById.get(legion.nationId) ??
    (ctx.attackerLegions.includes(legion) ? attacker : defender);
  /**
   * AI 路徑：按軍團 slot（＋可選國家名稱）查找 AI 回傳的積極度。
   * 僵持路徑（`StalemateInput`）不呼叫此函式——改由 `sides[].aggressionPctOf` 直接回傳固定值。
   */
  const findLegionAggressionPct = (
    sideResults: WarCycleAiResult["attacker"],
    legion: LoadedLegion,
  ): number => {
    const owner = ownerOf(legion);
    return (
      sideResults.legions.find(
        (r) =>
          r.slot === legion.slot &&
          (r.nationName === undefined ||
            r.nationName === (owner.name ?? "未知國家")),
      ) ?? sideResults.legions.find((r) => r.slot === legion.slot)
    )?.aggressionPct ?? 50;
  };

  return db.transaction(async (tx) => {
    // 樂觀鎖：cycle_number 沒變才前進（防手動結算與迴圈併發重複套用）。
    const nextResolveAt = new Date(
      now.getTime() + campaign.cycleHours * 3_600_000,
    );
    const guard = await tx
      .update(warCampaignsTable)
      .set({
        cycleNumber: campaign.cycleNumber + 1,
        nextResolveAt,
        failCount: 0,
      })
      .where(
        and(
          eq(warCampaignsTable.id, campaign.id),
          eq(warCampaignsTable.status, "active"),
          eq(warCampaignsTable.cycleNumber, campaign.cycleNumber),
        ),
      )
      .returning({ id: warCampaignsTable.id });
    if (guard.length === 0) return null;

    // 依結算路徑（AI 或僵持）解出雙方厭戰度增量。
    const warWearinessDeltaBySide = {
      attacker: 'attacker' in result ? result.attacker.warWearinessDelta : result.warWearinessDelta,
      defender: 'attacker' in result ? result.defender.warWearinessDelta : result.warWearinessDelta,
    };
    // Task #625 — 確定性領土/圍城計算需要的平均積極度與有效積極度。
    const attackerLegsForAgg = "attacker" in result ? result.attacker.legions : [];
    const defenderLegsForAgg = "attacker" in result ? result.defender.legions : [];
    const avgAttackerAggression =
      attackerLegsForAgg.length > 0
        ? attackerLegsForAgg.reduce(
            (s: number, l: { aggressionPct?: number }) => s + (l.aggressionPct ?? 50),
            0,
          ) / attackerLegsForAgg.length
        : 50;
    const avgDefenderAggression =
      defenderLegsForAgg.length > 0
        ? defenderLegsForAgg.reduce(
            (s: number, l: { aggressionPct?: number }) => s + (l.aggressionPct ?? 50),
            0,
          ) / defenderLegsForAgg.length
        : 50;
    const effectiveAttackerAggression = applyTacticalBonus(
      avgAttackerAggression,
      ctx.tacticalEdge,
      ctx.tacticalBonus,
      ctx.attackerMoraleBonus,
      "attacker",
    );
    const effectiveDefenderAggression = applyTacticalBonus(
      avgDefenderAggression,
      ctx.tacticalEdge,
      ctx.tacticalBonus,
      ctx.defenderMoraleBonus,
      "defender",
    );

    const summaries: Record<"attacker" | "defender", WarReportSideSummary> = {
      attacker: {
        moraleDelta: 0,
        woundedTotal: 0,
        deadTotal: 0,
        territoryPctDelta: 0,
        warWearinessDelta: warWearinessDeltaBySide.attacker,
        reconLevel: 0,
      },
      defender: {
        moraleDelta: 0,
        woundedTotal: 0,
        deadTotal: 0,
        territoryPctDelta: 0,
        warWearinessDelta: warWearinessDeltaBySide.defender,
        reconLevel: 0,
      },
    };

    // 偵查等級（摘要顯示用）。
    const reconRows = await tx
      .select({
        nationId: warCampaignOrdersTable.nationId,
        cycleNumber: warCampaignOrdersTable.cycleNumber,
      })
      .from(warCampaignOrdersTable)
      .where(
        and(
          eq(warCampaignOrdersTable.campaignId, campaign.id),
          eq(warCampaignOrdersTable.orderType, "recon"),
        ),
      );
    // Task #453 — 偵查等級取該邊所有參戰國的 recon 指令合併計算。
    const attackerIds = new Set(ctx.attackerNations.map((n) => n.id));
    const defenderIds = new Set(ctx.defenderNations.map((n) => n.id));
    summaries.attacker.reconLevel = reconLevelFromOrders(
      reconRows.filter((r) => attackerIds.has(r.nationId)).map((r) => r.cycleNumber),
      campaign.cycleNumber,
    );
    summaries.defender.reconLevel = reconLevelFromOrders(
      reconRows.filter((r) => defenderIds.has(r.nationId)).map((r) => r.cycleNumber),
      campaign.cycleNumber,
    );

    // ── 軍團傷亡、士氣、補給、前線傷兵復原 ──
    // `aggressionPctOf`：AI 路徑從回傳結果取各軍團積極度；僵持路徑固定低值。
    // `warWearinessDelta`：各邊的厭戰度增量（AI 路徑可不同，僵持路徑雙方相同）。
    const sides: {
      key: "attacker" | "defender";
      nation: PlayerNation;
      legions: LoadedLegion[];
      warWearinessDelta: number;
      aggressionPctOf: (legion: LoadedLegion) => number;
    }[] = [
      {
        key: "attacker",
        nation: attacker,
        legions: ctx.attackerLegions,
        warWearinessDelta: warWearinessDeltaBySide.attacker,
        aggressionPctOf: 'attacker' in result
          ? (l) => findLegionAggressionPct(result.attacker, l)
          : () => result.aggressionPct,
      },
      {
        key: "defender",
        nation: defender,
        legions: ctx.defenderLegions,
        warWearinessDelta: warWearinessDeltaBySide.defender,
        aggressionPctOf: 'attacker' in result
          ? (l) => findLegionAggressionPct(result.defender, l)
          : () => result.aggressionPct,
      },
    ];

    // 守方城牆對駐守軍團的減傷（依本週期開始時仍矗立的最強城牆階級）。
    const wallDefenseBonusPct = {
      attacker: bestStandingWallDefenseBonusPct(campaign.attackerCityState),
      defender: bestStandingWallDefenseBonusPct(campaign.defenderCityState),
    };
    // 攻擊修正（厭戰度＋攻擊方海上登陸換算，≤0）— 與送 AI 的 sideInput 一致。
    const attackModifierPct = {
      attacker:
        Math.round(
          (warWearinessAttackModifier(attacker.warWeariness) - 1) * 100,
        ) -
        (campaign.isSeaLanding ? (campaign.landingAttackReductionPct ?? 0) : 0),
      defender: Math.round(
        (warWearinessAttackModifier(defender.warWeariness) - 1) * 100,
      ),
    };

    const cycleMs = campaign.cycleHours * 3_600_000;
    // ── 階段 A：前線傷兵復原（玩家側，改動 in-memory quantity/wounded）──
    // Task #453 — 依軍團所屬國家各自取復原加成（多國參戰）。
    for (const side of sides) {
      for (const legion of side.legions) {
        const owner = ownerOf(legion);
        const bonuses = ctx.recoveryBonuses[owner.id] ?? {
          speedPct: 0,
          ratePct: 0,
        };
        const isPlayer = !owner.isNpc && owner.discordUserId !== null;
        if (!isPlayer) continue;
        for (const unit of legion.units) {
          if (unit.wounded <= 0) continue;
          const recovered = computeRecovery(
            unit.wounded,
            cycleMs,
            bonuses.speedPct,
          );
          if (recovered > 0) {
            unit.quantity += recovered;
            unit.wounded -= recovered;
          }
        }
      }
    }

    // ── 階段 B：雙方有效戰力（復原後、傷亡前）──
    const powerInputFor = (side: (typeof sides)[number]): SidePowerInput => ({
      legions: side.legions.map((l) => ({
        // Task #584 — 政變後士氣懲罰：僅影響本次戰力計算，不落地。
        morale: coupAdjustedMorale(
          l.morale,
          ctx.coupMoralePenaltyByNation?.[ownerOf(l).id] ?? 0,
        ),
        supply: l.supply,
        garrisoning: l.garrisoningCity,
        aggressionPct: side.aggressionPctOf(l),
        units: l.units.map((u) => ({
          quantity: u.quantity,
          attack: u.attack,
          defense: u.defense,
          hp: u.hp,
          // 武器系統 — 裝備乘數；武將系統 — 坐鎮武將乘數（只乘專精分類）。
          // 兩者皆未裝 = undefined → 結算層視為 1；兩者皆有 = 相乘。
          ...((u.weaponOffenseMult ?? 1) * (u.generalOffenseMult ?? 1) !== 1
            ? {
                offenseMult:
                  (u.weaponOffenseMult ?? 1) * (u.generalOffenseMult ?? 1),
              }
            : {}),
          ...((u.weaponDefenseMult ?? 1) * (u.generalDefenseMult ?? 1) !== 1
            ? {
                defenseMult:
                  (u.weaponDefenseMult ?? 1) * (u.generalDefenseMult ?? 1),
              }
            : {}),
        })),
      })),
      attackModifierPct: attackModifierPct[side.key],
      wallDefenseBonusPct: wallDefenseBonusPct[side.key],
    });
    const attackerSide = sides[0]!;
    const defenderSide = sides[1]!;
    const attackerPower = computeEffectivePower(powerInputFor(attackerSide));
    const defenderPower = computeEffectivePower(powerInputFor(defenderSide));
    // 圍城前的可戰兵力（＝復原後、傷亡前的兵力總數）。
    const besiegerTroops = {
      attacker: attackerPower.troops,
      defender: defenderPower.troops,
    };

    // ── 階段 C：伺服器確定性傷亡＋防守方反攻（弱方受硬上限約束）──
    const casualties = computeCycleCasualties({
      attacker: attackerPower,
      defender: defenderPower,
      intensityPct: ctx.warIntensityPct,
    });
    const counter = computeCounterattack({
      attacker: attackerPower,
      defender: defenderPower,
      intensityPct: ctx.warIntensityPct,
    });
    // Task #547 — 濫用反噬額外傷亡（伺服器決定量；沿用既有戰力硬上限，
    // 最終仍以該方剩餘兵力封頂）。
    const backlashCasualties = {
      attacker: computeBacklashExtraCasualties(
        attackerPower.troops,
        casualties.attackerCasualtyCap,
        ctx.orderBacklash?.attacker?.extraCasualtyPct ?? 0,
      ),
      defender: computeBacklashExtraCasualties(
        defenderPower.troops,
        casualties.defenderCasualtyCap,
        ctx.orderBacklash?.defender?.extraCasualtyPct ?? 0,
      ),
    };
    const sideCasualtyTotal = {
      attacker: Math.min(
        attackerPower.troops,
        casualties.attackerCasualties +
          counter.extraAttackerCasualties +
          backlashCasualties.attacker,
      ),
      defender: Math.min(
        defenderPower.troops,
        casualties.defenderCasualties + backlashCasualties.defender,
      ),
    };

    // ── 階段 D：把該方總傷亡分配到軍團→兵種，套用傷兵轉換與士氣補給 ──
    // 士氣／補給：僵持週期用固定常數（確定性）；一般週期依傷亡比例計算。
    // 兩者皆為伺服器決定性，不再由 AI legionResult 給定。
    for (const side of sides) {
      // 僱傭兵無傷亡:損失由同陣營真實軍團承擔(allocateLegionLosses)。
      // sideTotal 仍含僱傭兵兵力,所以士氣/補給用的「傷亡率」會被他們稀釋,
      // 陣營被打垮時士氣照樣會降。
      const sideTotal = side.legions
        .map((l) => l.units.reduce((s, u) => s + u.quantity, 0))
        .reduce((a, b) => a + b, 0);
      const ownCasualties = sideCasualtyTotal[side.key];
      const enemyCasualties =
        sideCasualtyTotal[side.key === "attacker" ? "defender" : "attacker"];
      const perLegionLoss = allocateLegionLosses(
        side.legions.map((l) => ({
          troops: l.units.reduce((sum, u) => sum + u.quantity, 0),
          isMercenary: !!l.mercenary,
        })),
        ownCasualties,
      );
      side.legions.forEach((legion, li) => {
        // Task #453 — 依軍團所屬國家取復原加成／玩家判定（多國參戰）。
        const owner = ownerOf(legion);
        const bonuses = ctx.recoveryBonuses[owner.id] ?? {
          speedPct: 0,
          ratePct: 0,
        };
        const isPlayer = !owner.isNpc && owner.discordUserId !== null;
        const legionLoss = legion.mercenary ? 0 : (perLegionLoss[li] ?? 0);
        if (legionLoss > 0) {
          const perUnitLoss = allocateProportionally(
            legion.units.map((u) => u.quantity),
            legionLoss,
          );
          legion.units.forEach((unit, ui) => {
            const loss = Math.min(unit.quantity, perUnitLoss[ui] ?? 0);
            if (loss <= 0) return;
            const woundedShare = Math.min(
              loss,
              Math.round((loss * WOUNDED_SHARE_PCT) / 100),
            );
            let dead = loss - woundedShare;
            let newWounded = woundedShare;
            if (isPlayer) {
              const shifted = shiftDeathsToWounded(dead, bonuses.ratePct);
              dead = shifted.dead;
              newWounded += shifted.extraWounded;
            }
            // Task #389 — NPC 也有傷兵（戰役結束回常備軍恢復池），但沒有
            // 復原科技加成（不做 shiftDeathsToWounded）。
            unit.quantity -= loss;
            unit.wounded += newWounded;
            unit.deadThisCycle = (unit.deadThisCycle ?? 0) + dead;
            summaries[side.key].deadTotal += dead;
            summaries[side.key].woundedTotal += newWounded;
          });
        }
        // 士氣／補給：僵持週期用固定常數；一般週期依整邊傷亡比例決定。
        const moraleDelta = result.stalemate
          ? STALEMATE_MORALE_DELTA
          : computeCycleMoraleDelta(ownCasualties, enemyCasualties, sideTotal);
        const supplyDelta = result.stalemate
          ? STALEMATE_SUPPLY_DELTA
          : computeCycleSupplyDelta(ownCasualties, sideTotal);
        const newMorale = clamp100(legion.morale + moraleDelta);
        const newSupply = clamp100(legion.supply + supplyDelta);
        summaries[side.key].moraleDelta += newMorale - legion.morale;
        legion.morale = newMorale;
        legion.supply = newSupply;
      });

      // 寫回軍團與兵種列。
      for (const legion of side.legions) {
        // Task #453 — 全國兵力扣減回軍團所屬國家（多國參戰）。
        const owner = ownerOf(legion);
        const isPlayer = !owner.isNpc && owner.discordUserId !== null;
        await tx
          .update(warCampaignLegionsTable)
          .set({ morale: legion.morale, supply: legion.supply })
          .where(eq(warCampaignLegionsTable.id, legion.id));
        for (const unit of legion.units) {
          // 僱傭兵是虛擬單位(unitRowId < 0):沒有資料列可更新,也沒有真實軍隊可扣。
          if (legion.mercenary || unit.unitRowId < 0) continue;
          await tx
            .update(warCampaignLegionUnitsTable)
            .set({
              quantity: Math.max(0, unit.quantity),
              wounded: Math.max(0, unit.wounded),
            })
            .where(eq(warCampaignLegionUnitsTable.id, unit.unitRowId));
          // 死亡同步扣減全國兵力（玩家側）。
          const dead = unit.deadThisCycle ?? 0;
          if (isPlayer && dead > 0 && owner.discordUserId) {
            await tx
              .update(playerArmiesTable)
              .set({
                quantity: sql`GREATEST(0, ${playerArmiesTable.quantity} - ${dead})`,
              })
              .where(
                and(
                  eq(playerArmiesTable.discordUserId, owner.discordUserId),
                  eq(playerArmiesTable.templateId, unit.templateId),
                ),
              );
          }
        }
      }
    }

    // ── 城市防線（先結算，供領土硬約束使用；若本週期城市陷落則可全取）──
    // 圍城傷害為決定性計算：強度（AI 給定）× 圍城方可戰兵力，非 AI 直接給防線值。
    const applyCity = (
      state: WarCityState | null,
      siegeDamage: number,
      ownerLegions: LoadedLegion[],
    ): WarCityState | null => {
      if (!state) return null;
      const cities = applySiegeToCities(state.cities, siegeDamage);
      const garrisoned =
        cities.some((c) => c.durability > 0) &&
        ownerLegions.some(
          (l) => l.garrisoningCity && l.units.some((u) => u.quantity > 0),
        );
      return { ...state, cities, garrisoned };
    };
    // 攻擊方圍攻守方城市（守方城牆承受攻擊方兵力＋強度）；防守方反圍攻擊方城市。
    // （NPC 全滅接管時會把敗方城市改寫為陷落，故用 let。）
    // 僵持路徑（StalemateInput）使用 result 中固定的圍城強度（通常為 0），
    // 不可改用 effectiveXxxAggression（固定值 20 帶入 computeSiegeIntensity 仍會
    // 產生非零強度，與「僵持=零圍城損耗」的語義相違）。
    const isAiResult = "attacker" in result;
    let newAttackerCity = applyCity(
      campaign.attackerCityState,
      computeSiegeDamage(
        isAiResult
          ? computeSiegeIntensity(
              effectiveDefenderAggression,
              cityLineHoldoutPct(campaign.attackerCityState) ?? 0,
              0,
            )
          : (result.defenderSiegeIntensityPct ?? 0),
        besiegerTroops.defender,
      ),
      ctx.attackerLegions,
    );
    let newDefenderCity = applyCity(
      campaign.defenderCityState,
      computeSiegeDamage(
        isAiResult
          ? computeSiegeIntensity(
              effectiveAttackerAggression,
              cityLineHoldoutPct(campaign.defenderCityState) ?? 0,
              0,
            )
          : (result.attackerSiegeIntensityPct ?? 0),
        besiegerTroops.attacker,
      ),
      ctx.defenderLegions,
    );

    // ── 領土消長（交易內 FOR UPDATE，Σ 不變）──
    // 城市硬約束（伺服器端，不依賴 AI）：地區的本方城市未陷落時，
    // 該方在此地區的控制率不得被清零 — capTransferForCity 保底 1%。
    // Task #453 — 多國參戰：勝方奪得的總量由伺服器決定；AI 只能建議勝方
    // 內部的分配比例（normalizeSplitWeights 驗證，非法/缺項 fallback 各國
    // 投入戰力權重）。輸家永遠只有敗方主帥。
    const troopsOf = (nations: PlayerNation[], legions: LoadedLegion[]) =>
      nations.map((n) =>
        legions
          .filter((l) => l.nationId === n.id)
          .reduce((s, l) => s + l.units.reduce((t, u) => t + u.quantity, 0), 0),
      );
    // 多國參戰領土分配恆用兵力比例（fallback 路徑），不再依賴 AI 分配欄位。
    const attackerGainWeights = normalizeSplitWeights(
      undefined,
      ctx.attackerNations.map((n) => n.name ?? "未知國家"),
      troopsOf(ctx.attackerNations, ctx.attackerLegions),
    );
    const defenderGainWeights = normalizeSplitWeights(
      undefined,
      ctx.defenderNations.map((n) => n.name ?? "未知國家"),
      troopsOf(ctx.defenderNations, ctx.defenderLegions),
    );
    const transferForRegion = async (
      regionId: number,
      shift: number,
      protectedNationId: string,
      protectedCityState: WarCityState | null,
    ): Promise<{
      attackerApplied: number;
      atkPct: number;
      defPct: number;
      leadAtkPct: number;
      leadDefPct: number;
    }> => {
      const rows = await tx
        .select()
        .from(regionControlsTable)
        .where(eq(regionControlsTable.regionId, regionId))
        .for("update");
      const current: ControlShare[] = rows.map((r) => ({
        nationId: r.nationId,
        percent: r.percent,
      }));
      const before = (nationId: string) =>
        current.find((c) => c.nationId === nationId)?.percent ?? 0;
      let next = current;
      if (shift !== 0) {
        const gainers = shift > 0 ? ctx.attackerNations : ctx.defenderNations;
        const gainWeights =
          shift > 0 ? attackerGainWeights : defenderGainWeights;
        const loser = shift > 0 ? defender.id : attacker.id;
        let amount = Math.abs(shift);
        if (loser === protectedNationId) {
          amount = capTransferForCity(amount, before(loser), protectedCityState);
        }
        // 勝方多國時依權重把總移轉量拆給各參戰國（Σ 不變，逐一套用）。
        const perGainer = allocateProportionally(gainWeights, amount);
        gainers.forEach((g, gi) => {
          const part = perGainer[gi] ?? 0;
          if (part <= 0) return;
          next = applyTerritoryTransfer(next, g.id, loser, part);
        });
      }
      const after = (nationId: string) =>
        next.find((c) => c.nationId === nationId)?.percent ?? 0;
      // 不變量：城市未陷落 → 受保護方持分不得由正轉零（違反即中止結算回滾）。
      if (
        protectedCityState &&
        !cityLineFallen(protectedCityState) &&
        before(protectedNationId) > 0 &&
        after(protectedNationId) <= 0
      ) {
        throw new Error(
          `戰役 ${campaign.id} 地區 ${regionId}：城市尚未陷落但守方控制率被清零，結算中止`,
        );
      }
      // Task #453 — 記錄所有參戰國（含晚加入者）的持分變動。
      const involvedIds = [
        ...new Set([
          ...ctx.attackerNations.map((n) => n.id),
          ...ctx.defenderNations.map((n) => n.id),
        ]),
      ];
      for (const nationId of involvedIds) {
        const b = before(nationId);
        const a = after(nationId);
        if (a === b) continue;
        // Task #392 — 同交易內記錄戰爭領土移轉。
        await recordTerritoryChanges(tx, [
          {
            nationId,
            regionId,
            percentBefore: b,
            percentAfter: Math.max(a, 0),
            changeType: "war",
            reason: `戰爭結算：「${attacker.name}」對「${defender.name}」的戰役 #${campaign.id} 領土移轉`,
            warId: campaign.warId,
          },
        ]);
        if (a <= 0) {
          await tx
            .delete(regionControlsTable)
            .where(
              and(
                eq(regionControlsTable.regionId, regionId),
                eq(regionControlsTable.nationId, nationId),
              ),
            );
        } else {
          await tx
            .insert(regionControlsTable)
            .values({ regionId, nationId, percent: a })
            .onConflictDoUpdate({
              target: [regionControlsTable.regionId, regionControlsTable.nationId],
              set: { percent: a },
            });
        }
      }
      // Task #453 — 戰報淨變動以「該邊合計持分」計（多國參戰）。
      // Task #579 — 勝負判定改以「兩位主帥各自持分」計（leadAtkPct/leadDefPct）：
      // 領土移轉的輸家永遠是敗方主帥（#453 deliberate design），晚加入者的持分
      // 永遠不會被本戰役移轉；若以該邊合計持分判定，敗方側 joiner 的殘餘持分
      // 會讓戰役永不結束、交戰鎖永久鎖死。戰役的賭注是主帥對主帥 —— 主帥兩區
      // 歸零＋城市陷落即分勝負，joiner 殘餘持分保留（要奪取需另開對 joiner 的
      // 戰役，雙方本就交戰中）。1v1 情境兩者相等、行為不變。
      const sideSum = (
        nations: PlayerNation[],
        f: (id: string) => number,
      ): number => nations.reduce((s, n) => s + f(n.id), 0);
      return {
        attackerApplied:
          sideSum(ctx.attackerNations, after) -
          sideSum(ctx.attackerNations, before),
        atkPct: sideSum(ctx.attackerNations, after),
        defPct: sideSum(ctx.defenderNations, after),
        leadAtkPct: after(attacker.id),
        leadDefPct: after(defender.id),
      };
    };

    // ── NPC 全滅自動偵測 ──
    // 主帥為 NPC 的一方在本週期傷亡結算後全軍歸零（該邊所有軍團、含 joiner）
    // 且對方尚有兵力 → 該 NPC 在戰役兩地區的全部持分立即移轉給勝方、戰役
    // 立即結束（endReason="annihilation"）。NPC 開戰後無補兵、兵力只會在
    // 結算週期內變動，故此單一偵測點涵蓋所有歸零時刻；歷史上已歸零的戰役
    // 也會在下次到期結算被本檢查接管。無主國家（is_npc=false）與玩家國家
    // 不適用；NPC↔NPC 戰爭依鐵則不存在。
    const sideTroopsLeft = (legions: LoadedLegion[]): number =>
      legions.reduce(
        (s, l) => s + l.units.reduce((t, u) => t + u.quantity, 0),
        0,
      );
    const attackerTroopsLeft = sideTroopsLeft(ctx.attackerLegions);
    const defenderTroopsLeft = sideTroopsLeft(ctx.defenderLegions);
    const annihilatedSide: "attacker" | "defender" | null =
      defender.isNpc && defenderTroopsLeft <= 0 && attackerTroopsLeft > 0
        ? "defender"
        : attacker.isNpc && attackerTroopsLeft <= 0 && defenderTroopsLeft > 0
          ? "attacker"
          : null;

    // 目標地區：攻擊方推進取「AI 值」與「確定性戰力下限」較大者（Task #275）。
    // AI 過度保守趨近 0 時，改由伺服器依戰力對比逼迫贏家實際奪地；AI 想給更高
    // 時仍尊重 AI。城市未陷落的硬約束仍由 transferForRegion 內把關（保底 1%）。
    // Task #412 — 領土奪取基礎值（管理員可調）決定確定性推進的滿幅上限，並
    // 等比縮放 AI 給的推進值；地區面積再換算佔領速度係數（大地區慢、小地區
    // 快、查無面積中性 1），套在「最終套用值」上。既有 ±25 淨收斂與城市保底
    // 1%（transferForRegion 內）不變。
    const basePct = ctx.territoryCaptureBasePct;
    const baseScale = basePct / TERRITORY_CAPTURE_BASE_DEFAULT_PCT;
    const defAreaFactor = areaCaptureSpeedFactor(ctx.defenderRegionAreaKm2);
    const atkAreaFactor = campaign.attackerRegionId === campaign.defenderRegionId
      ? defAreaFactor
      : areaCaptureSpeedFactor(ctx.attackerRegionAreaKm2);
    const deterministicAdvance = scaleTerritoryShift(
      computeForceRatioTerritoryShift({
        attacker: attackerPower,
        defender: defenderPower,
        basePct,
      }),
      defAreaFactor,
    );
    // Task #625 — 確定性領土推進（攻方在守方目標地區的推進量）。
    const aiDefenderShift = computeTerritoryShift(
      avgAttackerAggression,
      ctx.tacticalEdge,
      ctx.tacticalBonus,
      ctx.attackerMoraleBonus,
      baseScale * defAreaFactor,
      "attacker",
    );

    // Task #578 — 確定性掃蕩（mop-up）：兩地區戰役中，敗方在主要戰場持分
    // 已清空（且該區城市已陷落或無城市）、只剩另一區殘餘持分時，把確定性
    // 推進下限導向另一區逐週期清除殘餘，避免「AI 不給 shift → 永久僵持、
    // 地區被交戰鎖鎖死」。掃蕩量為伺服器純函式決定（computeMopUpShift，
    // 至少 1 點），實際移轉仍受 loser 持分、城市保底（transferForRegion 內
    // capTransferForCity）與 ±25 收斂封頂。持分預讀不加鎖：交戰鎖（每區
    // 一場戰役）＋結算 due-claim 已序列化本戰役地區的戰爭寫入，之後
    // transferForRegion 仍會 FOR UPDATE 重讀。
    let mopUpAtkShift = 0;
    let mopUpDefShift = 0;
    if (campaign.attackerRegionId !== campaign.defenderRegionId && !annihilatedSide) {
      const preRows = await tx
        .select({
          regionId: regionControlsTable.regionId,
          nationId: regionControlsTable.nationId,
          percent: regionControlsTable.percent,
        })
        .from(regionControlsTable)
        .where(
          and(
            inArray(regionControlsTable.regionId, [
              campaign.attackerRegionId,
              campaign.defenderRegionId,
            ]),
            inArray(regionControlsTable.nationId, [attacker.id, defender.id]),
          ),
        );
      const pctOf = (regionId: number, nationId: string): number =>
        preRows.find((r) => r.regionId === regionId && r.nationId === nationId)
          ?.percent ?? 0;
      // 攻方掃蕩：守方在目標地區歸零 → 清守方在攻方出發地區的殘餘。
      const mopUpAtk = computeMopUpShift({
        winner: attackerPower,
        loser: defenderPower,
        loserPctMainRegion: pctOf(campaign.defenderRegionId, defender.id),
        loserMainRegionCityFallen: cityLineFallen(newDefenderCity),
        loserPctOtherRegion: pctOf(campaign.attackerRegionId, defender.id),
        basePct,
      });
      // 守方掃蕩（鏡像）：攻方在出發地區歸零 → 清攻方在目標地區的殘餘。
      const mopUpDef = computeMopUpShift({
        winner: defenderPower,
        loser: attackerPower,
        loserPctMainRegion: pctOf(campaign.attackerRegionId, attacker.id),
        loserMainRegionCityFallen: cityLineFallen(newAttackerCity),
        loserPctOtherRegion: pctOf(campaign.defenderRegionId, attacker.id),
        basePct,
      });
      // 面積係數套在掃蕩發生的那一區（scaleTerritoryShift 非零至少 1，
      // 保住每週期至少 1 點的收斂保證）。
      mopUpAtkShift = mopUpAtk > 0 ? scaleTerritoryShift(mopUpAtk, atkAreaFactor) : 0;
      mopUpDefShift = mopUpDef > 0 ? scaleTerritoryShift(mopUpDef, defAreaFactor) : 0;
    }

    const baseDefenderRegionShift =
      deterministicAdvance > 0
        ? Math.max(aiDefenderShift, deterministicAdvance)
        : aiDefenderShift;
    // Task #578 — 守方掃蕩以負向下限（守方奪回）疊加在目標地區，收斂於 −25。
    const defenderRegionShift =
      mopUpDefShift > 0
        ? Math.min(baseDefenderRegionShift, Math.max(-25, -mopUpDefShift))
        : baseDefenderRegionShift;

    let atkRegionOutcome: Awaited<ReturnType<typeof transferForRegion>>;
    let defRegionOutcome: Awaited<ReturnType<typeof transferForRegion>>;
    if (annihilatedSide) {
      // ── NPC 全滅接管 ──
      // 守軍全滅 → 城市無人防守視同陷落（覆寫本週期城市狀態，稍後持久化），
      // capTransferForCity 不再保底、「城未陷不得清零」不變量放行。
      if (annihilatedSide === "defender") {
        newDefenderCity = fallenCityLine(newDefenderCity);
      } else {
        newAttackerCity = fallenCityLine(newAttackerCity);
      }
      // 全額移轉：shift=±100 交由 applyTerritoryTransfer 以敗方主帥現有持分
      // 封頂，一次清空其在戰役兩地區的全部持分（joiner 與第三方持分不動，
      // 同 Task #579 的主帥對主帥原則）；勝方多國時仍依 gainWeights 拆分。
      // 不套 ±25 收斂——全滅接管是終局移轉，非逐週期推進。
      const shift = annihilatedSide === "defender" ? 100 : -100;
      if (campaign.attackerRegionId === campaign.defenderRegionId) {
        const outcome = await transferForRegion(
          campaign.defenderRegionId,
          shift,
          defender.id,
          newDefenderCity,
        );
        atkRegionOutcome = outcome;
        defRegionOutcome = outcome;
        summaries.attacker.territoryPctDelta = outcome.attackerApplied;
        summaries.defender.territoryPctDelta = -outcome.attackerApplied;
      } else {
        atkRegionOutcome = await transferForRegion(
          campaign.attackerRegionId,
          shift,
          attacker.id,
          newAttackerCity,
        );
        defRegionOutcome = await transferForRegion(
          campaign.defenderRegionId,
          shift,
          defender.id,
          newDefenderCity,
        );
        const attackerNet =
          atkRegionOutcome.attackerApplied + defRegionOutcome.attackerApplied;
        summaries.attacker.territoryPctDelta = attackerNet;
        summaries.defender.territoryPctDelta = -attackerNet;
      }
    } else if (campaign.attackerRegionId === campaign.defenderRegionId) {
      // 同區戰役：只有一塊爭奪地區。攻擊方淨推進 = 推進值 − 防守方
      // 反攻（territoryPushbackPct），收斂於 ±25，一次結算。城市屬防守方（保底
      // 1%）；攻擊方無城市，被推到 0 即被逐出（於下方勝負判定生效）。
      const netShift = Math.max(
        -25,
        Math.min(
          25,
          defenderRegionShift -
            scaleTerritoryShift(counter.territoryPushbackPct, defAreaFactor),
        ),
      );
      const outcome = await transferForRegion(
        campaign.defenderRegionId,
        netShift,
        defender.id,
        newDefenderCity,
      );
      atkRegionOutcome = outcome;
      defRegionOutcome = outcome;
      summaries.attacker.territoryPctDelta = outcome.attackerApplied;
      summaries.defender.territoryPctDelta = -outcome.attackerApplied;
    } else {
      // 防守方反攻推回攻擊方本土：在攻擊方地區額外把控制率推向防守方
      // （territoryShiftPct 正值＝攻擊方控制增加，故反攻以負向疊加），總幅度收斂於 ±25。
      // Task #625 — 確定性反攻（守方在攻方出發地區的推進量）。
      const aiAttackerShift = computeTerritoryShift(
        avgDefenderAggression,
        ctx.tacticalEdge,
        ctx.tacticalBonus,
        ctx.defenderMoraleBonus,
        baseScale * atkAreaFactor,
        "defender",
      );
      // aiAttackerShift 是正值代表守方在攻方地區的推進量；但 transferForRegion
      // 以正值代表攻方獲益，故取負號轉換方向：守方越積極 → attackerRegionShift 越負
      // → 攻方在本土地區失地。counter.territoryPushbackPct 同樣代表守方反推能力
      // （正值越大→守方越強勢），故亦取負號加深守方的地區推進。
      const baseAttackerRegionShift = Math.max(
        -25,
        Math.min(
          25,
          -aiAttackerShift -
            scaleTerritoryShift(counter.territoryPushbackPct, atkAreaFactor),
        ),
      );
      // Task #578 — 攻方掃蕩以正向下限（攻方清殘餘）疊加在出發地區，收斂於 25。
      const attackerRegionShift =
        mopUpAtkShift > 0
          ? Math.max(baseAttackerRegionShift, Math.min(25, mopUpAtkShift))
          : baseAttackerRegionShift;
      atkRegionOutcome = await transferForRegion(
        campaign.attackerRegionId,
        attackerRegionShift,
        attacker.id,
        newAttackerCity,
      );
      defRegionOutcome = await transferForRegion(
        campaign.defenderRegionId,
        defenderRegionShift,
        defender.id,
        newDefenderCity,
      );
      const attackerNet =
        atkRegionOutcome.attackerApplied + defRegionOutcome.attackerApplied;
      summaries.attacker.territoryPctDelta = attackerNet;
      summaries.defender.territoryPctDelta = -attackerNet;
    }

    // ── 城市防線持久化（新狀態已於領土消長前計算） ──
    await tx
      .update(warCampaignsTable)
      .set({
        attackerCityState: newAttackerCity,
        defenderCityState: newDefenderCity,
      })
      .where(eq(warCampaignsTable.id, campaign.id));

    // ── 厭戰度與人口損失 ──
    // Task #322 — 人口損失（負向變化）依戰場地區權重分配到 region_controls
    // 的 population_bonus（僅作用於本戰役的攻/守地區，每地區下限 0）。
    for (const side of sides) {
      // 主厭戰度增量套用可調上升幅度倍率（gameBalance；不含反噬）。
      const wearinessDelta = scaleWarWearinessGain(
        side.warWearinessDelta,
        ctx.warWearinessGainMultiplierPct,
      );
      const popLoss =
        side.key === "attacker"
          ? ctx.populationLoss.attacker
          : ctx.populationLoss.defender;
      // Task #453 — 厭戰度套用到該邊所有參戰國；人口損失只算主帥
      // （戰場在主帥雙方的地區，晚加入者本土不受波及）。
      const sideAll =
        side.key === "attacker" ? ctx.attackerNations : ctx.defenderNations;
      await tx
        .update(playerNationsTable)
        .set({
          warWeariness: sql`LEAST(100, ${playerNationsTable.warWeariness} + ${wearinessDelta})`,
        })
        .where(
          inArray(
            playerNationsTable.id,
            sideAll.map((n) => n.id),
          ),
        );
      if (popLoss > 0) {
        await applyRegionPopulationDelta(
          tx,
          side.nation.id,
          ctx.statsEra,
          -popLoss,
          campaign.attackerRegionId === campaign.defenderRegionId
            ? [campaign.defenderRegionId]
            : [campaign.attackerRegionId, campaign.defenderRegionId],
        );
      }
      // Task #547 — 濫用反噬國家數值懲罰：只對被標旗方「主帥國家」且限
      // 有主玩家國家（!isNpc && discordUserId），單條 UPDATE 內 SQL clamp
      // 0–100（穩定−／暴動＋／厭戰＋）。
      const bl = ctx.orderBacklash?.[side.key];
      if (
        bl &&
        (bl.stabilityDrop > 0 || bl.unrestRise > 0 || bl.warWearinessRise > 0) &&
        !side.nation.isNpc &&
        side.nation.discordUserId !== null
      ) {
        await tx
          .update(playerNationsTable)
          .set({
            stability: sql`GREATEST(0, LEAST(100, ${playerNationsTable.stability} - ${bl.stabilityDrop}))`,
            unrest: sql`GREATEST(0, LEAST(100, ${playerNationsTable.unrest} + ${bl.unrestRise}))`,
            warWeariness: sql`GREATEST(0, LEAST(100, ${playerNationsTable.warWeariness} + ${bl.warWearinessRise}))`,
          })
          .where(eq(playerNationsTable.id, side.nation.id));
      }
    }

    // ── 戰報 ──
    const toReportCities = (
      state: WarCityState | null,
    ): WarReportCity[] | undefined =>
      state
        ? state.cities.map((c) => ({
            cityId: c.cityId,
            name: c.name,
            wallTier: c.wallTier,
            durability: c.durability,
            maxDurability: c.maxDurability,
          }))
        : undefined;
    const summary: WarReportSummary = {
      attacker: summaries.attacker,
      defender: summaries.defender,
      attackerCityHoldoutPct: cityLineHoldoutPct(newAttackerCity),
      defenderCityHoldoutPct: cityLineHoldoutPct(newDefenderCity),
      attackerCities: toReportCities(newAttackerCity),
      defenderCities: toReportCities(newDefenderCity),
      localPopulationLoss:
        ctx.populationLoss.attacker + ctx.populationLoss.defender,
      ...(result.stalemate ? { stalemate: true } : {}),
    };
    await tx
      .insert(warCampaignReportsTable)
      .values({
        campaignId: campaign.id,
        cycleNumber: campaign.cycleNumber,
        attackerReport: result.attackerReport,
        defenderReport: result.defenderReport,
        summary,
      })
      .onConflictDoNothing();

    // ── 勝負判定 ──
    // Task #579 — 以主帥持分判定（非該邊合計），避免敗方側 joiner 殘餘持分
    // 造成戰役永不結束（joiner 持分無法被本戰役移轉，見 transferForRegion）。
    // NPC 全滅接管 → 直接判對方獲勝（領土已全額移轉、城市已標記陷落），
    // 立即結束戰役，不等 determineCampaignOutcome 的常規條件。
    const winner: "attacker" | "defender" | null = annihilatedSide
      ? annihilatedSide === "defender"
        ? "attacker"
        : "defender"
      : determineCampaignOutcome({
          attackerPctAtkRegion: atkRegionOutcome.leadAtkPct,
          attackerPctDefRegion: defRegionOutcome.leadAtkPct,
          defenderPctAtkRegion: atkRegionOutcome.leadDefPct,
          defenderPctDefRegion: defRegionOutcome.leadDefPct,
          attackerCityState: newAttackerCity,
          defenderCityState: newDefenderCity,
        });
    let endedCampaign: WarCampaign | null = null;
    if (winner) {
      endedCampaign = await endCampaignInTx(tx, campaign.id, {
        reason: annihilatedSide ? "annihilation" : "territory",
        winnerNationId: winner === "attacker" ? attacker.id : defender.id,
        now,
      });
    }
    return { endedCampaign };
  });
}
