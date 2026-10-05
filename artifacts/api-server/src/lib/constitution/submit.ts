/**
 * 憲法送審與審查流程(DB + AI 編排)。規則在 core.ts / review.ts;這裡只負責:
 *  - 原子送審(狀態 draft→reviewing + 冷卻戳記 + 扣款,同一交易);
 *  - 背景跑 AI 品質審查 → 各黨投票 → 結果落庫;
 *  - AI 失敗一律「中止、退費、回到草稿」,絕不自動放行也不自動退回;
 *  - 卡死回收:伺服器重啟讓背景任務消失時,逾時的 reviewing 會被退費並恢復成草稿。
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  db, constitutionsTable, parliamentStateTable, parliamentPartiesTable, playerNationsTable, parliamentLogTable,
} from "@workspace/db";
import { callGameAi } from "../gameAi";
import { logger } from "../logger";
import { STANCE_LABELS, clampSat, type ParliamentStance } from "../parliament/core";
import {
  canSubmit, validateSubmission, tallyVotes, SUBMIT_COST_MONEY,
  type ReviewRecord, type ConstitutionStatus,
} from "./core";
import {
  QUALITY_SYSTEM, VOTE_SYSTEM, FLAW_SYSTEM, buildQualityPrompt, buildVotePrompt, buildFlawPrompt,
  parseQualityReview, parseVotes, parseFlaws, toPartyVotes, qualityPasses, clampForAi,
  type NationBrief, type PartyBrief,
} from "./review";
import { loadConstitution, statusOf, currentParliamentTick } from "./service";

/** 審議超過這麼久還沒結果,視為背景任務已死(重啟/當機),回收並退費。 */
export const REVIEW_STALE_MS = 10 * 60 * 1000;
/** 通過憲法對議會滿意度的獎勵(一次性);被退回/否決不罰,免得雙重懲罰。 */
export const RATIFY_SATISFACTION_BONUS = 10;

export type SubmitResult =
  | { ok: true }
  | { ok: false; code: 400 | 402 | 409 | 429; error: string };

type AiCaller = (feature: "constitution.quality" | "constitution.vote" | "constitution.flaws", system: string, user: string) => Promise<string>;

const defaultAi: AiCaller = async (feature, system, user) => {
  const tier = feature === "constitution.vote" ? "bulk" : "quality";
  const msg = await callGameAi(feature, tier, { system, messages: [{ role: "user", content: user }] });
  const block = msg.content[0];
  return block && block.type === "text" ? block.text : "";
};

let aiCaller: AiCaller = defaultAi;
/** 測試注入;傳 null 還原。 */
export function setConstitutionAiForTest(fn: AiCaller | null): void { aiCaller = fn ?? defaultAi; }

/** 背景排程器:預設直接非同步跑;測試可換成同步等待。 */
let runner: (job: () => Promise<void>) => void = (job) => {
  void job().catch((err) => logger.error({ err }, "constitution review job crashed"));
};
export function setConstitutionRunnerForTest(fn: ((job: () => Promise<void>) => void) | null): void {
  runner = fn ?? ((job) => { void job().catch((err) => logger.error({ err }, "constitution review job crashed")); });
}

/** 退費並把 reviewing 還原成 draft(AI 失敗/卡死時用)。只動仍在 reviewing 的列,冪等。 */
async function abortReview(nationId: string, reason: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const back = await tx.update(constitutionsTable)
      .set({ status: "draft", reviewStartedAt: null, lastSubmitTick: null })
      .where(and(eq(constitutionsTable.nationId, nationId), eq(constitutionsTable.status, "reviewing")))
      .returning({ n: constitutionsTable.nationId });
    if (back.length === 0) return false; // 已被別人處理(完成或已回收),不重複退費
    await tx.update(playerNationsTable)
      .set({ money: sql`${playerNationsTable.money} + ${SUBMIT_COST_MONEY}` })
      .where(eq(playerNationsTable.id, nationId));
    await tx.update(constitutionsTable)
      .set({ submissions: sql`GREATEST(0, ${constitutionsTable.submissions} - 1)` })
      .where(eq(constitutionsTable.nationId, nationId));
    logger.warn({ nationId, reason }, "constitution review aborted, refunded");
    return true;
  });
}

/** 回收卡死的審議(回合結算或讀取時呼叫皆可)。回傳回收數量。 */
export async function recoverStaleReviews(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REVIEW_STALE_MS);
  const stale = await db.select({ nationId: constitutionsTable.nationId }).from(constitutionsTable)
    .where(and(eq(constitutionsTable.status, "reviewing"), lt(constitutionsTable.reviewStartedAt, cutoff)));
  let n = 0;
  for (const s of stale) if (await abortReview(s.nationId, "stale")) n++;
  return n;
}

async function nationBrief(nationId: string, governmentLabel: string | null, stability: number): Promise<NationBrief> {
  const ps = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  const parties: PartyBrief[] = ps
    .filter((p) => p.seats > 0)
    .map((p) => ({
      name: p.name, stanceLabel: STANCE_LABELS[p.stance as ParliamentStance] ?? p.stance,
      description: p.description, seats: p.seats, isRuling: p.isRuling,
    }));
  return { governmentLabel: governmentLabel ?? "未知", stability, parties };
}

/**
 * 玩家送審。同步部分只做:驗證 + 原子鎖定 + 扣款,然後把 AI 審查丟到背景,立刻回傳。
 * 並發雙擊:UPDATE 的 WHERE 要求 status='draft',只有一個請求能把它改成 reviewing。
 */
export async function submitConstitution(nationId: string): Promise<SubmitResult> {
  const row = await loadConstitution(nationId);
  const status: ConstitutionStatus = statusOf(row);
  const tick = await currentParliamentTick(nationId);
  const gate = canSubmit(status, tick, row?.lastSubmitTick ?? null);
  if (!gate.ok) return { ok: false, code: status === "none" ? 400 : 409, error: gate.error };

  const text = row!.draftText;
  const sv = validateSubmission(text);
  if (!sv.ok) return { ok: false, code: 400, error: sv.error };

  const outcome = await db.transaction(async (tx) => {
    const claimed = await tx.update(constitutionsTable)
      .set({
        status: "reviewing", reviewStartedAt: new Date(), lastSubmitTick: tick,
        submissions: sql`${constitutionsTable.submissions} + 1`,
      })
      .where(and(eq(constitutionsTable.nationId, nationId), eq(constitutionsTable.status, "draft")))
      .returning({ n: constitutionsTable.nationId });
    if (claimed.length === 0) return "race" as const;
    const paid = await tx.update(playerNationsTable)
      .set({ money: sql`${playerNationsTable.money} - ${SUBMIT_COST_MONEY}` })
      .where(and(eq(playerNationsTable.id, nationId), gte(playerNationsTable.money, SUBMIT_COST_MONEY)))
      .returning({ id: playerNationsTable.id });
    if (paid.length === 0) { tx.rollback(); }
    return "ok" as const;
  }).catch((e) => (e && (e as Error).message?.includes("Rollback") ? ("broke" as const) : Promise.reject(e)));

  if (outcome === "race") return { ok: false, code: 409, error: "憲法已在審議中" };
  if (outcome === "broke") return { ok: false, code: 402, error: `國庫不足，送審需要 ${SUBMIT_COST_MONEY} 金錢` };

  runner(() => runReview(nationId, text, tick));
  return { ok: true };
}

/** 把審查結果落庫。只有仍在 reviewing 的列會被更新(被回收/重複完成都不會覆蓋)。 */
async function finishReview(
  nationId: string, record: ReviewRecord, patch: { status: "draft" | "ratified"; finalText?: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const set: Record<string, unknown> = { status: patch.status, reviewStartedAt: null, lastReview: record };
    if (patch.status === "ratified") {
      set["finalText"] = patch.finalText;
      set["ratifiedTick"] = record.reviewedTick;
      set["ratifiedAt"] = new Date();
    }
    const done = await tx.update(constitutionsTable).set(set as any)
      .where(and(eq(constitutionsTable.nationId, nationId), eq(constitutionsTable.status, "reviewing")))
      .returning({ n: constitutionsTable.nationId });
    if (done.length === 0) return false;

    const label = record.outcome === "ratified" ? "憲法通過" : record.outcome === "rejected_vote" ? "憲法遭否決" : "憲法被退回";
    const summary = record.outcome === "rejected_quality"
      ? `${label}:品質 ${record.qualityScore} 分,未達標準。${record.feedback}`
      : `${label}:贊成 ${record.yesSeats}/${record.totalSeats} 席(需過半)。`;
    let satDelta = 0;
    if (record.outcome === "ratified") {
      const [st] = await tx.select({ s: parliamentStateTable.satisfaction }).from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
      if (st) {
        const next = clampSat(st.s + RATIFY_SATISFACTION_BONUS);
        satDelta = next - st.s;
        await tx.update(parliamentStateTable).set({ satisfaction: next }).where(eq(parliamentStateTable.nationId, nationId));
      }
    }
    await tx.insert(parliamentLogTable).values({
      nationId, tick: record.reviewedTick, kind: "constitution", summary, satDelta,
    });
    return true;
  });
}

/** 背景審查。任何例外/AI 不合格輸出都走 abortReview(退費+回草稿)。 */
export async function runReview(nationId: string, rawText: string, tick: number): Promise<void> {
  try {
    const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
    if (!nation) { await abortReview(nationId, "nation_missing"); return; }
    const brief = await nationBrief(nationId, nation.government, nation.stability);
    const text = clampForAi(rawText);

    // ── 1. 品質審查 ─────────────────────────────────────────
    const qRaw = await aiCaller("constitution.quality", QUALITY_SYSTEM, buildQualityPrompt(text, brief));
    const quality = parseQualityReview(qRaw);
    if (!quality) { await abortReview(nationId, "quality_unparsable"); return; }

    const totalSeats = brief.parties.reduce((a, p) => a + p.seats, 0);
    if (!qualityPasses(quality.score)) {
      await finishReview(nationId, {
        outcome: "rejected_quality", qualityScore: quality.score, feedback: quality.feedback, flaws: quality.flaws,
        votes: [], yesSeats: 0, totalSeats, source: "ai", reviewedTick: tick,
      }, { status: "draft" });
      return;
    }

    // ── 2. 政黨投票 ─────────────────────────────────────────
    if (brief.parties.length === 0) { await abortReview(nationId, "no_parties"); return; }
    const vRaw = await aiCaller("constitution.vote", VOTE_SYSTEM, buildVotePrompt(text, brief));
    const parsed = parseVotes(vRaw, brief.parties);
    if (!parsed) { await abortReview(nationId, "votes_unparsable"); return; }
    const votes = toPartyVotes(parsed, brief.parties);
    const tally = tallyVotes(votes, totalSeats);

    const record: ReviewRecord = {
      outcome: tally.passed ? "ratified" : "rejected_vote",
      qualityScore: quality.score, feedback: quality.feedback, flaws: quality.flaws,
      votes, yesSeats: tally.yesSeats, totalSeats, source: "ai", reviewedTick: tick,
    };
    const landed = await finishReview(nationId, record, tally.passed ? { status: "ratified", finalText: rawText } : { status: "draft" });
    // 憲法已經通過並鎖定:漏洞掃描失敗不能反悔,只是留待之後補掃。
    if (landed && tally.passed) await scanFlaws(nationId).catch((err) => logger.warn({ err, nationId }, "constitution flaw scan failed, will retry"));
  } catch (err) {
    logger.error({ err, nationId }, "constitution review failed");
    await abortReview(nationId, "exception").catch((e) => logger.error({ e }, "constitution abort failed"));
  }
}



/**
 * 掃描已通過憲法的漏洞並存檔。冪等:已經有漏洞清單的不重掃(避免重複花 AI、避免覆蓋已觸發紀錄)。
 * 回傳是否寫入了新清單。失敗(AI 掛掉/格式錯誤)回傳 false,憲法本身不受影響,下次結算會重試。
 */
export async function scanFlaws(nationId: string): Promise<boolean> {
  const row = await loadConstitution(nationId);
  if (!row || row.status !== "ratified" || !row.finalText) return false;
  const existing = row.flaws as unknown[] | null;
  if (Array.isArray(existing) && existing.length > 0) return false;

  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  if (!nation) return false;
  const brief = await nationBrief(nationId, nation.government, nation.stability);
  const raw = await aiCaller("constitution.flaws", FLAW_SYSTEM, buildFlawPrompt(clampForAi(row.finalText), brief));
  const flaws = parseFlaws(raw);
  if (!flaws) { logger.warn({ nationId }, "constitution flaw scan: unparsable output"); return false; }

  // 條件更新:只有「還沒有漏洞清單」才寫入,並發的第二次掃描不會覆蓋第一次。
  const done = await db.update(constitutionsTable).set({ flaws })
    .where(and(
      eq(constitutionsTable.nationId, nationId), eq(constitutionsTable.status, "ratified"),
      sql`(${constitutionsTable.flaws} IS NULL OR jsonb_array_length(${constitutionsTable.flaws}) = 0)`,
    )).returning({ n: constitutionsTable.nationId });
  return done.length > 0;
}
