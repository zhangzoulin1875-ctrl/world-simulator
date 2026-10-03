import { desc, eq, or } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  diplomacyTreatiesTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { treatyTypeLabel } from "../../lib/diplomacy";

// ── 締約 ───────────────────────────────────────────────────────

export function serializeTreaty(
  treaty: DiplomacyTreaty,
  nameById: Map<string, string>,
  myId: string,
) {
  return {
    id: treaty.id,
    type: treaty.type,
    typeLabel: treatyTypeLabel(treaty.type),
    proposerNationId: treaty.proposerNationId,
    proposerName: nameById.get(treaty.proposerNationId) ?? "（未知國家）",
    targetNationId: treaty.targetNationId,
    targetName: nameById.get(treaty.targetNationId) ?? "（未知國家）",
    durationDays: treaty.durationDays,
    offerMoney: treaty.offerMoney,
    offerTechPoints: treaty.offerTechPoints,
    offerWood: treaty.offerWood,
    offerOre: treaty.offerOre,
    offerRegionIds: treaty.offerRegionIds,
    offerRegionPercents: treaty.offerRegionPercents,
    requestMoney: treaty.requestMoney,
    requestTechPoints: treaty.requestTechPoints,
    requestWood: treaty.requestWood,
    requestOre: treaty.requestOre,
    requestRegionIds: treaty.requestRegionIds,
    requestRegionPercents: treaty.requestRegionPercents,
    boundWarId: treaty.boundWarId,
    customClause: treaty.customClause,
    perTurnMoney: treaty.perTurnMoney,
    perTurnTech: treaty.perTurnTech,
    perTurnProduction: treaty.perTurnProduction,
    perTurnFood: treaty.perTurnFood,
    perTurnWood: treaty.perTurnWood,
    perTurnOre: treaty.perTurnOre,
    // Task #527 — 反向每回合經常性轉移（由 perTurn 付款方的對方支付）。
    requestPerTurnMoney: treaty.requestPerTurnMoney,
    requestPerTurnTech: treaty.requestPerTurnTech,
    requestPerTurnProduction: treaty.requestPerTurnProduction,
    requestPerTurnFood: treaty.requestPerTurnFood,
    requestPerTurnWood: treaty.requestPerTurnWood,
    requestPerTurnOre: treaty.requestPerTurnOre,
    proposerIsPayer: treaty.proposerIsPayer,
    tributePct: treaty.tributePct,
    proposerIsVassal: treaty.proposerIsVassal,
    status: treaty.status,
    isCounter: treaty.counterOfTreatyId !== null,
    responseNote: treaty.responseNote,
    awaitingMe:
      treaty.status === "proposed" && treaty.awaitingNationId === myId,
    acceptedAt: treaty.acceptedAt?.toISOString() ?? null,
    expiresAt: treaty.expiresAt?.toISOString() ?? null,
    createdAt: treaty.createdAt.toISOString(),
  };
}

export async function loadTreatyContext(myId: string) {
  const treaties = await db
    .select()
    .from(diplomacyTreatiesTable)
    .where(
      or(
        eq(diplomacyTreatiesTable.proposerNationId, myId),
        eq(diplomacyTreatiesTable.targetNationId, myId),
      ),
    )
    .orderBy(desc(diplomacyTreatiesTable.id))
    .limit(100);
  const nations = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
    })
    .from(playerNationsTable);
  const nameById = new Map<string, string>();
  for (const n of nations) nameById.set(n.id, n.name ?? "（未命名）");
  return { treaties, nameById };
}
