import { oilLockedByTemplate } from "../../lib/oilRigService";
import { hasActiveMercenaryContract } from "../../lib/mercenaryService";
import { type IRouter } from "express";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  playerWoundedUnitsTable,
  politicsEntriesTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
} from "@workspace/db";
import { effectiveMilitaryObedience } from "../../lib/politics";
import {
  computeAvailable,
  validateLegionsInput,
  type LegionInput,
} from "../../lib/war";
import { legionInitialMorale } from "../../lib/militaryPolitics";
import {
  buildAvailableUnits,
  buildMyLegionsView,
  HttpError,
  requireCampaignParticipant,
} from "./shared";

export function registerWarLegionRoutes(router: IRouter): void {
  // ── 軍團配置（全量取代） ───────────────────────────────────────

  router.put("/war/campaigns/:id/legions", async (req, res) => {
    const ctx = await requireCampaignParticipant(req, res);
    if (!ctx) return;
    const { campaign, nation, userId } = ctx;
    if (await hasActiveMercenaryContract(nation.id)) {
      res.status(409).json({ error: "簽有傭兵合約期間,軍團由傭兵團代管,無法自行編組" });
      return;
    }
    if (campaign.status !== "active") {
      res.status(409).json({ error: "戰役已結束，無法調整軍團" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const legions = body.legions as LegionInput[];
    const validationError = validateLegionsInput(legions);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    // 兵種可見性：只限自己的自創兵種（Task #549 起預設兵種已全面移除）。
    const requestedTemplateIds = [
      ...new Set(legions.flatMap((l) => l.units.map((u) => u.templateId))),
    ];
    if (requestedTemplateIds.length > 0) {
      const templates = await db
        .select({
          id: militaryUnitTemplatesTable.id,
          ownerDiscordUserId: militaryUnitTemplatesTable.ownerDiscordUserId,
        })
        .from(militaryUnitTemplatesTable)
        .where(inArray(militaryUnitTemplatesTable.id, requestedTemplateIds));
      const visible = new Set(
        templates
          .filter((t) => t.ownerDiscordUserId === userId)
          .map((t) => t.id),
      );
      const invalid = requestedTemplateIds.find((id) => !visible.has(id));
      if (invalid !== undefined) {
        res.status(400).json({ error: "包含不存在或無權使用的兵種" });
        return;
      }
    }

    try {
      await db.transaction(async (tx) => {
        // 序列化同一玩家的所有軍團配置操作（跨戰役共用全國兵力）
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${"war-legions:" + userId}))`,
        );
        const [fresh] = await tx
          .select()
          .from(warCampaignsTable)
          .where(eq(warCampaignsTable.id, campaign.id))
          .limit(1);
        if (!fresh || fresh.status !== "active") {
          throw new HttpError(409, "戰役已結束，無法調整軍團");
        }

        const armies = await tx
          .select({
            templateId: playerArmiesTable.templateId,
            quantity: playerArmiesTable.quantity,
          })
          .from(playerArmiesTable)
          .where(eq(playerArmiesTable.discordUserId, userId));
        const ownedBy = new Map(armies.map((a) => [a.templateId, a.quantity]));

        const pools = await tx
          .select({
            templateId: playerWoundedUnitsTable.templateId,
            wounded: playerWoundedUnitsTable.wounded,
          })
          .from(playerWoundedUnitsTable)
          .where(eq(playerWoundedUnitsTable.discordUserId, userId));
        const poolBy = new Map(pools.map((p) => [p.templateId, p.wounded]));

        const elsewhereRows = await tx
          .select({
            templateId: warCampaignLegionUnitsTable.templateId,
            total: sql<string>`SUM(${warCampaignLegionUnitsTable.quantity} + ${warCampaignLegionUnitsTable.wounded})`,
          })
          .from(warCampaignLegionUnitsTable)
          .innerJoin(
            warCampaignLegionsTable,
            eq(warCampaignLegionsTable.id, warCampaignLegionUnitsTable.legionId),
          )
          .innerJoin(
            warCampaignsTable,
            eq(warCampaignsTable.id, warCampaignLegionsTable.campaignId),
          )
          .where(
            and(
              eq(warCampaignLegionsTable.nationId, nation.id),
              eq(warCampaignsTable.status, "active"),
              ne(warCampaignsTable.id, campaign.id),
            ),
          )
          .groupBy(warCampaignLegionUnitsTable.templateId);
        const elsewhereBy = new Map(
          elsewhereRows.map((r) => [r.templateId, Number(r.total)]),
        );
        // 油井戰役鎖定的艦隊也算「他處已派」(在同一交易內讀,與下方檢查一致)。
        for (const [templateId, locked] of await oilLockedByTemplate(nation.id, tx)) {
          elsewhereBy.set(templateId, (elsewhereBy.get(templateId) ?? 0) + locked);
        }

        // 既有配置：士氣／補給按槽位保留；傷兵按（槽位, 兵種）保留
        const existingLegions = await tx
          .select()
          .from(warCampaignLegionsTable)
          .where(
            and(
              eq(warCampaignLegionsTable.campaignId, campaign.id),
              eq(warCampaignLegionsTable.nationId, nation.id),
            ),
          );
        const existingLegionIds = existingLegions.map((l) => l.id);
        const existingUnits =
          existingLegionIds.length > 0
            ? await tx
                .select()
                .from(warCampaignLegionUnitsTable)
                .where(
                  inArray(warCampaignLegionUnitsTable.legionId, existingLegionIds),
                )
            : [];
        const legionSlotById = new Map(
          existingLegions.map((l) => [l.id, l.slot]),
        );
        const stateBySlot = new Map(
          existingLegions.map((l) => [
            l.slot,
            { morale: l.morale, supply: l.supply },
          ]),
        );
        // Task #402 — 新建軍團初始士氣 = 有效軍方服從度（含 militaryObedience 政策偏移）。
        const activePoliticsEntries = await tx
          .select()
          .from(politicsEntriesTable)
          .where(
            and(
              eq(politicsEntriesTable.nationId, nation.id),
              eq(politicsEntriesTable.status, "active"),
            ),
          );
        const obedience = effectiveMilitaryObedience(
          nation.militaryObedience,
          activePoliticsEntries,
        );

        const woundedByKey = new Map<string, number>();
        const existingWoundedByTemplate = new Map<number, number>();
        for (const u of existingUnits) {
          if (u.wounded <= 0) continue;
          const slot = legionSlotById.get(u.legionId)!;
          woundedByKey.set(`${slot}:${u.templateId}`, u.wounded);
          existingWoundedByTemplate.set(
            u.templateId,
            (existingWoundedByTemplate.get(u.templateId) ?? 0) + u.wounded,
          );
        }

        // 新配置保留的傷兵（槽位＋兵種都還在才保留），其餘移回全國傷兵池
        const keptWoundedByTemplate = new Map<number, number>();
        const requestedByTemplate = new Map<number, number>();
        for (const legion of legions) {
          for (const unit of legion.units) {
            requestedByTemplate.set(
              unit.templateId,
              (requestedByTemplate.get(unit.templateId) ?? 0) + unit.quantity,
            );
            const kept = woundedByKey.get(`${legion.slot}:${unit.templateId}`);
            if (kept) {
              keptWoundedByTemplate.set(
                unit.templateId,
                (keptWoundedByTemplate.get(unit.templateId) ?? 0) + kept,
              );
            }
          }
        }
        const releasedByTemplate = new Map<number, number>();
        for (const [templateId, total] of existingWoundedByTemplate) {
          const released = total - (keptWoundedByTemplate.get(templateId) ?? 0);
          if (released > 0) releasedByTemplate.set(templateId, released);
        }

        // 可用兵力檢查：requested ≤ owned − (pool＋移回池) − 他戰役已派 − 本戰役保留傷兵
        const allCheckIds = new Set([
          ...requestedByTemplate.keys(),
          ...keptWoundedByTemplate.keys(),
        ]);
        for (const templateId of allCheckIds) {
          const owned = ownedBy.get(templateId) ?? 0;
          const pool =
            (poolBy.get(templateId) ?? 0) +
            (releasedByTemplate.get(templateId) ?? 0);
          const elsewhere = elsewhereBy.get(templateId) ?? 0;
          const kept = keptWoundedByTemplate.get(templateId) ?? 0;
          const requested = requestedByTemplate.get(templateId) ?? 0;
          const available = computeAvailable(owned, elsewhere + kept, pool);
          if (requested > available) {
            throw new HttpError(400, "可用兵力不足，請先確認持有數量與傷兵狀況");
          }
        }

        // Task #152 — 海上登陸戰役：攻擊「方」投入兵力不得超過海上登陸
        // 容許量（Task #453 — 晚加入攻方的參戰國同樣受限）。
        if (
          fresh.isSeaLanding &&
          fresh.seaLandingTroopCap !== null &&
          ctx.mySide === "attacker"
        ) {
          let totalRequested = 0;
          for (const qty of requestedByTemplate.values()) totalRequested += qty;
          if (totalRequested > fresh.seaLandingTroopCap) {
            throw new HttpError(
              400,
              `此為海上登陸戰役，投入兵力上限為 ${fresh.seaLandingTroopCap.toLocaleString()}，請減少軍團兵力`,
            );
          }
        }

        // 全量取代：刪舊（cascade 兵種列）→ 插新
        if (existingLegionIds.length > 0) {
          await tx
            .delete(warCampaignLegionsTable)
            .where(inArray(warCampaignLegionsTable.id, existingLegionIds));
        }
        for (const legion of legions) {
          const prev = stateBySlot.get(legion.slot);
          const [inserted] = await tx
            .insert(warCampaignLegionsTable)
            .values({
              campaignId: campaign.id,
              nationId: nation.id,
              slot: legion.slot,
              // Task #402 — 新建軍團初始士氣 = 軍方服從度（沿用既有軍團士氣）。
              morale: prev?.morale ?? legionInitialMorale(obedience),
              supply: prev?.supply ?? 100,
              garrisoningCity: legion.garrisoningCity ?? false,
            })
            .returning();
          for (const unit of legion.units) {
            const wounded =
              woundedByKey.get(`${legion.slot}:${unit.templateId}`) ?? 0;
            if (unit.quantity <= 0 && wounded <= 0) continue;
            await tx.insert(warCampaignLegionUnitsTable).values({
              legionId: inserted!.id,
              templateId: unit.templateId,
              quantity: unit.quantity,
              wounded,
            });
          }
        }

        // 被移出配置的傷兵 → 全國傷兵池
        for (const [templateId, released] of releasedByTemplate) {
          await tx
            .insert(playerWoundedUnitsTable)
            .values({
              discordUserId: userId,
              templateId,
              wounded: released,
              initialWounded: released,
            })
            .onConflictDoUpdate({
              target: [
                playerWoundedUnitsTable.discordUserId,
                playerWoundedUnitsTable.templateId,
              ],
              set: {
                wounded: sql`${playerWoundedUnitsTable.wounded} + ${released}`,
                initialWounded: sql`${playerWoundedUnitsTable.initialWounded} + ${released}`,
              },
            });
        }
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err, campaignId: campaign.id }, "update legions failed");
      res.status(500).json({ error: "軍團配置更新失敗，請稍後再試" });
      return;
    }

    const [legionsView, availableUnits] = await Promise.all([
      buildMyLegionsView(campaign.id, nation.id, userId),
      buildAvailableUnits(userId, nation.id),
    ]);
    res.json({ legions: legionsView, availableUnits });
  });
}
