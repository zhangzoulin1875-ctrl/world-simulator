/**
 * 油井海戰:純函式,不碰資料庫。
 *
 * 為什麼獨立於陸戰引擎:陸戰綁了 AI 指令、補給、士氣、宣戰。油井是「艦隊投入 + 時間到結算」
 * 的簡化海戰,硬套陸戰引擎會讓兩邊互相牽制。公式刻意確定性(不擲骰):結果可預測、可測試、
 * 玩家能自己算出要投多少。
 */

/** 艦種輸入(來自 military_unit_templates)。 */
export interface ShipStats { hp: number; attack: number; defense: number }

/** 單艦戰力 = (攻 + 防) / 2 × sqrt(血)。sqrt 壓縮血量,避免 AI 設計出誇張血量就一面倒。 */
export function shipPower(s: ShipStats): number {
  const f = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return ((f(s.attack) + f(s.defense)) / 2) * Math.sqrt(f(s.hp));
}

export interface FleetLine { templateId: number; quantity: number; stats: ShipStats }

/** 艦隊總戰力。數量負數或非有限值視為 0。 */
export function fleetPower(lines: readonly FleetLine[]): number {
  let total = 0;
  for (const l of lines) {
    const q = Number.isFinite(l.quantity) && l.quantity > 0 ? l.quantity : 0;
    total += q * shipPower(l.stats);
  }
  return total;
}

/**
 * 守方地利加成:守方戰力 ×1.15。以整數分子/分母(115/100)表示並用交叉相乘比較,
 * 因為 100×1.15 在浮點數是 114.99999999999999,直接比較會讓「剛好平手」的邊界結果不穩定。
 */
export const DEFENDER_ADV_NUM = 115;
export const DEFENDER_ADV_DEN = 100;
export const DEFENDER_ADVANTAGE = DEFENDER_ADV_NUM / DEFENDER_ADV_DEN;
/** 贏家最多損失其艦隊的比例 / 輸家最多損失的比例。 */
export const WINNER_MAX_LOSS = 0.3;
export const LOSER_MAX_LOSS = 0.6;

export type OilBattleOutcome = "attacker_wins" | "defender_wins";

export interface OilBattleResult {
  outcome: OilBattleOutcome;
  attackerPower: number;
  defenderPower: number;
  /** 攻方 / 守方各自損失比例(0~1),套用到每個艦種的數量。 */
  attackerLossRatio: number;
  defenderLossRatio: number;
}

/**
 * 結算一場油井海戰。
 * - 守方沒有艦隊(戰力 0)且攻方有戰力 → 攻方無損獲勝(空佔)。
 * - 雙方都 0 戰力 → 守方勝(維持現狀,攻方等於沒出兵)。
 * - 平手(含地利後相等)→ 守方勝。
 * - 攻方戰力先乘距離衰減係數(attackerFactor),回報的 attackerPower 是衰減後的實際值;守方不衰減。
 * - 贏家損失比例 = WINNER_MAX_LOSS × (輸家戰力 / 贏家戰力);輸家固定 LOSER_MAX_LOSS。
 *   所以以大欺小幾乎無損,勢均力敵時兩邊都重創。
 */
export function resolveOilBattle(
  attacker: readonly FleetLine[], defender: readonly FleetLine[],
  /** 攻方戰力係數(距離衰減,0~1,預設 1 = 不衰減)。非有限或超出範圍的值夾回 [0,1]。 */
  attackerFactor: number = 1,
): OilBattleResult {
  const f = Number.isFinite(attackerFactor) ? Math.min(1, Math.max(0, attackerFactor)) : 1;
  const a = fleetPower(attacker) * f;
  const dRaw = fleetPower(defender);
  const d = (dRaw * DEFENDER_ADV_NUM) / DEFENDER_ADV_DEN;   // 僅供回報與損失比例用
  if (a <= 0) {
    return { outcome: "defender_wins", attackerPower: 0, defenderPower: d, attackerLossRatio: 0, defenderLossRatio: 0 };
  }
  if (dRaw <= 0) {
    return { outcome: "attacker_wins", attackerPower: a, defenderPower: 0, attackerLossRatio: 0, defenderLossRatio: 0 };
  }
  // 勝負用交叉相乘:a > dRaw × 115/100  ⇔  a × 100 > dRaw × 115,避開浮點除法誤差
  if (a * DEFENDER_ADV_DEN > dRaw * DEFENDER_ADV_NUM) {
    return { outcome: "attacker_wins", attackerPower: a, defenderPower: d, attackerLossRatio: Math.min(WINNER_MAX_LOSS, WINNER_MAX_LOSS * (d / a)), defenderLossRatio: LOSER_MAX_LOSS };
  }
  return { outcome: "defender_wins", attackerPower: a, defenderPower: d, attackerLossRatio: LOSER_MAX_LOSS, defenderLossRatio: Math.min(WINNER_MAX_LOSS, WINNER_MAX_LOSS * (a / d)) };
}

/**
 * 把損失比例套到艦隊,回傳每種艦剩餘數量。向下取整損失(對玩家有利:不會因四捨五入多死),
 * 但只要比例 > 0 且該艦種有船,至少損失 1 艘,避免小艦隊永遠零損失。
 */
export function applyLosses(lines: readonly FleetLine[], lossRatio: number): Array<{ templateId: number; before: number; lost: number; after: number }> {
  const r = Number.isFinite(lossRatio) ? Math.min(1, Math.max(0, lossRatio)) : 0;
  return lines.map((l) => {
    const before = Number.isFinite(l.quantity) && l.quantity > 0 ? Math.floor(l.quantity) : 0;
    let lost = Math.floor(before * r);
    if (r > 0 && before > 0 && lost === 0) lost = 1;
    lost = Math.min(before, lost);
    return { templateId: l.templateId, before, lost, after: before - lost };
  });
}

// ── 無人佔領油井的守軍 ─────────────────────────────────────

/** 標準守軍艦的單艦戰力。守軍 garrison_strength 艘 × 此值 = 無人佔領時的防守戰力。 */
export const STANDARD_GARRISON_SHIP_POWER = 100;

/**
 * 無人佔領的油井由守軍迎戰:把 garrison_strength 折成一支虛擬艦隊(1 種艦,單艦戰力 100)。
 * 回傳 FleetLine 讓 resolveOilBattle 不必特別處理;templateId 0 代表虛擬守軍(不對應真實模板、不扣損失)。
 * garrison_strength <= 0 或非有限值 → 空艦隊(攻方可空佔)。
 */
export function garrisonFleet(garrisonStrength: number): FleetLine[] {
  const q = Number.isFinite(garrisonStrength) && garrisonStrength > 0 ? Math.floor(garrisonStrength) : 0;
  if (q === 0) return [];
  // attack=defense=100、hp=1 → (100+100)/2 × sqrt(1) = 100
  return [{ templateId: 0, quantity: q, stats: { attack: STANDARD_GARRISON_SHIP_POWER, defense: STANDARD_GARRISON_SHIP_POWER, hp: 1 } }];
}

/** 戰役結算延遲(小時)。預設 6,與每小時計分同為真實時間。 */
export const OIL_CAMPAIGN_DELAY_HOURS = 6;

export function settleTimeFor(startedAt: Date, delayHours: number = OIL_CAMPAIGN_DELAY_HOURS): Date {
  return new Date(startedAt.getTime() + delayHours * 3_600_000);
}

export type CommitCheck = { ok: true; lines: Array<{ templateId: number; quantity: number }> } | { ok: false; error: string };

/**
 * 驗證一次投入請求(純函式)。
 * - 至少一項、每項 quantity 為正整數、templateId 不重複(重複會繞過逐項上限檢查)
 * - 每項都必須是艦船模板(isShip)且投入量 ≤ 可派量
 */
export function validateCommit(
  requested: ReadonlyArray<{ templateId: unknown; quantity: unknown }>,
  isShip: (templateId: number) => boolean,
  availableOf: (templateId: number) => number,
): CommitCheck {
  if (!Array.isArray(requested) || requested.length === 0) return { ok: false, error: "請至少選擇一種艦船" };
  if (requested.length > 50) return { ok: false, error: "一次最多投入 50 種艦船" };
  const seen = new Set<number>();
  const lines: Array<{ templateId: number; quantity: number }> = [];
  for (const r of requested) {
    const t = r.templateId, q = r.quantity;
    if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) return { ok: false, error: "艦船編號不正確" };
    if (typeof q !== "number" || !Number.isInteger(q) || q <= 0) return { ok: false, error: "投入數量必須是正整數" };
    if (seen.has(t)) return { ok: false, error: "同一種艦船不可重複列出" };
    seen.add(t);
    if (!isShip(t)) return { ok: false, error: "油井戰役只能投入艦船" };
    if (q > availableOf(t)) return { ok: false, error: "可派遣的艦船不足" };
    lines.push({ templateId: t, quantity: q });
  }
  return { ok: true, lines };
}
