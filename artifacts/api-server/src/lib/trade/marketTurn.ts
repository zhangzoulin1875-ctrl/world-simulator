import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { GOODS, type GoodSlug } from "./goods";
import { planNpcOrders, tradableGoods } from "./market";
import { MARKET_GOODS, executeMarketTrade, readMids, revertAllMids } from "./marketData";
import { logger } from "../logger";

/**
 * 黑市的每回合結算(回合引擎在國家迴圈之後呼叫一次)。
 *
 * 順序:
 *   1. NPC 先做市 —— 玩家這一整個回合推出去的價格,由 NPC 在回合結算時反向拉一把。
 *   2. 再做價格回歸 —— 向基準價收斂。
 * 先 NPC 後回歸:NPC 看到的是玩家實際推出的價格,回歸才不會把偏離「藏起來」。
 *
 * 全程失敗不阻斷回合(呼叫端有自己的 try/catch),單一 NPC 失敗也不影響其他 NPC。
 */

export interface MarketTurnSummary {
  npcTrades: number;
  npcFailed: number;
  mids: Record<string, number>;
}

/** NPC 每回合最多參與做市的國家數(避免 NPC 很多時一回合打爆資料庫)。 */
export const MAX_NPC_MARKET_MAKERS = 20;

interface NpcRow {
  id: string;
  money: number;
  wood: number;
  ore: number;
}

async function loadNpcMakers(): Promise<NpcRow[]> {
  // 用 id 做確定性排序:同一批 NPC 每回合順序固定,不會靠隨機讓結果不可重現。
  const res = await db.execute(sql`
    SELECT id, money, wood, ore
    FROM player_nations
    WHERE is_npc = true
    ORDER BY id
    LIMIT ${MAX_NPC_MARKET_MAKERS}
  `);
  return (res.rows as { id: string; money: string | number; wood: string | number; ore: string | number }[]).map((r) => ({
    id: r.id,
    money: Number(r.money),
    wood: Number(r.wood),
    ore: Number(r.ore),
  }));
}

async function loadStocks(nationIds: string[]): Promise<Map<string, Partial<Record<GoodSlug, number>>>> {
  const out = new Map<string, Partial<Record<GoodSlug, number>>>();
  if (nationIds.length === 0) return out;
  const res = await db.execute(sql`
    SELECT nation_id, good, stock FROM nation_goods
    WHERE nation_id IN (${sql.join(nationIds.map((i) => sql`${i}::uuid`), sql`, `)})
  `);
  for (const r of res.rows as { nation_id: string; good: GoodSlug; stock: string | number }[]) {
    const m = out.get(r.nation_id) ?? {};
    m[r.good] = Number(r.stock);
    out.set(r.nation_id, m);
  }
  return out;
}

export async function runMarketTurn(statsEra?: string): Promise<MarketTurnSummary> {
  let npcTrades = 0;
  let npcFailed = 0;

  const npcs = await loadNpcMakers();
  const stocks = await loadStocks(npcs.map((n) => n.id));
  // 同一回合內價格會被前一個 NPC 推動,所以每個 NPC 規劃前重讀最新價格。
  for (const npc of npcs) {
    try {
      const mids = await readMids();
      const stock = { ...(stocks.get(npc.id) ?? {}), wood: npc.wood, ore: npc.ore };
      const goods = statsEra === undefined ? MARKET_GOODS : tradableGoods(MARKET_GOODS, statsEra);
      const orders = planNpcOrders({ stock, money: npc.money }, mids, goods);
      for (const o of orders) {
        const r = await executeMarketTrade(npc.id, o.good, o.side, o.qty, "npc", statsEra);
        if (r.ok) npcTrades += 1;
        else npcFailed += 1;
      }
    } catch (err) {
      npcFailed += 1;
      logger.error({ err, nationId: npc.id }, "market turn: npc trade failed");
    }
  }

  await revertAllMids();
  const mids = await readMids();
  return { npcTrades, npcFailed, mids };
}

export { GOODS };
