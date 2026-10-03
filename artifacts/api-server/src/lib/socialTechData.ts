import type { SocialTechEffect } from "@workspace/db";
import {
  aggregateSocialEffects,
  type AggregatedSocialEffects,
  type ResearchedSocialTechInput,
} from "./socialTech";
import {
  getTechTreeDomainEra,
  loadResearchedNodes,
  loadResearchedNodesByUser,
} from "./techTreeData";

/**
 * Task #126／#469 — 社會科技的 DB 存取層（供 routes 與回合引擎共用）。
 * Task #469 起資料來源為全球統一線性科技樹（tech_tree_nodes，domain="social"）；
 * 效果彙總純函式沿用 socialTech.ts。
 */

/** 已研發的社會科技樹節點（效果彙總所需欄位）。 */
export interface ResearchedSocialNode {
  id: number;
  name: string;
  eraSlug: string;
  keySlug: string | null;
  effects: SocialTechEffect[];
}

/** 讀取某玩家的社會領域目前時代（無列時回預設古典時代）。 */
export async function getSocialDomainEra(userId: string): Promise<string> {
  return getTechTreeDomainEra(userId, "social");
}

/** 載入某玩家已研發的社會科技節點（含 key_slug／effects／所屬時代）。 */
export async function loadResearchedSocialTechs(
  userId: string,
): Promise<ResearchedSocialNode[]> {
  const nodes = await loadResearchedNodes(userId, "social");
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    eraSlug: n.eraSlug,
    keySlug: n.keySlug,
    effects: n.effects as SocialTechEffect[],
  }));
}

function toInput(t: ResearchedSocialNode): ResearchedSocialTechInput {
  return { keySlug: t.keySlug, effects: t.effects };
}

/** 某玩家的彙總社會科技效果（單一真實來源）。 */
export async function aggregateSocialEffectsForUser(
  userId: string,
): Promise<AggregatedSocialEffects> {
  const techs = await loadResearchedSocialTechs(userId);
  return aggregateSocialEffects(techs.map(toInput));
}

/**
 * 一次載入全部玩家的彙總社會科技效果（回合引擎批次用；避免每國一次查詢）。
 * key = discord_user_id。
 */
export async function aggregateSocialEffectsByUser(): Promise<
  Map<string, AggregatedSocialEffects>
> {
  const byUser = await loadResearchedNodesByUser("social");
  const out = new Map<string, AggregatedSocialEffects>();
  for (const [userId, nodes] of byUser) {
    out.set(
      userId,
      aggregateSocialEffects(
        nodes.map((n) => ({
          keySlug: n.keySlug,
          effects: n.effects as SocialTechEffect[],
        })),
      ),
    );
  }
  return out;
}
