import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  diplomacyWarsTable,
  diplomacyRelationsTable,
  parliamentLogTable,
  parliamentStateTable,
} from "@workspace/db";
import { logger } from "./logger";
import { canonicalPair } from "./diplomacy";
import { recordTerritoryChanges } from "./territoryHistory";
import { governmentLabel, governmentSlugByLabel, DEFAULT_GOVERNMENT_SLUG } from "./governments";
import { parliamentTier, planRevolutionSplit } from "./parliament/core";
import {
  INCUMBENT_VICTORY_STABILITY,
  REBEL_VICTORY_STABILITY,
  VICTORY_GOVERNMENT,
  judgeCivilWar,
  rebelNationName,
  splitRatioFor,
  type RebelIdeology,
} from "./civilWarCore";

type Nation = typeof playerNationsTable.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 革命方在起事時的政體(還沒贏,先用預設;贏了才轉成意識形態對應的終點政體)。 */
const REBEL_START_GOVERNMENT: Record<RebelIdeology, string> = {
  red: "council_system",
  black: "military_dictatorship",
  parliament: DEFAULT_GOVERNMENT_SLUG,
};

export type StartCivilWarResult =
  | { started: true; warId: number; rebelNationId: string; transferredRegions: number }
  | { started: false; reason: "no_territory" | "already_civil_war" };

/**
 * 爆發奪權內戰:從 `incumbent`(原政權)切出一部分土地給新建的 NPC 革命方,
 * 寫下帶有內戰標記的戰爭(無法停戰、必須消滅對方)。
 * 沒有土地可切時回傳 no_territory,由呼叫端決定後備處置(例如直接換政體)。
 */
export async function startCivilWar(
  tx: Tx,
  incumbent: Nation,
  ideology: RebelIdeology,
  tick: number,
  cause: string,
): Promise<StartCivilWarResult> {
  // 一個原政權同時只會有一場內戰
  const existing = await tx
    .select({ id: diplomacyWarsTable.id })
    .from(diplomacyWarsTable)
    .where(and(eq(diplomacyWarsTable.isCivilWar, true), isNull(diplomacyWarsTable.endedAt), sql`(${diplomacyWarsTable.nationAId} = ${incumbent.id} OR ${diplomacyWarsTable.nationBId} = ${incumbent.id})`))
    .limit(1);
  if (existing.length > 0) return { started: false, reason: "already_civil_war" };

  const controls = await tx
    .select({ regionId: regionControlsTable.regionId, percent: regionControlsTable.percent, name: mapRegionsTable.name })
    .from(regionControlsTable)
    .innerJoin(mapRegionsTable, eq(mapRegionsTable.id, regionControlsTable.regionId))
    .where(eq(regionControlsTable.nationId, incumbent.id));

  const slug = governmentSlugByLabel(incumbent.government);
  const originIsAutocracy = parliamentTier(slug ?? undefined) === "autocracy";
  const plan = planRevolutionSplit(
    controls.map((c) => ({ regionId: c.regionId, percent: c.percent })),
    splitRatioFor(ideology, originIsAutocracy),
  );
  if (plan.mode === "regime_change" || plan.transfers.length === 0) return { started: false, reason: "no_territory" };

  const nameOf = new Map(controls.map((c) => [c.regionId, c.name]));
  const [rebel] = await tx
    .insert(playerNationsTable)
    .values({
      name: rebelNationName(nameOf.get(plan.transfers[0]!.regionId), ideology),
      government: governmentLabel(REBEL_START_GOVERNMENT[ideology]) ?? governmentLabel(DEFAULT_GOVERNMENT_SLUG)!,
      isNpc: true,
    })
    .returning();
  if (!rebel) throw new Error("建立革命方失敗");

  const changes: Parameters<typeof recordTerritoryChanges>[1] = [];
  for (const t of plan.transfers) {
    const cur = controls.find((c) => c.regionId === t.regionId)!;
    const left = Math.max(0, cur.percent - Math.round(t.percent));
    const moved = cur.percent - left;
    if (moved <= 0) continue;
    if (left <= 0) {
      await tx.delete(regionControlsTable).where(and(eq(regionControlsTable.nationId, incumbent.id), eq(regionControlsTable.regionId, t.regionId)));
    } else {
      await tx.update(regionControlsTable).set({ percent: left }).where(and(eq(regionControlsTable.nationId, incumbent.id), eq(regionControlsTable.regionId, t.regionId)));
    }
    await tx.insert(regionControlsTable).values({ regionId: t.regionId, nationId: rebel.id, percent: moved });
    changes.push(
      { nationId: incumbent.id, regionId: t.regionId, percentBefore: cur.percent, percentAfter: left, changeType: "revolution", reason: `${cause}:${moved}% 控制度被「${rebel.name}」奪走` },
      { nationId: rebel.id, regionId: t.regionId, percentBefore: 0, percentAfter: moved, changeType: "revolution", reason: `${cause}:自「${incumbent.name}」分裂` },
    );
  }
  if (changes.length === 0) {
    // 什麼都沒切到:撤銷剛建的革命方,視同沒有可切的土地
    await tx.delete(playerNationsTable).where(eq(playerNationsTable.id, rebel.id));
    return { started: false, reason: "no_territory" };
  }
  await recordTerritoryChanges(tx, changes);

  const { low, high } = canonicalPair(rebel.id, incumbent.id);
  await tx.insert(diplomacyRelationsTable).values({ nationAId: low, nationBId: high, score: -100 }).onConflictDoNothing();
  const [war] = await tx
    .insert(diplomacyWarsTable)
    .values({
      nationAId: low, nationBId: high, declaredByNationId: rebel.id,
      isCivilWar: true, rebelNationId: rebel.id, rebelIdeology: ideology,
    })
    .returning({ id: diplomacyWarsTable.id });
  await tx.insert(parliamentLogTable).values({
    nationId: incumbent.id, tick, kind: "revolution",
    summary: `${cause}:「${rebel.name}」奪取 ${changes.length / 2} 處領地並開啟內戰,雙方不會停戰,直到一方被完全消滅。`,
    satDelta: 0,
  });
  return { started: true, warId: war!.id, rebelNationId: rebel.id, transferredRegions: changes.length / 2 };
}

/** 一個國家目前的總控制度(無土地 = 0)。 */
async function landOf(tx: Tx, nationId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`COALESCE(SUM(${regionControlsTable.percent}), 0)::int` })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.nationId, nationId));
  return r?.n ?? 0;
}

export interface CivilWarSettleSummary { checked: number; incumbentWon: number; rebelWon: number; failed: number }

/**
 * 每回合判定內戰勝負。必須排在 NPC 除名檢查「之前」:
 * 除名會連同戰爭列一併 CASCADE 刪除,屆時就沒有人能領取勝利結算。
 * 每場戰爭一個交易、單場失敗不影響其他場,且可重跑(自癒)。
 */
export async function settleCivilWars(): Promise<CivilWarSettleSummary> {
  const wars = await db
    .select()
    .from(diplomacyWarsTable)
    .where(and(eq(diplomacyWarsTable.isCivilWar, true), isNull(diplomacyWarsTable.endedAt)));
  const out: CivilWarSettleSummary = { checked: wars.length, incumbentWon: 0, rebelWon: 0, failed: 0 };
  for (const w of wars) {
    try {
      const won = await db.transaction(async (tx) => settleOne(tx, w));
      if (won === "incumbent") out.incumbentWon++;
      else if (won === "rebel") out.rebelWon++;
    } catch (err) {
      out.failed++;
      logger.error({ err, warId: w.id }, "civil war settlement failed");
    }
  }
  return out;
}

async function settleOne(
  tx: Tx,
  w: typeof diplomacyWarsTable.$inferSelect,
): Promise<"incumbent" | "rebel" | null> {
  if (!w.rebelNationId || !w.rebelIdeology) return null; // 資料不完整:不動它
  const rebelId = w.rebelNationId;
  const incumbentId = w.nationAId === rebelId ? w.nationBId : w.nationAId;
  const outcome = judgeCivilWar(await landOf(tx, incumbentId), await landOf(tx, rebelId));
  if (!outcome.finished) return null;

  // 原子認領:只有第一個把 ended_at 從 NULL 設值的人能繼續(避免重複結算)
  const claimed = await tx
    .update(diplomacyWarsTable)
    .set({ endedAt: new Date(), ceasefireProposedBy: null })
    .where(and(eq(diplomacyWarsTable.id, w.id), isNull(diplomacyWarsTable.endedAt)))
    .returning({ id: diplomacyWarsTable.id });
  if (claimed.length === 0) return null;

  const [incumbent] = await tx.select().from(playerNationsTable).where(eq(playerNationsTable.id, incumbentId));
  const [rebel] = await tx.select().from(playerNationsTable).where(eq(playerNationsTable.id, rebelId));
  const ideology = w.rebelIdeology as RebelIdeology;
  const [ps] = await tx.select({ tick: parliamentStateTable.tick }).from(parliamentStateTable).where(eq(parliamentStateTable.nationId, incumbentId));
  const tick = ps?.tick ?? 0; // 寫進議會日誌用;該國沒有議會狀態就記 0

  if (outcome.winner === "incumbent") {
    if (incumbent) {
      await tx
        .update(playerNationsTable)
        .set({ stability: sql`LEAST(100, ${playerNationsTable.stability} + ${INCUMBENT_VICTORY_STABILITY})` })
        .where(eq(playerNationsTable.id, incumbentId));
      await tx.insert(parliamentLogTable).values({
        nationId: incumbentId, tick, kind: "revolution",
        summary: `平定內亂:${outcome.reason}。政權保住了,人心稍安。`, satDelta: 0,
      });
    }
    return "incumbent";
  }

  // 革命方勝:原政權 nation 保留身分(玩家綁定/科技/軍隊),政體改成意識形態對應的終點;
  // 革命方若是 NPC,其土地併回原政權 nation 後,該 NPC 留給除名檢查刪除。
  if (incumbent) {
    const target = governmentLabel(VICTORY_GOVERNMENT[ideology]);
    await tx
      .update(playerNationsTable)
      .set({
        ...(target ? { government: target } : {}),
        stability: sql`GREATEST(0, ${playerNationsTable.stability} + ${REBEL_VICTORY_STABILITY})`,
      })
      .where(eq(playerNationsTable.id, incumbentId));
    await tx.insert(parliamentLogTable).values({
      nationId: incumbentId, tick, kind: "revolution",
      summary: `革命成功:${outcome.reason}。國家改制為「${target ?? incumbent.government}」。`, satDelta: 0,
    });
  }
  if (rebel?.isNpc) {
    const rebelControls = await tx.select().from(regionControlsTable).where(eq(regionControlsTable.nationId, rebelId));
    for (const c of rebelControls) {
      // 一般情況下原政權已無土地,保險起見仍用 upsert 併入
      await tx
        .insert(regionControlsTable)
        .values({ regionId: c.regionId, nationId: incumbentId, percent: c.percent })
        .onConflictDoUpdate({
          target: [regionControlsTable.regionId, regionControlsTable.nationId],
          set: { percent: sql`LEAST(100, ${regionControlsTable.percent} + ${c.percent})` },
        });
    }
    await tx.delete(regionControlsTable).where(eq(regionControlsTable.nationId, rebelId));
  }
  return "rebel";
}
