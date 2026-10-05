import { edgesFrom, type RegimeEdge } from "./regimeGraph";

/**
 * 國策樹隨機分支(2026-10-05 定案):
 *  - 每個玩家從「目前政體」長出 3~5 個隨機分支政權(目的地),不是抽國策。
 *  - 出邊不足就全給,不硬湊。
 *  - 共產革命是獨立入口(不在政體圖裡),永遠存在,不佔名額,所以這裡完全不處理它。
 *  - 抽出的結果會存進資料表,之後不重抽(見 branchService)。
 */
export const BRANCH_MIN = 3;
export const BRANCH_MAX = 5;

/** 這次要抽幾個:3~5 之間隨機,但不超過出邊總數。 */
export function branchCount(available: number, rand: () => number): number {
  if (available <= 0) return 0;
  const want = BRANCH_MIN + Math.floor(rand() * (BRANCH_MAX - BRANCH_MIN + 1));
  return Math.min(available, want);
}

/** Fisher-Yates 洗牌後取前 n 個(不改動原陣列)。 */
export function pickRandom<T>(items: readonly T[], n: number, rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, Math.max(0, n));
}

/**
 * 從某政體的出邊抽出分支目的地(slug 陣列,依政體圖原順序回傳,方便畫面穩定)。
 * 一個目的地只會有一條邊(政體圖保證),所以抽邊 = 抽目的地。
 */
export function drawBranches(
  fromGovernment: string,
  rand: () => number = Math.random,
  edges: readonly RegimeEdge[] = edgesFrom(fromGovernment),
): string[] {
  const dests = [...new Set(edges.filter((e) => e.from === fromGovernment).map((e) => e.to))];
  const chosen = new Set(pickRandom(dests, branchCount(dests.length, rand), rand));
  return dests.filter((d) => chosen.has(d));
}
