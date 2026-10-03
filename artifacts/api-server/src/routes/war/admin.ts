import { type IRouter } from "express";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
} from "drizzle-orm";
import {
  db,
  playerNationsTable,
  mapRegionsTable,
  warCampaignsTable,
  warCampaignOrdersTable,
  warCampaignReportsTable,
  diplomacyWarsTable,
  diplomacyTreatiesTable,
  diplomacyRelationEventsTable,
} from "@workspace/db";
import { requireAdmin } from "../../middlewares/requireAdmin";
import {
  endCampaignsForWar,
  forceEndCampaign,
  settleAllActiveCampaigns,
  settleCampaign,
} from "../../lib/warEngine";
import {
  autoJoinNationIds,
  canonicalPair,
  findWarBlockingTreatyType,
  treatyTypeLabel,
} from "../../lib/diplomacy";
import { nationsInSameAlliance } from "../../lib/alliances";
import { notifyWarDeclared } from "../../lib/diplomacyNotify";
import {
  tryAcquireAiJudgmentLock,
  releaseAiJudgmentLock,
} from "../../lib/worldScheduler";
import {
  buildMyLegionsView,
  parseId,
  serializeCityStateView,
  serializeReportCities,
} from "./shared";

export function registerWarAdminRoutes(router: IRouter): void {
  // ── 管理端（requireAdmin，前端 raw fetch，不在 OpenAPI spec） ──

  /**
   * 管理端戰爭清單（diplomacy_wars 層級，非戰役層級）：預設回傳所有進行中的
   * 戰爭（endedAt 為 null），可帶 ?includeEnded=1 一併回傳近期已結束的 20 場。
   * 每筆含交戰雙方國名/是否 NPC、宣戰方、開戰時間，以及該戰爭下進行中的戰役數，
   * 供「戰爭管理」頁面終止戰爭。
   */
  router.get("/war/admin/wars", requireAdmin, async (req, res) => {
    const includeEnded =
      req.query.includeEnded === "1" || req.query.includeEnded === "true";
    const active = await db
      .select()
      .from(diplomacyWarsTable)
      .where(isNull(diplomacyWarsTable.endedAt))
      .orderBy(desc(diplomacyWarsTable.id));
    const ended = includeEnded
      ? await db
          .select()
          .from(diplomacyWarsTable)
          .where(isNotNull(diplomacyWarsTable.endedAt))
          .orderBy(desc(diplomacyWarsTable.endedAt))
          .limit(20)
      : [];
    const wars = [...active, ...ended];

    const nationIds = new Set<string>();
    for (const w of wars) {
      nationIds.add(w.nationAId);
      nationIds.add(w.nationBId);
      nationIds.add(w.declaredByNationId);
    }
    const nations = nationIds.size
      ? await db
          .select({
            id: playerNationsTable.id,
            name: playerNationsTable.name,
            isNpc: playerNationsTable.isNpc,
          })
          .from(playerNationsTable)
          .where(inArray(playerNationsTable.id, [...nationIds]))
      : [];
    const nationInfo = new Map(
      nations.map((n) => [
        n.id,
        { name: n.name ?? "未知國家", isNpc: n.isNpc },
      ]),
    );

    // 每場戰爭下進行中的戰役數（供頁面顯示）。
    const counts = await db
      .select({ warId: warCampaignsTable.warId, cnt: count() })
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.status, "active"))
      .groupBy(warCampaignsTable.warId);
    const activeCampaignCount = new Map(
      counts.map((c) => [c.warId, Number(c.cnt)]),
    );

    res.json({
      wars: wars.map((w) => {
        const a = nationInfo.get(w.nationAId);
        const b = nationInfo.get(w.nationBId);
        const d = nationInfo.get(w.declaredByNationId);
        return {
          id: w.id,
          nationAId: w.nationAId,
          nationAName: a?.name ?? "未知國家",
          nationAIsNpc: a?.isNpc ?? false,
          nationBId: w.nationBId,
          nationBName: b?.name ?? "未知國家",
          nationBIsNpc: b?.isNpc ?? false,
          declaredByNationId: w.declaredByNationId,
          declaredByName: d?.name ?? "未知國家",
          activeCampaignCount: activeCampaignCount.get(w.id) ?? 0,
          createdAt: w.createdAt.toISOString(),
          endedAt: w.endedAt ? w.endedAt.toISOString() : null,
        };
      }),
    });
  });

  /**
   * 終止一場戰爭（diplomacy_wars 層級）：條件式標記 endedAt（避免與停戰／自動
   * 結算重入），並依鐵則呼叫 endCampaignsForWar 安全收尾其下所有進行中的戰役
   * （釋放地區交戰鎖、寫入冷卻、回收傷兵、通知雙方、退出晚加入者）。
   */
  router.post("/war/admin/wars/:id/end", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id ?? "");
    if (id === null) {
      res.status(404).json({ error: "找不到指定的戰爭" });
      return;
    }
    const [war] = await db
      .select()
      .from(diplomacyWarsTable)
      .where(eq(diplomacyWarsTable.id, id))
      .limit(1);
    if (!war) {
      res.status(404).json({ error: "找不到指定的戰爭" });
      return;
    }
    if (war.endedAt) {
      res.status(400).json({ error: "這場戰爭已經結束" });
      return;
    }
    try {
      const now = new Date();
      const updated = await db
        .update(diplomacyWarsTable)
        .set({ endedAt: now, ceasefireProposedBy: null })
        .where(
          and(
            eq(diplomacyWarsTable.id, id),
            isNull(diplomacyWarsTable.endedAt),
          ),
        )
        .returning({ endedAt: diplomacyWarsTable.endedAt });
      if (updated.length === 0) {
        res.status(400).json({ error: "這場戰爭已經結束" });
        return;
      }
      // 鐵則：設定 diplomacy_wars.endedAt 的每條路徑都必須呼叫 endCampaignsForWar。
      await endCampaignsForWar(id, "ceasefire");
      req.log.info({ warId: id }, "admin terminated war");
      res.json({
        id,
        endedAt: (updated[0]!.endedAt ?? now).toISOString(),
      });
    } catch (err) {
      req.log.error({ err, warId: id }, "admin terminate war failed");
      res.status(500).json({ error: "終止戰爭失敗，請查看伺服器日誌" });
    }
  });

  /**
   * 管理端讓 NPC 對真人玩家宣戰。鐵則：發動方必須是 NPC；對象必須是真人玩家
   * 國家（有 Discord 帳號且非 NPC）——NPC↔NPC／NPC↔無主 戰爭列永不建立，
   * 否則會永久凍結雙方外交。仍套用互不侵犯／附庸／聯盟阻擋規則，並處理
   * 被宣戰方的保障獨立夥伴／宗主自動參戰（同樣只對真人參戰方建立戰爭列）。
   */
  router.post("/war/admin/wars/npc-declare", requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const attackerNationId = body.attackerNationId;
    const targetNationId = body.targetNationId;
    if (
      typeof attackerNationId !== "string" ||
      typeof targetNationId !== "string"
    ) {
      res.status(400).json({ error: "缺少發動方或對象國家" });
      return;
    }
    if (attackerNationId === targetNationId) {
      res.status(400).json({ error: "發動方與對象不能是同一國" });
      return;
    }
    const rows = await db
      .select()
      .from(playerNationsTable)
      .where(
        inArray(playerNationsTable.id, [attackerNationId, targetNationId]),
      );
    const atk = rows.find((n) => n.id === attackerNationId);
    const tgt = rows.find((n) => n.id === targetNationId);
    if (!atk) {
      res.status(404).json({ error: "找不到發動方國家" });
      return;
    }
    if (!tgt) {
      res.status(404).json({ error: "找不到對象國家" });
      return;
    }
    // 鐵則：發動方必須是 NPC。
    if (!atk.isNpc) {
      res.status(400).json({ error: "發動方必須是 NPC 國家" });
      return;
    }
    // 鐵則：對象必須是真人玩家國家；NPC↔NPC／NPC↔無主 戰爭列永不建立。
    if (tgt.isNpc || !tgt.discordUserId) {
      res.status(400).json({
        error: "對象必須是真人玩家國家（NPC 不能對 NPC 或無主國家宣戰）",
      });
      return;
    }

    const { low, high } = canonicalPair(atk.id, tgt.id);
    const activeTreaties = await db
      .select({
        type: diplomacyTreatiesTable.type,
        proposerNationId: diplomacyTreatiesTable.proposerNationId,
        targetNationId: diplomacyTreatiesTable.targetNationId,
        status: diplomacyTreatiesTable.status,
        expiresAt: diplomacyTreatiesTable.expiresAt,
        proposerIsVassal: diplomacyTreatiesTable.proposerIsVassal,
      })
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.status, "active"));

    const blocking = findWarBlockingTreatyType(activeTreaties, atk.id, tgt.id);
    if (blocking !== null) {
      res.status(400).json({
        error: `兩國之間的${treatyTypeLabel(blocking)}仍在生效中，無法宣戰`,
      });
      return;
    }
    if (await nationsInSameAlliance(atk.id, tgt.id)) {
      res.status(400).json({ error: "兩國同屬一個聯盟，無法宣戰" });
      return;
    }

    const inserted = await db
      .insert(diplomacyWarsTable)
      .values({ nationAId: low, nationBId: high, declaredByNationId: atk.id })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      res.status(409).json({ error: "兩國已處於交戰狀態" });
      return;
    }

    await db.insert(diplomacyRelationEventsTable).values({
      actorNationId: atk.id,
      targetNationId: tgt.id,
      action: "declare_war",
    });

    // 自動參戰：被宣戰方的保障獨立夥伴／宗主自動對發動方進入交戰。
    // 鐵則：發動方是 NPC，故只對「真人」參戰方建立戰爭列（跳過 NPC／無主），
    // 避免 NPC↔NPC／NPC↔無主 戰爭列。
    const joinerIds = autoJoinNationIds(activeTreaties, tgt.id, atk.id);
    const autoJoined: { nationId: string; name: string }[] = [];
    if (joinerIds.length > 0) {
      const joinerNations = await db
        .select({
          id: playerNationsTable.id,
          name: playerNationsTable.name,
          isNpc: playerNationsTable.isNpc,
          discordUserId: playerNationsTable.discordUserId,
        })
        .from(playerNationsTable)
        .where(inArray(playerNationsTable.id, joinerIds));
      for (const joiner of joinerNations) {
        if (joiner.isNpc || !joiner.discordUserId) continue;
        const pair = canonicalPair(joiner.id, atk.id);
        const joined = await db
          .insert(diplomacyWarsTable)
          .values({
            nationAId: pair.low,
            nationBId: pair.high,
            declaredByNationId: joiner.id,
          })
          .onConflictDoNothing()
          .returning({ id: diplomacyWarsTable.id });
        if (joined.length > 0) {
          autoJoined.push({
            nationId: joiner.id,
            name: joiner.name ?? "（未命名）",
          });
        }
      }
    }

    req.log.info(
      {
        warId: inserted[0]!.id,
        attackerNationId: atk.id,
        targetNationId: tgt.id,
      },
      "admin NPC declared war on player",
    );

    notifyWarDeclared({
      targetDiscordUserId: tgt.discordUserId,
      declarerNationName: atk.name,
    });

    res.json({
      id: inserted[0]!.id,
      attackerNationId: atk.id,
      attackerName: atk.name ?? "（未命名）",
      targetNationId: tgt.id,
      targetName: tgt.name ?? "（未命名）",
      createdAt: inserted[0]!.createdAt.toISOString(),
      autoJoined,
    });
  });

  /**
   * 管理端戰役清單：預設回傳所有進行中的戰役（可帶 ?includeEnded=1 一併回傳
   * 近期已結束的 20 場）。每筆含雙方國名、爭奪地區、週期數、結算週期、下次
   * 結算時間與狀態，供「戰役管理」頁面直接結算或調整週期。
   */
  router.get("/war/admin/campaigns", requireAdmin, async (req, res) => {
    const includeEnded =
      req.query.includeEnded === "1" || req.query.includeEnded === "true";
    const active = await db
      .select()
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.status, "active"))
      .orderBy(asc(warCampaignsTable.nextResolveAt));
    const ended = includeEnded
      ? await db
          .select()
          .from(warCampaignsTable)
          .where(ne(warCampaignsTable.status, "active"))
          .orderBy(desc(warCampaignsTable.endedAt))
          .limit(20)
      : [];
    const campaigns = [...active, ...ended];

    const nationIds = new Set<string>();
    const regionIds = new Set<number>();
    for (const c of campaigns) {
      nationIds.add(c.attackerNationId);
      nationIds.add(c.defenderNationId);
      regionIds.add(c.attackerRegionId);
      regionIds.add(c.defenderRegionId);
    }
    const nations = nationIds.size
      ? await db
          .select({
            id: playerNationsTable.id,
            name: playerNationsTable.name,
            isNpc: playerNationsTable.isNpc,
          })
          .from(playerNationsTable)
          .where(inArray(playerNationsTable.id, [...nationIds]))
      : [];
    const regions = regionIds.size
      ? await db
          .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
          .from(mapRegionsTable)
          .where(inArray(mapRegionsTable.id, [...regionIds]))
      : [];
    const nationInfo = new Map(
      nations.map((n) => [n.id, { name: n.name ?? "未知國家", isNpc: n.isNpc }]),
    );
    const regionName = new Map(regions.map((r) => [r.id, r.name]));

    res.json({
      campaigns: campaigns.map((c) => {
        const atk = nationInfo.get(c.attackerNationId);
        const def = nationInfo.get(c.defenderNationId);
        return {
          id: c.id,
          warId: c.warId,
          attackerNationId: c.attackerNationId,
          attackerName: atk?.name ?? "未知國家",
          attackerIsNpc: atk?.isNpc ?? false,
          defenderNationId: c.defenderNationId,
          defenderName: def?.name ?? "未知國家",
          defenderIsNpc: def?.isNpc ?? false,
          attackerRegionId: c.attackerRegionId,
          attackerRegionName: regionName.get(c.attackerRegionId) ?? "未知地區",
          defenderRegionId: c.defenderRegionId,
          defenderRegionName: regionName.get(c.defenderRegionId) ?? "未知地區",
          status: c.status,
          endReason: c.endReason,
          winnerNationId: c.winnerNationId,
          cycleNumber: c.cycleNumber,
          cycleHours: c.cycleHours,
          nextResolveAt: c.nextResolveAt.toISOString(),
          createdAt: c.createdAt.toISOString(),
          endedAt: c.endedAt ? c.endedAt.toISOString() : null,
          isSeaLanding: c.isSeaLanding,
        };
      }),
    });
  });

  /**
   * 管理端戰役細節：回傳單一戰役的完整資訊（雙方皆「不模糊化」），供「戰役管理」
   * 頁面點入檢視。含雙方國名/是否 NPC/爭奪地區、地形敘述、雙方城市防線、雙方
   * 軍團與兵種（真實兵力/傷兵/士氣/補給）、雙方本週期指令，以及所有戰報
   * （雙方文字與雙方數據，皆為真實值）。
   */
  router.get("/war/admin/campaigns/:id", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id ?? "");
    if (id === null) {
      res.status(404).json({ error: "找不到指定的戰役" });
      return;
    }
    const [campaign] = await db
      .select()
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.id, id))
      .limit(1);
    if (!campaign) {
      res.status(404).json({ error: "找不到指定的戰役" });
      return;
    }

    const [nations, regions] = await Promise.all([
      db
        .select({
          id: playerNationsTable.id,
          name: playerNationsTable.name,
          isNpc: playerNationsTable.isNpc,
          discordUserId: playerNationsTable.discordUserId,
        })
        .from(playerNationsTable)
        .where(
          inArray(playerNationsTable.id, [
            campaign.attackerNationId,
            campaign.defenderNationId,
          ]),
        ),
      db
        .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
        .from(mapRegionsTable)
        .where(
          inArray(mapRegionsTable.id, [
            campaign.attackerRegionId,
            campaign.defenderRegionId,
          ]),
        ),
    ]);
    const nationInfo = new Map(nations.map((n) => [n.id, n]));
    const regionName = new Map(regions.map((r) => [r.id, r.name]));
    const atk = nationInfo.get(campaign.attackerNationId);
    const def = nationInfo.get(campaign.defenderNationId);

    const [attackerLegions, defenderLegions, orderRows, reportRows] =
      await Promise.all([
        // discordUserId 只用於解析玩家自訂兵種名；NPC（null）退回基礎兵種名。
        buildMyLegionsView(
          campaign.id,
          campaign.attackerNationId,
          atk?.discordUserId ?? "",
        ),
        buildMyLegionsView(
          campaign.id,
          campaign.defenderNationId,
          def?.discordUserId ?? "",
        ),
        db
          .select()
          .from(warCampaignOrdersTable)
          .where(
            and(
              eq(warCampaignOrdersTable.campaignId, campaign.id),
              eq(warCampaignOrdersTable.cycleNumber, campaign.cycleNumber),
            ),
          )
          .orderBy(asc(warCampaignOrdersTable.orderType)),
        db
          .select()
          .from(warCampaignReportsTable)
          .where(eq(warCampaignReportsTable.campaignId, campaign.id))
          .orderBy(desc(warCampaignReportsTable.cycleNumber)),
      ]);

    const mapOrders = (nationId: string) =>
      orderRows
        .filter((o) => o.nationId === nationId)
        .map((o) => ({ orderType: o.orderType, body: o.body }));

    res.json({
      id: campaign.id,
      warId: campaign.warId,
      attacker: {
        nationId: campaign.attackerNationId,
        name: atk?.name ?? "未知國家",
        isNpc: atk?.isNpc ?? false,
        regionId: campaign.attackerRegionId,
        regionName: regionName.get(campaign.attackerRegionId) ?? "未知地區",
      },
      defender: {
        nationId: campaign.defenderNationId,
        name: def?.name ?? "未知國家",
        isNpc: def?.isNpc ?? false,
        regionId: campaign.defenderRegionId,
        regionName: regionName.get(campaign.defenderRegionId) ?? "未知地區",
      },
      status: campaign.status,
      endReason: campaign.endReason,
      winnerNationId: campaign.winnerNationId,
      cycleNumber: campaign.cycleNumber,
      cycleHours: campaign.cycleHours,
      nextResolveAt: campaign.nextResolveAt.toISOString(),
      createdAt: campaign.createdAt.toISOString(),
      endedAt: campaign.endedAt ? campaign.endedAt.toISOString() : null,
      isSeaLanding: campaign.isSeaLanding,
      landingAttackReductionPct: campaign.landingAttackReductionPct,
      seaLandingTroopCap: campaign.seaLandingTroopCap,
      terrainBrief: campaign.terrainBrief,
      attackerCityState: serializeCityStateView(campaign.attackerCityState),
      defenderCityState: serializeCityStateView(campaign.defenderCityState),
      attackerLegions,
      defenderLegions,
      attackerOrders: mapOrders(campaign.attackerNationId),
      defenderOrders: mapOrders(campaign.defenderNationId),
      reports: reportRows.map((r) => {
        const s = r.summary;
        return {
          id: r.id,
          cycleNumber: r.cycleNumber,
          attackerReport: r.attackerReport,
          defenderReport: r.defenderReport,
          attackerSummary: {
            moraleDelta: s.attacker.moraleDelta,
            woundedTotal: s.attacker.woundedTotal,
            deadTotal: s.attacker.deadTotal,
            territoryPctDelta: s.attacker.territoryPctDelta,
            warWearinessDelta: s.attacker.warWearinessDelta,
          },
          defenderSummary: {
            moraleDelta: s.defender.moraleDelta,
            woundedTotal: s.defender.woundedTotal,
            deadTotal: s.defender.deadTotal,
            territoryPctDelta: s.defender.territoryPctDelta,
            warWearinessDelta: s.defender.warWearinessDelta,
          },
          attackerCityHoldoutPct: s.attackerCityHoldoutPct,
          defenderCityHoldoutPct: s.defenderCityHoldoutPct,
          attackerCities: serializeReportCities(s.attackerCities),
          defenderCities: serializeReportCities(s.defenderCities),
          localPopulationLoss: s.localPopulationLoss,
          stalemate: s.stalemate ?? false,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    });
  });

  /**
   * 一鍵立即結算所有進行中的戰役（不受各戰役下次結算時間限制）。
   * 與背景 AI 判定 tick／world-sim 立即判定共用同一同步重入鎖，
   * 若正在執行 → 409 忙碌中提示，不會並行重跑。回傳實際結算的戰役數。
   */
  router.post("/war/admin/campaigns/settle-all", requireAdmin, async (req, res) => {
    if (!tryAcquireAiJudgmentLock()) {
      res.status(409).json({ error: "結算正在執行中，請稍後再試" });
      return;
    }
    try {
      const { settledCount } = await settleAllActiveCampaigns();
      req.log.info({ settledCount }, "all active campaigns settled manually");
      res.json({ settledCount });
    } catch (err) {
      req.log.error({ err }, "admin settle-all campaigns failed");
      res.status(500).json({ error: "立即結算全部戰役失敗，請稍後再試" });
    } finally {
      releaseAiJudgmentLock();
    }
  });

  /** 手動立即結算一場戰役（測試用）。 */
  router.post("/war/admin/campaigns/:id/settle", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id ?? "");
    if (id === null) {
      res.status(404).json({ error: "找不到指定的戰役" });
      return;
    }
    const [campaign] = await db
      .select()
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.id, id))
      .limit(1);
    if (!campaign) {
      res.status(404).json({ error: "找不到指定的戰役" });
      return;
    }
    if (campaign.status !== "active") {
      res.status(400).json({ error: "戰役已結束" });
      return;
    }
    try {
      const result = await settleCampaign(id);
      res.json(result);
    } catch (err) {
      req.log.error({ err, campaignId: id }, "admin manual settle failed");
      res.status(500).json({ error: "手動結算失敗，請查看伺服器日誌" });
    }
  });

  /**
   * 強制結束一場卡住或誤開的戰役：以指定 endReason（ceasefire／stalemate）安全收尾，
   * 重用 warEngine 收尾邏輯（釋放地區交戰鎖、寫入冷卻、回收傷兵）並通知雙方。
   */
  router.post("/war/admin/campaigns/:id/end", requireAdmin, async (req, res) => {
    const id = parseId(req.params.id ?? "");
    if (id === null) {
      res.status(404).json({ error: "找不到指定的戰役" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = body.endReason;
    if (reason !== "ceasefire" && reason !== "stalemate") {
      res.status(400).json({ error: "結束原因必須是「ceasefire」或「stalemate」" });
      return;
    }
    try {
      const ended = await forceEndCampaign(id, reason);
      if (!ended) {
        res.status(404).json({ error: "找不到進行中的戰役" });
        return;
      }
      res.json({
        id: ended.id,
        status: ended.status,
        endReason: ended.endReason,
        endedAt: ended.endedAt ? ended.endedAt.toISOString() : null,
      });
    } catch (err) {
      req.log.error({ err, campaignId: id }, "admin force end campaign failed");
      res.status(500).json({ error: "強制結束戰役失敗，請查看伺服器日誌" });
    }
  });
}
