/**
 * 黑市 — 純函式(2026-10-08 定案:系統浮動價格 + NPC 做市商,手續費 30%)。
 *
 * 全部 DB-free、可單元測試。資料層在 marketData.ts。
 *
 * 價格模型:
 *  - 每種貨物有一個「中間價」mid(存資料庫,每回合向基準價回歸)。
 *  - 玩家買入付 ask = mid × (1 + FEE),賣出得 bid = mid × (1 − FEE)。
 *    手續費 30% 的意義:一買一賣來回只剩 0.7/1.3 ≈ 54% (損失約 46%,
 *    再加上成交推價的滑價),炒價沒利潤,黑市只用來補缺口,不是賺錢工具。
 *  - 成交會推動 mid:買入推高、賣出壓低,幅度 = 成交量 / 市場深度。
 *    深度越大價格越穩;每回合 mid 再向基準價回歸一部分,避免單人把價格打到極端。
 *  - mid 夾在基準價 0.4 ~ 3 倍。
 */

import { GOODS, type GoodSlug } from "./goods";
import { isGoodUnlocked } from "./stock";

/** 黑市手續費(買貴賣便宜各 30%)。 */
export const MARKET_FEE = 0.3;
/** 中間價下限 / 上限(相對基準價)。 */
export const PRICE_FLOOR_MULT = 0.4;
export const PRICE_CEIL_MULT = 3;
/**
 * 市場深度(單位):成交這麼多量,中間價約移動 100%(再被夾在上下限)。
 * 基礎物資量大所以深;稀有貨物量小所以淺,價格更敏感。
 */
export const MARKET_DEPTH: Readonly<Record<GoodSlug, number>> = {
  food: 4000,
  wood: 2500,
  ore: 2500,
  ironcoal: 1500,
  oil: 1000,
  rare: 800,
  spice: 1200,
  cloth: 1200,
};
/** 每回合中間價向基準價回歸的比例。 */
export const REVERT_RATE = 0.15;
/** 玩家單一貨物、單一回合的買入 / 賣出總量上限(防囤貨炒價)。 */
export const PLAYER_TURN_CAP = 300;
/** 單筆交易量上限(防一次打穿)。 */
export const PER_TRADE_CAP = 200;

export function priceBounds(good: GoodSlug): { min: number; max: number } {
  const base = GOODS[good].basePrice;
  return { min: base * PRICE_FLOOR_MULT, max: base * PRICE_CEIL_MULT };
}

export function clampMid(good: GoodSlug, mid: number): number {
  const { min, max } = priceBounds(good);
  if (!Number.isFinite(mid)) return GOODS[good].basePrice;
  return Math.min(max, Math.max(min, mid));
}

export interface Quote {
  good: GoodSlug;
  mid: number;
  /** 玩家買入單價(含手續費)。 */
  ask: number;
  /** 玩家賣出單價(扣手續費)。 */
  bid: number;
}

export function quote(good: GoodSlug, mid: number): Quote {
  const m = clampMid(good, mid);
  return { good, mid: m, ask: m * (1 + MARKET_FEE), bid: m * (1 - MARKET_FEE) };
}

export type TradeSide = "buy" | "sell";

export interface TradeResult {
  /** 玩家總付出(買)/ 總收入(賣),整數金錢。 */
  money: number;
  /** 平均成交單價(含手續費)。 */
  avgPrice: number;
  /** 手續費總額(整數,已含在 money 內的差額)。 */
  fee: number;
  /** 成交後的新中間價。 */
  newMid: number;
}

/**
 * 計算一筆交易。大額交易的價格會在過程中滑動:用「起點與終點中間價的平均」
 * 當成交中間價,所以量越大單價越不利,但仍是確定性的閉式公式。
 *
 * 買入:mid 上移 qty/depth × 基準價;賣出反向。
 * 金額一律取整:買入無條件進位(玩家多付)、賣出無條件捨去(玩家少收),
 * 避免小額交易靠捨入套利。
 */
export function executeTrade(
  good: GoodSlug,
  mid: number,
  side: TradeSide,
  qty: number,
): TradeResult {
  const q = Math.floor(qty);
  const m0 = clampMid(good, mid);
  if (!(q > 0)) return { money: 0, avgPrice: 0, fee: 0, newMid: m0 };
  const base = GOODS[good].basePrice;
  const shift = (q / MARKET_DEPTH[good]) * base * (side === "buy" ? 1 : -1);
  const m1 = clampMid(good, m0 + shift);
  const execMid = (m0 + m1) / 2;
  if (side === "buy") {
    const gross = execMid * q;
    const money = Math.ceil(gross * (1 + MARKET_FEE));
    return { money, avgPrice: money / q, fee: money - Math.floor(gross), newMid: m1 };
  }
  const gross = execMid * q;
  const money = Math.floor(gross * (1 - MARKET_FEE));
  return { money, avgPrice: money / q, fee: Math.ceil(gross) - money, newMid: m1 };
}

/** 每回合中間價向基準價回歸。 */
export function revertMid(good: GoodSlug, mid: number): number {
  const base = GOODS[good].basePrice;
  const m = clampMid(good, mid);
  return clampMid(good, m + (base - m) * REVERT_RATE);
}

/** 目前玩家本回合還能買 / 賣多少(單一貨物)。 */
export function remainingTurnCap(usedThisTurn: number): number {
  return Math.max(0, PLAYER_TURN_CAP - Math.max(0, Math.floor(usedThisTurn)));
}

/** 驗證一筆交易量,回傳錯誤訊息或 null。 */
export function validateTradeQty(qty: unknown, usedThisTurn: number): string | null {
  if (typeof qty !== "number" || !Number.isFinite(qty) || !Number.isInteger(qty)) {
    return "數量必須是整數";
  }
  if (qty <= 0) return "數量必須大於 0";
  if (qty > PER_TRADE_CAP) return `單筆最多 ${PER_TRADE_CAP} 單位`;
  const left = remainingTurnCap(usedThisTurn);
  if (qty > left) return left > 0 ? `本回合此貨物只剩 ${left} 單位額度` : "本回合此貨物的交易額度已用完";
  return null;
}

/**
 * 目前時代可在黑市交易的貨物(排除糧食與尚未解鎖的貨物)。
 * 與倉庫頁同一個 isGoodUnlocked 判斷:古代買不到石油,否則會破壞
 * 「工業時代才浮現新爭奪點」的設計。路由與 NPC 做市共用這份判斷。
 */
export function tradableGoods(
  all: readonly GoodSlug[],
  statsEra: string,
): GoodSlug[] {
  return all.filter((g) => g !== "food" && isGoodUnlocked(g, statsEra));
}

/* ───────────────────────── NPC 做市商 ───────────────────────── */

export interface NpcMarketInput {
  /** 該 NPC 目前各貨物庫存。 */
  stock: Partial<Record<GoodSlug, number>>;
  money: number;
}

export interface NpcOrder {
  good: GoodSlug;
  side: TradeSide;
  qty: number;
}

/** NPC 每回合每貨物最多買 / 賣的量,以及保留的目標庫存。 */
export const NPC_TARGET_STOCK = 200;
export const NPC_MAX_PER_TURN = 60;
/** NPC 只在價格偏離基準到這個比例以外才出手(便宜才買、貴才賣)。 */
export const NPC_PRICE_TRIGGER = 0.1;

/**
 * NPC 的做市決策(純函式,確定性,不用 AI)。
 *  - 庫存高於目標且價格偏高(mid ≥ 基準 × 1.1)→ 賣出多餘的,最多 NPC_MAX_PER_TURN。
 *  - 庫存低於目標且價格偏低(mid ≤ 基準 × 0.9)→ 買進,受金錢限制,至少留一半現金。
 * 這讓 NPC 在玩家把價格推離基準時,反向把價格拉回,扮演穩定器。
 * 糧食不參與(糧食有自己的庫存機制,NPC 吃糧不靠黑市)。
 */
export function planNpcOrders(
  input: NpcMarketInput,
  mids: Partial<Record<GoodSlug, number>>,
  goods: readonly GoodSlug[],
): NpcOrder[] {
  const orders: NpcOrder[] = [];
  let budget = Math.max(0, Math.floor(input.money * 0.5));
  for (const g of goods) {
    if (g === "food") continue;
    const base = GOODS[g].basePrice;
    const mid = clampMid(g, mids[g] ?? base);
    const have = Math.max(0, Math.floor(input.stock[g] ?? 0));
    if (mid >= base * (1 + NPC_PRICE_TRIGGER) && have > NPC_TARGET_STOCK) {
      const qty = Math.min(NPC_MAX_PER_TURN, have - NPC_TARGET_STOCK);
      if (qty > 0) orders.push({ good: g, side: "sell", qty });
    } else if (mid <= base * (1 - NPC_PRICE_TRIGGER) && have < NPC_TARGET_STOCK) {
      const want = Math.min(NPC_MAX_PER_TURN, NPC_TARGET_STOCK - have);
      const cost = executeTrade(g, mid, "buy", want).money;
      if (cost > 0 && cost <= budget) {
        orders.push({ good: g, side: "buy", qty: want });
        budget -= cost;
      }
    }
  }
  return orders;
}
