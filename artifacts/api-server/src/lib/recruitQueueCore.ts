/**
 * 招募訓練佇列：純函式核心（不碰 DB，可單元測試）。
 *
 * 規格（2026-10-04 確認）：
 *  - 下單當下扣資源並佔用（由呼叫端的交易完成）；取消退 100%。
 *  - 佇列同時最多 MAX_QUEUE_TEMPLATES 個「不同兵種」；滿了不能開新兵種，
 *    同兵種可追加（即使當回合產能未用盡）。
 *  - 每國每回合有訓練產能（訓練點數）封頂；佇列先進先出，依產能逐回合完成。
 *  - 每單位訓練點數 TP = 1 + prodCostPer100 × 0.5（prodCostPer100 本來就與
 *    戰力成正比且有下限，舊兵種直接適用）。
 *  - 不設超時自動完成。
 */

/** 佇列同時容納的兵種數上限。 */
export const MAX_QUEUE_TEMPLATES = 3;

/** 每回合訓練產能 = 人口 × 此比例 × (1 + 科技加成)。可由管理員調整。 */
export const DEFAULT_CAPACITY_RATIO = 0.002;

/** 每單位訓練點數（整數下限 1）。 */
export function trainingPointsPerUnit(prodCostPer100: number): number {
  const p = Number.isFinite(prodCostPer100) ? Math.max(0, prodCostPer100) : 0;
  return Math.max(1, Math.ceil(1 + p * 0.5));
}

/** 該國每回合訓練產能（訓練點數，≥ 1）。 */
export function turnCapacity(
  population: number,
  ratio: number = DEFAULT_CAPACITY_RATIO,
  techBonusPct = 0,
): number {
  const pop = Number.isFinite(population) ? Math.max(0, population) : 0;
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_CAPACITY_RATIO;
  const bonus = Number.isFinite(techBonusPct) ? Math.max(0, techBonusPct) : 0;
  return Math.max(1, Math.floor(pop * r * (1 + bonus / 100)));
}

/** 佇列中的一筆訂單（已依下單順序排序）。 */
export interface QueueEntry {
  id: number;
  templateId: number;
  /** 尚未完成的單位數。 */
  remaining: number;
  /** 每單位訓練點數（下單當下快照，之後不隨科技變動，避免中途改價）。 */
  tpPerUnit: number;
}

export interface AdvanceResult {
  /** 每筆訂單本回合完成的單位數（只含 > 0 的）。 */
  completed: Array<{ id: number; templateId: number; units: number }>;
  /** 推進後仍留在佇列的訂單（remaining > 0）。 */
  remaining: QueueEntry[];
  /** 本回合實際用掉的訓練點數。 */
  pointsUsed: number;
}

/**
 * 推進一個回合：先進先出，依產能逐筆完成。前面的訂單吃不完產能才輪到後面；
 * 一筆訂單只要還有單位、產能夠完成至少 1 單位就會推進。
 * 產能不足一個完整單位的零頭不浪費在單位上（整數單位），但會留給後面較便宜
 * 的訂單。
 */
export function advanceQueue(
  entries: readonly QueueEntry[],
  capacity: number,
): AdvanceResult {
  let budget = Math.max(0, Math.floor(capacity));
  const completed: AdvanceResult["completed"] = [];
  const remaining: QueueEntry[] = [];
  let used = 0;
  for (const e of entries) {
    if (e.remaining <= 0) continue;
    const tp = Math.max(1, e.tpPerUnit);
    const canDo = Math.min(e.remaining, Math.floor(budget / tp));
    if (canDo > 0) {
      completed.push({ id: e.id, templateId: e.templateId, units: canDo });
      budget -= canDo * tp;
      used += canDo * tp;
    }
    const left = e.remaining - canDo;
    if (left > 0) remaining.push({ ...e, remaining: left });
  }
  // 保底：整個產能連 1 單位都做不出來（單位 TP > 產能，例如小國練艦船）時，
  // 佇列首筆每回合仍完成 1 單位，否則該訂單會永遠卡死、資源永久被佔用。
  if (completed.length === 0 && remaining.length > 0) {
    const head = remaining[0]!;
    completed.push({ id: head.id, templateId: head.templateId, units: 1 });
    used += Math.max(1, head.tpPerUnit);
    if (head.remaining <= 1) remaining.shift();
    else remaining[0] = { ...head, remaining: head.remaining - 1 };
  }
  return { completed, remaining, pointsUsed: used };
}

export type QueueCheck =
  | { ok: true; isNewTemplate: boolean }
  | { ok: false; reason: "QUEUE_FULL" };

/**
 * 能否接受新下單：已在佇列的兵種可追加；否則需有空位（< 3 個不同兵種）。
 * 滿 3 個不同兵種時，第 4 個兵種一律拒絕，不論當回合產能是否用盡。
 */
export function canEnqueue(
  queuedTemplateIds: readonly number[],
  templateId: number,
): QueueCheck {
  const distinct = new Set(queuedTemplateIds);
  if (distinct.has(templateId)) return { ok: true, isNewTemplate: false };
  if (distinct.size >= MAX_QUEUE_TEMPLATES) {
    return { ok: false, reason: "QUEUE_FULL" };
  }
  return { ok: true, isNewTemplate: true };
}

/**
 * 預估完成還需幾個回合（供前端顯示）。假設產能不變、FIFO。
 * 回傳每筆訂單的「最後一單位完成的回合數」（1 = 下個回合）。
 */
export function estimateTurnsToFinish(
  entries: readonly QueueEntry[],
  capacity: number,
  maxTurns = 10_000,
): Map<number, number> {
  const result = new Map<number, number>();
  let cur = entries.filter((e) => e.remaining > 0).map((e) => ({ ...e }));
  const cap = Math.max(1, Math.floor(capacity));
  let turn = 0;
  while (cur.length > 0 && turn < maxTurns) {
    turn++;
    const adv = advanceQueue(cur, cap);
    cur = adv.remaining;
    const stillIds = new Set(cur.map((e) => e.id));
    for (const c of adv.completed) {
      if (!stillIds.has(c.id) && !result.has(c.id)) result.set(c.id, turn);
    }
  }
  return result;
}
