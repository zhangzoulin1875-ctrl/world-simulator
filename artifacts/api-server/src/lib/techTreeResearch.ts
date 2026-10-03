import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  playerTechTreeStateTable,
  techTreeNodesTable,
  type PlayerNation,
  type TechTreeDomain,
  type TechTreeNode,
} from "@workspace/db";
import {
  computeNodeStatuses,
  isNodeResearchable,
  isTechTreeDomain,
  validateAllocation,
  type TechTreeAllocation,
} from "./techTree";
import {
  ensureTechTreeStates,
  loadDomainNodes,
  loadResearchedNodeIdSet,
  loadTechTreeStates,
} from "./techTreeData";
import {
  adjustedResearchCost,
  getNationResearchCostMultiplierForDomain,
} from "./researchCost";

/**
 * Task #469 — 科技樹研發操作（選研／取消／比例分配）。
 *
 * 玩家路由（routes/techTree.ts）與內閣自動研發（cabinet domains）共用同一套
 * 守衛：同領域一次只能一項（409）、節點可研發判定（前置／時代／支線掛點）、
 * 成本快照 = 基礎成本 × 國力倍率 × 領先時代加價（lib/researchCost.ts 管線，
 * 選研當下計算並鎖定）。Race safety：conditional UPDATE（WHERE active_node_id
 * IS NULL）擋並發重複選研。
 */

export type TechTreeOpResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string };

/** 選定開始研發：成本快照鎖定；同領域已有進行中 → 409。以 nation.id 為鍵（Task #481）。 */
export async function startTechTreeResearch(params: {
  nation: PlayerNation;
  nodeId: number;
  /** 限定領域（內閣大臣只能動自己領域的科技樹；不符 → 400）。 */
  expectedDomain?: TechTreeDomain;
}): Promise<
  TechTreeOpResult<{ node: TechTreeNode; domain: TechTreeDomain; cost: number }>
> {
  const { nation, nodeId } = params;
  const [node] = await db
    .select()
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.id, nodeId))
    .limit(1);
  if (!node || !isTechTreeDomain(node.domain)) {
    return { ok: false, status: 404, error: "找不到這項科技" };
  }
  const domain = node.domain;
  if (params.expectedDomain && domain !== params.expectedDomain) {
    return { ok: false, status: 400, error: "這項科技不屬於此領域" };
  }

  await ensureTechTreeStates(db, nation.id);
  const [states, domainNodes, researchedIds] = await Promise.all([
    loadTechTreeStates(nation.id),
    loadDomainNodes(domain),
    loadResearchedNodeIdSet(nation.id, domain),
  ]);
  const state = states[domain];
  if (state.activeNodeId !== null) {
    return {
      ok: false,
      status: 409,
      error: "此領域已有進行中的科技，請先完成或取消後再選擇",
    };
  }
  const check = isNodeResearchable({
    node,
    domainNodes,
    researchedIds,
    domainEraSlug: state.eraSlug,
  });
  if (!check.ok) {
    return { ok: false, status: 400, error: check.reason ?? "無法研發" };
  }

  // 成本快照：選研當下計算並鎖定（研發中不隨國力／時代浮動）。
  const costMult = await getNationResearchCostMultiplierForDomain(
    nation,
    state.eraSlug,
  );
  const cost = adjustedResearchCost(node.baseCost, costMult);

  const updated = await db
    .update(playerTechTreeStateTable)
    .set({
      activeNodeId: nodeId,
      costSnapshot: cost,
      progressPoints: 0,
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nation.id),
        eq(playerTechTreeStateTable.domain, domain),
        isNull(playerTechTreeStateTable.activeNodeId),
      ),
    )
    .returning({ id: playerTechTreeStateTable.id });
  if (!updated[0]) {
    return {
      ok: false,
      status: 409,
      error: "此領域已有進行中的科技，請先完成或取消後再選擇",
    };
  }
  return { ok: true, node, domain, cost };
}

/**
 * 內閣自動研發候選：該領域目前「可開始研發」的節點（含估算成本）。
 * 該領域已有進行中科技 → 空陣列（大臣本回合不選研）。
 */
export async function listTechTreeResearchCandidates(
  nation: PlayerNation,
  domain: TechTreeDomain,
): Promise<{ id: number; name: string; cost: number }[]> {
  const [states, domainNodes, researchedIds] = await Promise.all([
    loadTechTreeStates(nation.id),
    loadDomainNodes(domain),
    loadResearchedNodeIdSet(nation.id, domain),
  ]);
  const state = states[domain];
  if (state.activeNodeId !== null) return [];
  const statuses = computeNodeStatuses({
    nodes: domainNodes,
    researchedIds,
    domainEraSlug: state.eraSlug,
    activeNodeId: null,
  });
  const costMult = await getNationResearchCostMultiplierForDomain(
    nation,
    state.eraSlug,
  );
  return domainNodes
    .filter((n) => statuses.get(n.id)?.status === "available")
    .map((n) => ({
      id: n.id,
      name: n.name,
      cost: adjustedResearchCost(n.baseCost, costMult),
    }));
}

/** 取消進行中研發（進度作廢、成本快照清空）。無進行中 → 404。 */
export async function cancelTechTreeResearch(params: {
  nationId: string;
  domain: TechTreeDomain;
}): Promise<TechTreeOpResult<{ cancelled: true }>> {
  const { nationId, domain } = params;
  const updated = await db
    .update(playerTechTreeStateTable)
    .set({
      activeNodeId: null,
      costSnapshot: null,
      progressPoints: 0,
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, domain),
        sql`${playerTechTreeStateTable.activeNodeId} IS NOT NULL`,
      ),
    )
    .returning({ id: playerTechTreeStateTable.id });
  if (!updated[0]) {
    return { ok: false, status: 404, error: "此領域目前沒有進行中的科技" };
  }
  return { ok: true, cancelled: true };
}

/** 設定三領域科研點數分配比例（整數 %、合計 100；下一回合結算生效）。 */
export async function setTechTreeAllocation(params: {
  nationId: string;
  allocation: TechTreeAllocation;
}): Promise<TechTreeOpResult<{ allocation: TechTreeAllocation }>> {
  const { nationId, allocation } = params;
  const invalid = validateAllocation(allocation);
  if (invalid) return { ok: false, status: 400, error: invalid };
  await db.transaction(async (tx) => {
    await ensureTechTreeStates(tx, nationId);
    for (const domain of ["social", "production", "military"] as const) {
      await tx
        .update(playerTechTreeStateTable)
        .set({ ratioPct: allocation[domain], updatedAt: sql`NOW()` })
        .where(
          and(
            eq(playerTechTreeStateTable.nationId, nationId),
            eq(playerTechTreeStateTable.domain, domain),
          ),
        );
    }
  });
  return { ok: true, allocation };
}
