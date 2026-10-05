import { Router, type IRouter } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db, playerNationsTable, parliamentStateTable, parliamentPartiesTable, parliamentLogTable,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { logger } from "../lib/logger";
import { tierOfNation, ensureParliamentSeeded } from "../lib/parliament/service";
import {
  STANCE_LABELS, canSubmitReport, parliamentAlert, reportBonus, clampSat,
  MAX_PENALTY, DEMAND_INTERVAL_TURNS, effectiveParliamentTier, type ParliamentStance,
} from "../lib/parliament/core";
import {
  validateReportText, reportCooldownLeft, REPORT_COST_MONEY, REPORT_COOLDOWN_TICKS,
} from "../lib/parliament/reportCore";
import { scoreReport } from "../lib/parliament/report";

const router: IRouter = Router();

async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
) {
  const session = await getSession(readSessionToken(req));
  if (!session) { res.status(401).json({ error: "尚未登入 Discord" }); return null; }
  const [nation] = await db.select().from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, session.discordUserId)).limit(1);
  if (!nation) { res.status(400).json({ error: "尚未建國,請先在首頁建立你的國家" }); return null; }
  return { nation };
}

const TIER_LABEL = { autocracy: "專制(橡皮圖章議會)", semi: "半專制", democracy: "民主" } as const;

async function buildView(nationId: string, govLabel: string | null) {
  const [state] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  const parties = await db.select().from(parliamentPartiesTable)
    .where(eq(parliamentPartiesTable.nationId, nationId)).orderBy(desc(parliamentPartiesTable.seats), parliamentPartiesTable.id);
  const log = await db.select().from(parliamentLogTable)
    .where(eq(parliamentLogTable.nationId, nationId)).orderBy(desc(parliamentLogTable.id)).limit(20);
  const { tier: baseTier } = await tierOfNation({ government: govLabel });
  // 專制下若議會被事件改成非忠誠黨過半,橡皮圖章失效,以半專制規則問政
  const tier = effectiveParliamentTier(baseTier, parties.map((p) => ({ stance: p.stance as ParliamentStance, seats: p.seats })));
  const awakened = baseTier === "autocracy" && tier !== "autocracy";
  const sat = state?.satisfaction ?? 60;
  const demand = (state?.activeDemand ?? null) as { stance: string; text: string; issuedTick: number; levels: string[] } | null;
  const tick = state?.tick ?? 0;
  return {
    ready: !!state,
    tier, tierLabel: awakened ? "專制(議會已不再是橡皮圖章)" : TIER_LABEL[tier],
    satisfaction: sat, alert: parliamentAlert(sat),
    totalSeats: 100,
    parties: parties.map((p) => ({
      id: p.id, name: p.name, stance: p.stance, stanceLabel: STANCE_LABELS[p.stance as ParliamentStance] ?? p.stance,
      seats: p.seats, color: p.color, isRuling: p.isRuling,
    })),
    /** 議會對玩家說的兩種內容 */
    protest: state?.protestText ?? "",
    demand: demand ? {
      text: demand.text, stance: demand.stance,
      stanceLabel: STANCE_LABELS[demand.stance as ParliamentStance] ?? demand.stance,
      turnsElapsed: demand.levels.length, turnsTotal: DEMAND_INTERVAL_TURNS, levels: demand.levels,
    } : null,
    maxPenalty: MAX_PENALTY[tier],
    report: {
      allowed: canSubmitReport(tier),
      cooldownLeft: reportCooldownLeft(tick, state?.lastReportTick ?? null),
      cooldownTicks: REPORT_COOLDOWN_TICKS,
      cost: REPORT_COST_MONEY,
      lastFeedback: state?.lastReportFeedback ?? "",
    },
    log: log.map((l) => ({ id: l.id, tick: l.tick, kind: l.kind, summary: l.summary, satDelta: l.satDelta, createdAt: l.createdAt.toISOString() })),
  };
}

router.get("/parliament", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  try {
    // 新建國後議會黨要等下一個回合結算才會建立;沒有政黨時當場補建,避免議會頁顯示 0 席。
    await ensureParliamentSeeded(auth.nation).catch((err) => logger.warn({ err, nationId: auth.nation.id }, "parliament: lazy seed failed"));
    res.json(await buildView(auth.nation.id, auth.nation.government));
  }
  catch (err) { logger.error({ err }, "parliament view failed"); res.status(500).json({ error: "讀取議會失敗" }); }
});

router.post("/parliament/report", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  const { nation } = auth;
  try {
    const { tier: baseTier } = await tierOfNation(nation);
    const seats = await db.select({ stance: parliamentPartiesTable.stance, seats: parliamentPartiesTable.seats })
      .from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
    const tier = effectiveParliamentTier(baseTier, seats.map((p) => ({ stance: p.stance as ParliamentStance, seats: p.seats })));
    if (!canSubmitReport(tier)) { res.status(403).json({ error: "專制政體的議會只是橡皮圖章,不需要國情報告" }); return; }
    const v = validateReportText((req.body ?? {}).text);
    if (!v.ok) { res.status(400).json({ error: v.error }); return; }

    const [state] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nation.id));
    if (!state) { res.status(409).json({ error: "議會尚未成立,請等下一回合結算後再試" }); return; }
    const left = reportCooldownLeft(state.tick, state.lastReportTick);
    if (left > 0) { res.status(429).json({ error: `國情報告冷卻中,還需 ${left} 個議會回合` }); return; }

    // 原子鎖定:同時扣錢 + 蓋冷卻戳記。並發雙擊時只有一個請求的條件更新會命中。
    const claimed = await db.transaction(async (tx) => {
      const stamp = await tx.update(parliamentStateTable)
        .set({ lastReportTick: state.tick })
        .where(and(
          eq(parliamentStateTable.nationId, nation.id),
          // 樂觀鎖:冷卻戳記必須仍等於剛讀到的值;並發的第二個請求會因戳記已變而落空。
          sql`${parliamentStateTable.lastReportTick} IS NOT DISTINCT FROM ${state.lastReportTick}`,
        )).returning({ n: parliamentStateTable.nationId });
      if (stamp.length === 0) return "race" as const;
      const paid = await tx.update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${REPORT_COST_MONEY}` })
        .where(and(eq(playerNationsTable.id, nation.id), gte(playerNationsTable.money, REPORT_COST_MONEY)))
        .returning({ id: playerNationsTable.id });
      if (paid.length === 0) { tx.rollback(); }
      return "ok" as const;
    }).catch((e) => (e && (e as Error).message?.includes("Rollback") ? ("broke" as const) : Promise.reject(e)));
    if (claimed === "race") { res.status(409).json({ error: "你剛剛已提交過國情報告" }); return; }
    if (claimed === "broke") { res.status(402).json({ error: `國庫不足,國情報告需要 ${REPORT_COST_MONEY} 金錢` }); return; }

    const parties = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
    const demand = (state.activeDemand ?? null) as { text: string } | null;
    const result = await scoreReport(v.text, {
      nationName: nation.name ?? "本國", governmentLabel: nation.government ?? "未知", stability: nation.stability,
      atWar: false, protest: state.protestText, demand: demand?.text ?? null,
      partyLines: parties.map((p) => `${p.name}${p.seats}席(${STANCE_LABELS[p.stance as ParliamentStance] ?? p.stance})`),
    });
    const delta = reportBonus(result.score, state.satisfaction);
    const newSat = clampSat(state.satisfaction + delta);
    await db.transaction(async (tx) => {
      await tx.update(parliamentStateTable)
        .set({ satisfaction: newSat, lastReportFeedback: result.feedback })
        .where(eq(parliamentStateTable.nationId, nation.id));
      await tx.insert(parliamentLogTable).values({
        nationId: nation.id, tick: state.tick, kind: "report",
        summary: `國情報告評分 ${result.score}(${result.source === "ai" ? "AI" : "備援"}):${result.feedback}`, satDelta: delta,
      });
    });
    res.json({ score: result.score, delta, feedback: result.feedback, source: result.source, view: await buildView(nation.id, nation.government) });
  } catch (err) {
    logger.error({ err, nationId: nation.id }, "parliament report failed");
    res.status(500).json({ error: "國情報告處理失敗" });
  }
});

export default router;
