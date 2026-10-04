import type {
  MilitaryTechBonus,
  ProductionTechEffect,
  SocialTechEffect,
  TechTreeDomain,
  TechTreeNode,
} from "@workspace/db";
import { MILITARY_KEY_TECHS } from "./military";
import { PRODUCTION_KEY_TECHS } from "./production";
import { KEY_TECHS as SOCIAL_KEY_TECHS } from "./socialTech";
import { ERAS, getEraIndex, isEraSlug, DEFAULT_ERA_SLUG } from "./mapRegionEras";

/**
 * 科技樹下線後的「依年代解鎖」模型(純函式,DB-free,可單元測試)。
 *
 * 規則:世界時代進到某關鍵技術的所屬時代(含當代)起,該國視同已擁有該關鍵技術,
 * 不再有「研發」這一步。關鍵技術目錄(MILITARY_KEY_TECHS / PRODUCTION_KEY_TECHS /
 * KEY_TECHS)是唯一真相來源,各自帶著既有的數值加成與解鎖對照(兵種類別、政體、
 * 建築、海軍、殖民),因此下游系統的行為只在「取得時機」上改變,內容不變。
 *
 * 舊科技樹的一般節點(約 1000 個、其中過半沒有任何效果)一律不再生效。
 * 日後的國策樹會以獨立系統取代,不再借用 tech_tree_nodes。
 */

interface CatalogEntry {
  keySlug: string;
  eraSlug: string;
  name: string;
  description: string;
  effects: unknown[];
}

function catalogFor(domain: TechTreeDomain): readonly CatalogEntry[] {
  switch (domain) {
    case "military":
      return MILITARY_KEY_TECHS.map((k) => ({
        keySlug: k.keySlug,
        eraSlug: k.eraSlug,
        name: k.name,
        description: k.description,
        effects: k.bonuses,
      }));
    case "production":
      return PRODUCTION_KEY_TECHS.map((k) => ({
        keySlug: k.keySlug,
        eraSlug: k.eraSlug,
        name: k.name,
        description: k.description,
        effects: k.effects,
      }));
    case "social":
      return SOCIAL_KEY_TECHS.map((k) => ({
        keySlug: k.keySlug,
        eraSlug: k.eraSlug,
        name: k.name,
        description: k.description,
        effects: k.effects,
      }));
  }
}

/** 世界時代非法時退回預設(古典),避免壞資料讓全部科技消失或全開。 */
export function normalizeEra(eraSlug: string | null | undefined): string {
  return eraSlug && isEraSlug(eraSlug) ? eraSlug : DEFAULT_ERA_SLUG;
}

/** 指定領域的全部關鍵技術(不分時代),依目錄順序;供「年代解鎖一覽」顯示未解鎖者。 */
export function allKeyTechsOf(domain: TechTreeDomain): CatalogEntry[] {
  return [...catalogFor(domain)];
}

/** 指定領域在某時代(含當代)以內的全部關鍵技術,依目錄順序。 */
export function keyTechsUnlockedByEra(
  domain: TechTreeDomain,
  eraSlug: string,
): CatalogEntry[] {
  const idx = getEraIndex(normalizeEra(eraSlug));
  return catalogFor(domain).filter(
    (k) => isEraSlug(k.eraSlug) && getEraIndex(k.eraSlug) <= idx,
  );
}

/** 只要 key_slug 清單(兵種類別解鎖、有效射程、登陸旗標用)。 */
export function keySlugsUnlockedByEra(
  domain: TechTreeDomain,
  eraSlug: string,
): string[] {
  return keyTechsUnlockedByEra(domain, eraSlug).map((k) => k.keySlug);
}

/**
 * 以「虛擬節點」形狀回傳,讓既有消費者(軍事加成彙總、社會/生產效果彙總、
 * 政體與建築解鎖對照)不必改簽名。id 為負數,保證不會與舊表的真實節點混淆。
 */
export function virtualNodesUnlockedByEra(
  domain: TechTreeDomain,
  eraSlug: string,
): TechTreeNode[] {
  const now = new Date(0);
  return keyTechsUnlockedByEra(domain, eraSlug).map((k, i) => ({
    id: -(i + 1),
    domain,
    eraSlug: k.eraSlug,
    lineKey: "key",
    lineLabel: "關鍵技術",
    lineKind: "main",
    sortOrder: i + 1,
    name: k.name,
    description: k.description,
    baseCost: 0,
    effects: k.effects as (
      | SocialTechEffect
      | ProductionTechEffect
      | MilitaryTechBonus
    )[],
    keySlug: k.keySlug,
    branchFromNodeId: null,
    createdAt: now,
    updatedAt: now,
  }));
}

/** 時代清單(供唯讀「年代解鎖一覽」頁使用)。 */
export function eraTimeline(): { slug: string; label: string }[] {
  return ERAS.map((e) => ({ slug: e.slug, label: e.label }));
}
