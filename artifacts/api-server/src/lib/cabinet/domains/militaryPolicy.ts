import type { CabinetStyle, MilitaryUnitTemplate } from "@workspace/db";
import type { AgencyLevel } from "../types";
import { normalizeStyle } from "../style";
import {
  categoryLabel,
  categoryLockInfo,
  MILITARY_CATEGORIES,
  type MilitaryCategory,
} from "../../military";

/**
 * Task #244 — 元帥（軍事）領域：執政風格 → 自動執行門檻的純函式。
 *
 * 不觸 DB／AI／IO，可單元測試。集中「積極度」與各類動作「是否需玩家批准」
 * 的門檻判定。原 domains/military.ts 內的定義純搬移至此，行為不變。
 */

// ── 純函式：執政風格 → 自動執行門檻（供單元測試） ──────────────

/**
 * 由代理程度與執政風格算出 0–100 的「積極度」：
 *  - 代理程度定基準（保守 25／均衡 50／積極 75）。
 *  - 越權傾向拉高、膽小程度壓低（各 ±20）。
 * 積極度越高，元帥越敢自動動用大批資源；越低則越傾向提報請示。
 */
export function militaryAgentAggression(
  agencyLevel: AgencyLevel,
  style: CabinetStyle,
): number {
  const s = normalizeStyle(style);
  const base =
    agencyLevel === "aggressive" ? 75 : agencyLevel === "conservative" ? 25 : 50;
  const overreachAdj = (s.overreach - 50) * 0.4;
  const timidityAdj = (s.timidity - 50) * 0.4;
  const raw = base + overreachAdj - timidityAdj;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** 每回合各類動作可「自動執行（不提報）」的預算比例（0–1）。 */
export interface MilitaryAutoBudget {
  /** 招募：本回合可自動動用的「可用生產力」比例。 */
  recruitProductionFraction: number;
  /** 金錢購買：本回合可自動動用的「今日剩餘購買配額」比例。 */
  purchaseCapFraction: number;
  /** 研發科技：可自動投入、占「目前科技點數」的比例。 */
  techAutoCostFraction: number;
  /** 設計兵種：可自動投入、占「目前科技點數」的比例。 */
  designAutoCostFraction: number;
}

export function militaryAutoBudget(
  agencyLevel: AgencyLevel,
  style: CabinetStyle,
): MilitaryAutoBudget {
  const a = militaryAgentAggression(agencyLevel, style) / 100;
  return {
    recruitProductionFraction: 0.1 + a * 0.6,
    purchaseCapFraction: 0.2 + a * 0.6,
    techAutoCostFraction: 0.2 + a * 0.5,
    designAutoCostFraction: 0.3 + a * 0.5,
  };
}

/** 招募：生產力成本超過「可用生產力 × 允許比例」→ 需玩家批准。 */
export function recruitNeedsApproval(params: {
  productionCost: number;
  availableProduction: number;
  fraction: number;
}): boolean {
  const budget = Math.floor(
    Math.max(0, params.availableProduction) * params.fraction,
  );
  return params.productionCost > budget;
}

/**
 * 財政可持續性守衛(玩家回報:元帥無視國內財政瘋狂爆兵,讓稅收赤字)。
 *
 * 自動招募前估算:招募後「每回合盈餘 = 稅收 − (現有維護費 + 本次新增維護費)」。
 *  - 招募後盈餘 ≥ 0                       → 可自動招募。
 *  - 招募後盈餘 < 0,但國庫撐得過緩衝回合 → 仍可自動招募(短期可承受)。
 *  - 其餘(會讓國庫在緩衝回合內見底)     → 不自動招募,改提報請玩家批准並標明財政風險。
 * 玩家仍可手動批准,權力不被剝奪;只是元帥不能擅自把國家拖進赤字。
 */
export const FISCAL_BUFFER_TURNS = 8; // 一天 8 回合

export interface FiscalGuardInput {
  /** 目前國庫。 */
  money: number;
  /** 每回合稅收。 */
  taxIncome: number;
  /** 目前每回合總維護費(軍隊 + 建築 + 資源建築 + 僱傭兵租金)。 */
  currentUpkeep: number;
  /** 本回合已自動招募、尚未反映在 currentUpkeep 的新增維護費(累計)。 */
  pendingUpkeep: number;
  /** 本次招募預計新增的每回合維護費。 */
  addedUpkeep: number;
}

export interface FiscalGuardResult {
  ok: boolean;
  /** 招募後每回合盈餘(可為負)。 */
  surplusAfter: number;
  /** 國庫撐得過幾回合(盈餘 ≥ 0 時為 Infinity)。 */
  turnsOfRunway: number;
}

export function fiscalRecruitGuard(p: FiscalGuardInput): FiscalGuardResult {
  const upkeepAfter =
    Math.max(0, p.currentUpkeep) + Math.max(0, p.pendingUpkeep) + Math.max(0, p.addedUpkeep);
  const surplusAfter = Math.floor(p.taxIncome) - Math.ceil(upkeepAfter);
  if (surplusAfter >= 0) {
    return { ok: true, surplusAfter, turnsOfRunway: Infinity };
  }
  const turnsOfRunway = Math.max(0, p.money) / -surplusAfter;
  return { ok: turnsOfRunway >= FISCAL_BUFFER_TURNS, surplusAfter, turnsOfRunway };
}

/** 金錢購買：數量超過「今日剩餘配額 × 允許比例」→ 需玩家批准。 */
export function purchaseNeedsApproval(params: {
  quantity: number;
  remainingCap: number;
  fraction: number;
}): boolean {
  const budget = Math.floor(Math.max(0, params.remainingCap) * params.fraction);
  return params.quantity > budget;
}

/** 科技／設計：點數成本超過「目前科技點數 × 允許比例」→ 需玩家批准。 */
export function techSpendNeedsApproval(params: {
  costPoints: number;
  techPoints: number;
  fraction: number;
}): boolean {
  const budget = Math.floor(Math.max(0, params.techPoints) * params.fraction);
  return params.costPoints > budget;
}

// ── 純函式：兵種模板可用性（Task #511，供單元測試） ─────────────

/**
 * Task #511 — 內閣可「設計兵種」的類別：全類別經科技解鎖判定，
 * 不依可見模板推導（否則玩家沒有任何自創兵種時永遠無法設計第一個兵種）。
 */
export function listDesignableCategories(
  researchedKeySlugs: readonly string[],
  currentEraSlug: string,
): { slug: MilitaryCategory; label: string }[] {
  return MILITARY_CATEGORIES.filter(
    (c) => categoryLockInfo(c, researchedKeySlugs).unlocked,
  ).map((c) => ({ slug: c, label: categoryLabel(c, currentEraSlug) }));
}

/**
 * Task #511 — 內閣代理只可建造玩家自己的自創兵種；他人模板一律拒絕
 * （Task #549 起預設兵種已全面移除）。錯誤訊息 zh-TW。純函式（DB 查詢
 * 由呼叫端負責）。
 */
export function resolveUsableTemplate(
  template: MilitaryUnitTemplate | null | undefined,
  params: {
    userId: string;
    eraSlug: string;
    researchedKeySlugs: readonly string[];
  },
): MilitaryUnitTemplate {
  if (!template || template.ownerDiscordUserId !== params.userId) {
    throw new Error("找不到這個兵種模板（請先設計自創兵種）");
  }
  const category = template.category as MilitaryCategory;
  const lock = categoryLockInfo(category, params.researchedKeySlugs);
  if (!lock.unlocked) {
    throw new Error(
      lock.lockReason ?? `${categoryLabel(category, params.eraSlug)}尚未解鎖`,
    );
  }
  return template;
}
