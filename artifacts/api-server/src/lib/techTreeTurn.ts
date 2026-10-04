import { TECH_TREE_RESEARCH_ENABLED } from "./techTreeFlags";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  nationPopulationBuffsTable,
  playerNationsTable,
  playerTechTreeStateTable,
  techTreeNodesTable,
  type PlayerNation,
  type TechTreeNode,
} from "@workspace/db";
import { TECH_TREE_DOMAIN_LABELS, type TechTreeAllocation } from "./techTree";
import { allocateResearchPoints } from "./researchAllocation";
import { grantNode, refreshDomainEra, type DbOrTx } from "./techTreeData";
import { TEMP_POP_GROWTH_TURNS } from "./production";
import {
  notifyTechTreeEraAdvanced,
  notifyTechTreeResearchComplete,
} from "./gameNotify";
import {
  autoPickNpcResearch,
  ensureNpcTechTreeInit,
  syncNpcTechEraMirror,
} from "./npcTechTree";
import { getEraSlugs } from "./nationStats";
import { logger } from "./logger";

/**
 * Task #469 — 回合制研發結算（科研點數不可累積）。
 *
 * 每日回合針對每個國家：把當回合科研產出（techGain）依三領域的
 * ratio_pct 以最大餘數法拆分（Task #548，總和守恆＝整數收入），灌入各
 * 領域「進行中節點」的 progress_points；沒有進行中節點或比例為 0 的
 * 份額直接作廢（不轉移、不累積）。進度達到成本快照 → 研發完成：授予
 * 節點、清空進行中狀態、站內通知、重算領域時代（主幹線全完成 → 推進
 * 並通知）。完成時超過成本的溢出點數：玩家國家退回庫存 tech_points
 * （下回合自動消化）；NPC／無主國家作廢（Task #548）。
 *
 * Task #481 — 改鍵到 nation_id；NPC（discord_user_id = null）也逐格走樹：
 * 結算前先 lazy 初始化＋確定性自動選研（npcTechTree.ts），通知只發給
 * 有主玩家，NPC 的領域時代推進會同步寫回 player_nations.techEra* 鏡像。
 *
 * Race safety：每領域一個 db.transaction；灌點用 conditional UPDATE
 * （WHERE active_node_id 不變），完成清空同樣鎖定 active_node_id，
 * 玩家中途取消／切換研發不會被覆蓋。
 */

/**
 * 節點完成的一次性副作用：生產科技帶 tempPopulationGrowth 效果 →
 * 寫入暫時人口增長 buff（沿用三牌組時代的規則；buff 表以
 * discord_user_id 為鍵，NPC 無此副作用）。
 */
export async function applyNodeCompletionEffects(
  dbc: DbOrTx,
  discordUserId: string | null,
  node: TechTreeNode,
): Promise<void> {
  if (discordUserId === null) return;
  if (node.domain !== "production") return;
  const effects = node.effects as { target?: string; value?: number }[];
  for (const eff of effects) {
    if (eff.target === "tempPopulationGrowth" && typeof eff.value === "number") {
      await dbc.insert(nationPopulationBuffsTable).values({
        discordUserId,
        growthPct: eff.value,
        remainingTurns: TEMP_POP_GROWTH_TURNS,
        source: node.name,
      });
    }
  }
}

export interface TechTreeTurnSummary {
  nations: number;
  pointsApplied: number;
  /** Task #524 — 本回合被研發吸收的庫存科技點數（player_nations.tech_points）。 */
  stockConsumed: number;
  completed: number;
  erasAdvanced: number;
  npcInitialized: number;
  npcResearchStarted: number;
  failures: number;
}

/**
 * 單一國家的回合研發結算。techGain ≤ 0 且無庫存可吸收時直接跳過。
 *
 * Task #524 — 庫存科技點自動消化：玩家國家（discordUserId 非 null）先照
 * 現行邏輯灌入自產科研點，再把庫存科技點（player_nations.tech_points）依
 * 領域分配比例拆分投入各領域「進行中節點」，吸收上限 = 該節點剩餘所需
 * 成本；以交易＋條件式 UPDATE（tech_points ≥ 消耗量）只扣實際吸收量，
 * 溢出／無進行中節點的份額留在庫存下回合再消化。自產點「未分配／無進
 * 行中即作廢」不變；完成節點的溢出改退玩家庫存（Task #548）。
 * NPC／無主國家不消化庫存（維持現狀）。
 */
export async function settleNationResearch(params: {
  nationId: string;
  discordUserId: string | null;
  techGain: number;
}): Promise<{
  pointsApplied: number;
  stockConsumed: number;
  completed: number;
  erasAdvanced: number;
}> {
  const { nationId, discordUserId, techGain } = params;
  const result = {
    pointsApplied: 0,
    stockConsumed: 0,
    completed: 0,
    erasAdvanced: 0,
  };

  // 庫存科技點（只有玩家國家消化；NPC／無主國家維持現狀）。
  let stock = 0;
  if (discordUserId !== null) {
    const [row] = await db
      .select({ techPoints: playerNationsTable.techPoints })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .limit(1);
    stock = Math.max(0, row?.techPoints ?? 0);
  }
  if (techGain <= 0 && stock <= 0) return result;

  const states = await db
    .select()
    .from(playerTechTreeStateTable)
    .where(eq(playerTechTreeStateTable.nationId, nationId));

  // Task #548 — 自產科研點以最大餘數法拆分（總和守恆＝整數收入；與總覽
  // 路由 perTurnPoints 同一個純函式）。無進行中節點／比例 0 的份額照設計
  // 作廢。庫存拆分沿用 floor（餘數留在庫存，不會丟失）。
  const ratios: TechTreeAllocation = { social: 0, production: 0, military: 0 };
  for (const state of states) {
    if (state.domain in ratios) {
      ratios[state.domain as keyof TechTreeAllocation] = state.ratioPct;
    }
  }
  const gainAlloc = allocateResearchPoints(Math.max(0, techGain), ratios);

  for (const state of states) {
    if (state.activeNodeId === null || state.ratioPct <= 0) continue;
    const points = gainAlloc[state.domain as keyof TechTreeAllocation] ?? 0;
    const stockShare = Math.floor((stock * state.ratioPct) / 100);
    if (points <= 0 && stockShare <= 0) continue;

    const outcome = await db.transaction(async (tx) => {
      // 灌點：conditional UPDATE 鎖定 active_node_id（玩家可能同時取消/換研）。
      // points 可能為 0（純庫存吸收回合）——仍執行以鎖定並取回現值。
      const [updated] = await tx
        .update(playerTechTreeStateTable)
        .set({
          progressPoints: sql`${playerTechTreeStateTable.progressPoints} + ${points}`,
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(playerTechTreeStateTable.id, state.id),
            eq(playerTechTreeStateTable.activeNodeId, state.activeNodeId!),
          ),
        )
        .returning({
          progressPoints: playerTechTreeStateTable.progressPoints,
          costSnapshot: playerTechTreeStateTable.costSnapshot,
          activeNodeId: playerTechTreeStateTable.activeNodeId,
        });
      if (!updated || updated.activeNodeId === null) {
        return {
          applied: 0,
          stockUsed: 0,
          completedNodeId: null as number | null,
        };
      }
      const cost = updated.costSnapshot ?? 0;
      let progress = updated.progressPoints;
      let applied = points;
      let stockUsed = 0;

      // Task #524 — 庫存吸收：只吸「剩餘所需」，條件式扣款保證不扣成負值
      // （同回合條約結算／並發結算下，扣款失敗＝本回合略過，庫存不動）。
      if (stockShare > 0 && progress < cost) {
        const absorb = Math.min(stockShare, cost - progress);
        const deducted = await tx
          .update(playerNationsTable)
          .set({
            techPoints: sql`${playerNationsTable.techPoints} - ${absorb}`,
          })
          .where(
            and(
              eq(playerNationsTable.id, nationId),
              sql`${playerNationsTable.techPoints} >= ${absorb}`,
            ),
          )
          .returning({ id: playerNationsTable.id });
        if (deducted.length > 0) {
          const [after] = await tx
            .update(playerTechTreeStateTable)
            .set({
              progressPoints: sql`${playerTechTreeStateTable.progressPoints} + ${absorb}`,
              updatedAt: sql`NOW()`,
            })
            .where(
              and(
                eq(playerTechTreeStateTable.id, state.id),
                eq(
                  playerTechTreeStateTable.activeNodeId,
                  updated.activeNodeId,
                ),
              ),
            )
            .returning({
              progressPoints: playerTechTreeStateTable.progressPoints,
            });
          // 同一交易內第一個 UPDATE 已鎖定 state 列，這裡必定成功。
          progress = after?.progressPoints ?? progress + absorb;
          stockUsed = absorb;
          applied += absorb;
        }
      }

      if (progress < cost) {
        return { applied, stockUsed, completedNodeId: null as number | null };
      }
      // Task #548 — 完成溢出退庫存：超過成本快照的自產點數（庫存吸收有
      // 上限＝剩餘所需，不會溢出）退回玩家國家的 tech_points，下回合自動
      // 消化；NPC／無主國家維持歸零作廢。
      const overflow = Math.max(0, progress - cost);
      if (overflow > 0 && discordUserId !== null) {
        await tx
          .update(playerNationsTable)
          .set({
            techPoints: sql`${playerNationsTable.techPoints} + ${overflow}`,
          })
          .where(eq(playerNationsTable.id, nationId));
      }
      // 完成：授予節點＋清空進行中（progress 歸零；玩家溢出已退庫存）。
      const granted = await grantNode(tx, nationId, updated.activeNodeId);
      if (granted) {
        const [nodeRow] = await tx
          .select()
          .from(techTreeNodesTable)
          .where(eq(techTreeNodesTable.id, updated.activeNodeId))
          .limit(1);
        if (nodeRow) {
          await applyNodeCompletionEffects(tx, discordUserId, nodeRow);
        }
      }
      await tx
        .update(playerTechTreeStateTable)
        .set({
          activeNodeId: null,
          costSnapshot: null,
          progressPoints: 0,
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(playerTechTreeStateTable.id, state.id),
            eq(playerTechTreeStateTable.activeNodeId, updated.activeNodeId),
          ),
        );
      return { applied, stockUsed, completedNodeId: updated.activeNodeId };
    });

    result.pointsApplied += outcome.applied;
    result.stockConsumed += outcome.stockUsed;
    if (outcome.completedNodeId === null) continue;
    result.completed += 1;

    const domain = state.domain as keyof typeof TECH_TREE_DOMAIN_LABELS;
    if (discordUserId !== null) {
      const [node] = await db
        .select({ name: techTreeNodesTable.name })
        .from(techTreeNodesTable)
        .where(eq(techTreeNodesTable.id, outcome.completedNodeId))
        .limit(1);
      notifyTechTreeResearchComplete({
        discordUserId,
        domainLabel: TECH_TREE_DOMAIN_LABELS[domain] ?? state.domain,
        techName: node?.name ?? "未知科技",
      });
    }

    // 時代推進判定（主幹線全完成 → 進入下一時代）。
    const before = state.eraSlug;
    const after = await refreshDomainEra(db, nationId, domain);
    if (after !== before) {
      result.erasAdvanced += 1;
      if (discordUserId !== null) {
        notifyTechTreeEraAdvanced({
          discordUserId,
          domainLabel: TECH_TREE_DOMAIN_LABELS[domain] ?? state.domain,
          eraSlug: after,
        });
      } else {
        // NPC：領域時代鏡像寫回 player_nations.techEra*（worldSim／戰爭引擎讀取端）。
        await syncNpcTechEraMirror(db, nationId, domain, after);
      }
    }
  }
  return result;
}

/** runTechTreeResearchTurn 的輸入：一國本回合的科研產出。 */
export interface NationResearchEntry {
  nation: PlayerNation;
  techGain: number;
}

/**
 * 全部國家的回合研發結算。輸入 = 本回合各國科研產出（由回合引擎在國家
 * 迴圈中收集；含 NPC／無主國家）。NPC／無主國家先 lazy 初始化樹狀態＋
 * 確定性自動選研，再與玩家走同一套結算。單一國家失敗只記 log。
 */
export async function runTechTreeResearchTurn(
  entries: readonly NationResearchEntry[],
): Promise<TechTreeTurnSummary> {
  const summary: TechTreeTurnSummary = {
    nations: 0,
    pointsApplied: 0,
    stockConsumed: 0,
    completed: 0,
    erasAdvanced: 0,
    npcInitialized: 0,
    npcResearchStarted: 0,
    failures: 0,
  };
  // 科技樹已下線(關鍵技術改依世界時代解鎖):不再把科研點灌進任何節點,
  // 也不消耗玩家庫存科技點(tech_points),留給日後的國策樹使用。
  if (!TECH_TREE_RESEARCH_ENABLED) return summary;
  const { currentEra: worldEra } = await getEraSlugs();
  for (const { nation, techGain } of entries) {
    try {
      if (nation.discordUserId === null) {
        if (await ensureNpcTechTreeInit(nation, worldEra)) {
          summary.npcInitialized += 1;
        }
        summary.npcResearchStarted += await autoPickNpcResearch(
          nation,
          worldEra,
        );
      }
      const r = await settleNationResearch({
        nationId: nation.id,
        discordUserId: nation.discordUserId,
        techGain,
      });
      summary.nations += 1;
      summary.pointsApplied += r.pointsApplied;
      summary.stockConsumed += r.stockConsumed;
      summary.completed += r.completed;
      summary.erasAdvanced += r.erasAdvanced;
    } catch (err) {
      summary.failures += 1;
      logger.error(
        { err, nationId: nation.id },
        "tech tree turn: nation research settlement failed",
      );
    }
  }
  return summary;
}
