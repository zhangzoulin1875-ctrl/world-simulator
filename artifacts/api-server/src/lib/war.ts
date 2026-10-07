import { supplyPowerFactor } from "./supply";
import type {
  MilitaryTechBonus,
  WarCityState,
  WallTier,
} from "@workspace/db";
import { cityLineFallen, makeWarCity } from "./wall";

/**
 * Task #105 — 戰爭戰役系統的領域純函式（無 DB、無 AI，可單元測試）。
 * 結算迴圈與路由共用這裡的規則，確保行為一致。
 */

/** 軍團槽位（每方每戰役最多 3 個軍團）。 */
export const LEGION_SLOTS = ["A", "B", "C"] as const;
export type LegionSlot = (typeof LEGION_SLOTS)[number];

export function isLegionSlot(v: string): v is LegionSlot {
  return (LEGION_SLOTS as readonly string[]).includes(v);
}

/** 每軍團最多可編入的兵種數。 */
export const MAX_UNIT_TYPES_PER_LEGION = 5;

/** 作戰指令類型（單一自由文字欄）。 */
export const WAR_ORDER_TYPES = ["command"] as const;
export type WarOrderType = (typeof WAR_ORDER_TYPES)[number];

export function isWarOrderType(v: string): v is WarOrderType {
  return (WAR_ORDER_TYPES as readonly string[]).includes(v);
}

export const WAR_ORDER_TYPE_LABELS: Record<WarOrderType, string> = {
  command: "作戰",
};

/** 指令內容長度上限。 */
export const ORDER_BODY_MAX_LENGTH = 150;

/** 預設結算週期（小時）；管理員可覆寫（1–168）。 */
export const DEFAULT_CYCLE_HOURS = 24;

/** 戰役結束後兩地區的冷卻時間（分鐘）。 */
export const REGION_COOLDOWN_MINUTES = 30;

/** AI 結算連續失敗達此次數後，改用確定性「僵持」結算避免戰役卡死。 */
export const MAX_AI_FAIL_COUNT = 3;

/** AI 結算失敗後的重試延遲（分鐘）。 */
export const RESOLVE_RETRY_MINUTES = 10;

/** 傷兵基礎復原速度（時間比例）：每日復原前線傷兵的比例（供戰役週期前線復原用）。 */
export const WOUNDED_BASE_RECOVERY_PER_DAY = 0.10;

/** 可用兵力 = 持有 − 已派前線（含前線傷兵） − 全國傷兵池，下限 0。 */
export function computeAvailable(
  owned: number,
  committed: number,
  woundedPool: number,
): number {
  return Math.max(0, owned - committed - woundedPool);
}

/** 玩家提交的軍團配置輸入。 */
export interface LegionInput {
  slot: string;
  garrisoningCity?: boolean;
  units: { templateId: number; quantity: number }[];
}

/**
 * 驗證軍團配置輸入的結構規則（≤3 軍團、槽位唯一且為 A/B/C、每團 ≤5 種
 * 兵種、兵種不重複、數量為非負整數）。可用兵力檢查在路由交易內做。
 * 回傳 zh-TW 錯誤訊息；null = 通過。
 */
export function validateLegionsInput(legions: LegionInput[]): string | null {
  if (!Array.isArray(legions)) return "軍團配置格式錯誤";
  if (legions.length > LEGION_SLOTS.length) {
    return `每場戰役最多 ${LEGION_SLOTS.length} 個軍團（A／B／C）`;
  }
  const seenSlots = new Set<string>();
  for (const legion of legions) {
    if (typeof legion.slot !== "string" || !isLegionSlot(legion.slot)) {
      return "軍團槽位必須是 A、B 或 C";
    }
    if (seenSlots.has(legion.slot)) {
      return `軍團槽位 ${legion.slot} 重複`;
    }
    seenSlots.add(legion.slot);
    if (!Array.isArray(legion.units)) return "軍團兵種配置格式錯誤";
    if (legion.units.length > MAX_UNIT_TYPES_PER_LEGION) {
      return `每個軍團最多 ${MAX_UNIT_TYPES_PER_LEGION} 種兵種`;
    }
    const seenTemplates = new Set<number>();
    for (const unit of legion.units) {
      if (
        typeof unit.templateId !== "number" ||
        !Number.isInteger(unit.templateId) ||
        unit.templateId <= 0
      ) {
        return "兵種模板編號無效";
      }
      if (seenTemplates.has(unit.templateId)) {
        return "同一軍團內的兵種不可重複";
      }
      seenTemplates.add(unit.templateId);
      if (
        typeof unit.quantity !== "number" ||
        !Number.isInteger(unit.quantity) ||
        unit.quantity < 0
      ) {
        return "派遣數量必須是非負整數";
      }
      if (unit.quantity > 10_000_000) {
        return "單一兵種派遣數量不可超過 1000 萬";
      }
    }
  }
  return null;
}

/** 驗證指令內容；回傳 trim 後內容或 zh-TW 錯誤。 */
export function normalizeOrderBody(
  body: unknown,
): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof body !== "string") return { ok: false, error: "指令內容必須是文字" };
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, error: "指令內容不可為空" };
  if (trimmed.length > ORDER_BODY_MAX_LENGTH) {
    return {
      ok: false,
      error: `指令內容長度不可超過 ${ORDER_BODY_MAX_LENGTH} 字`,
    };
  }
  return { ok: true, body: trimmed };
}

/**
 * 從已研發科技加成中彙總指定 target 的百分比（category 為 null 的全域項
 * 直接相加；帶 category 的項目僅在呼叫端未指定類別彙總時忽略）。
 * 用於 recoverySpeed / recoveryRate 等國家層級加成。
 */
export function sumNationalBonusPct(
  techs: readonly { bonuses: MilitaryTechBonus[] }[],
  target: MilitaryTechBonus["target"],
): number {
  let total = 0;
  for (const tech of techs) {
    for (const bonus of tech.bonuses) {
      if (bonus.target !== target) continue;
      total += bonus.pct;
    }
  }
  return total;
}

/**
 * 傷兵復原量（時間比例）：wounded × 每日基礎復原率 × (1 + speedBonusPct/100)
 * × 經過天數，向下取整、封頂於 wounded。專供戰役週期前線傷兵復原使用。
 * 回傳 0 時呼叫端不應更新 lastRecoveryAt，讓時間持續累積。
 */
export function computeRecovery(
  wounded: number,
  elapsedMs: number,
  speedBonusPct: number,
): number {
  if (wounded <= 0 || elapsedMs <= 0) return 0;
  const rate =
    WOUNDED_BASE_RECOVERY_PER_DAY * Math.max(0, 1 + speedBonusPct / 100);
  const elapsedDays = elapsedMs / 86_400_000;
  return Math.min(wounded, Math.floor(wounded * rate * elapsedDays));
}

/**
 * 全國傷兵池回合制線性復原量：
 * 每回合固定復原 ceil(initialWounded × pctPerTurn% × speedBonus)，
 * 封頂於現存 wounded，保證在 ceil(100/pctPerTurn) 回合後完全復原。
 *
 * @param initialWounded 入池時的初始傷兵數（若為 0 則以 wounded 為後援基準）
 * @param wounded        目前剩餘傷兵數
 * @param speedBonusPct  recoverySpeed 科技加成（0 = 無加成，50 = +50%）
 * @param pctPerTurn     每回合復原百分比（來自 gameBalance.war.woundedRecoveryPctPerTurn）
 */
export function computeTurnRecovery(
  initialWounded: number,
  wounded: number,
  speedBonusPct: number,
  pctPerTurn: number,
): number {
  if (wounded <= 0) return 0;
  const basis = initialWounded > 0 ? initialWounded : wounded;
  const rate = (pctPerTurn / 100) * Math.max(0, 1 + speedBonusPct / 100);
  return Math.min(wounded, Math.max(1, Math.ceil(basis * rate)));
}

/**
 * 復原率加成：把 AI 判定的死亡數按 recoveryRate 百分比轉為受傷（復原率
 * 越高、直接戰死越少）。轉換比例夾在 0–90%。
 */
export function shiftDeathsToWounded(
  dead: number,
  recoveryRatePct: number,
): { dead: number; extraWounded: number } {
  if (dead <= 0) return { dead: Math.max(0, dead), extraWounded: 0 };
  const pct = Math.min(90, Math.max(0, recoveryRatePct));
  const converted = Math.min(dead, Math.floor((dead * pct) / 100));
  return { dead: dead - converted, extraWounded: converted };
}

/**
 * 按整數比例分配 total 到各權重（largest remainder；權重全 0 → 平均
 * 分配）。分配總和恰等於 total；total ≤ 0 → 全 0。
 */
export function allocateProportionally(
  weights: readonly number[],
  total: number,
): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (total <= 0) return new Array<number>(n).fill(0);
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  const effective =
    sum > 0 ? weights.map((w) => Math.max(0, w)) : new Array<number>(n).fill(1);
  const effectiveSum = sum > 0 ? sum : n;
  const raw = effective.map((w) => (total * w) / effectiveSum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    result[i] = (result[i] ?? 0) + 1;
    remainder -= 1;
  }
  return result;
}

// ── Task #453 — 多國參戰：勝方領土分配比例正規化 ─────────────────

/**
 * 驗證 AI 給的勝方領土分配比例並正規化為權重陣列（與 nationNames 對齊）。
 * 有效條件：每個參戰國都有對應項（依國家名比對）、權重皆為有限非負數、
 * 總和 > 0。不合法／缺項／AI 未提供時 fallback 為 fallbackWeights（通常為
 * 各國投入戰力）；fallback 總和為 0 時退為平均分配。回傳的權重僅供
 * allocateProportionally 使用（毋須總和 100）。
 */
export function normalizeSplitWeights(
  aiSplit: { nationName: string; weightPct: number }[] | undefined,
  nationNames: readonly string[],
  fallbackWeights: readonly number[],
): number[] {
  const n = nationNames.length;
  const fallback = (): number[] => {
    const fb = nationNames.map((_, i) => Math.max(0, fallbackWeights[i] ?? 0));
    return fb.reduce((a, b) => a + b, 0) > 0 ? fb : new Array<number>(n).fill(1);
  };
  if (!aiSplit || n === 0) return fallback();
  const byName = new Map<string, number>();
  for (const s of aiSplit) {
    if (!Number.isFinite(s.weightPct) || s.weightPct < 0) return fallback();
    byName.set(s.nationName, (byName.get(s.nationName) ?? 0) + s.weightPct);
  }
  const weights: number[] = [];
  for (const name of nationNames) {
    const w = byName.get(name);
    if (w === undefined) return fallback();
    weights.push(w);
  }
  if (weights.reduce((a, b) => a + b, 0) <= 0) return fallback();
  return weights;
}

// ── 戰力對比與確定性傷亡（Task #238） ────────────────────────────
// 傷亡數量由伺服器依雙方有效戰力確定性計算，AI 僅提供敘事與戰術意圖
// （aggressionPct）。設計目標：戰力接近時呈低傷亡消耗戰；戰力懸殊時
// 決定性但仍受硬上限約束（弱方無法造成不成比例的傷亡）；防守方可反攻。

/** 消耗戰基礎傷亡率（雙方戰力相當時，受害方每週期損失比例）。 */
export const CASUALTY_BASELINE_RATE = 0.05;

// ── Task #412 — 全域戰爭參數（管理員可調，存 world_game_state 單列）──

/** 戰鬥激烈度倍率上下限與預設（%；100 = 現行傷亡比率）。 */
export const WAR_INTENSITY_MIN_PCT = 10;
export const WAR_INTENSITY_MAX_PCT = 500;
export const WAR_INTENSITY_DEFAULT_PCT = 100;

/** 領土奪取基礎值上下限與預設（百分點；15 = 現行確定性推進上限）。 */
export const TERRITORY_CAPTURE_BASE_MIN_PCT = 1;
export const TERRITORY_CAPTURE_BASE_MAX_PCT = 30;
export const TERRITORY_CAPTURE_BASE_DEFAULT_PCT = 15;

/** 夾取戰鬥激烈度倍率到合法範圍（非法輸入回預設 100）。 */
export function clampWarIntensityPct(v: number | null | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return WAR_INTENSITY_DEFAULT_PCT;
  }
  return Math.min(
    WAR_INTENSITY_MAX_PCT,
    Math.max(WAR_INTENSITY_MIN_PCT, Math.round(v)),
  );
}

/** 夾取領土奪取基礎值到合法範圍（非法輸入回預設 15）。 */
export function clampTerritoryCaptureBasePct(
  v: number | null | undefined,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return TERRITORY_CAPTURE_BASE_DEFAULT_PCT;
  }
  return Math.min(
    TERRITORY_CAPTURE_BASE_MAX_PCT,
    Math.max(TERRITORY_CAPTURE_BASE_MIN_PCT, Math.round(v)),
  );
}

// ── Task #412 — 地區面積 → 佔領速度係數 ──────────────────────────
// 面積越大的地區，單一週期可被推進的百分點越低（大地區要打很多週期）；
// 小地區則加速。以對數尺度相對「基準面積」計算並夾在上下限之間，避免
// 極端面積造成極端係數。找不到面積的地區用中性係數 1（行為不變）。

/** 佔領速度係數的基準面積（km²）：此面積 → 係數 1。 */
export const AREA_CAPTURE_REFERENCE_KM2 = 150_000;
/** 佔領速度係數下限（超大地區也至少有此速度）。 */
export const AREA_CAPTURE_FACTOR_MIN = 0.35;
/** 佔領速度係數上限（迷你地區的加速封頂）。 */
export const AREA_CAPTURE_FACTOR_MAX = 2.5;

/**
 * 依地區面積計算佔領速度係數。areaKm2 為 null／undefined／非正數 → 1
 * （中性，不影響現行行為）。係數 = (基準面積 / 面積)^0.5，夾在
 * [AREA_CAPTURE_FACTOR_MIN, AREA_CAPTURE_FACTOR_MAX]。
 * 例：94 萬 km²（大湖區）≈ 0.4；15 萬 km² = 1；1.8 萬 km²（上法蘭西）≈ 2.5（封頂）。
 */
export function areaCaptureSpeedFactor(
  areaKm2: number | null | undefined,
): number {
  if (typeof areaKm2 !== "number" || !Number.isFinite(areaKm2) || areaKm2 <= 0) {
    return 1;
  }
  const factor = Math.sqrt(AREA_CAPTURE_REFERENCE_KM2 / areaKm2);
  return Math.min(
    AREA_CAPTURE_FACTOR_MAX,
    Math.max(AREA_CAPTURE_FACTOR_MIN, factor),
  );
}

/**
 * 把佔領速度係數套在領土推進值上（正負皆可）。0 → 0；非零值縮放後
 * 至少保留 1 個百分點的幅度（大地區仍會緩慢推進，不會完全凍結）。
 * 回傳整數。
 */
export function scaleTerritoryShift(shift: number, factor: number): number {
  const s = Math.trunc(shift);
  if (s === 0) return 0;
  const f = Math.max(0, factor);
  const scaled = Math.round(s * f);
  return s > 0 ? Math.max(1, scaled) : Math.min(-1, scaled);
}

// ── Task #412 — 戰鬥規模因子 ─────────────────────────────────────
// 雙方投入總兵力越大，戰場越擁擠、火力密度越高，傷亡「比率」向上調
// （不只是等比放大）。以對數尺度相對基準兵力計算，有封頂。

/** 戰鬥規模因子的基準總兵力（雙方合計）：此規模以下 → 因子 1。 */
export const BATTLE_SCALE_REFERENCE_TROOPS = 100_000;
/** 戰鬥規模因子上限。 */
export const BATTLE_SCALE_MAX_FACTOR = 2;

/**
 * 依雙方合計總兵力計算傷亡比率放大因子：≤ 基準兵力 → 1；每高一個數量級
 * +0.5，封頂 BATTLE_SCALE_MAX_FACTOR（例：10 萬 → 1、100 萬 → 1.5、
 * ≥1000 萬 → 2）。
 */
export function battleScaleFactor(totalTroops: number): number {
  if (!Number.isFinite(totalTroops) || totalTroops <= BATTLE_SCALE_REFERENCE_TROOPS) {
    return 1;
  }
  const factor =
    1 + Math.log10(totalTroops / BATTLE_SCALE_REFERENCE_TROOPS) * 0.5;
  return Math.min(BATTLE_SCALE_MAX_FACTOR, factor);
}

/**
 * 共用戰鬥上下文：`computeCycleCasualties` 與 `computeCounterattack`
 * 都需要的戰鬥規模因子與激烈度倍率，抽出純函式避免重複計算。
 */
export interface BattleContext {
  /** 戰鬥規模因子（1–2；合計兵力越大越高）。 */
  scale: number;
  /** 管理員激烈度倍率（0.1–5；100% = 1）。 */
  intensityMult: number;
}

/** 由雙方兵力與激烈度設定建立戰鬥上下文。 */
export function buildBattleContext(input: {
  attackerTroops: number;
  defenderTroops: number;
  intensityPct?: number;
}): BattleContext {
  const scale = battleScaleFactor(
    Math.max(0, input.attackerTroops) + Math.max(0, input.defenderTroops),
  );
  const intensityMult =
    clampWarIntensityPct(input.intensityPct ?? WAR_INTENSITY_DEFAULT_PCT) / 100;
  return { scale, intensityMult };
}

/** 單一週期傷亡率上限（依戰力比例計算的傷亡率封頂）。 */
export const CASUALTY_MAX_RATE = 0.5;
/** 防守方反攻對攻擊方額外傷亡的比例上限（依攻擊方兵力）。 */
export const COUNTERATTACK_MAX_RATE = 0.35;
/** 防守方反攻往攻擊方出發地區反推的領土百分點上限。 */
export const COUNTERATTACK_MAX_TERRITORY_PCT = 10;

/** 結算時載入的單一兵種戰力輸入。 */
export interface PowerUnitInput {
  quantity: number;
  attack: number;
  defense: number;
  hp: number;
  /**
   * 武器系統 — 該兵種裝備武器後的戰鬥乘數（相容加成／不相容懲罰＋
   * 特殊技能效果，由呼叫端以 weaponCombatMods 純函式算出）。
   * 缺省 = 1（未裝備或舊路徑）。
   */
  offenseMult?: number;
  defenseMult?: number;
}

/** 單一軍團的戰力輸入（士氣／補給／是否駐守城市／作戰積極度）。 */
export interface PowerLegionInput {
  morale: number;
  supply: number;
  garrisoning: boolean;
  /** AI 提供的作戰積極度（0–100，戰術意圖），影響有效進攻投入。 */
  aggressionPct: number;
  units: readonly PowerUnitInput[];
}

/** 一方的整體戰力輸入。 */
export interface SidePowerInput {
  legions: readonly PowerLegionInput[];
  /** 厭戰度＋海上登陸換算的攻擊修正（百分比，≤0）；僅影響進攻力。 */
  attackModifierPct: number;
  /** 駐守城市軍團可得的城牆防禦加成（0–90）；僅提升駐守軍團的防禦。 */
  wallDefenseBonusPct: number;
}

/** 一方的有效戰力（兵力總數、進攻力、防禦／承受力）。 */
export interface SidePower {
  troops: number;
  offense: number;
  defense: number;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Task #584 — 政變後士氣懲罰（純計算層）：戰力計算時把軍團士氣扣減
 * penalty 點（夾 ≥0），不寫回軍團 morale；penalty ≤ 0 時原值返回。
 */
export function coupAdjustedMorale(morale: number, penalty: number): number {
  if (penalty <= 0) return morale;
  return Math.max(0, morale - penalty);
}

/**
 * 士氣與補給對戰力的乘數。
 * 士氣：0.5–1.0。補給：見 supply.ts 的 supplyPowerFactor（0.1–1.0，崩潰區再打七折）。
 * 兩者相乘：完全沒補給、沒士氣的部隊戰力只剩約 5%（舊版下限 25%，缺補給根本不痛）。
 */
export function combatConditionFactor(morale: number, supply: number): number {
  const m = 0.5 + 0.5 * clamp01(morale / 100);
  return m * supplyPowerFactor(supply);
}

/**
 * 計算一方的有效戰力。進攻力＝Σ(數量×攻擊)×(士氣補給×攻擊修正×積極度)；
 * 防禦力＝Σ(數量×(防禦+HP))×(士氣補給×(駐守則×城牆加成))。積極度與攻擊
 * 修正只影響進攻力；城牆加成只惠及駐守軍團的防禦。
 */
export function computeEffectivePower(input: SidePowerInput): SidePower {
  const atkMod = Math.max(0, 1 + input.attackModifierPct / 100);
  const wallMult =
    1 + Math.max(0, Math.min(90, input.wallDefenseBonusPct)) / 100;
  let troops = 0;
  let offense = 0;
  let defense = 0;
  for (const legion of input.legions) {
    const cond = combatConditionFactor(legion.morale, legion.supply);
    const aggression = 0.5 + 0.5 * clamp01(legion.aggressionPct / 100);
    const offMult = cond * atkMod * aggression;
    const defMult = cond * (legion.garrisoning ? wallMult : 1);
    for (const u of legion.units) {
      const q = Math.max(0, u.quantity);
      // 武器系統 — 裝備乘數只放大該兵種的攻/防貢獻（缺省 1）。
      const weaponOff = u.offenseMult ?? 1;
      const weaponDef = u.defenseMult ?? 1;
      troops += q;
      offense += q * Math.max(0, u.attack) * offMult * weaponOff;
      defense += q * Math.max(0, u.defense + u.hp) * defMult * weaponDef;
    }
  }
  return {
    troops,
    offense: Math.max(0, offense),
    defense: Math.max(0, defense),
  };
}

export interface CycleCasualtyResult {
  attackerCasualties: number;
  defenderCasualties: number;
  /** 硬上限：對方以其進攻力最多能造成的傷亡（供測試／敘事）。 */
  attackerCasualtyCap: number;
  defenderCasualtyCap: number;
  /** 未封頂的比例傷亡值（供敘事：實際值 < 比例值 ＝ 被硬上限或兵力封頂）。 */
  attackerRateValue: number;
  defenderRateValue: number;
  /** 戰鬥規模因子（供敘事）。 */
  scaleFactor: number;
  /** 管理員激烈度倍率（1 = 不變；供敘事）。 */
  intensityMultiplier: number;
}

/**
 * 依雙方有效戰力確定性計算本週期傷亡。受害方傷亡＝min(比例值, 硬上限,
 * 現有兵力)：比例值由「攻擊方總戰力相對優勢」決定（相當時僅基礎消耗率，
 * 懸殊時上升至上限）；硬上限＝攻擊方進攻力 ÷ 受害方單位平均耐久，確保弱方
 * 無法造成不成比例的傷亡。
 *
 * Task #412 — 傷亡「比率」另乘上：
 *  - 戰鬥規模因子（battleScaleFactor，雙方合計兵力越大越慘重，有封頂）；
 *  - 管理員激烈度倍率 intensityPct（10–500%，預設 100 = 不變）。
 * 兩者只放大比例值；硬上限與現有兵力封頂維持不變。
 */
export function computeCycleCasualties(input: {
  attacker: SidePower;
  defender: SidePower;
  /** 戰鬥激烈度倍率（%；預設 100）。呼叫端讀 world_game_state 後傳入。 */
  intensityPct?: number;
}): CycleCasualtyResult {
  const { scale, intensityMult: intensity } = buildBattleContext({
    attackerTroops: input.attacker.troops,
    defenderTroops: input.defender.troops,
    intensityPct: input.intensityPct,
  });
  const casualtiesOn = (
    victim: SidePower,
    striker: SidePower,
  ): { value: number; cap: number; rateValue: number } => {
    if (victim.troops <= 0) return { value: 0, cap: 0, rateValue: 0 };
    const pv = victim.offense + victim.defense;
    const ps = striker.offense + striker.defense;
    const total = pv + ps;
    const dominance = total > 0 ? Math.max(0, ps / total - 0.5) * 2 : 0;
    const rate =
      CASUALTY_BASELINE_RATE +
      dominance * (CASUALTY_MAX_RATE - CASUALTY_BASELINE_RATE);
    const rateValue = Math.round(rate * scale * intensity * victim.troops);
    const perUnitDurability = Math.max(1, victim.defense / victim.troops);
    const cap = Math.floor(striker.offense / perUnitDurability);
    const value = Math.max(0, Math.min(rateValue, cap, victim.troops));
    return { value, cap, rateValue };
  };
  const def = casualtiesOn(input.defender, input.attacker);
  const atk = casualtiesOn(input.attacker, input.defender);
  return {
    attackerCasualties: atk.value,
    defenderCasualties: def.value,
    attackerCasualtyCap: atk.cap,
    defenderCasualtyCap: def.cap,
    attackerRateValue: atk.rateValue,
    defenderRateValue: def.rateValue,
    scaleFactor: scale,
    intensityMultiplier: intensity,
  };
}

export interface CounterattackResult {
  /** 防守方反攻額外加諸攻擊方的傷亡。 */
  extraAttackerCasualties: number;
  /** 往攻擊方出發地區反推的領土百分點（0–COUNTERATTACK_MAX_TERRITORY_PCT）。 */
  territoryPushbackPct: number;
  /** 反攻強度 0–1（供敘事）。 */
  intensity: number;
}

/**
 * 防守方反攻：攻擊方相對越弱，防守方反攻越猛，對攻擊方造成額外傷亡並往
 * 攻擊方出發地區反推領土。額外傷亡同樣受防守方進攻力硬上限與攻擊方現有
 * 兵力約束。Task #412 — 反攻傷亡比率同樣乘上戰鬥規模因子與管理員激烈度
 * 倍率（intensityPct，預設 100 = 不變）；領土反推幅度不受兩者影響。
 */
export function computeCounterattack(input: {
  attacker: SidePower;
  defender: SidePower;
  /** 戰鬥激烈度倍率（%；預設 100）。呼叫端讀 world_game_state 後傳入。 */
  intensityPct?: number;
}): CounterattackResult {
  const { attacker, defender } = input;
  const pa = attacker.offense + attacker.defense;
  const pd = defender.offense + defender.defense;
  const total = pa + pd;
  if (total <= 0 || defender.troops <= 0 || attacker.troops <= 0) {
    return { extraAttackerCasualties: 0, territoryPushbackPct: 0, intensity: 0 };
  }
  const { scale, intensityMult } = buildBattleContext({
    attackerTroops: attacker.troops,
    defenderTroops: defender.troops,
    intensityPct: input.intensityPct,
  });
  const intensity = Math.max(0, pd / total - 0.5) * 2;
  const perUnitDurability = Math.max(1, attacker.defense / attacker.troops);
  const cap = Math.floor(defender.offense / perUnitDurability);
  const raw = Math.round(
    intensity * COUNTERATTACK_MAX_RATE * scale * intensityMult * attacker.troops,
  );
  const extraAttackerCasualties = Math.max(
    0,
    Math.min(raw, cap, attacker.troops),
  );
  const territoryPushbackPct = Math.round(
    intensity * COUNTERATTACK_MAX_TERRITORY_PCT,
  );
  return { extraAttackerCasualties, territoryPushbackPct, intensity };
}

/**
 * 各方在週期中傷亡的固定比例視為受傷（其餘為陣亡）。
 * 替代舊有 AI woundedSharePct 欄位；玩家國家享有回復加成。
 */
export const WOUNDED_SHARE_PCT = 30;

/**
 * 依本週期傷亡比例計算士氣變化（伺服器確定性；不再由 AI 提供）。
 * 贏方輕微回升、輸方依傷亡率下降，以該方主帥側合計計算。
 */
export function computeCycleMoraleDelta(
  ownCasualties: number,
  enemyCasualties: number,
  ownTroops: number,
): number {
  if (ownTroops <= 0) return 0;
  const rate = ownCasualties / ownTroops;
  if (rate >= 0.3) return -15;
  if (rate >= 0.15) return -8;
  if (rate >= 0.05) return -3;
  if (enemyCasualties > ownCasualties) return 3;
  return -2;
}

/**
 * 依本週期傷亡比例計算補給消耗（伺服器確定性；不再由 AI 提供）。
 * 傷亡越重補給損耗越多；補給不因戰況好壞回升。
 */
export function computeCycleSupplyDelta(
  ownCasualties: number,
  ownTroops: number,
): number {
  if (ownTroops <= 0) return 0;
  const rate = ownCasualties / ownTroops;
  if (rate >= 0.2) return -15;
  if (rate >= 0.1) return -10;
  return -5;
}

/** 僵持週期固定士氣扣減（確定性；兩方皆適用）。 */
export const STALEMATE_MORALE_DELTA = -5;
/** 僵持週期固定補給扣減（確定性；兩方皆適用）。 */
export const STALEMATE_SUPPLY_DELTA = -10;

/**
 * 確定性僵持結算輸入。
 *
 * 與 WarCycleAiResult 是不同的獨立型別——不含 AI 回傳的 attacker/defender
 * 側別結果、territoryShiftPct 等 AI 輸出欄位。呼叫端以 `'attacker' in result`
 * 判斷是否為 AI 路徑；僵持路徑的所有數值均由伺服器純函式決定。
 */
export interface StalemateInput {
  readonly stalemate: true;
  /** 固定低積極度（使雙方確定性傷亡自然壓低）。 */
  readonly aggressionPct: number;
  /** 雙方共用的固定厭戰度增量。 */
  readonly warWearinessDelta: number;
  readonly attackerSiegeIntensityPct: number | null;
  readonly defenderSiegeIntensityPct: number | null;
  readonly attackerReport: string;
  readonly defenderReport: string;
  /** 僵持週期無戰鬥人口損失。 */
  readonly localPopulationLossPct: 0;
  /** 僵持週期無指令稽核。 */
  readonly orderFlags: never[];
}

/**
 * 依雙方有效戰力對比計算「確定性領土推進下限」（Task #275）。
 *
 * 問題：領土消長原本完全交給 AI 的 territoryShiftPct，而 AI 過度保守、
 * 幾乎永遠給 0，導致即使攻擊方殲滅了守軍、戰役仍卡在守方 100% 控制、
 * 永不結束。此函式改由伺服器依戰力對比確定性地給出攻擊方「至少」該推進的
 * 幅度，讓贏家真的能奪地。
 *
 * 規則：以攻擊方相對戰力優勢（dominance = pa / (pa+pd)）為基準——
 *  - 勢均力敵（dominance ≤ 0.5）→ 回傳 0，維持膠著、由 AI 敘事主導。
 *  - 攻擊方越佔優，推進越大；守軍被殲滅（戰力趨近 0）→ 逼近上限，
 *    使壓倒性勝利能在合理週期數內完成征服。
 * 僅在攻擊方仍有兵力時推進。回傳非負整數（攻擊方在目標地區的推進百分點），
 * 供結算端與 AI 給的值取較大者（作為下限，不取代 AI 想給更高的情況）。
 *
 * Task #412 — basePct（管理員可調的領土奪取基礎值，1–30，預設 15）取代
 * 固定的 DETERMINISTIC_TERRITORY_MAX_SHIFT 作為滿幅上限；結果永不超過
 * basePct（夾取後）本身。
 */
export function computeForceRatioTerritoryShift(input: {
  attacker: SidePower;
  defender: SidePower;
  /** 領土奪取基礎值（百分點；預設 15 = 現行行為）。 */
  basePct?: number;
}): number {
  const { attacker, defender } = input;
  const base = clampTerritoryCaptureBasePct(
    input.basePct ?? TERRITORY_CAPTURE_BASE_DEFAULT_PCT,
  );
  if (attacker.troops <= 0) return 0;
  const pa = attacker.offense + attacker.defense;
  const pd = defender.offense + defender.defense;
  const total = pa + pd;
  if (total <= 0) return 0;
  const dominance = pa / total;
  if (dominance <= 0.5) return 0;
  const scaled = (dominance - 0.5) * 2; // 0–1
  return Math.min(base, Math.round(scaled * base));
}

/**
 * Task #578 — 確定性掃蕩（mop-up）：兩地區戰役中，敗方在「主要戰場」
 * （其受保護的核心地區）持分已清空、該區城市已陷落或無城市，只剩另一區
 * 的殘餘持分時，由伺服器確定性地把勝方推進導向另一區，逐週期清除殘餘，
 * 讓戰役能自然分出勝負。
 *
 * 背景：確定性推進下限（computeForceRatioTerritoryShift）只套用在目標
 * 地區；守方反攻在攻方出發地區取得的殘餘持分（例如 2%）原本只能靠 AI
 * 主動給正向 attackerRegion shift 才會減少——AI 不給就永久僵持，該地區
 * 又被「每區一場戰役」的交戰鎖鎖死。對稱地，攻方在出發地被清空、只剩
 * 目標地區殘餘時也會鏡像僵持。
 *
 * 規則（全部成立才掃蕩，否則回傳 0）：
 *  - 敗方在主要戰場持分 ≤ 0；
 *  - 該區敗方城市防線已陷落或無城市（城未陷落時勝負本就未定，不掃蕩）；
 *  - 敗方在另一區仍有殘餘持分（> 0）；
 *  - 勝方仍有兵力。
 * 掃蕩量＝依戰力對比的確定性推進（同 computeForceRatioTerritoryShift，
 * 受 basePct 封頂），但**至少 1 個百分點**——雙方戰力對等時也會逐週期
 * 推進，保證戰役收斂（實際移轉仍受 loser 持分與城市保底
 * capTransferForCity 封頂；面積係數由呼叫端以 scaleTerritoryShift 套用，
 * 其非零值至少保留 1 的性質保住收斂）。
 */
export function computeMopUpShift(input: {
  winner: SidePower;
  loser: SidePower;
  /** 敗方在其主要戰場（受保護核心地區）的持分。 */
  loserPctMainRegion: number;
  /** 敗方主要戰場的城市防線是否已陷落（無城市視為已陷落）。 */
  loserMainRegionCityFallen: boolean;
  /** 敗方在另一戰場地區的殘餘持分。 */
  loserPctOtherRegion: number;
  /** 領土奪取基礎值（百分點；預設 15）。 */
  basePct?: number;
}): number {
  if (input.loserPctMainRegion > 0) return 0;
  if (!input.loserMainRegionCityFallen) return 0;
  if (input.loserPctOtherRegion <= 0) return 0;
  if (input.winner.troops <= 0) return 0;
  const ratio = computeForceRatioTerritoryShift({
    attacker: input.winner,
    defender: input.loser,
    basePct: input.basePct,
  });
  return Math.max(1, ratio);
}

/** 單一地區的控制列（applyTerritoryTransfer 的輸入／輸出）。 */
export interface ControlShare {
  nationId: string;
  percent: number;
}

/**
 * 領土消長：在單一地區內，把 pct 個百分點從 loser 移轉給 gainer。
 * 只在交戰雙方之間移動（第三方持分不動）；實際移轉量以 loser 現有持分
 * 封頂，且結果總和不變（Σ ≤ 100 由輸入保證）。percent ≤ 0 的列會被移除。
 */
export function applyTerritoryTransfer(
  controls: readonly ControlShare[],
  gainerNationId: string,
  loserNationId: string,
  pct: number,
): ControlShare[] {
  const transfer = Math.max(0, Math.floor(pct));
  const loser = controls.find((c) => c.nationId === loserNationId);
  const actual = Math.min(transfer, loser?.percent ?? 0);
  if (actual === 0) return controls.map((c) => ({ ...c }));
  const result: ControlShare[] = [];
  let gainerFound = false;
  for (const c of controls) {
    if (c.nationId === loserNationId) {
      const next = c.percent - actual;
      if (next > 0) result.push({ nationId: c.nationId, percent: next });
    } else if (c.nationId === gainerNationId) {
      gainerFound = true;
      result.push({
        nationId: c.nationId,
        percent: Math.min(100, c.percent + actual),
      });
    } else {
      result.push({ ...c });
    }
  }
  if (!gainerFound) {
    result.push({ nationId: gainerNationId, percent: Math.min(100, actual) });
  }
  return result;
}

/**
 * 城市硬約束：地區的本方城市防線尚未陷落（holdoutPct > 0）時，
 * 該方在此地區的控制率不得被打到 0 — 轉移量封頂至讓其至少保留 1%。
 * 城市已陷落或無城市 → 不設限（回傳原請求量，向下取整、非負）。
 * 這是伺服器端守則，不依賴 AI prompt 的自律。
 */
export function capTransferForCity(
  requestedPct: number,
  loserCurrentPct: number,
  loserCityState: WarCityState | null,
): number {
  const transfer = Math.max(0, Math.floor(requestedPct));
  if (cityLineFallen(loserCityState)) return transfer;
  return Math.max(0, Math.min(transfer, loserCurrentPct - 1));
}

/**
 * 戰役結束判定的輸入：雙方「主帥」在兩塊地區的控制百分比與城市防線。
 * Task #579 — 多國戰役時輸入必須是主帥各自的持分（非該邊合計）：領土移轉的
 * 輸家永遠是敗方主帥，晚加入者的持分不會被本戰役移轉；以合計持分判定會讓
 * 敗方側 joiner 的殘餘持分卡死戰役（永不結束、交戰鎖不釋放）。
 */
export interface CampaignOutcomeInput {
  /** 攻擊方主帥在（出發地區, 目標地區）的控制百分比。 */
  attackerPctAtkRegion: number;
  attackerPctDefRegion: number;
  /** 防守方主帥在（出發地區, 目標地區）的控制百分比。 */
  defenderPctAtkRegion: number;
  defenderPctDefRegion: number;
  /** 出發地區的城市防線（保護攻擊方）；null = 無城市。 */
  attackerCityState: WarCityState | null;
  /** 目標地區的城市防線（保護防守方）；null = 無城市。 */
  defenderCityState: WarCityState | null;
}

/**
 * 戰役結束判定：一方「主帥」在兩塊地區的持分全部歸零，且其城市防線（若有）
 * 已陷落 → 對方獲勝。雙方同時歸零（理論上不會發生）視為攻擊方獲勝優先
 * 判防守方潰敗。回傳勝方："attacker" | "defender" | null（未分勝負）。
 * 晚加入參戰國的殘餘持分不影響判定（戰役結束時保留，見 applyCycleResult）。
 */
export function determineCampaignOutcome(
  input: CampaignOutcomeInput,
): "attacker" | "defender" | null {
  const defenderCityFallen = cityLineFallen(input.defenderCityState);
  const attackerCityFallen = cityLineFallen(input.attackerCityState);
  const defenderWipedOut =
    input.defenderPctAtkRegion <= 0 &&
    input.defenderPctDefRegion <= 0 &&
    defenderCityFallen;
  const attackerWipedOut =
    input.attackerPctAtkRegion <= 0 &&
    input.attackerPctDefRegion <= 0 &&
    attackerCityFallen;
  if (defenderWipedOut) return "attacker";
  if (attackerWipedOut) return "defender";
  return null;
}

/**
 * 偵查等級：最近 windowCycles 個週期內提交過的偵查指令數，封頂 3。
 * 0 = 幾乎無情報（±50% 模糊）、3 = 精確（±5%）。
 */
export function reconLevelFromOrders(
  reconOrderCycleNumbers: readonly number[],
  currentCycle: number,
  windowCycles = 3,
): number {
  const floor = currentCycle - windowCycles;
  const count = reconOrderCycleNumbers.filter(
    (c) => c > floor && c <= currentCycle,
  ).length;
  return Math.min(3, count);
}

const FUZZ_MARGIN_BY_LEVEL = [0.5, 0.3, 0.15, 0.05] as const;

/** FNV-1a 雜湊 → [0, 1)，讓模糊值對同一 seed 穩定（不隨請求跳動）。 */
function hash01(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/**
 * 敵方數值模糊化：依偵查等級以確定性偏移量（±50/30/15/5%）擾動真值，
 * 同一 seed 永遠回傳同一估計值。回傳非負整數。
 */
export function fuzzValue(
  value: number,
  reconLevel: number,
  seed: string,
): number {
  if (value <= 0) return 0;
  const level = Math.min(3, Math.max(0, Math.floor(reconLevel)));
  const margin = FUZZ_MARGIN_BY_LEVEL[level]!;
  const offset = (hash01(seed) * 2 - 1) * margin;
  return Math.max(0, Math.round(value * (1 + offset)));
}

/**
 * 建立地區的城市防線初始狀態（開戰快照）；無城市 → null。逐城依其城牆
 * 階級快照耐久上限與滿耐久（Task #150）。
 */
export function initialCityState(
  cities: readonly { cityId: number; name: string; tier: WallTier }[],
): WarCityState | null {
  if (cities.length === 0) return null;
  return {
    cities: cities.map((c) =>
      makeWarCity({ cityId: c.cityId, name: c.name, tier: c.tier }),
    ),
    garrisoned: false,
  };
}

/** 夾取 0–100 整數。 */
export function clamp100(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ── 純函式：確定性戰術效果（Task #625） ─────────────────────────────────

/**
 * 依兵種分析的戰術優勢（tacticalEdge/tacticalBonus）與士氣加成調整積極度。
 * side 指本次計算代表哪一方：佔優的一方加 bonus，劣勢方扣 bonus。
 */
export function applyTacticalBonus(
  aggressionPct: number,
  tacticalEdge: "attacker" | "defender" | "neutral",
  tacticalBonus: number,
  moraleBonus: number,
  side: "attacker" | "defender" = "attacker",
): number {
  const edgeBonus =
    tacticalEdge === "neutral"
      ? 0
      : tacticalEdge === side
        ? tacticalBonus
        : -tacticalBonus;
  return Math.max(0, Math.min(100, aggressionPct + edgeBonus + moraleBonus));
}

/**
 * 根據積極度（0–100）計算確定性領土推進量（百分點），再套面積係數。
 * aggressionPct=50 → 0（中性）；100 → +15；0 → −15。
 * side 決定兵種優勢方向（攻擊方或防守方）。
 */
export function computeTerritoryShift(
  aggressionPct: number,
  tacticalEdge: "attacker" | "defender" | "neutral",
  tacticalBonus: number,
  moraleBonus: number,
  scaleFactor: number,
  side: "attacker" | "defender" = "attacker",
): number {
  const effective = applyTacticalBonus(
    aggressionPct,
    tacticalEdge,
    tacticalBonus,
    moraleBonus,
    side,
  );
  const raw = Math.max(-15, Math.min(15, Math.round(((effective - 50) / 50) * 15)));
  return scaleTerritoryShift(raw, scaleFactor);
}

/**
 * 確定性圍城強度（0–100）：依積極度與戰術加成推算；城市已陷落（holdoutPct≤0）時為 0。
 */
export function computeSiegeIntensity(
  aggressionPct: number,
  holdoutPct: number,
  tacticalBonusForBesieger: number,
): number {
  if (holdoutPct <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, Math.round(aggressionPct + tacticalBonusForBesieger)),
  );
}

/**
 * 確定性人口損失比例（0–5%）：依積極度、戰術優勢與士氣推算。
 * aggressionPct=50 / 中性 / 無加成 → 2.5%；最大 5%。
 */
export function computeLocalPopulationLossPct(
  aggressionPct: number,
  tacticalEdge: "attacker" | "defender" | "neutral",
  tacticalBonus: number,
  moraleBonus: number,
): number {
  const effective = applyTacticalBonus(
    aggressionPct,
    tacticalEdge,
    tacticalBonus,
    moraleBonus,
  );
  return (effective / 100) * 5;
}



/**
 * 把陣營傷亡分配給各軍團。僱傭兵軍團(isMercenary)永遠零損失,
 * 損失全由同陣營的真實軍團按兵力比例承擔;沒有任何真實軍團時,傷亡直接落空(不硬塞)。
 *
 * 注意:allocateProportionally 在權重全為 0 時會改成平均分配,所以不能只把
 * 僱傭兵權重設 0,必須在「沒有真實軍團」時明確回傳全 0。
 */
export function allocateLegionLosses(
  legions: ReadonlyArray<{ troops: number; isMercenary: boolean }>,
  sideCasualties: number,
): number[] {
  const weights = legions.map((l) => (l.isMercenary ? 0 : Math.max(0, l.troops)));
  if (weights.every((w) => w <= 0)) return legions.map(() => 0);
  const alloc = allocateProportionally(weights, sideCasualties);
  return alloc.map((loss, i) =>
    legions[i]!.isMercenary ? 0 : Math.min(loss, weights[i]!),
  );
}
