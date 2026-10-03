import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
  techTreeNodesTable,
  TECH_TREE_DOMAINS,
  type TechTreeDomain,
} from "@workspace/db";
import { DEFAULT_ERA_SLUG, getEraIndex, isEraSlug } from "./mapRegionEras";
import { getEraSlugs } from "./nationStats";
import { DEFAULT_ALLOCATION } from "./techTree";
import { loadDomainNodes } from "./techTreeData";
import { effectiveNpcTechEra } from "./npcTech";
import { initNpcTechTreeFromPointers } from "./npcTechTree";

/**
 * 國家管理（管理員）批次「關鍵科技」工具的資料層。Task #469 起關鍵科技即
 * 科技樹節點（tech_tree_nodes.key_slug 非 null），目錄改為 DB 驅動（管理員
 * 後台增刪關鍵節點會即時反映）。
 *
 * Task #481 起兩表改鍵到 nation_id，NPC／無主國家與玩家一樣實際持有
 * player_researched_tree_nodes 列：授予＝插入該列；移除＝刪除該 node_id 的列。
 * 尚未初始化樹狀態的 NPC（無任何 player_tech_tree_state 列）會在批次操作時
 * 先依其舊時代指標初始化（同一交易內），再套用授予／移除。
 */

export const KEY_TECH_DOMAINS = TECH_TREE_DOMAINS;
export type KeyTechDomain = TechTreeDomain;

export function isKeyTechDomain(v: unknown): v is KeyTechDomain {
  return (
    typeof v === "string" &&
    (KEY_TECH_DOMAINS as readonly string[]).includes(v)
  );
}

export interface KeyTechCatalogEntry {
  keySlug: string;
  eraSlug: string;
  name: string;
}

/** DB 驅動的三領域關鍵科技目錄（key_slug 非 null 的節點，依時代序）。 */
export async function loadKeyTechCatalog(): Promise<
  Record<KeyTechDomain, KeyTechCatalogEntry[]>
> {
  const rows = await db
    .select({
      domain: techTreeNodesTable.domain,
      keySlug: techTreeNodesTable.keySlug,
      eraSlug: techTreeNodesTable.eraSlug,
      name: techTreeNodesTable.name,
    })
    .from(techTreeNodesTable)
    .where(isNotNull(techTreeNodesTable.keySlug))
    .orderBy(asc(techTreeNodesTable.id));
  const out: Record<KeyTechDomain, KeyTechCatalogEntry[]> = {
    military: [],
    social: [],
    production: [],
  };
  for (const r of rows) {
    if (!isKeyTechDomain(r.domain) || !r.keySlug) continue;
    out[r.domain].push({
      keySlug: r.keySlug,
      eraSlug: r.eraSlug,
      name: r.name,
    });
  }
  for (const domain of KEY_TECH_DOMAINS) {
    out[domain].sort(
      (a, b) => getEraIndex(a.eraSlug) - getEraIndex(b.eraSlug),
    );
  }
  return out;
}

/** 查某領域某 key_slug 的目錄項目（不存在 → null）。 */
export async function keyTechCatalogEntry(
  domain: KeyTechDomain,
  keySlug: string,
): Promise<KeyTechCatalogEntry | null> {
  const [r] = await db
    .select({
      keySlug: techTreeNodesTable.keySlug,
      eraSlug: techTreeNodesTable.eraSlug,
      name: techTreeNodesTable.name,
    })
    .from(techTreeNodesTable)
    .where(
      and(
        eq(techTreeNodesTable.domain, domain),
        eq(techTreeNodesTable.keySlug, keySlug),
      ),
    )
    .limit(1);
  if (!r?.keySlug) return null;
  return { keySlug: r.keySlug, eraSlug: r.eraSlug, name: r.name };
}

/** player_nations 上各領域的 NPC 科技時代指標欄位（唯讀鏡像）。 */
const NPC_POINTER_COLUMN = {
  military: "techEraMilitary",
  social: "techEraSocial",
  production: "techEraProduction",
} as const satisfies Record<
  KeyTechDomain,
  "techEraMilitary" | "techEraSocial" | "techEraProduction"
>;

/** db.transaction 回呼參數型別（tx 用於批次寫入）。 */
type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 查關鍵科技節點 id（查不到回 null；呼叫端回 404）。 */
export async function getKeyTechId(
  domain: KeyTechDomain,
  keySlug: string,
): Promise<number | null> {
  const [r] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(
      and(
        eq(techTreeNodesTable.domain, domain),
        eq(techTreeNodesTable.keySlug, keySlug),
      ),
    )
    .limit(1);
  return r?.id ?? null;
}

/** 授予某關鍵科技給所有玩家國家（冪等 onConflictDoNothing）。回傳玩家國家數。 */
export async function grantKeyTechToAllPlayers(
  tx: TxClient,
  _domain: KeyTechDomain,
  nodeId: number,
): Promise<number> {
  const players = await tx
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(isNotNull(playerNationsTable.discordUserId));
  if (players.length === 0) return 0;
  await tx
    .insert(playerResearchedTreeNodesTable)
    .values(players.map((p) => ({ nationId: p.id, nodeId })))
    .onConflictDoNothing();
  return players.length;
}

/** 從所有玩家國家移除某關鍵科技。回傳刪除的紀錄筆數。 */
export async function revokeKeyTechFromAllPlayers(
  tx: TxClient,
  _domain: KeyTechDomain,
  nodeId: number,
): Promise<number> {
  const players = await tx
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(isNotNull(playerNationsTable.discordUserId));
  const ids = players.map((p) => p.id);
  if (ids.length === 0) return 0;
  const d = await tx
    .delete(playerResearchedTreeNodesTable)
    .where(
      and(
        eq(playerResearchedTreeNodesTable.nodeId, nodeId),
        inArray(playerResearchedTreeNodesTable.nationId, ids),
      ),
    )
    .returning({ id: playerResearchedTreeNodesTable.id });
  return d.length;
}

export interface NpcKeyTechWriteResult {
  /** 有實際變更（新增／刪除列）的 NPC／無主國家數。 */
  npcUpdated: number;
  /** 保留欄位（Task #481 起改列制授予，不再有世界時代上限夾住的情形）。 */
  npcCapped: number;
  /** 略過的國家（附中文原因，例如本就未擁有此科技）。 */
  npcSkipped: { id: string; name: string | null; reason: string }[];
}

/**
 * 對所有 NPC／無主國家套用某關鍵科技的授予／移除。Task #481 起 NPC 與玩家
 * 一樣持有 player_researched_tree_nodes 列：授予＝插入列、移除＝刪除列。
 * 尚未初始化樹狀態的國家先在同一交易內依舊時代指標初始化，確保「初始化時
 * 視同擁有該時代以下全部關鍵科技」的語義不因先移除後初始化而被復原。
 */
export async function applyKeyTechToNullOwnerNations(
  tx: TxClient,
  _domain: KeyTechDomain,
  _keyEraSlug: string,
  worldEraSlug: string,
  action: "grant" | "revoke",
  nodeId: number,
): Promise<NpcKeyTechWriteResult> {
  const rows = await tx
    .select()
    .from(playerNationsTable)
    .where(isNull(playerNationsTable.discordUserId));
  const result: NpcKeyTechWriteResult = {
    npcUpdated: 0,
    npcCapped: 0,
    npcSkipped: [],
  };
  if (rows.length === 0) return result;

  // 尚未初始化樹狀態的國家先初始化（同交易；預載三領域節點避免重複查詢）。
  const ids = rows.map((n) => n.id);
  const initialized = await tx
    .selectDistinct({ nationId: playerTechTreeStateTable.nationId })
    .from(playerTechTreeStateTable)
    .where(inArray(playerTechTreeStateTable.nationId, ids));
  const initializedIds = new Set(
    initialized.map((r) => r.nationId).filter((v): v is string => v !== null),
  );
  const uninitialized = rows.filter((n) => !initializedIds.has(n.id));
  if (uninitialized.length > 0) {
    const [social, production, military] = await Promise.all([
      loadDomainNodes("social", tx),
      loadDomainNodes("production", tx),
      loadDomainNodes("military", tx),
    ]);
    const nodesByDomain = { social, production, military };
    for (const n of uninitialized) {
      await initNpcTechTreeFromPointers(tx, n, worldEraSlug, nodesByDomain);
    }
  }

  if (action === "grant") {
    const inserted = await tx
      .insert(playerResearchedTreeNodesTable)
      .values(ids.map((nationId) => ({ nationId, nodeId })))
      .onConflictDoNothing()
      .returning({ nationId: playerResearchedTreeNodesTable.nationId });
    result.npcUpdated = inserted.length;
  } else {
    const deleted = await tx
      .delete(playerResearchedTreeNodesTable)
      .where(
        and(
          eq(playerResearchedTreeNodesTable.nodeId, nodeId),
          inArray(playerResearchedTreeNodesTable.nationId, ids),
        ),
      )
      .returning({ nationId: playerResearchedTreeNodesTable.nationId });
    result.npcUpdated = deleted.length;
    const deletedIds = new Set(deleted.map((d) => d.nationId));
    for (const n of rows) {
      if (!deletedIds.has(n.id)) {
        result.npcSkipped.push({
          id: n.id,
          name: n.name,
          reason: "本就未擁有此科技",
        });
      }
    }
  }
  return result;
}

export interface DomainTechStatus {
  era: string;
  keySlugs: string[];
}

export interface NationTechStatus {
  id: string;
  name: string | null;
  isNpc: boolean;
  isOwned: boolean;
  domains: Record<KeyTechDomain, DomainTechStatus>;
}

/**
 * 全國家（NPC＋玩家）三領域關鍵科技狀況總覽。時代取自
 * player_tech_tree_state（nation_id 鍵），已持有取自
 * player_researched_tree_nodes × tech_tree_nodes（key_slug 非 null）。
 * 尚未初始化樹狀態的 NPC／無主國家退回舊時代指標近似（有效時代夾世界時代，
 * 已持有 = 目錄中時代 ≤ 有效時代者）。不外洩 discord_user_id。
 */
export async function loadKeyTechStatus(): Promise<{
  worldEra: string;
  catalog: Record<KeyTechDomain, KeyTechCatalogEntry[]>;
  nations: NationTechStatus[];
}> {
  const [{ currentEra: worldEra }, catalog, nations] = await Promise.all([
    getEraSlugs(),
    loadKeyTechCatalog(),
    db
      .select()
      .from(playerNationsTable)
      .orderBy(asc(playerNationsTable.createdAt)),
  ]);

  const domainRows = await db
    .select({
      nationId: playerTechTreeStateTable.nationId,
      domain: playerTechTreeStateTable.domain,
      eraSlug: playerTechTreeStateTable.eraSlug,
    })
    .from(playerTechTreeStateTable);
  const eraByNationDomain = new Map<string, string>();
  const nationsWithState = new Set<string>();
  for (const r of domainRows) {
    if (r.nationId === null) continue;
    eraByNationDomain.set(`${r.nationId}:${r.domain}`, r.eraSlug);
    nationsWithState.add(r.nationId);
  }

  const heldByNationDomain = new Map<string, Set<string>>();
  const held = await db
    .select({
      nationId: playerResearchedTreeNodesTable.nationId,
      domain: techTreeNodesTable.domain,
      keySlug: techTreeNodesTable.keySlug,
    })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .where(isNotNull(techTreeNodesTable.keySlug));
  for (const r of held) {
    if (r.nationId === null || !r.keySlug || !isKeyTechDomain(r.domain)) {
      continue;
    }
    const k = `${r.nationId}:${r.domain}`;
    const set = heldByNationDomain.get(k) ?? new Set<string>();
    set.add(r.keySlug);
    heldByNationDomain.set(k, set);
  }

  const out: NationTechStatus[] = nations.map((n) => {
    const domains = {} as Record<KeyTechDomain, DomainTechStatus>;
    const hasState = nationsWithState.has(n.id);
    for (const domain of KEY_TECH_DOMAINS) {
      if (hasState || n.discordUserId !== null) {
        const era =
          eraByNationDomain.get(`${n.id}:${domain}`) ?? DEFAULT_ERA_SLUG;
        const heldSet = heldByNationDomain.get(`${n.id}:${domain}`);
        const keySlugs = catalog[domain]
          .filter((k) => heldSet?.has(k.keySlug))
          .map((k) => k.keySlug);
        domains[domain] = { era, keySlugs };
      } else {
        // 尚未初始化樹狀態的 NPC／無主國家 → 舊時代指標近似。
        const pointer = n[NPC_POINTER_COLUMN[domain]];
        const eff = effectiveNpcTechEra(pointer, worldEra);
        const effIdx = getEraIndex(eff);
        const keySlugs = catalog[domain]
          .filter((k) => getEraIndex(k.eraSlug) <= effIdx)
          .map((k) => k.keySlug);
        domains[domain] = { era: eff, keySlugs };
      }
    }
    return {
      id: n.id,
      name: n.name,
      isNpc: n.isNpc,
      isOwned: n.discordUserId !== null,
      domains,
    };
  });

  return { worldEra, catalog, nations: out };
}

/**
 * 新玩家建國／接手國家時，依加入當下的世界時代 worldEraSlug 自動補齊科技：
 * 三領域「時代嚴格早於世界時代」的全部主幹線節點與關鍵科技節點一次授予，
 * 並把各領域時代設為世界時代（當下時代的節點仍需自行研發）。世界時代為最早
 * 的 classical 時不做任何事。
 *
 * 全部寫入皆在呼叫端傳入的交易 tx 內完成（與建國／接手同一交易，確保原子性）；
 * 授予冪等（onConflictDoNothing），領域狀態 upsert，重複呼叫安全。
 */
export async function grantJoinEraKeyTechsToPlayer(
  tx: TxClient,
  nationId: string,
  worldEraSlug: string,
): Promise<void> {
  if (!isEraSlug(worldEraSlug) || getEraIndex(worldEraSlug) <= 0) return;
  const worldIdx = getEraIndex(worldEraSlug);

  const nodes = await tx
    .select({
      id: techTreeNodesTable.id,
      eraSlug: techTreeNodesTable.eraSlug,
      lineKind: techTreeNodesTable.lineKind,
      keySlug: techTreeNodesTable.keySlug,
    })
    .from(techTreeNodesTable);
  const grantIds = nodes
    .filter(
      (n) =>
        isEraSlug(n.eraSlug) &&
        getEraIndex(n.eraSlug) < worldIdx &&
        (n.lineKind === "main" || n.keySlug !== null),
    )
    .map((n) => n.id);
  if (grantIds.length > 0) {
    await tx
      .insert(playerResearchedTreeNodesTable)
      .values(grantIds.map((nodeId) => ({ nationId, nodeId })))
      .onConflictDoNothing();
  }

  for (const domain of KEY_TECH_DOMAINS) {
    await tx
      .insert(playerTechTreeStateTable)
      .values({
        nationId,
        domain,
        eraSlug: worldEraSlug,
        ratioPct: DEFAULT_ALLOCATION[domain],
      })
      .onConflictDoUpdate({
        target: [
          playerTechTreeStateTable.nationId,
          playerTechTreeStateTable.domain,
        ],
        set: { eraSlug: worldEraSlug, updatedAt: sql`NOW()` },
      });
  }
}
