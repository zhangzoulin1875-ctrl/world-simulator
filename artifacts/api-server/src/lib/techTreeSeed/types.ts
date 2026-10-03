import type {
  MilitaryTechBonus,
  ProductionTechEffect,
  SocialTechEffect,
  TechTreeDomain,
} from "@workspace/db";

/**
 * Task #469 — 全球統一線性科技樹的預設內容種子（一次性：只在
 * tech_tree_nodes 為空時種入；之後由管理員後台完全接管）。
 *
 * 結構約定（由 techTreeSeed.test.ts 鎖定）：
 * - 14 個時代 × 每領域 ≥2 條主幹線（lineKind = "main"）；
 * - 每條主幹線 ≥10 個節點（sortOrder 1..N 連號）；
 * - 支線（lineKind = "branch"）以 branchFrom 掛在同 domain × era 的
 *   某條主幹線節點上（只掛第一節點；其後線內線性推進）；
 * - 既有關鍵科技（key_slug）全部保留並座落在主幹線上（政體／建築解鎖
 *   對照沿用 KEY_TECH_GOVERNMENTS / KEY_TECH_BUILDINGS）。
 */

export interface TechTreeSeedNode<E> {
  /** 線內順序（1 起連號）。 */
  order: number;
  name: string;
  description: string;
  /**
   * 基準成本。Task #477 調校後的節奏約定（由 techTreeSeed.test.ts 鎖定）：
   * 每時代「主幹線成本總和 ÷ 該時代 techAvg」落在 PACING_TARGETS 頻帶內
   * （≈ 平均國力、單領域約 1/3 分配下走完主幹線所需回合數）——短歷史時代
   * （ww1/ww2/cold_war）較低、中古長時代較高、future 為終局成本池。
   * 線內遞增；支線每節點平均成本低於主幹線；關鍵科技（keySlug）帶
   * ×1.25 成本溢價（里程碑感，可能略高於線內下一節點）。
   */
  baseCost: number;
  effects: E[];
  /** 關鍵科技（★）識別字；一般節點省略。 */
  keySlug?: string;
}

export interface TechTreeSeedLine<E> {
  /** 同 domain × era 內唯一。 */
  lineKey: string;
  /** zh-TW 顯示名稱。 */
  lineLabel: string;
  lineKind: "main" | "branch";
  /** 支線掛點（同 domain × era 的主幹線節點）；主幹線省略。 */
  branchFrom?: { lineKey: string; order: number };
  nodes: TechTreeSeedNode<E>[];
}

export interface TechTreeSeedEra<E> {
  eraSlug: string;
  lines: TechTreeSeedLine<E>[];
}

export interface TechTreeSeedDomain<E> {
  domain: TechTreeDomain;
  eras: TechTreeSeedEra<E>[];
}

export type SocialSeedDomain = TechTreeSeedDomain<SocialTechEffect>;
export type ProductionSeedDomain = TechTreeSeedDomain<ProductionTechEffect>;
export type MilitarySeedDomain = TechTreeSeedDomain<MilitaryTechBonus>;
