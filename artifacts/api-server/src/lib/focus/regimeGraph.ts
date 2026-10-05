import { FOUNDING_GOVERNMENT_SLUGS, GOVERNMENTS } from "../governments";
import type { FocusTrack } from "./core";

/**
 * 政體有向圖:換政體只能沿著邊走,每條邊對應一個「轉型國策」。
 *
 * 設計(2026-10-05 定案):
 *  - 建國只能三選一(君主專制/貴族制/議會共和),其餘 11 個政體靠轉型國策走到。
 *  - 紅線終點:社會主義委員會制、委員會制。
 *  - 黑線終點:軍事獨裁、神權制。
 *  - 穩定路線:君主立憲、議會內閣、總統制;原本是獨裁或民主則多第四條(世襲化/民主化)。
 *  - 不是每個政體都互通:邊的方向與數量就是「國家的命運選項」。
 */
export interface RegimeEdge {
  from: string;
  to: string;
  track: FocusTrack;
  /** 轉型國策 id(對應 catalog 中 regime 領域、含 transition 效果的國策)。 */
  focusId: string;
  /**
   * 革命奪權(人民推翻獨裁政權):完成後由革命方以 `revolutionLandShare` 的土地開內戰,
   * 而不是政府自己轉型。只用在獨裁國家走紅線。
   */
  revolution?: { landShare: number };
}

const e = (from: string, to: string, track: FocusTrack): RegimeEdge => ({
  from,
  to,
  track,
  focusId: `regime.${from}_to_${to}`,
});

/** 獨裁國家發動共產革命:革命政權只佔 35% 土地(民主國家的議會式革命是 40%)。 */
export const AUTOCRACY_RED_REVOLUTION_LAND_SHARE = 0.35;
const rev = (from: string): RegimeEdge => ({
  ...e(from, "council_system", "red"),
  focusId: `regime.${from}_red_revolution`,
  revolution: { landShare: AUTOCRACY_RED_REVOLUTION_LAND_SHARE },
});

export const REGIME_EDGES: readonly RegimeEdge[] = [
  // ── 君主專制(建國起點)──────────────────────────────
  e("absolute_monarchy", "constitutional_monarchy", "reform"), // 頒布憲章
  e("absolute_monarchy", "military_dictatorship", "black"), // 軍人奪權
  e("absolute_monarchy", "theocracy", "black"), // 神權
  e("absolute_monarchy", "elective_monarchy", "stable"), // 改選舉君主
  e("absolute_monarchy", "dual_monarchy", "stable"), // 並立雙王冠

  // ── 貴族制(建國起點)────────────────────────────────
  e("aristocracy", "elective_monarchy", "stable"),
  e("aristocracy", "absolute_monarchy", "stable"), // 王權集中
  e("aristocracy", "plutocracy", "stable"), // 商賈崛起
  e("aristocracy", "confederation", "stable"), // 諸侯聯盟
  e("aristocracy", "theocracy", "black"),

  // ── 議會共和(建國起點)──────────────────────────────
  e("parliamentary_republic", "parliamentary", "stable"),
  e("parliamentary_republic", "presidential_democracy", "stable"),
  e("parliamentary_republic", "plutocracy", "stable"),
  e("parliamentary_republic", "council_system", "red"),
  e("parliamentary_republic", "military_dictatorship", "black"),

  // ── 獨裁國家的共產革命(代價比民主國家更高,革命方只佔 35% 土地)──
  rev("absolute_monarchy"),
  rev("military_dictatorship"),
  rev("theocracy"),

  // ── 君主立憲 ──────────────────────────────────────
  e("constitutional_monarchy", "parliamentary", "reform"), // 虛君議會化
  e("constitutional_monarchy", "absolute_monarchy", "stable"), // 復辟(世襲化)
  e("constitutional_monarchy", "dual_monarchy", "stable"),

  // ── 議會內閣 ──────────────────────────────────────
  e("parliamentary", "presidential_democracy", "reform"),
  e("parliamentary", "constitutional_monarchy", "stable"), // 迎立君主
  e("parliamentary", "council_system", "red"),
  e("parliamentary", "military_dictatorship", "black"),

  // ── 總統制 ────────────────────────────────────────
  e("presidential_democracy", "parliamentary", "reform"),
  e("presidential_democracy", "military_dictatorship", "black"),
  e("presidential_democracy", "plutocracy", "stable"),

  // ── 委員會制(紅線中繼)──────────────────────────────
  e("council_system", "socialist_council", "red"),
  e("council_system", "parliamentary", "reform"), // 回頭走議會
  e("council_system", "military_dictatorship", "black"),

  // ── 社會主義委員會(紅線終點)────────────────────────
  e("socialist_council", "council_system", "reform"), // 鬆綁
  e("socialist_council", "military_dictatorship", "black"),

  // ── 軍事獨裁(黑線)──────────────────────────────────
  e("military_dictatorship", "absolute_monarchy", "stable"), // 軍人稱王
  e("military_dictatorship", "theocracy", "black"),
  e("military_dictatorship", "parliamentary_republic", "reform"), // 還政於民(民主化)

  // ── 神權制(黑線終點)────────────────────────────────
  e("theocracy", "absolute_monarchy", "stable"), // 政教分離
  e("theocracy", "military_dictatorship", "black"),

  // ── 其他 ──────────────────────────────────────────
  e("elective_monarchy", "absolute_monarchy", "stable"), // 王位世襲化
  e("elective_monarchy", "constitutional_monarchy", "reform"),
  e("dual_monarchy", "constitutional_monarchy", "reform"),
  e("dual_monarchy", "confederation", "stable"),
  e("plutocracy", "presidential_democracy", "reform"),
  e("plutocracy", "military_dictatorship", "black"),
  e("confederation", "parliamentary_republic", "reform"),
  e("confederation", "absolute_monarchy", "stable"), // 強人統一
];

/** 從某政體出發能走到的邊。 */
export function edgesFrom(slug: string, edges: readonly RegimeEdge[] = REGIME_EDGES): RegimeEdge[] {
  return edges.filter((x) => x.from === slug);
}

export function findEdge(from: string, to: string): RegimeEdge | undefined {
  return REGIME_EDGES.find((x) => x.from === from && x.to === to);
}

/** 從建國起點集合出發,BFS 可達的政體集合。 */
export function reachableFrom(
  starts: readonly string[],
  edges: readonly RegimeEdge[] = REGIME_EDGES,
): Set<string> {
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const edge of edgesFrom(cur, edges)) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

/** 圖的結構問題(空陣列=通過)。 */
export function validateRegimeGraph(edges: readonly RegimeEdge[] = REGIME_EDGES): string[] {
  const problems: string[] = [];
  const slugs = new Set(GOVERNMENTS.map((g) => g.slug));
  const seen = new Set<string>();
  for (const x of edges) {
    if (!slugs.has(x.from)) problems.push(`邊的起點不是有效政體:${x.from}`);
    if (!slugs.has(x.to)) problems.push(`邊的終點不是有效政體:${x.to}`);
    if (x.from === x.to) problems.push(`自環:${x.from}`);
    const key = `${x.from}>${x.to}`;
    if (seen.has(key)) problems.push(`重複的邊:${key}`);
    seen.add(key);
  }
  // 每個政體都要有出口(不能被困死),除非圖中只有它一個
  for (const g of GOVERNMENTS) {
    if (!edges.some((x) => x.from === g.slug)) problems.push(`政體沒有任何出口:${g.slug}`);
  }
  // 所有政體都必須從建國三選一出發可達
  const reach = reachableFrom(FOUNDING_GOVERNMENT_SLUGS, edges);
  for (const g of GOVERNMENTS) {
    if (!reach.has(g.slug)) problems.push(`從建國政體無法抵達:${g.slug}`);
  }
  return problems;
}
