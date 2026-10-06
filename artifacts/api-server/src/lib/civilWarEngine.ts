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
import { endCampaignsForNation } from "./warEngine/endCampaign";
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
  /**
   * `nation` 是誰:
   *  - "incumbent"(預設):`nation` 是原政權,切出 X% 給新建的 NPC 革命方。
   *  - "rebel":`nation` 是發動革命的一方(玩家奪權),它只留下 X%,
   *    其餘 (1-X)% 歸新建的 NPC「原政權」。
   */
  side: "incumbent" | "rebel" = "incumbent",
  /**
   * 指定只從這些地區切出革命方的土地(革命浪潮:壓力滿 100 的地區)。
   * 這些地區的控制度會「整塊」(100%)交給革命方,不再套用意識形態的切分比例。
   * 只在 side = "incumbent" 時有意義;未指定則維持原本按比例挑地區的行為。
   */
  onlyRegionIds?: readonly number[],
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
  const only = onlyRegionIds && side === "incumbent" ? new Set(onlyRegionIds) : null;
  const plan = only
    ? {
        mode: "split" as const,
        transfers: controls
          .filter((c) => only.has(c.regionId) && c.percent > 0)
          .map((c) => ({ regionId: c.regionId, percent: c.percent })),
      }
    : planRevolutionSplit(
        controls.map((c) => ({ regionId: c.regionId, percent: c.percent })),
        splitRatioFor(ideology, originIsAutocracy),
      );
  if (plan.mode === "regime_change" || plan.transfers.length === 0) return { started: false, reason: "no_territory" };

  const nameOf = new Map(controls.map((c) => [c.regionId, c.name]));
  // 新建的 NPC:side=incumbent 時是革命方;side=rebel 時是「舊政權的殘餘」(沿用玩家原政體)
  const [created] = await tx
    .insert(playerNationsTable)
    .values(
      side === "incumbent"
        ? {
            name: rebelNationName(nameOf.get(plan.transfers[0]!.regionId), ideology),
            government: governmentLabel(REBEL_START_GOVERNMENT[ideology]) ?? governmentLabel(DEFAULT_GOVERNMENT_SLUG)!,
            isNpc: true,
          }
        : {
            name: `${incumbent.name}舊政權`.slice(0, 25).replace(/[\s\p{P}]/gu, ""),
            government: incumbent.government,
            isNpc: true,
          },
    )
    .returning();
  if (!created) throw new Error("建立內戰對手失敗");
  // 誰拿「切出來的那部分土地」= 革命方;另一方 = 原政權
  const rebel = side === "incumbent" ? created : incumbent;
  const old = side === "incumbent" ? incumbent : created; // 「原政權」這一側
  // 土地從 incumbent(現有玩家國)搬到 created(新建 NPC):
  //  - side=incumbent:搬的是革命方應得的 transfers(X%)。
  //  - side=rebel:玩家是革命方,只留下 transfers(X%),其餘每區全搬給新 NPC(原政權)。
  const keepByRegion = new Map(plan.transfers.map((t) => [t.regionId, Math.round(t.percent)]));
  const toMove = controls.map((c) => {
    const want = keepByRegion.get(c.regionId) ?? 0;
    const moved = side === "incumbent" ? want : c.percent - Math.min(c.percent, want);
    return { regionId: c.regionId, before: c.percent, moved: Math.min(c.percent, Math.max(0, moved)) };
  }).filter((m) => m.moved > 0);

  const changes: Parameters<typeof recordTerritoryChanges>[1] = [];
  for (const m of toMove) {
    const left = m.before - m.moved;
    if (left <= 0) {
      await tx.delete(regionControlsTable).where(and(eq(regionControlsTable.nationId, incumbent.id), eq(regionControlsTable.regionId, m.regionId)));
    } else {
      await tx.update(regionControlsTable).set({ percent: left }).where(and(eq(regionControlsTable.nationId, incumbent.id), eq(regionControlsTable.regionId, m.regionId)));
    }
    await tx.insert(regionControlsTable).values({ regionId: m.regionId, nationId: created.id, percent: m.moved });
    changes.push(
      { nationId: incumbent.id, regionId: m.regionId, percentBefore: m.before, percentAfter: left, changeType: "revolution", reason: `${cause}:${m.moved}% 控制度轉入「${created.name}」` },
      { nationId: created.id, regionId: m.regionId, percentBefore: 0, percentAfter: m.moved, changeType: "revolution", reason: `${cause}:自「${incumbent.name}」分出` },
    );
  }
  // 革命方必須真的拿到土地,否則不成立(例如 side=rebel 卻什麼都沒搬,代表玩家吃下全部)
  const rebelGotLand = side === "incumbent" ? toMove.length > 0 : toMove.length > 0 && keepByRegion.size > 0;
  if (!rebelGotLand) {
    await tx.delete(playerNationsTable).where(eq(playerNationsTable.id, created.id));
    return { started: false, reason: "no_territory" };
  }
  await recordTerritoryChanges(tx, changes);

  const { low, high } = canonicalPair(rebel.id, old.id);
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
    summary: side === "incumbent"
      ? `${cause}:「${rebel.name}」奪取 ${changes.length / 2} 處領地並開啟內戰,雙方不會停戰,直到一方被完全消滅。`
      : `${cause}:你發動革命,舊政權「${old.name}」佔據其餘領地,雙方不會停戰,直到一方被完全消滅。`,
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

interface SettleOneResult { winner: "incumbent" | "rebel"; eliminatePlayerId: string | null }

/** 真人玩家在內戰中被消滅:與玩家自己刪國同一流程(先終止戰役通知對手,再刪國;其餘 CASCADE)。 */
async function eliminatePlayerNation(nationId: string): Promise<void> {
  try {
    await endCampaignsForNation(nationId);
  } catch (err) {
    logger.error({ err, nationId }, "civil war: failed to end campaigns before eliminating player");
  }
  const deleted = await db
    .delete(playerNationsTable)
    .where(and(eq(playerNationsTable.id, nationId), eq(playerNationsTable.isNpc, false)))
    .returning({ id: playerNationsTable.id });
  if (deleted.length > 0) logger.info({ nationId }, "civil war: player nation eliminated, back to nation creation");
}

export interface CivilWarSettleSummary { checked: number; incumbentWon: number; rebelWon: number; failed: number; playersEliminated: number }

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
  const out: CivilWarSettleSummary = { checked: wars.length, incumbentWon: 0, rebelWon: 0, failed: 0, playersEliminated: 0 };
  for (const w of wars) {
    try {
      const r = await db.transaction(async (tx) => settleOne(tx, w));
      if (!r) continue;
      if (r.winner === "incumbent") out.incumbentWon++;
      else out.rebelWon++;
      // 交易已提交:現在才做有外部副作用的淘汰(終止戰役/Discord 通知/刪國)
      if (r.eliminatePlayerId) {
        await eliminatePlayerNation(r.eliminatePlayerId);
        out.playersEliminated++;
      }
    } catch (err) {
      out.failed++;
      logger.error({ err, warId: w.id }, "civil war settlement failed");
    }
  }
  out.playersEliminated += await sweepUneliminatedLosers();
  return out;
}

/**
 * 自癒:內戰已標記結束,但敗方真人玩家還在(例如提交後、刪國前程序中斷)。
 * 只依結算時記下的 loser_nation_id 補做淘汰(不靠土地推論,否則勝方日後在別場戰爭失地會被誤殺)。
 */
async function sweepUneliminatedLosers(): Promise<number> {
  const recent = await db
    .select({ id: diplomacyWarsTable.id, loserNationId: diplomacyWarsTable.loserNationId })
    .from(diplomacyWarsTable)
    .where(and(
      eq(diplomacyWarsTable.isCivilWar, true),
      sql`${diplomacyWarsTable.endedAt} IS NOT NULL`,
      sql`${diplomacyWarsTable.loserNationId} IS NOT NULL`,
      sql`${diplomacyWarsTable.endedAt} > NOW() - INTERVAL '2 days'`,
    ));
  let n = 0;
  for (const w of recent) {
    try {
      // 只淘汰「結算時記下的敗方」,且它必須仍是真人玩家國(NPC 歸除名檢查管)
      const [nat] = await db.select({ isNpc: playerNationsTable.isNpc })
        .from(playerNationsTable).where(eq(playerNationsTable.id, w.loserNationId!));
      if (!nat || nat.isNpc) continue;
      await eliminatePlayerNation(w.loserNationId!);
      n++;
    } catch (err) {
      logger.error({ err, warId: w.id }, "civil war: sweep of defeated player failed");
    }
  }
  return n;
}

async function settleOne(
  tx: Tx,
  w: typeof diplomacyWarsTable.$inferSelect,
): Promise<SettleOneResult | null> {
  if (!w.rebelNationId || !w.rebelIdeology) return null; // 資料不完整:不動它
  const rebelId = w.rebelNationId;
  const incumbentId = w.nationAId === rebelId ? w.nationBId : w.nationAId;
  const outcome = judgeCivilWar(await landOf(tx, incumbentId), await landOf(tx, rebelId));
  if (!outcome.finished) return null;

  // 原子認領:只有第一個把 ended_at 從 NULL 設值的人能繼續(避免重複結算);同時記下敗方
  const claimedLoserId = outcome.winner === "rebel" ? incumbentId : rebelId;
  const claimed = await tx
    .update(diplomacyWarsTable)
    .set({ endedAt: new Date(), ceasefireProposedBy: null, loserNationId: claimedLoserId })
    .where(and(eq(diplomacyWarsTable.id, w.id), isNull(diplomacyWarsTable.endedAt)))
    .returning({ id: diplomacyWarsTable.id });
  if (claimed.length === 0) return null;

  const [incumbent] = await tx.select().from(playerNationsTable).where(eq(playerNationsTable.id, incumbentId));
  const [rebel] = await tx.select().from(playerNationsTable).where(eq(playerNationsTable.id, rebelId));
  const ideology = w.rebelIdeology as RebelIdeology;

  // 以「勝方 / 敗方」為主軸(不論玩家站哪一邊,規則都一樣)
  let eliminatePlayerId: string | null = null;
  const winnerIsRebel = outcome.winner === "rebel";
  const winnerId = winnerIsRebel ? rebelId : incumbentId;
  const loserId = claimedLoserId;
  const winner = winnerIsRebel ? rebel : incumbent;
  const loser = winnerIsRebel ? incumbent : rebel;

  const [ps] = await tx.select({ tick: parliamentStateTable.tick }).from(parliamentStateTable).where(eq(parliamentStateTable.nationId, winnerId));
  const tick = ps?.tick ?? 0; // 寫進議會日誌用;該國沒有議會狀態就記 0

  if (winner) {
    if (winnerIsRebel) {
      // 革命成功:勝方 nation 保留身分(玩家綁定/科技/軍隊),政體改成意識形態對應的終點
      const target = governmentLabel(VICTORY_GOVERNMENT[ideology]);
      await tx
        .update(playerNationsTable)
        .set({
          ...(target ? { government: target } : {}),
          stability: sql`GREATEST(0, ${playerNationsTable.stability} + ${REBEL_VICTORY_STABILITY})`,
        })
        .where(eq(playerNationsTable.id, winnerId));
      await tx.insert(parliamentLogTable).values({
        nationId: winnerId, tick, kind: "revolution",
        summary: `革命成功:${outcome.reason}。國家改制為「${target ?? winner.government}」。`, satDelta: 0,
      });
    } else {
      await tx
        .update(playerNationsTable)
        .set({ stability: sql`LEAST(100, ${playerNationsTable.stability} + ${INCUMBENT_VICTORY_STABILITY})` })
        .where(eq(playerNationsTable.id, winnerId));
      await tx.insert(parliamentLogTable).values({
        nationId: winnerId, tick, kind: "revolution",
        summary: `平定內亂:${outcome.reason}。政權保住了,人心稍安。`, satDelta: 0,
      });
    }
  }

  if (loser) {
    if (loser.isNpc) {
      // 敗方是 NPC:殘餘土地(通常已是 0)併給勝方,NPC 本身留給除名檢查刪除
      const loserControls = await tx.select().from(regionControlsTable).where(eq(regionControlsTable.nationId, loserId));
      for (const c of loserControls) {
        await tx
          .insert(regionControlsTable)
          .values({ regionId: c.regionId, nationId: winnerId, percent: c.percent })
          .onConflictDoUpdate({
            target: [regionControlsTable.regionId, regionControlsTable.nationId],
            set: { percent: sql`LEAST(100, ${regionControlsTable.percent} + ${c.percent})` },
          });
      }
      await tx.delete(regionControlsTable).where(eq(regionControlsTable.nationId, loserId));
    } else {
      // 敗方是真人玩家:視同被消滅,走一般流程(終止戰役通知對手 → 刪國),玩家回到建國畫面。
      // 終止戰役會用獨立連線寫入並發 Discord 通知(外部副作用),不能放進交易;
      // 這裡只登記,交易提交後才處理(順序與 DELETE /player/nation 相同)。
      eliminatePlayerId = loserId;
    }
  }
  return { winner: winnerIsRebel ? "rebel" : "incumbent", eliminatePlayerId };
}
