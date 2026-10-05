import { FOUNDING_GOVERNMENT_SLUGS, GOVERNMENTS } from "../governments";
import { REGIME_EDGES, edgesFrom, type RegimeEdge } from "./regimeGraph";
import type { FocusTrack } from "./core";

/**
 * 國策樹畫面用的資料(純函式,不碰資料庫)。
 *  - rooted:以「目前政體」為根。depth 0 = 現在;depth 1 = 我這棵樹抽到的分支(真的可以走);
 *    depth 2 = 從那些分支再往下一步(僅供預覽,換政體後會以新政體為根重抽,所以實際能走哪些還不確定)。
 *  - full:固定的全景,全部政體依「離建國起點最短步數」分層,有環也只取最短層。
 */
/** 全景分欄:建國起點 → 中繼 → 終點(終點 = 已定案的紅線 / 黑線 / 穩定路線終點站) */
export type TreeStage = 0 | 1 | 2;
export type TerminalLine = "red" | "black" | "stable";

export interface TreeNode {
  slug: string;
  label: string;
  /** 全景欄位:0 建國起點 / 1 中繼 / 2 終點 */
  stage: TreeStage;
  /** 終點所屬路線(只有 stage = 2 才有) */
  line: TerminalLine | null;
  /** 全景:離任一建國起點的最短步數(參考用) */
  layer: number | null;
  isFounding: boolean;
  isCurrent: boolean;
  /** 以我為根的視角:0 = 目前、1 = 我抽到的分支、2 = 再往下一步(預覽);不在範圍內為 null */
  depth: 0 | 1 | 2 | null;
}

export interface TreeEdge {
  from: string;
  to: string;
  track: FocusTrack;
  focusId: string;
  /** 這一步是我這棵樹上真的能走的(從目前政體出發且被抽到) */
  walkable: boolean;
  /** 從目前政體出發、但這次沒被抽到(走不了) */
  notDrawn: boolean;
}

export interface FocusTreeData {
  currentGovernment: string | null;
  /** 是否有套用分支限制(抽選失敗降級時為 false,畫面會提示) */
  limited: boolean;
  nodes: TreeNode[];
  edges: TreeEdge[];
}

/** 已定案的終點站:紅線=社會主義委員會制/委員會制;黑線=軍事獨裁/神權制;穩定=君主立憲/議會內閣/總統制 */
export const TERMINAL_LINE: Readonly<Record<string, TerminalLine>> = {
  socialist_council: "red",
  council_system: "red",
  military_dictatorship: "black",
  theocracy: "black",
  constitutional_monarchy: "stable",
  parliamentary: "stable",
  presidential_democracy: "stable",
};

export function stageOf(slug: string): TreeStage {
  if (FOUNDING_GOVERNMENT_SLUGS.includes(slug)) return 0;
  return TERMINAL_LINE[slug] ? 2 : 1;
}

/** 從所有建國起點做多源 BFS,回傳每個政體的最短層數 */
export function computeLayers(
  starts: readonly string[] = FOUNDING_GOVERNMENT_SLUGS,
  edges: readonly RegimeEdge[] = REGIME_EDGES,
): Map<string, number> {
  const layer = new Map<string, number>();
  let frontier = [...starts];
  for (const s of frontier) layer.set(s, 0);
  let d = 0;
  while (frontier.length > 0) {
    d++;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of edges) {
        if (e.from === cur && !layer.has(e.to)) { layer.set(e.to, d); next.push(e.to); }
      }
    }
    frontier = next;
  }
  return layer;
}

export function buildFocusTree(currentSlug: string | null, myBranches: ReadonlySet<string> | null): FocusTreeData {
  const layers = computeLayers();
  const depth = new Map<string, 0 | 1 | 2>();
  if (currentSlug) {
    depth.set(currentSlug, 0);
    const firstStep = edgesFrom(currentSlug).filter((e) => !myBranches || myBranches.has(e.to));
    for (const e of firstStep) if (!depth.has(e.to)) depth.set(e.to, 1);
    for (const e of firstStep) {
      for (const e2 of edgesFrom(e.to)) if (!depth.has(e2.to)) depth.set(e2.to, 2);
    }
  }
  const nodes: TreeNode[] = GOVERNMENTS.map((g) => ({
    slug: g.slug,
    label: g.label,
    stage: stageOf(g.slug),
    line: stageOf(g.slug) === 2 ? TERMINAL_LINE[g.slug]! : null,
    layer: layers.get(g.slug) ?? null,
    isFounding: FOUNDING_GOVERNMENT_SLUGS.includes(g.slug),
    isCurrent: g.slug === currentSlug,
    depth: depth.get(g.slug) ?? null,
  }));
  const edges: TreeEdge[] = REGIME_EDGES.map((e) => {
    const fromMe = e.from === currentSlug;
    const drawn = !myBranches || myBranches.has(e.to);
    return {
      from: e.from,
      to: e.to,
      track: e.track,
      focusId: e.focusId,
      walkable: fromMe && drawn,
      notDrawn: fromMe && !drawn,
    };
  });
  return { currentGovernment: currentSlug, limited: myBranches !== null, nodes, edges };
}
