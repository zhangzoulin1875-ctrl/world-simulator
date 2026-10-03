import type { WallTier, WarCity, WarCityState } from "@workspace/db";
import { getEraIndex } from "./mapRegionEras";

/**
 * Task #150 — 城牆防禦階級的領域純函式（無 DB、無 AI，可單元測試）。
 * 城牆分四級：木牆 < 石牆 < 碉堡 < 混凝土要塞。每級有耐久上限與（該級、
 * 非累加的）防禦加成。戰役結算與升級路由共用這裡的規則，確保行為一致。
 */

/** 城牆階級（由低到高）。 */
export const WALL_TIERS = ["wood", "stone", "bunker", "concrete"] as const;

const _tiersCheck: readonly WallTier[] = WALL_TIERS;
void _tiersCheck;

/** 城牆階級中文標籤。 */
export const WALL_TIER_LABELS: Record<WallTier, string> = {
  wood: "木牆",
  stone: "石牆",
  bunker: "碉堡",
  concrete: "混凝土要塞",
};

/** 各階級城牆耐久上限（石 = 木×10，碉堡 = 石×10，混凝土 = 碉堡×5）。 */
export const WALL_MAX_DURABILITY: Record<WallTier, number> = {
  wood: 100,
  stone: 1_000,
  bunker: 10_000,
  concrete: 50_000,
};

/**
 * 各階級城牆給「駐守該城守軍」的防禦加成（%）。此為該階級的加成，非累加：
 * 木 0、石 +50、碉堡 +50、混凝土 +80。結算時以「減免守軍傷亡」實作。
 */
export const WALL_DEFENSE_BONUS_PCT: Record<WallTier, number> = {
  wood: 0,
  stone: 50,
  bunker: 50,
  concrete: 80,
};

/**
 * 升級到該階級所需金錢（逐級升級，只升不降）。木牆為預設起點、不可購買。
 * 成本隨耐久與加成的躍升遞增（相對建築 800–10000 的量級，城牆屬戰略基建）。
 */
export const WALL_UPGRADE_COST: Record<WallTier, number> = {
  wood: 0,
  stone: 5_000,
  bunker: 30_000,
  concrete: 150_000,
};

/** 攻城傷害的強度係數（見 computeSiegeDamage 的平方根壓縮模型）。 */
export const SIEGE_DAMAGE_K = 25;

export function isWallTier(v: unknown): v is WallTier {
  return typeof v === "string" && (WALL_TIERS as readonly string[]).includes(v);
}

/** 階級序（wood=0 … concrete=3）；非法階級回傳 -1。 */
export function wallTierIndex(tier: string): number {
  return (WALL_TIERS as readonly string[]).indexOf(tier);
}

export function wallMaxDurability(tier: WallTier): number {
  return WALL_MAX_DURABILITY[tier];
}

export function wallDefenseBonusPct(tier: WallTier): number {
  return WALL_DEFENSE_BONUS_PCT[tier];
}

export function wallUpgradeCost(tier: WallTier): number {
  return WALL_UPGRADE_COST[tier];
}

/** 下一階級；已是最高階（concrete）回傳 null。 */
export function nextWallTier(tier: WallTier): WallTier | null {
  const i = wallTierIndex(tier);
  if (i < 0 || i >= WALL_TIERS.length - 1) return null;
  return WALL_TIERS[i + 1]!;
}

/**
 * 城牆階級是否解鎖。任務規格的具名生產科技（鐵質器具／機械革新／煉製技術）
 * 在本專案不存在，改以「既有」的生產科技訊號把關：
 * - 木牆：永遠可用（預設）。
 * - 石牆：需已解鎖 cityWallEnabled（來自關鍵技術「風車技術」，high_medieval）。
 * - 碉堡：cityWallEnabled 且玩家生產領域時代 ≥ 工業革命（industrial）。
 * - 混凝土：cityWallEnabled 且生產領域時代 ≥ 現代（modern）。
 */
export function wallTierUnlocked(
  tier: WallTier,
  opts: { cityWallEnabled: boolean; productionEraSlug: string },
): boolean {
  if (tier === "wood") return true;
  if (!opts.cityWallEnabled) return false;
  if (tier === "stone") return true;
  const eraIdx = getEraIndex(opts.productionEraSlug);
  if (tier === "bunker") return eraIdx >= getEraIndex("industrial");
  if (tier === "concrete") return eraIdx >= getEraIndex("modern");
  return false;
}

/**
 * 逐級升級校驗（只升不降、逐級、且目標階級已解鎖）。回傳 { ok:true } 或
 * 帶 zh-TW 錯誤訊息。金錢與掌控權檢查在路由交易內做。
 */
export function canUpgradeWall(
  current: WallTier,
  target: string,
  opts: { cityWallEnabled: boolean; productionEraSlug: string },
): { ok: true; tier: WallTier } | { ok: false; error: string } {
  if (!isWallTier(target)) return { ok: false, error: "城牆階級不正確" };
  const ci = wallTierIndex(current);
  const ti = wallTierIndex(target);
  if (ti <= ci) return { ok: false, error: "只能升級城牆，無法降級" };
  if (ti !== ci + 1) return { ok: false, error: "城牆需逐級升級，無法跳級" };
  if (!wallTierUnlocked(target, opts)) {
    return { ok: false, error: `${WALL_TIER_LABELS[target]}尚未解鎖` };
  }
  return { ok: true, tier: target };
}

/**
 * Task #173 — NPC 城牆階級的「時代上限」。NPC 不研發科技（`cityWallEnabled`
 * 恆為 false），若沿用玩家的 `wallTierUnlocked` 只會永遠停在木牆、守城形同虛設。
 * 因此改以純時代決定 NPC 開戰時可用的最高城牆階級：
 * 石牆 ≥ 中世紀中期、碉堡 ≥ 工業革命、混凝土 ≥ 現代；更早僅木牆。門檻對齊
 * 玩家的解鎖時代（石牆＝風車技術所在的 high_medieval）。
 */
export function maxNpcWallTierForEra(eraSlug: string): WallTier {
  const eraIdx = getEraIndex(eraSlug);
  if (eraIdx >= getEraIndex("modern")) return "concrete";
  if (eraIdx >= getEraIndex("industrial")) return "bunker";
  if (eraIdx >= getEraIndex("high_medieval")) return "stone";
  return "wood";
}

/**
 * 確定性 NPC 城牆階級選取（無 AI）。以時代上限為範圍，依人口三段式選出階級：
 * - 弱國（< 500,000）→ 最低允許階級。
 * - 強國（≥ 2,000,000）→ 最高允許階級。
 * - 中等 → 中間階級。
 * `allowedTiers` 由呼叫端依 `maxNpcWallTierForEra` 收斂，此函式只做三段選取。
 */
export function pickNpcWallTier(
  population: number,
  allowedTiers: readonly WallTier[],
): WallTier {
  if (allowedTiers.length === 0) return "wood";
  if (allowedTiers.length === 1) return allowedTiers[0]!;
  if (population < 500_000) return allowedTiers[0]!;
  if (population >= 2_000_000) return allowedTiers[allowedTiers.length - 1]!;
  return allowedTiers[Math.floor((allowedTiers.length - 1) / 2)]!;
}

/**
 * 攻城傷害：以「強度（0–100）× 圍城兵力」決定單一結算週期消耗的城牆耐久。
 * 兵力以平方根壓縮——軍隊規模跨度極大（數千到數百萬），線性換算會讓混凝土
 * 不是永不陷落就是瞬間崩潰。damage = round(intensity/100 × K × √troops)。
 */
export function computeSiegeDamage(
  intensityPct: number,
  besiegerTroops: number,
): number {
  const intensity = Math.max(0, Math.min(100, intensityPct));
  const troops = Math.max(0, Math.floor(besiegerTroops));
  if (intensity <= 0 || troops <= 0) return 0;
  return Math.round((intensity / 100) * SIEGE_DAMAGE_K * Math.sqrt(troops));
}

/**
 * 把總攻城傷害分配到一個地區的多座城市：集中—溢出模式。順序為「目前耐久
 * 最低的尚存城市優先」（同耐久 → 陣列原順序），逐城打到 0 後溢出到下一座。
 * 讓城市逐座陷落、便於逐城顯示耐久，而非一次雨露均霑。回傳新陣列（不變更輸入）。
 */
export function applySiegeToCities(
  cities: readonly WarCity[],
  totalDamage: number,
): WarCity[] {
  const result = cities.map((c) => ({ ...c }));
  let remaining = Math.max(0, Math.floor(totalDamage));
  if (remaining <= 0) return result;
  const order = result
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.durability > 0)
    .sort((a, b) => a.c.durability - b.c.durability || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    const city = result[i]!;
    const applied = Math.min(city.durability, remaining);
    city.durability -= applied;
    remaining -= applied;
  }
  return result;
}

/** 單城防線完整度 0–100（round(durability/max×100)）；max ≤ 0 → 0。 */
export function durabilityPct(city: WarCity): number {
  if (city.maxDurability <= 0) return 0;
  return Math.round((city.durability / city.maxDurability) * 100);
}

/**
 * 整條城市防線是否陷落：所有城市耐久皆 ≤ 0（或無城市）→ true。任一城市
 * 尚存 → false（capTransferForCity 以此保底守方 ≥1% 控制率）。
 */
export function cityLineFallen(state: WarCityState | null): boolean {
  if (!state || state.cities.length === 0) return true;
  return state.cities.every((c) => c.durability <= 0);
}

/**
 * 該方城市防線的「整體完整度」0–100（顯示與舊戰報相容用）：取最脆弱尚存
 * 城市的耐久百分比；全部陷落 → 0；無城市 → null。
 */
export function cityLineHoldoutPct(state: WarCityState | null): number | null {
  if (!state || state.cities.length === 0) return null;
  const standing = state.cities.filter((c) => c.durability > 0);
  if (standing.length === 0) return 0;
  return Math.min(...standing.map((c) => durabilityPct(c)));
}

/**
 * 尚存城市中最強城牆的防禦加成（%）。無尚存城市或 null → 0。用於減免
 * 「駐守該地區城市」的守軍傷亡。
 */
export function bestStandingWallDefenseBonusPct(
  state: WarCityState | null,
): number {
  if (!state) return 0;
  let best = 0;
  for (const c of state.cities) {
    if (c.durability > 0) {
      best = Math.max(best, WALL_DEFENSE_BONUS_PCT[c.wallTier]);
    }
  }
  return best;
}

/**
 * 以城牆防禦加成減免守軍傷亡：傷亡 × (1 − pct/100)，pct 夾在 0–90。
 * 例：石牆/碉堡 +50% → 傷亡減半；混凝土 +80% → 僅剩兩成。回傳非負整數。
 */
export function applyWallDefenseToCasualty(
  casualty: number,
  defenseBonusPct: number,
): number {
  const c = Math.max(0, Math.floor(casualty));
  if (c <= 0) return 0;
  const pct = Math.max(0, Math.min(90, defenseBonusPct));
  return Math.round(c * (1 - pct / 100));
}

/**
 * NPC 全滅接管：把整條城市防線標記為陷落（全部城市耐久歸 0、駐軍解除）。
 * 守軍全滅後城市無人防守，視同陷落 — 讓 capTransferForCity 不再保底、
 * transferForRegion 的「城未陷不得清零」不變量放行。null（無城市）原樣回傳；
 * 不變更輸入（回傳新物件）。
 */
export function fallenCityLine(
  state: WarCityState | null,
): WarCityState | null {
  if (!state) return null;
  return {
    ...state,
    garrisoned: false,
    cities: state.cities.map((c) => ({ ...c, durability: 0 })),
  };
}

/** 建立單城的初始戰役城牆狀態（開戰快照）。 */
export function makeWarCity(input: {
  cityId: number;
  name: string;
  tier: WallTier;
}): WarCity {
  return {
    cityId: input.cityId,
    name: input.name,
    wallTier: input.tier,
    maxDurability: WALL_MAX_DURABILITY[input.tier],
    durability: WALL_MAX_DURABILITY[input.tier],
  };
}
