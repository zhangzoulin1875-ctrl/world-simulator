/**
 * Task #152 — 海上登陸系統（純資料與純函式）。
 *
 * 兩種跨海方式：
 *  - 近海相鄰（隔海相鄰）：雙方地區以狹窄海域／海峽相隔（見 SEA_ADJACENCY_PAIRS）。
 *    研發「海戰」(naval_warfare) 後即可登陸。
 *  - 跨洋（trans-ocean）：既非陸地相鄰、也非近海相鄰。需研發「指南針」(compass)，
 *    無視距離即可登陸。
 *
 * 兩項可受加成影響的國家數值：
 *  - 海上登陸容許量（seaLandingCapacity）：單場登陸戰役可投入的兵力上限。
 *    指南針解鎖後 ×10。
 *  - 減損攻擊力（landingAttackReduction）：登陸時攻擊力的減損百分比（愈低愈好）。
 *
 * 本檔僅含靜態資料與純函式，方便單元測試；加成彙總與 DB 存取在伺服器層完成。
 */

import { MAP_REGION_SEED, EXPECTED_ISOLATED } from "./mapRegions";

/**
 * 近海相鄰（隔海相鄰）的地區對，以地區名稱表示（無向；同步時展開為雙向）。
 * 這些地區之間沒有固定陸橋／隧道，但以狹窄海域或海峽相隔，屬「可登陸」範圍。
 * 未列於此、且非陸地相鄰者，視為跨洋，需指南針。
 */
export const SEA_ADJACENCY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  // 島嶼近海連結（確保每座孤島除跨洋外仍有近海登陸點）
  // 東亞／東南亞／大洋洲
  ["蘇門答臘島", "半島東西海岸"], // 麻六甲海峽
  ["蘇門答臘島", "爪哇島"], // 巽他海峽
  ["爪哇島", "婆羅洲東馬"], // 爪哇海
  ["婆羅洲東馬", "蘇拉威西摩鹿加"], // 望加錫海峽
  ["婆羅洲東馬", "呂宋民答那峨"], // 蘇祿海
  ["蘇拉威西摩鹿加", "新幾內亞島"], // 摩鹿加海
  ["新幾內亞島", "澳洲東部沿海"], // 托雷斯海峽
  ["紐西蘭南北島", "澳洲東部沿海"], // 塔斯曼海
  ["瓊州南海", "珠江嶺南"], // 瓊州海峽
  ["沖繩琉球", "九州島"], // 琉球群島（東海）
  ["濟州島", "全羅地方"], // 濟州海峽
  ["九州島", "釜山廣域圈"], // 對馬海峽（日本 ↔ 朝鮮半島）
  // 歐洲／地中海
  ["北愛爾蘭區", "蘇格蘭低地"], // 北海峽
  ["巴利阿里群島", "瓦倫西亞"], // 巴利阿里海
  ["科西嘉島", "薩丁尼亞"], // 博尼法喬海峽
  ["科西嘉島", "托斯卡尼"], // 科西嘉海峽（第勒尼安海）
  ["阿特拉斯", "安達魯西亞"], // 直布羅陀海峽
  ["雅典阿提卡", "愛琴海沿岸"], // 愛琴海
  // 南亞
  ["斯里蘭卡", "坦米爾納杜"], // 保克海峽
  // 非洲
  ["馬達加斯", "莫三比克"], // 莫三比克海峽
  // 美洲
  ["西印度群島", "中美地峽"], // 加勒比海
  ["西印度群島", "佛羅里達"], // 佛羅里達海峽
];

/**
 * 僅能以跨洋登陸抵達的孤島（無近海相鄰連結，必須研發指南針）。
 * 這些地區刻意不列入 SEA_ADJACENCY_PAIRS，用於驗證登陸資料完整性。
 */
export const COMPASS_ONLY_ISLANDS: readonly string[] = ["冰島", "夏威夷"];

/** 海上登陸容許量基準（未受加成、未解鎖指南針時的單場兵力上限）。 */
export const BASE_SEA_LANDING_CAPACITY = 5_000;

/** 指南針解鎖後的容許量倍率。 */
export const COMPASS_CAPACITY_MULTIPLIER = 10;

/** 登陸攻擊力減損基準百分比（未受加成時；愈高代表登陸愈吃虧）。 */
export const BASE_LANDING_ATTACK_REDUCTION_PCT = 50;

/** 登陸攻擊力減損下限（加成再多也至少保留此減損）。 */
export const MIN_LANDING_ATTACK_REDUCTION_PCT = 10;

/** 登陸種類：陸地相鄰不需渡海；近海需海戰；跨洋需指南針。 */
export type LandingKind = "land" | "nearSea" | "transOcean";

let cachedAdjacency: Map<string, Set<string>> | null = null;

/** 建立雙向近海相鄰查詢表（名稱 → 相鄰名稱集合）。 */
export function buildSeaAdjacency(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    const set = map.get(a) ?? new Set<string>();
    set.add(b);
    map.set(a, set);
  };
  for (const [a, b] of SEA_ADJACENCY_PAIRS) {
    add(a, b);
    add(b, a);
  }
  return map;
}

function adjacency(): Map<string, Set<string>> {
  cachedAdjacency ??= buildSeaAdjacency();
  return cachedAdjacency;
}

/** 兩地區是否近海相鄰（隔海相鄰）。 */
export function isSeaAdjacent(a: string, b: string): boolean {
  return adjacency().get(a)?.has(b) ?? false;
}

/** 某地區的近海相鄰名稱清單（穩定排序）。 */
export function seaNeighborsOf(name: string): string[] {
  return [...(adjacency().get(name) ?? [])].sort((x, y) =>
    x.localeCompare(y, "zh-Hant"),
  );
}

/**
 * 依「是否陸地相鄰」「是否近海相鄰」判定登陸種類。
 * 陸地相鄰優先（一般進攻，不算登陸）。
 */
export function classifyLanding(
  landAdjacent: boolean,
  seaAdjacent: boolean,
): LandingKind {
  if (landAdjacent) return "land";
  if (seaAdjacent) return "nearSea";
  return "transOcean";
}

/**
 * 有效海上登陸容許量：基準 ×(1＋加成%)，指南針解鎖再 ×10。
 * bonusPct 為正提高容許量。結果取非負整數。
 */
export function effectiveSeaLandingCapacity(
  bonusPct: number,
  hasCompass: boolean,
): number {
  const base = Math.max(
    0,
    Math.round(BASE_SEA_LANDING_CAPACITY * (1 + bonusPct / 100)),
  );
  return hasCompass ? base * COMPASS_CAPACITY_MULTIPLIER : base;
}

/**
 * 有效登陸攻擊力減損百分比：基準 − 加成（加成為正代表減少減損／登陸更順利），
 * 夾在 [MIN, BASE] 之間並取整數。
 */
export function effectiveLandingAttackReductionPct(bonusPct: number): number {
  const v = BASE_LANDING_ATTACK_REDUCTION_PCT - bonusPct;
  return Math.round(
    Math.min(
      BASE_LANDING_ATTACK_REDUCTION_PCT,
      Math.max(MIN_LANDING_ATTACK_REDUCTION_PCT, v),
    ),
  );
}

/**
 * 靜態一致性檢查：近海對名稱皆存在、無自環／重複、每座孤島（COMPASS_ONLY 除外）
 * 至少有一個近海相鄰。啟動與單元測試皆呼叫，壞編輯即時失敗。
 */
export function validateSeaAdjacency(): void {
  const names = new Set<string>();
  for (const list of Object.values(MAP_REGION_SEED)) {
    for (const n of list) names.add(n);
  }
  const seen = new Set<string>();
  const withSea = new Set<string>();
  for (const [a, b] of SEA_ADJACENCY_PAIRS) {
    if (a === b) throw new Error(`sea adjacency: self pair for ${a}`);
    if (!names.has(a)) throw new Error(`sea adjacency: unknown region ${a}`);
    if (!names.has(b)) throw new Error(`sea adjacency: unknown region ${b}`);
    const key = [a, b].sort().join("\u0000");
    if (seen.has(key)) {
      throw new Error(`sea adjacency: duplicate pair ${a} – ${b}`);
    }
    seen.add(key);
    withSea.add(a);
    withSea.add(b);
  }
  const compassOnly = new Set(COMPASS_ONLY_ISLANDS);
  for (const island of EXPECTED_ISOLATED) {
    if (compassOnly.has(island)) {
      if (withSea.has(island)) {
        throw new Error(
          `sea adjacency: ${island} 應為跨洋孤島，不應有近海相鄰`,
        );
      }
      continue;
    }
    if (!withSea.has(island)) {
      throw new Error(`sea adjacency: 孤島 ${island} 缺少近海登陸點`);
    }
  }
}
