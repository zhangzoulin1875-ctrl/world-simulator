import { eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
  TECH_TREE_DOMAINS,
  type PlayerNation,
  type TechTreeDomain,
  type TechTreeNode,
} from "@workspace/db";
import { getEraIndex, isEraSlug } from "./mapRegionEras";
import { DEFAULT_ALLOCATION, computeNodeStatuses } from "./techTree";
import {
  loadDomainNodes,
  loadResearchedNodeIdSet,
  loadTechTreeStates,
  type DbOrTx,
} from "./techTreeData";
import { startTechTreeResearch } from "./techTreeResearch";
import { resolveNpcTechEras } from "./npcTech";
import { logger } from "./logger";

/**
 * Task #481 — NPC 國家沿全球線性科技樹「逐格研發」（取代整代跳級的時代指標制）。
 *
 * - **初始化（lazy）**：NPC 無任何 player_tech_tree_state 列時，依其三領域
 *   「有效時代」（舊時代指標夾世界時代；null = 跟隨世界）一次性授予：
 *   時代嚴格早於有效時代的全部主幹線＋關鍵科技節點、以及有效時代當代的
 *   關鍵科技節點（保持與舊「時代指標 = 視同擁有該時代以下全部關鍵科技」
 *   的解鎖語義一致），領域時代設為有效時代、分配比例用預設值。
 * - **確定性自動選研（無 AI）**：每回合各領域若無進行中節點，從「可研發且
 *   節點時代 ≤ 世界時代」的候選中挑最早時代→主幹優先→sort_order→id 最小者
 *   開始研發（成本走與玩家相同的 researchCost 管線；NPC 不研發超前世界時代
 *   的節點，維持「NPC 永不超越世界時代」的刻意設計）。
 * - **鏡像指標**：player_nations.techEra* 保留為 NPC 樹狀態的唯讀鏡像
 *   （worldSim 快照／AI prompt／warEngine clamp 等讀取端沿用），初始化與
 *   領域時代推進時寫回。
 */

const NPC_POINTER_COLUMN = {
  military: "techEraMilitary",
  social: "techEraSocial",
  production: "techEraProduction",
} as const satisfies Record<
  TechTreeDomain,
  "techEraMilitary" | "techEraSocial" | "techEraProduction"
>;

/** ensureNpcTechTreeInit／resync 需要的最小國家形狀。 */
export interface NpcTechTreeNation {
  id: string;
  discordUserId: string | null;
  techEraMilitary: string | null;
  techEraSocial: string | null;
  techEraProduction: string | null;
}

/** NPC 領域時代鏡像寫回（僅無主／NPC 國家）。 */
export async function syncNpcTechEraMirror(
  dbc: DbOrTx,
  nationId: string,
  domain: TechTreeDomain,
  eraSlug: string,
): Promise<void> {
  await dbc
    .update(playerNationsTable)
    .set({ [NPC_POINTER_COLUMN[domain]]: eraSlug })
    .where(eq(playerNationsTable.id, nationId));
}

/**
 * 初始化寫入核心（無存在性檢查、不自建交易）：依三領域有效時代授予節點、
 * upsert 領域狀態、寫回時代鏡像。供 ensureNpcTechTreeInit 與管理員批次工具
 * （keyTechAdmin，於呼叫端交易內）共用。nodesByDomain 可預載避免重複查詢。
 */
export async function initNpcTechTreeFromPointers(
  dbc: DbOrTx,
  nation: NpcTechTreeNation,
  worldEraSlug: string,
  nodesByDomain?: Partial<Record<TechTreeDomain, TechTreeNode[]>>,
): Promise<void> {
  const eras = resolveNpcTechEras(nation, worldEraSlug);
  for (const domain of TECH_TREE_DOMAINS) {
    const effSlug = eras[domain];
    const effIdx = getEraIndex(effSlug);
    const nodes =
      nodesByDomain?.[domain] ?? (await loadDomainNodes(domain, dbc));
    const grantIds = nodes
      .filter((n) => {
        if (!isEraSlug(n.eraSlug)) return false;
        const idx = getEraIndex(n.eraSlug);
        if (idx < effIdx) return n.lineKind === "main" || n.keySlug !== null;
        if (idx === effIdx) return n.keySlug !== null;
        return false;
      })
      .map((n) => n.id);
    if (grantIds.length > 0) {
      await dbc
        .insert(playerResearchedTreeNodesTable)
        .values(grantIds.map((nodeId) => ({ nationId: nation.id, nodeId })))
        .onConflictDoNothing();
    }
    await dbc
      .insert(playerTechTreeStateTable)
      .values({
        nationId: nation.id,
        domain,
        eraSlug: effSlug,
        ratioPct: DEFAULT_ALLOCATION[domain],
      })
      .onConflictDoNothing();
    await syncNpcTechEraMirror(dbc, nation.id, domain, effSlug);
  }
}

/**
 * NPC 科技樹狀態 lazy 初始化（idempotent）：已有任何 state 列 → no-op。
 * 回傳是否本次執行了初始化。
 */
export async function ensureNpcTechTreeInit(
  nation: NpcTechTreeNation,
  worldEraSlug: string,
): Promise<boolean> {
  if (nation.discordUserId !== null) return false;
  const [existing] = await db
    .select({ id: playerTechTreeStateTable.id })
    .from(playerTechTreeStateTable)
    .where(eq(playerTechTreeStateTable.nationId, nation.id))
    .limit(1);
  if (existing) return false;

  await db.transaction(async (tx) => {
    await initNpcTechTreeFromPointers(tx, nation, worldEraSlug);
  });
  logger.info(
    { nationId: nation.id },
    "npc tech tree: initialized from era pointers",
  );
  return true;
}

/**
 * 管理員直接改動 NPC 的 techEra* 指標後重新同步：整組刪除該國樹狀態列並
 * 依新指標重新初始化（管理員語義 = 直接設定該國科技水準）。
 */
export async function resyncNpcTechTreeToPointers(
  nation: NpcTechTreeNation,
  worldEraSlug: string,
): Promise<void> {
  if (nation.discordUserId !== null) return;
  await db.transaction(async (tx) => {
    await tx
      .delete(playerResearchedTreeNodesTable)
      .where(eq(playerResearchedTreeNodesTable.nationId, nation.id));
    await tx
      .delete(playerTechTreeStateTable)
      .where(eq(playerTechTreeStateTable.nationId, nation.id));
  });
  await ensureNpcTechTreeInit(nation, worldEraSlug);
}

function pickCandidate(
  nodes: TechTreeNode[],
  statuses: ReturnType<typeof computeNodeStatuses>,
  worldEraIdx: number,
): TechTreeNode | null {
  const candidates = nodes.filter((n) => {
    if (statuses.get(n.id)?.status !== "available") return false;
    if (!isEraSlug(n.eraSlug)) return false;
    return getEraIndex(n.eraSlug) <= worldEraIdx;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ea = getEraIndex(a.eraSlug);
    const eb = getEraIndex(b.eraSlug);
    if (ea !== eb) return ea - eb;
    if (a.lineKind !== b.lineKind) return a.lineKind === "main" ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id - b.id;
  });
  return candidates[0];
}

/**
 * NPC 確定性自動選研：各領域若無進行中節點，挑選一個候選並開始研發
 * （沿用玩家的 startTechTreeResearch race-safe 寫入與成本快照管線）。
 * 回傳本次開始研發的領域數。
 */
export async function autoPickNpcResearch(
  nation: PlayerNation,
  worldEraSlug: string,
): Promise<number> {
  if (nation.discordUserId !== null) return 0;
  const worldEraIdx = isEraSlug(worldEraSlug) ? getEraIndex(worldEraSlug) : 0;
  const states = await loadTechTreeStates(nation.id);
  let started = 0;
  for (const domain of TECH_TREE_DOMAINS) {
    const state = states[domain];
    if (state.activeNodeId !== null) continue;
    const [nodes, researchedIds] = await Promise.all([
      loadDomainNodes(domain),
      loadResearchedNodeIdSet(nation.id, domain),
    ]);
    const statuses = computeNodeStatuses({
      nodes,
      researchedIds,
      domainEraSlug: state.eraSlug,
      activeNodeId: null,
    });
    const candidate = pickCandidate(nodes, statuses, worldEraIdx);
    if (!candidate) continue;
    const r = await startTechTreeResearch({
      nation,
      nodeId: candidate.id,
      expectedDomain: domain,
    });
    if (r.ok) {
      started += 1;
    } else if (r.status !== 409) {
      logger.warn(
        { nationId: nation.id, domain, nodeId: candidate.id, error: r.error },
        "npc tech tree: auto research start failed",
      );
    }
  }
  return started;
}
