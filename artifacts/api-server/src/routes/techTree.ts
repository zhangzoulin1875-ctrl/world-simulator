import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  type MilitaryTechBonus,
  type PlayerNation,
  type ProductionTechEffect,
  type SocialTechEffect,
  type TechTreeDomain,
  type TechTreeNode,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { ERAS, getEraIndex } from "../lib/mapRegionEras";
import {
  TECH_TREE_DOMAIN_LABELS,
  computeNodeStatuses,
  isTechTreeDomain,
} from "../lib/techTree";
import {
  loadDomainNodes,
  loadResearchedNodeIdSet,
  loadTechTreeStates,
} from "../lib/techTreeData";
import {
  cancelTechTreeResearch,
  setTechTreeAllocation,
  startTechTreeResearch,
} from "../lib/techTreeResearch";
import {
  adjustedResearchCost,
  getNationResearchCostMultiplierForDomain,
} from "../lib/researchCost";
import { allocateResearchPoints } from "../lib/researchAllocation";
import { computeAdjustedNationStats, getEraSlugs } from "../lib/nationStats";
import { describeSocialEffect } from "../lib/socialTech";
import { describeProductionEffect } from "../lib/production";
import { describeMilitaryBonus } from "../lib/military";

/**
 * Task #469 — 全球統一線性科技樹玩家路由（Discord session 閘門，進 OpenAPI spec）。
 *
 * - GET  /tech-tree/overview   三領域科技樹總覽（節點狀態、進行中、分配比例）。
 * - POST /tech-tree/research   選定節點開始研發（成本快照鎖定）。
 * - POST /tech-tree/cancel     取消該領域進行中研發（進度作廢）。
 * - PUT  /tech-tree/allocation 設定三領域科研點數分配比例（整數 %、合計 100）。
 */

const router: IRouter = Router();

async function requirePlayer(
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

function eraLabel(slug: string): string {
  return ERAS[getEraIndex(slug)]?.label ?? slug;
}

/** 依領域把節點效果轉成 zh-TW 顯示文字。 */
function effectLabels(node: TechTreeNode): string[] {
  const domain = node.domain;
  return node.effects.map((eff) => {
    if (domain === "social") return describeSocialEffect(eff as SocialTechEffect);
    if (domain === "production") {
      return describeProductionEffect(eff as ProductionTechEffect);
    }
    return describeMilitaryBonus(eff as MilitaryTechBonus);
  });
}

/** 三領域科技樹總覽。 */
router.get("/tech-tree/overview", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  const [{ statsEra }, states] = await Promise.all([
    getEraSlugs(),
    loadTechTreeStates(nation.id),
  ]);
  const stats = await computeAdjustedNationStats(nation, statsEra);
  const techGainPerTurn = Math.max(0, Math.round(stats.techPerTurn));
  // Task #548 — 與回合引擎同一個純函式（最大餘數法），三領域份額總和恰好
  // 等於整數回合科研收入，顯示與實際灌入量一致。
  const perTurnAlloc = allocateResearchPoints(techGainPerTurn, {
    social: states.social.ratioPct,
    production: states.production.ratioPct,
    military: states.military.ratioPct,
  });

  const domains = await Promise.all(
    (["social", "production", "military"] as const).map(async (domain) => {
      const state = states[domain];
      const [nodes, researchedIds, costMult] = await Promise.all([
        loadDomainNodes(domain),
        loadResearchedNodeIdSet(nation.id, domain),
        getNationResearchCostMultiplierForDomain(nation, state.eraSlug),
      ]);
      const statuses = computeNodeStatuses({
        nodes,
        researchedIds,
        domainEraSlug: state.eraSlug,
        activeNodeId: state.activeNodeId,
      });
      const perTurnPoints = perTurnAlloc[domain];

      let active: {
        nodeId: number;
        name: string;
        costSnapshot: number;
        progressPoints: number;
        remainingPoints: number;
        estimatedTurns: number | null;
      } | null = null;
      if (state.activeNodeId !== null) {
        const activeNode = nodes.find((n) => n.id === state.activeNodeId);
        const cost = state.costSnapshot ?? 0;
        const remaining = Math.max(0, cost - state.progressPoints);
        active = {
          nodeId: state.activeNodeId,
          name: activeNode?.name ?? "未知科技",
          costSnapshot: cost,
          progressPoints: state.progressPoints,
          remainingPoints: remaining,
          estimatedTurns:
            perTurnPoints > 0 ? Math.ceil(remaining / perTurnPoints) : null,
        };
      }

      return {
        domain,
        domainLabel: TECH_TREE_DOMAIN_LABELS[domain],
        eraSlug: state.eraSlug,
        eraLabel: eraLabel(state.eraSlug),
        ratioPct: state.ratioPct,
        perTurnPoints,
        active,
        nodes: nodes.map((n) => {
          const detail = statuses.get(n.id);
          return {
            id: n.id,
            eraSlug: n.eraSlug,
            eraLabel: eraLabel(n.eraSlug),
            lineKey: n.lineKey,
            lineLabel: n.lineLabel,
            lineKind: n.lineKind,
            sortOrder: n.sortOrder,
            branchFromNodeId: n.branchFromNodeId,
            name: n.name,
            description: n.description,
            keySlug: n.keySlug,
            isKey: n.keySlug !== null,
            // Task #548 — 研發中節點顯示選研當下鎖定的成本快照（與結算
            // 口徑一致，研發期間不再隨國力浮動）；其餘節點維持動態計價。
            costPoints:
              n.id === state.activeNodeId && state.costSnapshot !== null
                ? state.costSnapshot
                : adjustedResearchCost(n.baseCost, costMult),
            effects: effectLabels(n),
            status: detail?.status ?? "locked",
            lockedReason: detail?.lockedReason ?? null,
          };
        }),
      };
    }),
  );

  res.json({
    techGainPerTurn,
    // Task #524 — 庫存科技點數：每回合依分配比例自動投入研發（只扣實際吸收量）。
    stockTechPoints: Math.max(0, nation.techPoints),
    allocation: {
      social: states.social.ratioPct,
      production: states.production.ratioPct,
      military: states.military.ratioPct,
    },
    domains,
  });
});

/** 選定節點開始研發。 */
router.post("/tech-tree/research", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const nodeId = Number(req.body?.nodeId);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    res.status(400).json({ error: "請提供有效的科技節點編號" });
    return;
  }
  const result = await startTechTreeResearch({
    nation: auth.nation,
    nodeId,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({
    nodeId: result.node.id,
    name: result.node.name,
    domain: result.domain,
    cost: result.cost,
  });
});

/** 取消該領域進行中研發（進度作廢）。 */
router.post("/tech-tree/cancel", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const domain = String(req.body?.domain ?? "");
  if (!isTechTreeDomain(domain)) {
    res.status(400).json({ error: "請提供有效的領域（social／production／military）" });
    return;
  }
  const result = await cancelTechTreeResearch({
    nationId: auth.nation.id,
    domain,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

/** 設定三領域科研點數分配比例。 */
router.put("/tech-tree/allocation", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const body = req.body ?? {};
  const allocation = {
    social: Number(body.social),
    production: Number(body.production),
    military: Number(body.military),
  };
  const result = await setTechTreeAllocation({
    nationId: auth.nation.id,
    allocation,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ allocation: result.allocation });
});

export default router;
