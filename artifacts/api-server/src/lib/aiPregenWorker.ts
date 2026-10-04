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
import { noteGameActivity } from "./schedulerWake";
import {
  normalizeTurnTimes,
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
import {
  GENERAL_POOL_TARGET_PER_BUCKET,
} from "./generals";
import {
  loadDominantCultureProfile,
  topUpGeneralPool,
} from "./generalAi";

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
 *   - 「結算前 20 分鐘」規則（以「現在時間」判斷）：現在落在任一種類
 *     下次結算的前 20 分鐘內 → 該種類整段不預產（規則原意：避免政策
 *     變動後用到舊資料、以及生成到一半撞上結算；雜湊比對仍是最終
 *     兜底）。窗口結束會自動恢復預產。
 *   - 單件失敗進 5 分鐘冷卻（in-memory），不對同一壞輸入連環重試；
 *     冷卻結束自動恢復。
 *
 * 事件驅動（省電）：tick 靠 notePregenWork() 旗標喚醒——玩家提交/撤回
 * 想法、結算 AI 失敗保留想法時打旗標；沒有旗標時 tick 純記憶體返回
 * （零 DB 查詢，Neon 可休眠）。冷卻／結算鎖定窗用精準 setTimeout 排
 * 下一次自我喚醒，不靠輪詢。
 */

const TICK_MS = 30_000;
/** 距離下次結算多少毫秒內就不再預產（以現在時間判斷）。 */
const STOP_BEFORE_SETTLEMENT_MS = 20 * 60 * 1000;
/** 單件生成失敗後的冷卻毫秒數。 */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** 武將預產池：單一「時代×文化圈」桶的補位目標。 */
const PREGEN_KIND_GENERAL_POOL = "general_pool";

let tickInFlight = false;
const failureCooldown = new Map<string, number>();

/** 有「可能可以預產的工作」旗標；false 時 tick 直接返回（零 DB 查詢）。 */
let workPending = true;

/** 外部掛旗標：玩家提交/撤回想法、結算保留想法等事件後呼叫。 */
export function notePregenWork(): void {
  workPending = true;
}

/** 在指定時刻自我喚醒（冷卻結束／結算鎖定窗結束）。不會 hold 事件迴圈。 */
function rearmPregenWorkAt(atMs: number): void {
  const delay = Math.max(1_000, atMs - Date.now());
  const timer = setTimeout(() => {
    workPending = true;
  }, delay);
  timer.unref?.();
}

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

/**
 * 下一次每日回合（政治結算）的瞬時時間＝純看時鐘的「下一個未來時段」。
 * 不依賴 lastTurnAt（結算觸發中、lastTurn_at 尚未前進時，舊算法會高估
 * 下次結算時間、導致鎖定窗失準）；算不出回 null（保守：不預產）。
 */
async function nextTurnSettlementInstant(now: Date): Promise<Date | null> {
  const [state] = await db
    .select({
      turnTimes: worldGameStateTable.turnTimes,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  if (!state) return null;
  const times = normalizeTurnTimes(state.turnTimes);
  if (times.length === 0) return null;
  const nowMs = now.getTime();
  const today = localDateString(now);
  let nextUpcoming: number | null = null;
  for (const t of times) {
    const ms = localSlotInstant(today, t.hour, t.minute).getTime();
    if (ms > nowMs && (nextUpcoming === null || ms < nextUpcoming)) {
      nextUpcoming = ms;
    }
  }
  if (nextUpcoming !== null) return new Date(nextUpcoming);
  // 今日時段全部過了 → 明日第一個時段（times 已排序）。
  const first = times[0]!;
  return new Date(
    localSlotInstant(today, first.hour, first.minute).getTime() + 24 * 60 * 60_000,
  );
}

async function tick(): Promise<void> {
  if (tickInFlight || !workPending) return;
  tickInFlight = true;
  try {
    // 只在完全閒置時做事：有任何進行中／排隊中的 AI 呼叫一律讓路。
    const stats = getAiQueueStats();
    if (stats.active > 0 || stats.queued > 0) return;
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
          .select({
            financeNextRunAt: worldGameStateTable.financeNextRunAt,
            currentEra: worldGameStateTable.currentEra,
          })
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
                context: input["context"] as string | undefined,
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
                activePolicies: input["activePolicies"] as
                  | Parameters<typeof judgePolicyIdea>[0]["activePolicies"],
                context: input["context"] as string | undefined,
                settings: politicsSettings ?? undefined,
              }),
          };
        },
      });
    }

    // 最舊的想法優先。
    candidates.sort((a, b) => a.ideaCreatedAt.getTime() - b.ideaCreatedAt.getTime());

    // 武將預產池補位（每個「時代×文化圈」桶補到目標數）：玩家抽取走池卡
    // （notePregenWork 打旗標）或開機首個 tick 時補。與其他預產同樣受
    // 「結算前 20 分鐘」規則保護（時代可能推進 → 舊時代池卡會作廢）。
    const currentEra = state[0]?.currentEra ?? null;
    if (currentEra !== null && nextTurnAt !== null) {
      const nextTurnMs = nextTurnAt.getTime();
      if (now.getTime() < nextTurnMs - STOP_BEFORE_SETTLEMENT_MS) {
        const bucketRep = new Map<string, string>();
        for (const nation of nations) {
          const profile = await loadDominantCultureProfile(nation.id);
          const key = `${currentEra}|${profile}`;
          if (!bucketRep.has(key)) bucketRep.set(key, nation.id);
        }
        for (const [bucketKey, repNationId] of bucketRep) {
          const profile = bucketKey.split("|")[1]!;
          const cooldownKey = `${PREGEN_KIND_GENERAL_POOL}:${repNationId}`;
          const cooldownUntil = failureCooldown.get(cooldownKey);
          if (cooldownUntil !== undefined && cooldownUntil > Date.now()) {
            // 冷卻中：排自我喚醒後跳過該桶（旗標保留，其他工作照做）。
            rearmPregenWorkAt(cooldownUntil);
            continue;
          }
          // 二次確認仍然閒置。
          const fresh = getAiQueueStats();
          if (fresh.active > 0 || fresh.queued > 0) return;
          try {
            const made = await runWithAiPriority(AI_PRIORITY_PREGEN, () =>
              topUpGeneralPool({
                eraSlug: currentEra,
                cultureProfile: profile,
                targetPerBucket: GENERAL_POOL_TARGET_PER_BUCKET,
              }),
            );
            if (made) {
              noteGameActivity();
              logger.info(
                { eraSlug: currentEra, cultureProfile: profile },
                "ai pregen: general pool topped up",
              );
              // 一個 tick 只生成一張；旗標保留，下個 tick 補下一桶。
              return;
            }
          } catch (err) {
            failureCooldown.set(cooldownKey, Date.now() + FAILURE_COOLDOWN_MS);
            logger.error(
              { err, eraSlug: currentEra, cultureProfile: profile },
              "ai pregen: general pool top-up failed (cooldown)",
            );
            return;
          }
        }
      }
    }

    // 每種類的下次結算時間（fiscal = 財政排程；politics = 下次回合時段）。
    const fiscalNext = state[0]?.financeNextRunAt ?? null;
    const nowMs = now.getTime();
    // 「現在」是否落在某種類結算前 20 分鐘的鎖定窗內。
    const lockedKinds = new Set<string>();
    let earliestWindowEnd: number | null = null;
    for (const [kind, nextSettle] of [
      [PREGEN_KIND_FISCAL, fiscalNext],
      [PREGEN_KIND_POLITICS, nextTurnAt],
    ] as Array<[string, Date | null]>) {
      if (nextSettle === null) continue; // 結算時間未知 → 不鎖定，靠下方保守跳過
      if (nowMs >= nextSettle.getTime() - STOP_BEFORE_SETTLEMENT_MS) {
        lockedKinds.add(kind);
        const end = nextSettle.getTime() + 60_000; // 結算跑完的寬限
        if (earliestWindowEnd === null || end < earliestWindowEnd) {
          earliestWindowEnd = end;
        }
      }
    }

    let sawCooldown = false;
    let earliestCooldownEnd: number | null = null;
    let sawUnknownSettle = false;

    for (const cand of candidates) {
      const key = `${cand.kind}:${cand.nationId}`;
      const cached = cacheByKey.get(key);
      const cooldownUntil = failureCooldown.get(key);
      if (cooldownUntil !== undefined && cooldownUntil > nowMs) {
        sawCooldown = true;
        if (earliestCooldownEnd === null || cooldownUntil < earliestCooldownEnd) {
          earliestCooldownEnd = cooldownUntil;
        }
        continue;
      }

      const nextSettle =
        cand.kind === PREGEN_KIND_FISCAL ? fiscalNext : nextTurnAt;
      // 下次結算時間未知（財政從未排程過 = 隨時會跑）→ 保守不預產。
      if (nextSettle === null) {
        sawUnknownSettle = true;
        continue;
      }
      // 「結算前 20 分鐘」規則（現在時間判斷）：整個鎖定窗內不預產。
      if (lockedKinds.has(cand.kind)) continue;

      // 二次確認仍然閒置（build/載入期間可能有玩家呼叫進來）。
      const fresh = getAiQueueStats();
      if (fresh.active > 0 || fresh.queued > 0) return;

      try {
        const { hash, run } = await cand.build();
        // build 完比對：雜湊與快取相同 = 已預產過（無論表上 input_hash 新舊）。
        if (cached && cached.inputHash === hash) continue;
        const result = await runWithAiPriority(AI_PRIORITY_PREGEN, run);
        await storePregenResult(cand.kind, cand.nationId, hash, result);
        noteGameActivity();
        logger.info(
          { kind: cand.kind, nationId: cand.nationId },
          "ai pregen: cached judgement",
        );
      } catch (err) {
        failureCooldown.set(key, Date.now() + FAILURE_COOLDOWN_MS);
        sawCooldown = true;
        if (earliestCooldownEnd === null ||
            Date.now() + FAILURE_COOLDOWN_MS < earliestCooldownEnd) {
          earliestCooldownEnd = Date.now() + FAILURE_COOLDOWN_MS;
        }
        logger.error(
          { err, kind: cand.kind, nationId: cand.nationId },
          "ai pregen: generation failed (cooldown)",
        );
      }
      // 一個 tick 只做一件（成功或失敗都是）：旗標保留，下個 tick 再看
      // （成功 → 下一件還等著；失敗 → 冷卻已排 rearm）。
      return;
    }

    // 走完整輪都沒有生成：各種「暫時不能做」的原因都排好自我喚醒，
    // 其餘候選都是「已預產且雜湊相符」→ 清旗標，零成本待命。
    if (earliestCooldownEnd !== null) rearmPregenWorkAt(earliestCooldownEnd);
    if (earliestWindowEnd !== null) rearmPregenWorkAt(earliestWindowEnd);
    // 財政從未排程（finance_next_run_at NULL）＝結算迴圈尚未首次認領，
    // 幾分鐘內就會補上；不用 30 秒輪詢，5 分鐘後再看一次即可。
    if (sawUnknownSettle) rearmPregenWorkAt(Date.now() + 5 * 60_000);
    workPending = false;
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
