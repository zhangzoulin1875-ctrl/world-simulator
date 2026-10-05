import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerArmiesTable,
  militaryUnitTemplatesTable,
  playerWoundedUnitsTable,
  politicsEntriesTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignOrdersTable,
  type PlayerNation,
} from "@workspace/db";
import { logger } from "../../logger";
import { ERAS, getEraIndex } from "../../mapRegionEras";
import { applyTechBonuses } from "../../military";
import { legionInitialMorale } from "../../militaryPolitics";
import { effectiveMilitaryObedience } from "../../politics";
import { loadResearchedMilitaryTechs } from "../../militaryTechData";
import {
  allocateProportionally,
  computeAvailable,
  validateLegionsInput,
  WAR_ORDER_TYPES,
  type LegionInput,
} from "../../war";
import {
  generateNpcOrders,
  NPC_FALLBACK_ORDERS,
  type WarCycleLegionInput,
  type WarCycleSideInput,
} from "../../warAi";

/**
 * Task #244 — 元帥（軍事）領域：戰場軍團編制與本週期指令下達。
 *
 * 由 runDomain 呼叫，為進行中戰役自動編制軍團並下達四類戰場指令。原
 * domains/military.ts 內的定義純搬移至此，行為與交易守衛皆不變。此檔不依賴 ../index。
 */

// ── 戰場指揮：為進行中戰役下達本週期指令 ───────────────────────

/**
 * 海上登陸戰役的攻方總兵力上限:把軍團配置按比例縮到 cap 以內(純函式)。
 *
 * 內閣元帥/AI 託管自動組軍團原本會把全國可用兵力 100% 投入,無視海上登陸容許量
 * (玩家回報:對方在單場跨海戰役派出十幾萬人)。手動 PUT /legions 本來就有同樣檢查,
 * 這裡補上自動路徑。總和 ≤ cap;cap 為 null 或總兵力未超過 → 原樣回傳。
 * 以 allocateProportionally(largest remainder)分配,各兵種按原比例縮、總和恰為 cap。
 */
export function capLegionsToSeaLanding(
  legions: LegionInput[],
  cap: number | null,
): LegionInput[] {
  if (cap === null || !Number.isFinite(cap)) return legions;
  const flat: Array<{ li: number; ui: number; qty: number }> = [];
  legions.forEach((l, li) =>
    l.units.forEach((u, ui) => flat.push({ li, ui, qty: Math.max(0, u.quantity) })),
  );
  const total = flat.reduce((s, f) => s + f.qty, 0);
  const limit = Math.max(0, Math.floor(cap));
  if (total <= limit) return legions;
  const shares = allocateProportionally(
    flat.map((f) => f.qty),
    limit,
  );
  const scaled = new Map<string, number>();
  flat.forEach((f, i) => scaled.set(`${f.li}:${f.ui}`, shares[i] ?? 0));
  return legions
    .map((l, li) => ({
      ...l,
      units: l.units
        .map((u, ui) => ({ ...u, quantity: scaled.get(`${li}:${ui}`) ?? 0 }))
        .filter((u) => u.quantity > 0),
    }))
    .filter((l) => l.units.length > 0);
}

/** 把全國可用兵力（未派遣他役、未在傷兵池）編成軍團 A／B。 */
export async function autoFormLegions(nation: PlayerNation, eraSlug: string): Promise<void> {
  const userId = nation.discordUserId;
  if (!userId) return;
  const active = await db
    .select({
      id: warCampaignsTable.id,
      attackerNationId: warCampaignsTable.attackerNationId,
      defenderNationId: warCampaignsTable.defenderNationId,
      isSeaLanding: warCampaignsTable.isSeaLanding,
      seaLandingTroopCap: warCampaignsTable.seaLandingTroopCap,
    })
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.status, "active"),
        or(
          eq(warCampaignsTable.attackerNationId, nation.id),
          eq(warCampaignsTable.defenderNationId, nation.id),
        ),
      ),
    );
  if (active.length === 0) return;

  for (const campaign of active) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${"war-legions:" + userId}))`,
        );
        // 只在該戰役我方尚未部署任何軍團時自動編制（不動既有配置）。
        const existing = await tx
          .select({ id: warCampaignLegionsTable.id })
          .from(warCampaignLegionsTable)
          .where(
            and(
              eq(warCampaignLegionsTable.campaignId, campaign.id),
              eq(warCampaignLegionsTable.nationId, nation.id),
            ),
          )
          .limit(1);
        if (existing[0]) return;

        const armies = await tx
          .select({
            templateId: playerArmiesTable.templateId,
            quantity: playerArmiesTable.quantity,
          })
          .from(playerArmiesTable)
          .where(eq(playerArmiesTable.discordUserId, userId));
        if (armies.length === 0) return;

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

        // 每種兵種的可用量 = 持有 − 他役已派 − 傷兵池；取前 5 種投入。
        const availableUnits = armies
          .map((a) => ({
            templateId: a.templateId,
            available: computeAvailable(
              a.quantity,
              elsewhereBy.get(a.templateId) ?? 0,
              poolBy.get(a.templateId) ?? 0,
            ),
          }))
          .filter((u) => u.available > 0)
          .sort((x, y) => y.available - x.available)
          .slice(0, 5);
        if (availableUnits.length === 0) return;

        const isDefender = campaign.defenderNationId === nation.id;
        const formed: LegionInput[] = [
          {
            slot: "A",
            garrisoningCity: isDefender,
            units: availableUnits.map((u) => ({
              templateId: u.templateId,
              quantity: Math.ceil(u.available * 0.6),
            })),
          },
          {
            slot: "B",
            garrisoningCity: false,
            units: availableUnits
              .map((u) => ({
                templateId: u.templateId,
                quantity: Math.floor(u.available * 0.4),
              }))
              .filter((u) => u.quantity > 0),
          },
        ].filter((l) => l.units.length > 0);
        // 海上登陸戰役:攻方總投入不得超過登陸容許量(與手動 PUT /legions 同一口徑)。
        const legions = capLegionsToSeaLanding(
          formed,
          campaign.isSeaLanding && !isDefender ? campaign.seaLandingTroopCap : null,
        );
        if (validateLegionsInput(legions) !== null) return;

        // Task #402 — 初始士氣 = 有效軍方服從度（含 militaryObedience 政策偏移）。
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

        for (const legion of legions) {
          const [inserted] = await tx
            .insert(warCampaignLegionsTable)
            .values({
              campaignId: campaign.id,
              nationId: nation.id,
              slot: legion.slot,
              // Task #402 — 玩家新建軍團初始士氣 = 軍方服從度。
              morale: legionInitialMorale(obedience),
              supply: 100,
              garrisoningCity: legion.garrisoningCity ?? false,
            })
            .returning();
          if (!inserted) continue;
          const unitRows = legion.units
            .filter((u) => u.quantity > 0)
            .map((u) => ({
              legionId: inserted.id,
              templateId: u.templateId,
              quantity: u.quantity,
              wounded: 0,
            }));
          if (unitRows.length > 0) {
            await tx.insert(warCampaignLegionUnitsTable).values(unitRows);
          }
        }
      });
    } catch (err) {
      logger.warn(
        { err, campaignId: campaign.id, nationId: nation.id },
        "cabinet auto-form legions failed",
      );
    }
  }
}

/**
 * 為進行中戰役補齊我方本週期缺少的指令類型：玩家已下過的類型原封不動
 * （絕不覆蓋），僅對缺少的類型用 bulk AI 產生並寫入；四類皆已有 → 跳過。
 */
export async function autoIssueBattlefieldOrders(
  nation: PlayerNation,
  eraSlug: string,
  directive: string,
): Promise<void> {
  const active = await db
    .select()
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.status, "active"),
        or(
          eq(warCampaignsTable.attackerNationId, nation.id),
          eq(warCampaignsTable.defenderNationId, nation.id),
        ),
      ),
    );
  if (active.length === 0) return;

  const eraLabel = ERAS[getEraIndex(eraSlug)]?.label ?? eraSlug;

  for (const campaign of active) {
    try {
      // 只補「缺少的指令類型」：玩家已親自下過的類型絕不覆蓋（唯一索引＋
      // onConflictDoNothing 雙重保障），其餘類型由內閣代為補齊。
      const existingOrders = await db
        .select({ orderType: warCampaignOrdersTable.orderType })
        .from(warCampaignOrdersTable)
        .where(
          and(
            eq(warCampaignOrdersTable.campaignId, campaign.id),
            eq(warCampaignOrdersTable.nationId, nation.id),
            eq(warCampaignOrdersTable.cycleNumber, campaign.cycleNumber),
          ),
        );
      const existingTypes = new Set(existingOrders.map((o) => o.orderType));
      const missingTypes = WAR_ORDER_TYPES.filter(
        (t) => !existingTypes.has(t),
      );
      if (missingTypes.length === 0) continue;

      const isDefender = campaign.defenderNationId === nation.id;
      const opponentId = isDefender
        ? campaign.attackerNationId
        : campaign.defenderNationId;
      const [opponent] = await db
        .select({ name: playerNationsTable.name })
        .from(playerNationsTable)
        .where(eq(playerNationsTable.id, opponentId))
        .limit(1);

      const ownSide = await buildOwnSide(campaign.id, nation, eraSlug);
      const ownTroops = ownSide.legions
        .flatMap((l) => l.units)
        .reduce((s, u) => s + u.quantity, 0);
      const [oppRow] = await db
        .select({
          total: sql<string>`COALESCE(SUM(${warCampaignLegionUnitsTable.quantity}), 0)`,
        })
        .from(warCampaignLegionUnitsTable)
        .innerJoin(
          warCampaignLegionsTable,
          eq(warCampaignLegionUnitsTable.legionId, warCampaignLegionsTable.id),
        )
        .where(
          and(
            eq(warCampaignLegionsTable.campaignId, campaign.id),
            eq(warCampaignLegionsTable.nationId, opponentId),
          ),
        );
      const opponentTroops = Number(oppRow?.total ?? 0);
      const powerRatio = ownTroops / Math.max(1, opponentTroops);
      let orders = NPC_FALLBACK_ORDERS;
      try {
        orders = await generateNpcOrders({
          eraLabel,
          isDefenderSide: isDefender,
          ownSide,
          powerRatio,
          adminDirective: directive.trim() ? directive.trim() : null,
        });
      } catch (err) {
        logger.warn(
          { err, campaignId: campaign.id },
          "cabinet battlefield order generation failed, using fallback",
        );
      }

      for (const orderType of missingTypes) {
        await db
          .insert(warCampaignOrdersTable)
          .values({
            campaignId: campaign.id,
            nationId: nation.id,
            cycleNumber: campaign.cycleNumber,
            orderType,
            body: orders.command,
          })
          .onConflictDoNothing();
      }
    } catch (err) {
      logger.warn(
        { err, campaignId: campaign.id, nationId: nation.id },
        "cabinet battlefield command failed",
      );
    }
  }
}

/** 組出提供給戰役指令 AI 的我方現況（軍團＋兵種戰力）。城市狀態省略為 null。 */
async function buildOwnSide(
  campaignId: number,
  nation: PlayerNation,
  eraSlug: string,
): Promise<WarCycleSideInput> {
  const legions = await db
    .select()
    .from(warCampaignLegionsTable)
    .where(
      and(
        eq(warCampaignLegionsTable.campaignId, campaignId),
        eq(warCampaignLegionsTable.nationId, nation.id),
      ),
    )
    .orderBy(asc(warCampaignLegionsTable.slot));
  const legionIds = legions.map((l) => l.id);
  const units =
    legionIds.length > 0
      ? await db
          .select()
          .from(warCampaignLegionUnitsTable)
          .where(inArray(warCampaignLegionUnitsTable.legionId, legionIds))
      : [];
  const templateIds = [...new Set(units.map((u) => u.templateId))];
  const templates =
    templateIds.length > 0
      ? await db
          .select()
          .from(militaryUnitTemplatesTable)
          .where(inArray(militaryUnitTemplatesTable.id, templateIds))
      : [];
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const researched = nation.discordUserId
    ? await loadResearchedMilitaryTechs(nation.discordUserId)
    : [];

  const aiLegions: WarCycleLegionInput[] = legions.map((legion) => ({
    slot: legion.slot,
    morale: legion.morale,
    supply: legion.supply,
    garrisoningCity: legion.garrisoningCity,
    units: units
      .filter((u) => u.legionId === legion.id)
      .map((u) => {
        const template = templateById.get(u.templateId);
        const eff = template
          ? applyTechBonuses(template, researched)
          : { attack: 0, defense: 0, hp: 0 };
        return {
          name: template?.name ?? "未知兵種",
          category: template?.category ?? "infantry",
          quantity: u.quantity,
          wounded: u.wounded,
          attack: eff.attack,
          defense: eff.defense,
          hp: eff.hp,
          speed: template?.speed ?? 0,
          accuracy: template?.accuracy ?? 0,
          range: template?.range ?? "melee",
          antiCavalryPct: template?.antiCavalryPct ?? 0,
          antiRangedPct: template?.antiRangedPct ?? 0,
          siegePct: template?.siegePct ?? 0,
        };
      }),
  }));

  return {
    nationName: nation.name ?? "我方",
    isNpc: nation.isNpc,
    warWeariness: nation.warWeariness,
    attackModifierPct: 0,
    seaLandingReductionPct: null,
    cityState: null,
    legions: aiLegions,
    orders: [],
  };
}
