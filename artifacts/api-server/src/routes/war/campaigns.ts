import { hasActiveMercenaryContract } from "../../lib/mercenaryService";
import { type IRouter } from "express";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  diplomacyWarsTable,
  nationMilitarySnapshotsTable,
  playerNationsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignOrdersTable,
  warCampaignParticipantsTable,
} from "@workspace/db";
import { fuzzValue, reconLevelFromOrders } from "../../lib/war";
import { WarActionError, initiateCampaign } from "../../lib/warEngine";
import {
  SIDE_LABELS,
  getJoinEligibility,
  joinCampaign,
  loadParticipants,
  type CampaignSide,
} from "../../lib/warEngine/participants";
import { pgErrorCode } from "../../lib/playerValidation";
import {
  buildAvailableUnits,
  buildMyLegionsView,
  loadCampaignNames,
  requireCampaignParticipant,
  requirePlayer,
  serializeCityStateView,
  toListItem,
} from "./shared";

export function registerWarCampaignRoutes(router: IRouter): void {
  // ── 公開地圖：進行中戰役（世界地圖使用，無需 session） ──────────

  router.get("/war/active-campaigns-map", async (_req, res) => {
    const campaigns = await db
      .select({
        id: warCampaignsTable.id,
        attackerRegionId: warCampaignsTable.attackerRegionId,
        defenderRegionId: warCampaignsTable.defenderRegionId,
        attackerNationId: warCampaignsTable.attackerNationId,
        defenderNationId: warCampaignsTable.defenderNationId,
      })
      .from(warCampaignsTable)
      .where(isNull(warCampaignsTable.endedAt));

    if (campaigns.length === 0) {
      res.json({ campaigns: [] });
      return;
    }

    const nationIds = new Set<string>();
    for (const c of campaigns) {
      nationIds.add(c.attackerNationId);
      nationIds.add(c.defenderNationId);
    }

    const nations = await db
      .select({ id: playerNationsTable.id, name: playerNationsTable.name })
      .from(playerNationsTable)
      .where(inArray(playerNationsTable.id, [...nationIds]));

    const nationName = new Map(nations.map((n) => [n.id, n.name ?? "未知國家"]));

    res.json({
      campaigns: campaigns.map((c) => ({
        id: c.id,
        attackerRegionId: c.attackerRegionId,
        defenderRegionId: c.defenderRegionId,
        attackerNationName: nationName.get(c.attackerNationId) ?? "未知國家",
        defenderNationName: nationName.get(c.defenderNationId) ?? "未知國家",
      })),
    });
  });

  // ── 戰役列表／發起 ─────────────────────────────────────────────

  router.get("/war/campaigns", async (req, res) => {
    const player = await requirePlayer(req, res);
    if (!player) return;
    // Task #453 — 以參戰列為準（主帥回填＋晚加入者都涵蓋）。
    const rows = await db
      .select({
        campaign: warCampaignsTable,
        side: warCampaignParticipantsTable.side,
      })
      .from(warCampaignParticipantsTable)
      .innerJoin(
        warCampaignsTable,
        eq(warCampaignsTable.id, warCampaignParticipantsTable.campaignId),
      )
      .where(eq(warCampaignParticipantsTable.nationId, player.nation.id))
      .orderBy(desc(warCampaignsTable.createdAt));
    const campaigns = rows.map((r) => r.campaign);
    const sideOf = new Map<number, "attacker" | "defender">(
      rows.map((r) => [r.campaign.id, r.side as "attacker" | "defender"]),
    );
    const names = await loadCampaignNames(campaigns, player.nation.id, sideOf);
    res.json({
      campaigns: campaigns.map((c) =>
        toListItem(c, player.nation.id, names.get(c.id)!, sideOf.get(c.id)),
      ),
    });
  });

  // ── Task #453 — 晚加入資格查詢／加入 ──────────────────────────

  router.get("/war/campaigns/:id/join-eligibility", async (req, res) => {
    const player = await requirePlayer(req, res);
    if (!player) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
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
    const eligibility = await getJoinEligibility(campaign, player.nation);
    res.json({
      alreadyParticipant: eligibility.alreadyParticipant,
      joinableSides: eligibility.joinableSides.map((s) => ({
        side: s.side,
        sideLabel: SIDE_LABELS[s.side],
      })),
    });
  });

  router.post("/war/campaigns/:id/join", async (req, res) => {
    const player = await requirePlayer(req, res);
    if (!player) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: "找不到指定的戰役" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const side = body.side;
    if (side !== "attacker" && side !== "defender") {
      res.status(400).json({ error: "請選擇要加入的陣營（進攻方或防守方）" });
      return;
    }
    const [campaign] = await db
      .select()
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.id, id))
      .limit(1);
    if (!campaign || campaign.status !== "active") {
      res.status(404).json({ error: "找不到進行中的指定戰役" });
      return;
    }
    try {
      await joinCampaign({
        campaign,
        nation: player.nation,
        side: side as CampaignSide,
      });
      res.json({ ok: true, campaignId: campaign.id, side });
    } catch (err) {
      if (err instanceof WarActionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (pgErrorCode(err) === "23505") {
        res.status(409).json({ error: "你已是這場戰役的參戰國" });
        return;
      }
      req.log.error({ err, campaignId: id }, "join war campaign failed");
      res.status(500).json({ error: "加入戰役失敗，請稍後再試" });
    }
  });

  router.post("/war/campaigns", async (req, res) => {
    const player = await requirePlayer(req, res);
    if (!player) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const attackerRegionId = body.attackerRegionId;
    const defenderRegionId = body.defenderRegionId;
    if (
      typeof attackerRegionId !== "number" ||
      !Number.isInteger(attackerRegionId) ||
      attackerRegionId <= 0 ||
      typeof defenderRegionId !== "number" ||
      !Number.isInteger(defenderRegionId) ||
      defenderRegionId <= 0
    ) {
      res.status(400).json({ error: "請指定有效的出發地區與目標地區" });
      return;
    }
    // Task #353 — 多國混戰同區爭奪：可選指定要爭奪的交戰敵國。
    // Task #609 — defenderNationId: null 表示明確攻打無人地帶（JSON null 穿透）。
    const defenderNationId = body.defenderNationId;
    if (
      defenderNationId !== undefined &&
      defenderNationId !== null &&
      (typeof defenderNationId !== "string" || defenderNationId.length === 0)
    ) {
      res.status(400).json({ error: "指定的目標國家無效" });
      return;
    }
    try {
      const campaign = await initiateCampaign({
        attackerNationId: player.nation.id,
        attackerRegionId,
        defenderRegionId,
        ...(defenderNationId !== undefined ? { defenderNationId: defenderNationId as string | null } : {}),
      });
      const names = await loadCampaignNames([campaign], player.nation.id);
      res.json(toListItem(campaign, player.nation.id, names.get(campaign.id)!));
    } catch (err) {
      if (err instanceof WarActionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "initiate war campaign failed");
      res.status(500).json({ error: "發起戰役失敗，請稍後再試" });
    }
  });

  // ── 戰役詳情 ───────────────────────────────────────────────────

  router.get("/war/campaigns/:id", async (req, res) => {
    const ctx = await requireCampaignParticipant(req, res);
    if (!ctx) return;
    const { campaign, nation, userId, mySide } = ctx;
    // Task #453 — 對手主帥＝對面那方的主帥（偵查趨勢／停戰顯示對象）。
    const opponentNationId =
      mySide === "attacker"
        ? campaign.defenderNationId
        : campaign.attackerNationId;
    const participants = await loadParticipants(campaign.id);
    const enemyNationIds = participants
      .filter((p) => p.side !== mySide)
      .map((p) => p.nationId);
    if (!enemyNationIds.includes(opponentNationId)) {
      enemyNationIds.push(opponentNationId);
    }

    const [
      names,
      myLegions,
      availableUnits,
      myOrderRows,
      reconRows,
      warRow,
      trendRows,
    ] = await Promise.all([
        loadCampaignNames([campaign], nation.id),
        buildMyLegionsView(campaign.id, nation.id, userId),
        buildAvailableUnits(userId, nation.id),
        db
          .select()
          .from(warCampaignOrdersTable)
          .where(
            and(
              eq(warCampaignOrdersTable.campaignId, campaign.id),
              eq(warCampaignOrdersTable.nationId, nation.id),
              eq(warCampaignOrdersTable.cycleNumber, campaign.cycleNumber),
            ),
          )
          .orderBy(asc(warCampaignOrdersTable.orderType)),
        db
          .select({ cycleNumber: warCampaignOrdersTable.cycleNumber })
          .from(warCampaignOrdersTable)
          .where(
            and(
              eq(warCampaignOrdersTable.campaignId, campaign.id),
              eq(warCampaignOrdersTable.nationId, nation.id),
              eq(warCampaignOrdersTable.orderType, "recon"),
            ),
          ),
        db
          .select()
          .from(diplomacyWarsTable)
          .where(eq(diplomacyWarsTable.id, campaign.warId))
          .limit(1),
        // Task #417 — 對手全國軍力快照趨勢（由舊到新，最多 14 點；只取聚合
        // 人口值，絕不外洩兵種編制），數值套 fuzzValue 依偵查等級模糊化。
        db
          .select({
            date: sql<string>`to_char(${nationMilitarySnapshotsTable.snapshotDate}, 'YYYY-MM-DD')`,
            armyPopulation: nationMilitarySnapshotsTable.armyPopulation,
          })
          .from(nationMilitarySnapshotsTable)
          .where(eq(nationMilitarySnapshotsTable.nationId, opponentNationId))
          .orderBy(asc(nationMilitarySnapshotsTable.snapshotDate)),
      ]);

    const reconLevel = reconLevelFromOrders(
      reconRows.map((r) => r.cycleNumber),
      campaign.cycleNumber,
    );

    // 敵方軍團模糊視圖（Task #453 — 含敵方所有參戰國的軍團）。
    const enemyLegions = await db
      .select()
      .from(warCampaignLegionsTable)
      .where(
        and(
          eq(warCampaignLegionsTable.campaignId, campaign.id),
          inArray(warCampaignLegionsTable.nationId, enemyNationIds),
        ),
      );
    const enemyLegionIds = enemyLegions.map((l) => l.id);
    const enemyUnits =
      enemyLegionIds.length > 0
        ? await db
            .select({
              quantity: warCampaignLegionUnitsTable.quantity,
              wounded: warCampaignLegionUnitsTable.wounded,
            })
            .from(warCampaignLegionUnitsTable)
            .where(inArray(warCampaignLegionUnitsTable.legionId, enemyLegionIds))
        : [];
    const enemyTroops = enemyUnits.reduce((s, u) => s + u.quantity, 0);
    const enemyWounded = enemyUnits.reduce((s, u) => s + u.wounded, 0);
    const enemyMorale =
      enemyLegions.length > 0
        ? Math.round(
            enemyLegions.reduce((s, l) => s + l.morale, 0) / enemyLegions.length,
          )
        : 0;
    const seedBase = `${campaign.id}:${campaign.cycleNumber}:enemy`;

    // Task #453 — 參戰國名單（雙方所有國家，含晚加入者）。
    const participantNationIds = participants.map((p) => p.nationId);
    const participantNations = participantNationIds.length
      ? await db
          .select({
            id: playerNationsTable.id,
            name: playerNationsTable.name,
            isNpc: playerNationsTable.isNpc,
          })
          .from(playerNationsTable)
          .where(inArray(playerNationsTable.id, participantNationIds))
      : [];
    const pNationById = new Map(participantNations.map((n) => [n.id, n]));

    const war = warRow[0];
    res.json({
      ...toListItem(campaign, nation.id, names.get(campaign.id)!, mySide),
      participants: participants.map((p) => ({
        nationId: p.nationId,
        nationName: pNationById.get(p.nationId)?.name ?? "未知國家",
        side: p.side,
        isLead: p.isLead,
        isNpc: pNationById.get(p.nationId)?.isNpc ?? false,
        isMe: p.nationId === nation.id,
      })),
      terrainBrief: campaign.terrainBrief,
      attackerCityState: serializeCityStateView(campaign.attackerCityState),
      defenderCityState: serializeCityStateView(campaign.defenderCityState),
      myLegions,
      enemy: {
        reconLevel,
        legionCount: enemyLegions.length,
        totalTroops: fuzzValue(enemyTroops, reconLevel, `${seedBase}:troops`),
        totalWounded: fuzzValue(enemyWounded, reconLevel, `${seedBase}:wounded`),
        averageMorale: Math.min(
          100,
          fuzzValue(enemyMorale, reconLevel, `${seedBase}:morale`),
        ),
        // Task #417 — 對手全國軍力趨勢（每回合快照，最多 14 點），每點依偵查
        // 等級套 fuzzValue（seed 綁日期，同一天內數值穩定不跳動）。
        armyTrend: trendRows.slice(-14).map((p) => ({
          date: p.date,
          armyPopulation: fuzzValue(
            p.armyPopulation,
            reconLevel,
            `${campaign.id}:${opponentNationId}:trend:${p.date}`,
          ),
        })),
      },
      availableUnits,
      mercenaryLocked: await hasActiveMercenaryContract(nation.id),
      myOrders: myOrderRows.map((o) => ({
        orderType: o.orderType,
        body: o.body,
      })),
      ceasefire: {
        proposedByNationId: war?.ceasefireProposedBy ?? null,
        proposedByMe: war?.ceasefireProposedBy === nation.id,
      },
    });
  });
}
