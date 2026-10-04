import { loadMercenaryUnitsForCampaign } from "../../lib/mercenaryService";
import { type IRouter } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerArmiesTable,
  militaryUnitTemplatesTable,
  playerUnitCustomizationsTable,
  playerWoundedUnitsTable,
  mapRegionsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignParticipantsTable,
  type PlayerNation,
  type WarCampaign,
  type WarCampaignParticipant,
  type WarCityState,
  type WarReportCity,
} from "@workspace/db";
import { WALL_TIER_LABELS, durabilityPct } from "../../lib/wall";
import { getSession, readSessionToken } from "../../lib/sessions";
import { computeAvailable } from "../../lib/war";

/** WarCityState → API 視圖：逐城附上城牆階級標籤與耐久百分比（Task #150）。 */
export function serializeCityStateView(state: WarCityState | null | undefined) {
  if (!state) return null;
  return {
    cities: state.cities.map((c) => ({
      cityId: c.cityId,
      name: c.name,
      wallTier: c.wallTier,
      wallTierLabel: WALL_TIER_LABELS[c.wallTier],
      durability: c.durability,
      maxDurability: c.maxDurability,
      durabilityPct: durabilityPct(c),
    })),
    garrisoned: state.garrisoned,
  };
}

/** 戰報逐城城牆狀態 → API 視圖（附標籤與耐久百分比）。舊戰報 → null。 */
export function serializeReportCities(cities: WarReportCity[] | undefined) {
  if (!cities) return null;
  return cities.map((c) => ({
    cityId: c.cityId,
    name: c.name,
    wallTier: c.wallTier,
    wallTierLabel: WALL_TIER_LABELS[c.wallTier],
    durability: c.durability,
    maxDurability: c.maxDurability,
    durabilityPct:
      c.maxDurability > 0
        ? Math.round((c.durability / c.maxDurability) * 100)
        : 0,
  }));
}

/** 交易內丟出 → rollback 並轉成對應 HTTP 狀態。 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{ nation: PlayerNation; userId: string } | null> {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return null;
  }
  const userId = session.discordUserId;
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!nation) {
    res.status(400).json({ error: "尚未建國，請先在玩家首頁建立或接手國家" });
    return null;
  }
  return { nation, userId };
}

export function parseId(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// ── 共用視圖建構 ───────────────────────────────────────────────

/** 兵種顯示名稱（玩家自訂名優先）。 */
export async function loadDisplayNames(
  userId: string,
  templateIds: number[],
): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (templateIds.length === 0) return names;
  const templates = await db
    .select({
      id: militaryUnitTemplatesTable.id,
      name: militaryUnitTemplatesTable.name,
    })
    .from(militaryUnitTemplatesTable)
    .where(inArray(militaryUnitTemplatesTable.id, templateIds));
  for (const t of templates) names.set(t.id, t.name);
  const customs = await db
    .select({
      templateId: playerUnitCustomizationsTable.templateId,
      customName: playerUnitCustomizationsTable.customName,
    })
    .from(playerUnitCustomizationsTable)
    .where(
      and(
        eq(playerUnitCustomizationsTable.discordUserId, userId),
        inArray(playerUnitCustomizationsTable.templateId, templateIds),
      ),
    );
  for (const c of customs) names.set(c.templateId, c.customName);
  return names;
}

interface LegionView {
  /** 傭兵團代管的軍團(戰力於結算時動態計算),玩家不可編輯。 */
  mercenary: { companyName: string; troops: number; attack: number; defense: number } | null;
  slot: string;
  morale: number;
  supply: number;
  garrisoningCity: boolean;
  units: {
    templateId: number;
    name: string;
    quantity: number;
    wounded: number;
  }[];
}

/** 己方軍團完整視圖。 */
export async function buildMyLegionsView(
  campaignId: number,
  nationId: string,
  userId: string,
): Promise<LegionView[]> {
  const legions = await db
    .select()
    .from(warCampaignLegionsTable)
    .where(
      and(
        eq(warCampaignLegionsTable.campaignId, campaignId),
        eq(warCampaignLegionsTable.nationId, nationId),
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
          .orderBy(asc(warCampaignLegionUnitsTable.id))
      : [];
  const names = await loadDisplayNames(userId, [
    ...new Set(units.map((u) => u.templateId)),
  ]);
  const mercUnits = await loadMercenaryUnitsForCampaign(campaignId);
  return legions.map((l) => {
    const m = mercUnits.get(`${nationId}:${l.slot}`);
    return {
    mercenary: m
      ? { companyName: m.name, troops: m.quantity, attack: m.attack, defense: m.defense }
      : null,
    slot: l.slot,
    morale: l.morale,
    supply: l.supply,
    garrisoningCity: l.garrisoningCity,
    units: units
      .filter((u) => u.legionId === l.id)
      .map((u) => ({
        templateId: u.templateId,
        name: names.get(u.templateId) ?? "未知兵種",
        quantity: u.quantity,
        wounded: u.wounded,
      })),
  };
  });
}

interface AvailableUnitView {
  templateId: number;
  name: string;
  owned: number;
  committed: number;
  woundedPool: number;
  available: number;
}

/** 可派遣兵力視圖：持有 − 所有進行中戰役已派（含前線傷兵） − 全國傷兵池。 */
export async function buildAvailableUnits(
  userId: string,
  nationId: string,
): Promise<AvailableUnitView[]> {
  const armies = await db
    .select({
      templateId: playerArmiesTable.templateId,
      quantity: playerArmiesTable.quantity,
    })
    .from(playerArmiesTable)
    .where(eq(playerArmiesTable.discordUserId, userId));
  const pools = await db
    .select({
      templateId: playerWoundedUnitsTable.templateId,
      wounded: playerWoundedUnitsTable.wounded,
    })
    .from(playerWoundedUnitsTable)
    .where(eq(playerWoundedUnitsTable.discordUserId, userId));
  const committedRows = await db
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
        eq(warCampaignLegionsTable.nationId, nationId),
        eq(warCampaignsTable.status, "active"),
      ),
    )
    .groupBy(warCampaignLegionUnitsTable.templateId);

  const ownedBy = new Map<number, number>();
  for (const a of armies) ownedBy.set(a.templateId, a.quantity);
  const poolBy = new Map<number, number>();
  for (const p of pools) poolBy.set(p.templateId, p.wounded);
  const committedBy = new Map<number, number>();
  for (const c of committedRows) committedBy.set(c.templateId, Number(c.total));

  const allIds = [
    ...new Set([...ownedBy.keys(), ...poolBy.keys(), ...committedBy.keys()]),
  ];
  const names = await loadDisplayNames(userId, allIds);
  return allIds
    .map((templateId) => {
      const owned = ownedBy.get(templateId) ?? 0;
      const committed = committedBy.get(templateId) ?? 0;
      const woundedPool = poolBy.get(templateId) ?? 0;
      return {
        templateId,
        name: names.get(templateId) ?? "未知兵種",
        owned,
        committed,
        woundedPool,
        available: computeAvailable(owned, committed, woundedPool),
      };
    })
    .filter((u) => u.owned > 0 || u.committed > 0 || u.woundedPool > 0)
    .sort((a, b) => a.templateId - b.templateId);
}

interface CampaignNames {
  opponentName: string;
  attackerRegionName: string;
  defenderRegionName: string;
}

/** Task #453 — 對手＝我方所屬那一方的「對面主帥」。 */
function opponentLeadId(
  c: WarCampaign,
  myNationId: string,
  mySide?: "attacker" | "defender",
): string {
  const side =
    mySide ?? (c.attackerNationId === myNationId ? "attacker" : "defender");
  return side === "attacker" ? c.defenderNationId : c.attackerNationId;
}

export async function loadCampaignNames(
  campaigns: WarCampaign[],
  myNationId: string,
  mySideOf?: Map<number, "attacker" | "defender">,
): Promise<Map<number, CampaignNames>> {
  const nationIds = new Set<string>();
  const regionIds = new Set<number>();
  for (const c of campaigns) {
    nationIds.add(opponentLeadId(c, myNationId, mySideOf?.get(c.id)));
    regionIds.add(c.attackerRegionId);
    regionIds.add(c.defenderRegionId);
  }
  const nations = nationIds.size
    ? await db
        .select({
          id: playerNationsTable.id,
          name: playerNationsTable.name,
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
  const nationName = new Map(nations.map((n) => [n.id, n.name ?? "未知國家"]));
  const regionName = new Map(regions.map((r) => [r.id, r.name]));
  const out = new Map<number, CampaignNames>();
  for (const c of campaigns) {
    const opponentId = opponentLeadId(c, myNationId, mySideOf?.get(c.id));
    out.set(c.id, {
      opponentName: nationName.get(opponentId) ?? "未知國家",
      attackerRegionName: regionName.get(c.attackerRegionId) ?? "未知地區",
      defenderRegionName: regionName.get(c.defenderRegionId) ?? "未知地區",
    });
  }
  return out;
}

export function toListItem(
  c: WarCampaign,
  myNationId: string,
  names: CampaignNames,
  mySide?: "attacker" | "defender",
): Record<string, unknown> {
  const role =
    mySide ?? (c.attackerNationId === myNationId ? "attacker" : "defender");
  const isLead =
    role === "attacker"
      ? c.attackerNationId === myNationId
      : c.defenderNationId === myNationId;
  return {
    id: c.id,
    warId: c.warId,
    role,
    isLead,
    opponentNationId:
      role === "attacker" ? c.defenderNationId : c.attackerNationId,
    opponentName: names.opponentName,
    attackerRegionId: c.attackerRegionId,
    attackerRegionName: names.attackerRegionName,
    defenderRegionId: c.defenderRegionId,
    defenderRegionName: names.defenderRegionName,
    status: c.status,
    winnerNationId: c.winnerNationId,
    endReason: c.endReason,
    cycleNumber: c.cycleNumber,
    cycleHours: c.cycleHours,
    nextResolveAt: c.nextResolveAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
    endedAt: c.endedAt ? c.endedAt.toISOString() : null,
    isSeaLanding: c.isSeaLanding,
    landingAttackReductionPct: c.landingAttackReductionPct,
    seaLandingTroopCap: c.seaLandingTroopCap,
  };
}

/**
 * 載入戰役並驗證目前玩家是參戰方（含晚加入的參戰國，Task #453）；
 * 失敗時已回應。回傳我方陣營與是否主帥。
 */
export async function requireCampaignParticipant(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{
  campaign: WarCampaign;
  nation: PlayerNation;
  userId: string;
  mySide: "attacker" | "defender";
  isLead: boolean;
  participant: WarCampaignParticipant | null;
} | null> {
  const player = await requirePlayer(req, res);
  if (!player) return null;
  const id = parseId(req.params.id ?? "");
  if (id === null) {
    res.status(404).json({ error: "找不到指定的戰役" });
    return null;
  }
  const [campaign] = await db
    .select()
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, id))
    .limit(1);
  if (!campaign) {
    res.status(404).json({ error: "找不到指定的戰役" });
    return null;
  }
  const [participant] = await db
    .select()
    .from(warCampaignParticipantsTable)
    .where(
      and(
        eq(warCampaignParticipantsTable.campaignId, campaign.id),
        eq(warCampaignParticipantsTable.nationId, player.nation.id),
      ),
    )
    .limit(1);
  // 主帥兜底（回填前的舊列或極端競態）：主帥欄位仍視為參戰方。
  const leadSide: "attacker" | "defender" | null =
    campaign.attackerNationId === player.nation.id
      ? "attacker"
      : campaign.defenderNationId === player.nation.id
        ? "defender"
        : null;
  if (!participant && !leadSide) {
    res.status(403).json({ error: "你不是這場戰役的參戰方" });
    return null;
  }
  const mySide =
    (participant?.side as "attacker" | "defender" | undefined) ??
    (leadSide as "attacker" | "defender");
  return {
    campaign,
    nation: player.nation,
    userId: player.userId,
    mySide,
    isLead: participant ? participant.isLead : true,
    participant: participant ?? null,
  };
}
