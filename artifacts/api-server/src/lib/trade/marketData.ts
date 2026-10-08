import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { GOODS, type GoodSlug } from "./goods";
import {
  PRICE_CEIL_MULT,
  PRICE_FLOOR_MULT,
  REVERT_RATE,
  clampMid,
  executeTrade,
  quote,
  remainingTurnCap,
  tradableGoods,
  validateTradeQty,
  type Quote,
  type TradeSide,
} from "./market";
import { logger } from "../logger";

/**
 * 黑市資料層(2026-10-08)。
 *
 * 可交易貨物 = 除糧食以外的 7 種(糧食有自己的庫存機制,不開放黑市)。
 * 木材 / 礦石存在 player_nations.wood / ore;其餘 5 種存在 nation_goods。
 *
 * 成交 = 單一資料庫交易:
 *   1. 鎖住該國 player_nations 列(FOR UPDATE)—— 同一國的連點 / 並行請求排隊,
 *      不會雙重花同一筆錢或雙重賣同一批貨。
 *   2. 鎖住該貨物的價格列(FOR UPDATE)—— 不同國家同時交易同一貨物也排隊,
 *      每筆都讀到上一筆成交後的價格,不會兩筆都用舊價。
 *   3. 檢查額度 / 餘額 / 庫存 → 扣加 → 更新價格 → 寫紀錄。任何一步失敗整筆回滾。
 */

export const MARKET_GOODS: readonly GoodSlug[] = [
  "wood", "ore", "ironcoal", "oil", "rare", "spice", "cloth",
];

export function isMarketGood(v: unknown): v is GoodSlug {
  return typeof v === "string" && (MARKET_GOODS as readonly string[]).includes(v);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 讀所有可交易貨物的中間價;沒有列的以基準價補。純讀取。 */
export async function readMids(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const g of MARKET_GOODS) out[g] = GOODS[g].basePrice;
  try {
    const res = await db.execute(sql`SELECT good, mid FROM market_prices`);
    for (const r of res.rows as { good: string; mid: number }[]) {
      if (isMarketGood(r.good)) out[r.good] = clampMid(r.good, Number(r.mid));
    }
  } catch (err) {
    // 表尚未建立等情況:退回基準價,不讓讀取頁面整個失敗。
    logger.error({ err }, "market mids read failed, using base prices");
  }
  return out;
}

export async function readQuotes(): Promise<Quote[]> {
  const mids = await readMids();
  return MARKET_GOODS.map((g) => quote(g, mids[g]!));
}

/**
 * 自上次回合結算以來,某國某貨物某方向的已成交量(用於本回合額度)。
 * 只算玩家成交;NPC 做市不佔玩家額度。
 */
export async function usedThisTurn(
  nationId: string,
  good: GoodSlug,
  side: TradeSide,
  tx?: Tx,
): Promise<number> {
  const exec = tx ?? db;
  const res = await exec.execute(sql`
    SELECT COALESCE(SUM(t.qty), 0) AS used
    FROM market_trades t
    WHERE t.nation_id = ${nationId}::uuid
      AND t.good = ${good}
      AND t.side = ${side}
      AND t.actor = 'player'
      AND t.created_at > COALESCE(
        (SELECT last_turn_at FROM world_game_state WHERE id = 1), 'epoch'::timestamptz)
  `);
  return Number((res.rows[0] as { used: string | number } | undefined)?.used ?? 0);
}

export type TradeOutcome =
  | {
      ok: true;
      good: GoodSlug;
      side: TradeSide;
      qty: number;
      money: number;
      fee: number;
      avgPrice: number;
      midBefore: number;
      midAfter: number;
      moneyAfter: number;
      stockAfter: number;
    }
  | { ok: false; code: "bad_qty" | "no_money" | "no_stock" | "no_nation" | "bad_good"; message: string };

/** 在交易內讀某國某貨物庫存(已持有鎖)。 */
async function readStockTx(tx: Tx, nationId: string, good: GoodSlug): Promise<number> {
  if (good === "wood" || good === "ore") {
    const col = good === "wood" ? sql`wood` : sql`ore`;
    const r = await tx.execute(sql`SELECT ${col} AS s FROM player_nations WHERE id = ${nationId}::uuid`);
    return Number((r.rows[0] as { s: string | number } | undefined)?.s ?? 0);
  }
  const r = await tx.execute(
    sql`SELECT stock AS s FROM nation_goods WHERE nation_id = ${nationId}::uuid AND good = ${good}`,
  );
  return Number((r.rows[0] as { s: string | number } | undefined)?.s ?? 0);
}

/** 在交易內改庫存(delta 可負);呼叫前已確認不會變負。 */
async function addStockTx(tx: Tx, nationId: string, good: GoodSlug, delta: number): Promise<void> {
  if (good === "wood") {
    await tx.execute(sql`UPDATE player_nations SET wood = wood + ${delta} WHERE id = ${nationId}::uuid`);
  } else if (good === "ore") {
    await tx.execute(sql`UPDATE player_nations SET ore = ore + ${delta} WHERE id = ${nationId}::uuid`);
  } else {
    await tx.execute(sql`
      INSERT INTO nation_goods (nation_id, good, stock)
      VALUES (${nationId}::uuid, ${good}, ${Math.max(0, delta)})
      ON CONFLICT (nation_id, good)
      DO UPDATE SET stock = nation_goods.stock + ${delta}, updated_at = NOW()
    `);
  }
}

/**
 * 執行一筆黑市交易。actor = 'player' 會檢查回合額度與單筆上限;
 * actor = 'npc' 由 NPC 做市呼叫,不受玩家額度限制(但仍檢查餘額 / 庫存)。
 */
export async function executeMarketTrade(
  nationId: string,
  good: GoodSlug,
  side: TradeSide,
  qty: number,
  actor: "player" | "npc" = "player",
  statsEra?: string,
): Promise<TradeOutcome> {
  if (!isMarketGood(good)) return { ok: false, code: "bad_good", message: "此貨物無法在黑市交易" };
  // 時代鎖:傳入 statsEra 時,尚未解鎖的貨物不能交易(玩家路由與 NPC 做市都會傳)。
  if (statsEra !== undefined && !tradableGoods(MARKET_GOODS, statsEra).includes(good)) {
    return { ok: false, code: "bad_good", message: "此貨物在目前時代尚未開放交易" };
  }

  return db.transaction(async (tx): Promise<TradeOutcome> => {
    // 1) 鎖國家列。
    const nat = await tx.execute(
      sql`SELECT money FROM player_nations WHERE id = ${nationId}::uuid FOR UPDATE`,
    );
    const natRow = nat.rows[0] as { money: string | number } | undefined;
    if (!natRow) return { ok: false, code: "no_nation", message: "找不到國家" };
    const money = Number(natRow.money);

    // 2) 玩家額度 / 數量驗證。
    if (actor === "player") {
      const used = await usedThisTurn(nationId, good, side, tx);
      const err = validateTradeQty(qty, used);
      if (err) return { ok: false, code: "bad_qty", message: err };
    } else if (!Number.isInteger(qty) || qty <= 0) {
      return { ok: false, code: "bad_qty", message: "數量必須是正整數" };
    }

    // 3) 鎖價格列(沒有就先建立再鎖,確保同貨物的並行交易排隊)。
    await tx.execute(sql`
      INSERT INTO market_prices (good, mid) VALUES (${good}, ${GOODS[good].basePrice})
      ON CONFLICT (good) DO NOTHING
    `);
    const pr = await tx.execute(sql`SELECT mid FROM market_prices WHERE good = ${good} FOR UPDATE`);
    const midBefore = clampMid(good, Number((pr.rows[0] as { mid: number }).mid));

    const r = executeTrade(good, midBefore, side, qty);

    // 4) 餘額 / 庫存檢查。
    if (side === "buy") {
      if (money < r.money) {
        return { ok: false, code: "no_money", message: `金錢不足:需要 ${r.money},目前只有 ${money}` };
      }
    } else {
      const have = await readStockTx(tx, nationId, good);
      if (have < qty) {
        return { ok: false, code: "no_stock", message: `庫存不足:要賣 ${qty},目前只有 ${have}` };
      }
    }

    // 5) 扣加。
    const moneyDelta = side === "buy" ? -r.money : r.money;
    await tx.execute(
      sql`UPDATE player_nations SET money = money + ${moneyDelta} WHERE id = ${nationId}::uuid`,
    );
    await addStockTx(tx, nationId, good, side === "buy" ? qty : -qty);

    // 6) 更新價格、寫紀錄。
    await tx.execute(
      sql`UPDATE market_prices SET mid = ${r.newMid}, updated_at = NOW() WHERE good = ${good}`,
    );
    await tx.execute(sql`
      INSERT INTO market_trades (nation_id, good, side, qty, money, fee, mid_after, actor)
      VALUES (${nationId}::uuid, ${good}, ${side}, ${qty}, ${r.money}, ${r.fee}, ${r.newMid}, ${actor})
    `);

    const stockAfter = await readStockTx(tx, nationId, good);
    return {
      ok: true,
      good,
      side,
      qty,
      money: r.money,
      fee: r.fee,
      avgPrice: r.avgPrice,
      midBefore,
      midAfter: r.newMid,
      moneyAfter: money + moneyDelta,
      stockAfter,
    };
  });
}

/** 每回合價格回歸(回合引擎呼叫)。單一 SQL,不先讀後寫。 */
export async function revertAllMids(): Promise<void> {
  for (const g of MARKET_GOODS) {
    const base = GOODS[g].basePrice;
    // 與 market.ts 的 revertMid 同一組常數,避免兩份公式各改各的。
    const min = base * PRICE_FLOOR_MULT;
    const max = base * PRICE_CEIL_MULT;
    await db.execute(sql`
      UPDATE market_prices
      SET mid = LEAST(${max}, GREATEST(${min}, mid + (${base} - mid) * ${REVERT_RATE})),
          updated_at = NOW()
      WHERE good = ${g}
    `);
  }
}

export { remainingTurnCap };
