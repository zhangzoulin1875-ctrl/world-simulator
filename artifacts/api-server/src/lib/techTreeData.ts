import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
  techTreeNodesTable,
  TECH_TREE_DOMAINS,
  type PlayerTechTreeState,
  type TechTreeDomain,
  type TechTreeNode,
} from "@workspace/db";
import { DEFAULT_ERA_SLUG, getEraIndex } from "./mapRegionEras";
import { DEFAULT_ALLOCATION, advanceDomainEra } from "./techTree";
import { logger } from "./logger";

/**
 * Task #469 — 科技樹 DB 存取層（routes／回合引擎／內閣共用）。
 * 純函式（可研發判定、時代推進、分配驗證）在 techTree.ts。
 *
 * Task #481 起兩張狀態表改鍵到 nation_id（NPC 也逐格走樹）：核心 primitives
 * 一律以 nationId 為鍵；效果彙總層仍以 discord_user_id 消費的讀取端
 * （loadResearchedNodes／loadResearchedNodesByUser／getTechTreeDomainEra）
 * 保留 user-keyed 簽名，內部 join player_nations 解析到 nation。
 *
 * player_tech_tree_state 採 lazy 建列：讀取時無列以預設值代替
 * （era=classical、ratio=34/33/33、無進行中節點）；任何寫入
 * （開始研發／調整分配）前先 ensureTechTreeStates upsert。
 */

type DbLike = typeof db;
type TxLike = Parameters<Parameters<DbLike["transaction"]>[0]>[0];
export type DbOrTx = DbLike | TxLike;

export interface TechTreeDomainState {
  domain: TechTreeDomain;
  eraSlug: string;
  activeNodeId: number | null;
  costSnapshot: number | null;
  progressPoints: number;
  ratioPct: number;
}

function defaultState(domain: TechTreeDomain): TechTreeDomainState {
  return {
    domain,
    eraSlug: DEFAULT_ERA_SLUG,
    activeNodeId: null,
    costSnapshot: null,
    progressPoints: 0,
    ratioPct: DEFAULT_ALLOCATION[domain],
  };
}

function toState(row: PlayerTechTreeState): TechTreeDomainState {
  return {
    domain: row.domain as TechTreeDomain,
    eraSlug: row.eraSlug,
    activeNodeId: row.activeNodeId,
    costSnapshot: row.costSnapshot,
    progressPoints: row.progressPoints,
    ratioPct: row.ratioPct,
  };
}

/** 讀取某國三領域研發狀態（無列以預設值補齊，不寫 DB）。 */
export async function loadTechTreeStates(
  nationId: string,
  dbc: DbOrTx = db,
): Promise<Record<TechTreeDomain, TechTreeDomainState>> {
  const rows = await dbc
    .select()
    .from(playerTechTreeStateTable)
    .where(eq(playerTechTreeStateTable.nationId, nationId));
  const out = {
    social: defaultState("social"),
    production: defaultState("production"),
    military: defaultState("military"),
  };
  for (const row of rows) {
    const d = row.domain as TechTreeDomain;
    if (d in out) out[d] = toState(row);
  }
  return out;
}

/** 寫入前保證三領域列存在（預設值；已存在不動）。 */
export async function ensureTechTreeStates(
  dbc: DbOrTx,
  nationId: string,
): Promise<void> {
  await dbc
    .insert(playerTechTreeStateTable)
    .values(
      TECH_TREE_DOMAINS.map((domain) => ({
        nationId,
        domain,
        eraSlug: DEFAULT_ERA_SLUG,
        ratioPct: DEFAULT_ALLOCATION[domain],
      })),
    )
    .onConflictDoNothing();
}

/** 讀取某國某領域目前時代（無列 → 古典）。 */
export async function getTechTreeDomainEraByNation(
  nationId: string,
  domain: TechTreeDomain,
  dbc: DbOrTx = db,
): Promise<string> {
  const [row] = await dbc
    .select({ eraSlug: playerTechTreeStateTable.eraSlug })
    .from(playerTechTreeStateTable)
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, domain),
      ),
    )
    .limit(1);
  return row?.eraSlug ?? DEFAULT_ERA_SLUG;
}

/** 讀取某玩家（discord_user_id）某領域目前時代（無國家／無列 → 古典）。 */
export async function getTechTreeDomainEra(
  userId: string,
  domain: TechTreeDomain,
): Promise<string> {
  const [row] = await db
    .select({ eraSlug: playerTechTreeStateTable.eraSlug })
    .from(playerTechTreeStateTable)
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, playerTechTreeStateTable.nationId),
    )
    .where(
      and(
        eq(playerNationsTable.discordUserId, userId),
        eq(playerTechTreeStateTable.domain, domain),
      ),
    )
    .limit(1);
  return row?.eraSlug ?? DEFAULT_ERA_SLUG;
}

/** 載入單一領域全部節點（線內排序）。 */
export async function loadDomainNodes(
  domain: TechTreeDomain,
  dbc: DbOrTx = db,
): Promise<TechTreeNode[]> {
  const rows = await dbc
    .select()
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.domain, domain))
    .orderBy(
      asc(techTreeNodesTable.lineKey),
      asc(techTreeNodesTable.sortOrder),
      asc(techTreeNodesTable.id),
    );
  // 依 ERAS 定義的 14 時代先後排序（eraSlug 字母序會亂掉：classical → cold_war → …）。
  return rows.sort((a, b) => getEraIndex(a.eraSlug) - getEraIndex(b.eraSlug));
}

/** 某國已研發節點 id 集合（可選領域過濾）。 */
export async function loadResearchedNodeIdSet(
  nationId: string,
  domain?: TechTreeDomain,
  dbc: DbOrTx = db,
): Promise<Set<number>> {
  const conditions = [eq(playerResearchedTreeNodesTable.nationId, nationId)];
  if (domain) conditions.push(eq(techTreeNodesTable.domain, domain));
  const rows = await dbc
    .select({ nodeId: playerResearchedTreeNodesTable.nodeId })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .where(and(...conditions));
  return new Set(rows.map((r) => r.nodeId));
}

/** 某國某領域已研發節點（含 effects／keySlug；id 排序）。 */
export async function loadResearchedNodesByNation(
  nationId: string,
  domain: TechTreeDomain,
): Promise<TechTreeNode[]> {
  const rows = await db
    .select({ node: techTreeNodesTable })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .where(
      and(
        eq(playerResearchedTreeNodesTable.nationId, nationId),
        eq(techTreeNodesTable.domain, domain),
      ),
    )
    .orderBy(asc(techTreeNodesTable.id));
  return rows.map((r) => r.node);
}

/** 某玩家（discord_user_id）某領域已研發節點（join 其國家；id 排序）。 */
export async function loadResearchedNodes(
  userId: string,
  domain: TechTreeDomain,
): Promise<TechTreeNode[]> {
  const rows = await db
    .select({ node: techTreeNodesTable })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, playerResearchedTreeNodesTable.nationId),
    )
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .where(
      and(
        eq(playerNationsTable.discordUserId, userId),
        eq(techTreeNodesTable.domain, domain),
      ),
    )
    .orderBy(asc(techTreeNodesTable.id));
  return rows.map((r) => r.node);
}

/**
 * 一次載入全部「有主玩家」某領域的已研發節點（回合引擎／戰爭引擎批次用）。
 * key = discord_user_id（join player_nations；NPC／無主國家不在其中）。
 */
export async function loadResearchedNodesByUser(
  domain: TechTreeDomain,
): Promise<Map<string, TechTreeNode[]>> {
  const rows = await db
    .select({
      userId: playerNationsTable.discordUserId,
      node: techTreeNodesTable,
    })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, playerResearchedTreeNodesTable.nationId),
    )
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .where(eq(techTreeNodesTable.domain, domain));
  const out = new Map<string, TechTreeNode[]>();
  for (const r of rows) {
    if (r.userId === null) continue;
    const list = out.get(r.userId) ?? [];
    list.push(r.node);
    out.set(r.userId, list);
  }
  return out;
}

/**
 * 授予節點（idempotent；已研發不重複）。回傳是否新增。
 * 不做前置檢查——呼叫端（研發完成／時代補齊／管理員授予）自行守門。
 */
export async function grantNode(
  dbc: DbOrTx,
  nationId: string,
  nodeId: number,
): Promise<boolean> {
  const inserted = await dbc
    .insert(playerResearchedTreeNodesTable)
    .values({ nationId, nodeId })
    .onConflictDoNothing()
    .returning({ id: playerResearchedTreeNodesTable.id });
  return inserted.length > 0;
}

/** 批次授予節點（idempotent）。回傳新增數。 */
export async function grantNodes(
  dbc: DbOrTx,
  nationId: string,
  nodeIds: readonly number[],
): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const inserted = await dbc
    .insert(playerResearchedTreeNodesTable)
    .values(nodeIds.map((nodeId) => ({ nationId, nodeId })))
    .onConflictDoNothing()
    .returning({ id: playerResearchedTreeNodesTable.id });
  return inserted.length;
}

/**
 * 研發完成後重算並套用領域時代（主幹線全研發 → 逐時代推進）。
 * 回傳最終時代。呼叫端須先 ensureTechTreeStates。
 */
export async function refreshDomainEra(
  dbc: DbOrTx,
  nationId: string,
  domain: TechTreeDomain,
): Promise<string> {
  const [nodes, researched, [stateRow]] = await Promise.all([
    loadDomainNodes(domain, dbc),
    loadResearchedNodeIdSet(nationId, domain, dbc),
    dbc
      .select({ eraSlug: playerTechTreeStateTable.eraSlug })
      .from(playerTechTreeStateTable)
      .where(
        and(
          eq(playerTechTreeStateTable.nationId, nationId),
          eq(playerTechTreeStateTable.domain, domain),
        ),
      )
      .limit(1),
  ]);
  const current = stateRow?.eraSlug ?? DEFAULT_ERA_SLUG;
  const next = advanceDomainEra({
    nodes,
    researchedIds: researched,
    currentEraSlug: current,
  });
  if (next !== current) {
    await dbc
      .update(playerTechTreeStateTable)
      .set({ eraSlug: next, updatedAt: sql`NOW()` })
      .where(
        and(
          eq(playerTechTreeStateTable.nationId, nationId),
          eq(playerTechTreeStateTable.domain, domain),
        ),
      );
    logger.info(
      { nationId, domain, from: current, to: next },
      "tech tree domain era advanced",
    );
  }
  return next;
}

/** 依 key_slug 查節點 id（不存在 → null）。 */
export async function getNodeIdByKeySlug(
  keySlug: string,
  dbc: DbOrTx = db,
): Promise<number | null> {
  const [row] = await dbc
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.keySlug, keySlug))
    .limit(1);
  return row?.id ?? null;
}

/** 批次載入節點（id 順序不保證）。 */
export async function loadNodesByIds(
  ids: readonly number[],
  dbc: DbOrTx = db,
): Promise<TechTreeNode[]> {
  if (ids.length === 0) return [];
  return dbc
    .select()
    .from(techTreeNodesTable)
    .where(inArray(techTreeNodesTable.id, [...ids]));
}
