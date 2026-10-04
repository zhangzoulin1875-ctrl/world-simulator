/**
 * 招募訓練佇列：資料層（原子入列／回合推進／取消退還）。純邏輯在
 * recruitQueueCore.ts。功能開關存在 game_flags（key 存在 = 啟用），預設關閉。
 *
 * 不變量：
 *  - 入列時資源與佔用已由呼叫端的同一筆交易扣除；本模組只記帳。
 *  - 推進時把完成單位併入 player_armies／npc_armies，並按
 *    (完成/總量) 比例把訂單上的佔用量轉成軍隊預留量（總和守恆，
 *    最後一批吃掉尾差）。
 *  - 取消時按 remaining/total 比例 100% 退還佔用、人口、木礦、金錢，
 *    並扣回國家 spent 計數。
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  npcArmiesTable,
  playerArmiesTable,
  playerNationsTable,
  recruitQueueTable,
  type RecruitQueueRow,
} from "@workspace/db";
import {
  advanceQueue,
  canEnqueue,
  type QueueEntry,
} from "./recruitQueueCore";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = Pick<typeof db, "select" | "execute">;

export const RECRUIT_QUEUE_FLAG = "recruit-queue-enabled";

/** 功能是否啟用（game_flags 有該 key）。預設關閉。 */
export async function isRecruitQueueEnabled(dbc: DbLike = db): Promise<boolean> {
  const r = await dbc.execute(
    sql`SELECT 1 FROM game_flags WHERE key = ${RECRUIT_QUEUE_FLAG} LIMIT 1`,
  );
  return r.rows.length > 0;
}

export async function setRecruitQueueEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await db.execute(
      sql`INSERT INTO game_flags (key) VALUES (${RECRUIT_QUEUE_FLAG}) ON CONFLICT (key) DO NOTHING`,
    );
  } else {
    await db.execute(sql`DELETE FROM game_flags WHERE key = ${RECRUIT_QUEUE_FLAG}`);
  }
}

export class RecruitQueueFullError extends Error {
  constructor() {
    super("訓練佇列已滿（最多同時訓練 3 種兵種），請等待現有兵種訓練完成或取消其中一項");
    this.name = "RecruitQueueFullError";
  }
}

export interface EnqueueInput {
  nationId: string;
  templateId: number;
  quantity: number;
  tpPerUnit: number;
  productionReserved?: number;
  populationReserved?: number;
  woodPaid?: number;
  orePaid?: number;
  moneyPaid?: number;
}

/**
 * 入列。必須在呼叫端已持有該國列鎖的交易內呼叫（招募／購買的條件式
 * UPDATE 已序列化同國並發），以保證「不同兵種 ≤ 3」的檢查不被並發穿透。
 * 滿 3 種且為新兵種 → 丟 RecruitQueueFullError（整筆交易由呼叫端回滾）。
 */
export async function enqueueInTx(tx: Tx, input: EnqueueInput): Promise<RecruitQueueRow> {
  const existing = await tx
    .select({ templateId: recruitQueueTable.templateId })
    .from(recruitQueueTable)
    .where(eq(recruitQueueTable.nationId, input.nationId));
  const check = canEnqueue(
    existing.map((r) => r.templateId),
    input.templateId,
  );
  if (!check.ok) throw new RecruitQueueFullError();
  const [row] = await tx
    .insert(recruitQueueTable)
    .values({
      nationId: input.nationId,
      templateId: input.templateId,
      totalQuantity: input.quantity,
      remaining: input.quantity,
      tpPerUnit: Math.max(1, Math.floor(input.tpPerUnit)),
      productionReserved: input.productionReserved ?? 0,
      populationReserved: input.populationReserved ?? 0,
      woodPaid: input.woodPaid ?? 0,
      orePaid: input.orePaid ?? 0,
      moneyPaid: input.moneyPaid ?? 0,
    })
    .returning();
  if (!row) throw new Error("訓練佇列寫入失敗");
  return row;
}

/** 按比例分攤（向下取整；呼叫端讓最後一批吃掉尾差）。 */
function share(total: number, part: number, whole: number): number {
  if (whole <= 0 || part <= 0 || total <= 0) return 0;
  if (part >= whole) return total;
  return Math.floor((total * part) / whole);
}

/**
 * 推進單一國家一個回合。回傳本回合各兵種完成的單位。
 * 交易內鎖定該國佇列列（FOR UPDATE），重複呼叫不會重複完成（每次都讀最新
 * remaining）。capacity 由呼叫端依人口算出。
 */
export async function advanceNationQueue(
  nationId: string,
  capacity: number,
  isNpc: boolean,
): Promise<Array<{ templateId: number; units: number }>> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(recruitQueueTable)
      .where(eq(recruitQueueTable.nationId, nationId))
      .orderBy(asc(recruitQueueTable.id))
      .for("update");
    if (rows.length === 0) return [];
    const entries: QueueEntry[] = rows.map((r) => ({
      id: r.id,
      templateId: r.templateId,
      remaining: r.remaining,
      tpPerUnit: r.tpPerUnit,
    }));
    const adv = advanceQueue(entries, capacity);
    if (adv.completed.length === 0) return [];

    const byTemplate = new Map<number, number>();
    for (const c of adv.completed) {
      const row = rows.find((r) => r.id === c.id)!;
      // 防超發：以資料庫原子扣減為準，不信任先前讀到的 remaining 快照。
      // UPDATE … SET remaining = remaining - want WHERE remaining >= want 只在
      // 真的還有這麼多單位時成功；並發的另一個推進若已先完成，這裡會扣不到，
      // 退而扣「當下實際剩餘」，最壞是這批完成 0。RETURNING 回傳扣後值，
      // 實際完成量 = 扣前 − 扣後。
      const taken = await tx.execute(sql`
        UPDATE recruit_queue AS q
        SET remaining = GREATEST(0, q.remaining - ${c.units})
        FROM (SELECT id, remaining AS before FROM recruit_queue WHERE id = ${row.id} FOR UPDATE) AS old
        WHERE q.id = old.id
        RETURNING old.before AS before, q.remaining AS after,
                  q.production_reserved AS prod, q.population_reserved AS pop
      `);
      const t = taken.rows[0] as
        | { before: string | number; after: string | number; prod: string | number; pop: string | number }
        | undefined;
      if (!t) continue; // 訂單已被取消／完成
      const before = Number(t.before);
      const units = Math.min(c.units, before);
      if (units <= 0) continue;
      const prodMove = share(Number(t.prod), units, before);
      const popMove = share(Number(t.pop), units, before);

      if (isNpc) {
        await tx
          .insert(npcArmiesTable)
          .values({ nationId, templateId: c.templateId, quantity: units })
          .onConflictDoUpdate({
            target: [npcArmiesTable.nationId, npcArmiesTable.templateId],
            set: {
              quantity: sql`${npcArmiesTable.quantity} + ${units}`,
              updatedAt: new Date(),
            },
          });
      } else {
        const [nation] = await tx
          .select({ discordUserId: playerNationsTable.discordUserId })
          .from(playerNationsTable)
          .where(eq(playerNationsTable.id, nationId))
          .limit(1);
        if (!nation?.discordUserId) continue;
        await tx
          .insert(playerArmiesTable)
          .values({
            discordUserId: nation.discordUserId,
            templateId: c.templateId,
            quantity: units,
            productionReserved: prodMove,
            populationReserved: popMove,
          })
          .onConflictDoUpdate({
            target: [playerArmiesTable.discordUserId, playerArmiesTable.templateId],
            set: {
              quantity: sql`${playerArmiesTable.quantity} + ${units}`,
              productionReserved: sql`${playerArmiesTable.productionReserved} + ${prodMove}`,
              populationReserved: sql`${playerArmiesTable.populationReserved} + ${popMove}`,
              updatedAt: new Date(),
            },
          });
      }
      await tx
        .update(recruitQueueTable)
        .set({
          productionReserved: sql`GREATEST(0, ${recruitQueueTable.productionReserved} - ${prodMove})`,
          populationReserved: sql`GREATEST(0, ${recruitQueueTable.populationReserved} - ${popMove})`,
        })
        .where(eq(recruitQueueTable.id, row.id));
      await tx
        .delete(recruitQueueTable)
        .where(and(eq(recruitQueueTable.id, row.id), sql`${recruitQueueTable.remaining} <= 0`));
      byTemplate.set(c.templateId, (byTemplate.get(c.templateId) ?? 0) + units);
    }
    return [...byTemplate.entries()].map(([templateId, units]) => ({ templateId, units }));
  });
}

export interface CancelResult {
  refundedUnits: number;
  production: number;
  population: number;
  wood: number;
  ore: number;
  money: number;
}

/**
 * 取消一筆訂單的剩餘部分，100% 退還（佔用、人口、木礦、金錢）。
 * 只能取消自己國家的訂單；已完成的單位不受影響。
 */
export async function cancelQueueOrder(
  nationId: string,
  orderId: number,
): Promise<CancelResult | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(recruitQueueTable)
      .where(and(eq(recruitQueueTable.id, orderId), eq(recruitQueueTable.nationId, nationId)))
      .for("update")
      .limit(1);
    if (!row) return null;
    // 剩餘比例：佔用／人口在推進時已隨完成批次轉出，故訂單上剩下的就是
    // 「尚未完成部分」的全額；木礦／金錢是下單總額，按 remaining/total 退。
    const wood = share(row.woodPaid, row.remaining, row.totalQuantity);
    const ore = share(row.orePaid, row.remaining, row.totalQuantity);
    const money = share(row.moneyPaid, row.remaining, row.totalQuantity);
    const production = row.productionReserved;
    const population = row.populationReserved;

    await tx
      .update(playerNationsTable)
      .set({
        productionSpent: sql`GREATEST(0, ${playerNationsTable.productionSpent} - ${production})`,
        populationSpent: sql`GREATEST(0, ${playerNationsTable.populationSpent} - ${population})`,
        wood: sql`${playerNationsTable.wood} + ${wood}`,
        ore: sql`${playerNationsTable.ore} + ${ore}`,
        money: sql`${playerNationsTable.money} + ${money}`,
      })
      .where(eq(playerNationsTable.id, nationId));
    await tx.delete(recruitQueueTable).where(eq(recruitQueueTable.id, row.id));
    return { refundedUnits: row.remaining, production, population, wood, ore, money };
  });
}

/** 該國目前的佇列（依下單順序）。 */
export async function listNationQueue(nationId: string): Promise<RecruitQueueRow[]> {
  return db
    .select()
    .from(recruitQueueTable)
    .where(eq(recruitQueueTable.nationId, nationId))
    .orderBy(asc(recruitQueueTable.id));
}

/**
 * NPC 入列：NPC 的「每回合固定生產」不是玩家下單，不該被「3 種兵種」上限擋下
 * （NPC 一次就會產多個兵種），因此這裡不做 canEnqueue 檢查；同兵種合併進既有
 * 訂單，避免每回合新增一筆造成佇列列數無限成長。
 */
export async function enqueueNpcOrderInTx(
  tx: Tx,
  input: { nationId: string; templateId: number; quantity: number; tpPerUnit: number },
): Promise<void> {
  const tp = Math.max(1, Math.floor(input.tpPerUnit));
  const merged = await tx.execute(sql`
    UPDATE recruit_queue
    SET total_quantity = total_quantity + ${input.quantity},
        remaining = remaining + ${input.quantity},
        tp_per_unit = ${tp}
    WHERE id = (
      SELECT id FROM recruit_queue
      WHERE nation_id = ${input.nationId} AND template_id = ${input.templateId}
      ORDER BY id LIMIT 1
      FOR UPDATE
    )
    RETURNING id
  `);
  if (merged.rows.length > 0) return;
  await tx.insert(recruitQueueTable).values({
    nationId: input.nationId,
    templateId: input.templateId,
    totalQuantity: input.quantity,
    remaining: input.quantity,
    tpPerUnit: tp,
  });
}

/**
 * 回合推進：對所有有訂單的國家依人口產能推進一個回合。每國獨立 try/catch，
 * 單國失敗不阻斷其他國與回合。功能關閉時直接略過（已排隊的訂單保留，
 * 重新開啟後繼續，不會遺失）。
 */
export async function runRecruitQueueTurn(
  statsEra: string,
  loadPopulation: (nationId: string, statsEra: string) => Promise<number>,
): Promise<{ nations: number; completedUnits: number; failed: number }> {
  const summary = { nations: 0, completedUnits: 0, failed: 0 };
  if (!(await isRecruitQueueEnabled())) return summary;
  const rows = await db
    .selectDistinct({
      nationId: recruitQueueTable.nationId,
      isNpc: playerNationsTable.isNpc,
    })
    .from(recruitQueueTable)
    .innerJoin(playerNationsTable, eq(playerNationsTable.id, recruitQueueTable.nationId));
  const { turnCapacity } = await import("./recruitQueueCore");
  for (const r of rows) {
    try {
      const pop = await loadPopulation(r.nationId, statsEra);
      const done = await advanceNationQueue(r.nationId, turnCapacity(pop), r.isNpc);
      summary.nations++;
      summary.completedUnits += done.reduce((a, d) => a + d.units, 0);
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
