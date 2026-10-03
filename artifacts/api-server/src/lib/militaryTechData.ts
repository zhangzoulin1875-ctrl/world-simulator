import type { MilitaryTechBonus } from "@workspace/db";
import {
  getTechTreeDomainEra,
  loadResearchedNodes,
  loadResearchedNodesByUser,
} from "./techTreeData";

/**
 * Task #151／#469 — 軍事科技的 DB 存取層（供 routes 與戰爭引擎共用）。
 * Task #469 起資料來源為全球統一線性科技樹（tech_tree_nodes，domain="military"）；
 * 解鎖判定純函式沿用 military.ts。
 */

/** 已研發的軍事科技樹節點（加成彙總所需欄位）。 */
export interface ResearchedMilitaryNode {
  id: number;
  name: string;
  description: string;
  eraSlug: string;
  keySlug: string | null;
  bonuses: MilitaryTechBonus[];
}

/** 讀取某玩家的軍事領域目前時代（無列時回預設古典時代）。 */
export async function getMilitaryDomainEra(userId: string): Promise<string> {
  return getTechTreeDomainEra(userId, "military");
}

/** 載入某玩家已研發的軍事科技節點（含 key_slug／bonuses／所屬時代）。 */
export async function loadResearchedMilitaryTechs(
  userId: string,
): Promise<ResearchedMilitaryNode[]> {
  const nodes = await loadResearchedNodes(userId, "military");
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    description: n.description,
    eraSlug: n.eraSlug,
    keySlug: n.keySlug,
    bonuses: n.effects as MilitaryTechBonus[],
  }));
}

/** 某玩家已研發的關鍵技術 key_slug 清單（供兵種類別解鎖／有效射程判定）。 */
export async function loadResearchedKeySlugs(
  userId: string,
): Promise<string[]> {
  const techs = await loadResearchedMilitaryTechs(userId);
  return techs
    .filter((t) => t.keySlug !== null)
    .map((t) => t.keySlug as string);
}

/**
 * 一次載入全部玩家已研發的關鍵技術 key_slug（回合引擎／戰爭引擎批次用）。
 * key = discord_user_id。
 */
export async function loadResearchedKeySlugsByUser(): Promise<
  Map<string, string[]>
> {
  const byUser = await loadResearchedNodesByUser("military");
  const out = new Map<string, string[]>();
  for (const [userId, nodes] of byUser) {
    const slugs = nodes
      .filter((n) => n.keySlug !== null)
      .map((n) => n.keySlug as string);
    if (slugs.length > 0) out.set(userId, slugs);
  }
  return out;
}

/**
 * 一次載入全部玩家已研發軍事科技的加成（戰爭引擎批次用）。
 * key = discord_user_id。
 */
export async function loadMilitaryBonusesByUser(): Promise<
  Map<string, MilitaryTechBonus[]>
> {
  const byUser = await loadResearchedNodesByUser("military");
  const out = new Map<string, MilitaryTechBonus[]>();
  for (const [userId, nodes] of byUser) {
    out.set(
      userId,
      nodes.flatMap((n) => n.effects as MilitaryTechBonus[]),
    );
  }
  return out;
}
