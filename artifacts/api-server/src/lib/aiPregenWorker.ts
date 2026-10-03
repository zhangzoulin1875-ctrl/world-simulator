import { eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  worldGameStateTable,
  financePendingIdeasTable,
  politicsPendingIdeasTable,
  aiPregenCacheTable,
  type FinancePendingIdea,
  type PoliticsPendingIdea,
  type PlayerNation,
} from "@workspace/db";
import {
  getAiQueueStats,
  runWithAiPriority,
  AI_PRIORITY_PREGEN,
} from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";
import {
  normalizeTurnTimes,
  computeTurnProgress,
  type TurnTime,
} from "./turnEngine";
import { localDateString, localSlotInstant } from "./time";
import { getPoliticsSettings } from "./politicsSettings";
import { judgeFiscalPolicyIdea } from "./financeAi";
import { judgePolicyIdea } from "./politicsAi";
import {
  PREGEN_KIND_FISCAL,
  PREGEN_KIND_POLITICS,
  buildFiscalJudgeInput,
  buildPoliticsJudgeInput,
  storePregenResult,
} from "./aiPregenCache";

/**
 * AI 閒時預產 worker（v3）。
 *
 * 背景 worker 只在 AI 佇列「完全閒置」時（active=0 且 queued=0）挑一件
 * 「不急但重要」的任務預先生成：財政政策想法判定、政治政策想法判定。
 * 每個 tick 最多做一件、做完即停，下個 tick 仍閒置才做下一件 → 佇列佔用
 * 永遠 ≤1，且以最低優先權入隊（AI_PRIORITY_PREGEN），玩家互動與回合
 * 結算一律插隊在前，感受不到背景預產存在。
 *
 * 安全規則：
 *   - 預產結果只存 ai_pregen_cache，玩家看不到；效果一律在結算當下套用。
 *   - 玩家改了想法 → 輸入雜湊不同 → 舊快取自動失效並重生成。
 *   - 「結算前 20 分鐘」規則：想法是在距離下一次結算 20 分鐘內提出/修改
 *     的 → 不預產（結算馬上就到，現場判定即可，避免生成到一半撞結算）。
 *   - 單件失敗進 5 分鐘冷卻（in-memory），不對同一壞輸入連環重試。
 */

const TICK_MS = 30_000;
/** 結算前多少毫秒內提出/修改的想法不做預產。 */
const STOP_BEFORE_SETTLEMENT_MS = 20 * 60 * 1000;
/** 單件生成失敗後的冷卻毫秒數。 */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

let tickInFlight = false;
const failureCooldown = new Map<string, number>();

interface PregenCandidate {
  kind: string;
  nationId: string;
  ideaCreatedAt: Date;
  /** 輸入雜湊；worker 逐欄位重建 prompt 輸入後比對。 */
  build: () => Promise<{
    hash: string;
    run: () => Promise<unknown>;
  }>;
}

/** 下一次每日回合（政治結算）的瞬時時間；算不出回 null（保守：不預產）。 */
async function nextTurnSettlementInstant(now: Date): Promise<Date | null> {
  const [state] = await db
    .select({
      turnTimes: worldGameStateTable.turnTimes,
      lastTurnAt: worldGameStateTable.lastTurnAt,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  if (!state) return null;
  const times = normalizeTurnTimes(state.turnTimes);
  if (times.length === 0) return null;
  const today = localDateString(now);
  const progress = computeTurnProgress(
    times,
    now,
    state.lastTurnAt ?? null,
    today,
  );
  const nextTime: TurnTime | null = progress.nextTime;
  if (!nextTime) return null;
  let inst = localSlotInstant(today, nextTime.hour, nextTime.minute);
  if (inst.getTime() <= now.getTime()) {
    // 今日時段已全部跑完 → 明日第一個時段。
    inst = new Date(inst.getTime() + 24 * 60 * 60 * 1000);
  }
  return inst;
}

async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    // 只在完全閒置時做事：有任何進行中／排隊中的 AI 呼叫一律讓路。
    const stats = getAiQueueStats();
    if (stats.active > 0 || stats.queued > 0) return;

    const now = new Date();

    const [nations, fiscalIdeas, politicsIdeas, cacheRows, nextTurnAt, state] =
      await Promise.all([
        db.select().from(playerNationsTable),
        db.select().from(financePendingIdeasTable),
        db.select().from(politicsPendingIdeasTable),
        db.select().from(aiPregenCacheTable),
        nextTurnSettlementInstant(now),
        db
          .select({ financeNextRunAt: worldGameStateTable.financeNextRunAt })
          .from(worldGameStateTable)
          .where(eq(worldGameStateTable.id, 1))
          .limit(1),
      ]);

    const nationsById = new Map<string, PlayerNation>(nations.map((n) => [n.id, n]));
    const cacheByKey = new Map<string, { inputHash: string; id: number }>(
      cacheRows.map((r) => [`${r.kind}:${r.nationId}`, { inputHash: r.inputHash, id: r.id }]),
    );

    // 孤兒清理：對應想法已不存在（已判定/被玩家刪除）的快取列直接刪除。
    const liveKeys = new Set<string>();
    for (const idea of fiscalIdeas) liveKeys.add(`${PREGEN_KIND_FISCAL}:${idea.nationId}`);
    for (const idea of politicsIdeas) liveKeys.add(`${PREGEN_KIND_POLITICS}:${idea.nationId}`);
    for (const row of cacheRows) {
      if (!liveKeys.has(`${row.kind}:${row.nationId}`)) {
        await db.delete(aiPregenCacheTable).where(eq(aiPregenCacheTable.id, row.id));
      }
    }

    const candidates: PregenCandidate[] = [];

    for (const idea of fiscalIdeas) {
      const nation = nationsById.get(idea.nationId);
      if (!nation) continue;
      const ideaCreatedAt = idea.createdAt;
      candidates.push({
        kind: PREGEN_KIND_FISCAL,
        nationId: nation.id,
        ideaCreatedAt,
        build: async () => {
          const { input, hash } = await buildFiscalJudgeInput(nation, idea);
          return {
            hash,
            run: () =>
              judgeFiscalPolicyIdea({
                government: input["government"] as string | null,
                eraSlug: input["eraSlug"] as string,
                currentTaxRatePct: input["currentTaxRatePct"] as number,
                taxEfficiencyPct: input["taxEfficiencyPct"] as number,
                idea: input["idea"] as string,
                geoContext: input["geoContext"] as string | undefined,
              }),
          };
        },
      });
    }

    const politicsSettings =
      politicsIdeas.length > 0 ? await getPoliticsSettings() : null;
    for (const idea of politicsIdeas) {
      const nation = nationsById.get(idea.nationId);
      if (!nation) continue;
      const ideaCreatedAt = idea.createdAt;
      candidates.push({
        kind: PREGEN_KIND_POLITICS,
        nationId: nation.id,
        ideaCreatedAt,
        build: async () => {
          const { input, hash } = await buildPoliticsJudgeInput(
            nation,
            idea,
            politicsSettings ?? undefined,
          );
          return {
            hash,
            run: () =>
              judgePolicyIdea({
                government: input["government"] as string | null,
                direction: input["direction"] as
                  | Parameters<typeof judgePolicyIdea>[0]["direction"],
                eraSlug: input["eraSlug"] as string,
                idea: input["idea"] as string,
                politicalNote: input["politicalNote"] as string | null | undefined,
                geoContext: input["geoContext"] as string | undefined,
                settings: politicsSettings ?? undefined,
              }),
          };
        },
      });
    }

    // 最舊的想法優先。
    candidates.sort((a, b) => a.ideaCreatedAt.getTime() - b.ideaCreatedAt.getTime());

    for (const cand of candidates) {
      const cached = cacheByKey.get(`${cand.kind}:${cand.nationId}`);
      const cooldownUntil = failureCooldown.get(`${cand.kind}:${cand.nationId}`);
      if (cooldownUntil !== undefined && cooldownUntil > now.getTime()) continue;

      // 「結算前 20 分鐘」規則：想法在距離下次結算 20 分鐘內提出/修改 → 跳過。
      const nextSettle =
        cand.kind === PREGEN_KIND_FISCAL
          ? (state[0]?.financeNextRunAt ?? null)
          : nextTurnAt;
      // 下次結算時間未知（財政從未排程過 = 隨時會跑）→ 保守不預產。
      if (nextSettle === null) continue;
      const windowStart = nextSettle.getTime() - STOP_BEFORE_SETTLEMENT_MS;
      if (cand.ideaCreatedAt.getTime() >= windowStart) continue;

      // 二次確認仍然閒置（build/載入期間可能有玩家呼叫進來）。
      const fresh = getAiQueueStats();
      if (fresh.active > 0 || fresh.queued > 0) return;

      try {
        const { hash, run } = await cand.build();
        // build 完比對：雜湊與快取相同 = 已預產過（無論表上 input_hash 新舊）。
        if (cached && cached.inputHash === hash) continue;
        const result = await runWithAiPriority(AI_PRIORITY_PREGEN, run);
        await storePregenResult(cand.kind, cand.nationId, hash, result);
        logger.info(
          { kind: cand.kind, nationId: cand.nationId },
          "ai pregen: cached judgement",
        );
      } catch (err) {
        failureCooldown.set(`${cand.kind}:${cand.nationId}`, Date.now() + FAILURE_COOLDOWN_MS);
        logger.error(
          { err, kind: cand.kind, nationId: cand.nationId },
          "ai pregen: generation failed (cooldown)",
        );
      }
      // 一個 tick 只做一件。
      return;
    }
  } catch (err) {
    logger.error({ err }, "ai pregen worker tick failed");
  } finally {
    tickInFlight = false;
  }
}

/** 啟動背景預產迴圈（於 bootstrap 完成後呼叫）。 */
export function startAiPregenWorker(): void {
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), TICK_MS);
  }, 60_000);
  logger.info("ai pregen worker loop started (idle-time policy judgement pregen)");
}
