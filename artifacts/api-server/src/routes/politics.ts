import { notePregenWork } from "../lib/aiPregenWorker";
import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  politicsEntriesTable,
  politicsHistoryTable,
  politicsPendingDecisionsTable,
  politicsPendingIdeasTable,
  type PlayerNation,
  type PoliticsEntry,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { logger } from "../lib/logger";
import { requireAdmin } from "../middlewares/requireAdmin";
import {
  DEFAULT_POLITICS_SETTINGS,
  DIRECTION_LABELS,
  ENTRY_TYPE_LABELS,
  POLITICS_DIRECTIONS,
  SATISFACTION_LABELS,
  baseSatisfaction,
  computePoliticsState,
  effectiveMilitaryObedience,
  enabledPoliticsDirections,
  entryStrength,
  GENERAL_DIRECTION,
  isPoliticsDirection,
  politicsSettingsSchema,
  populationGrowthRatePct,
  scalePopulationGrowthRatePct,
  warWearinessAttackModifier,
  type PoliticsDirection,
} from "../lib/politics";
import {
  DEFAULT_GOVERNMENT_SLUG,
  governmentDecisionDifficulty,
  governmentLabel,
  governmentSlugByLabel,
} from "../lib/governments";
import {
  computeNationStats,
  getPopulationGrowthMultiplierPct,
  getStatsEraSlug,
} from "../lib/nationStats";
import { computeNationMilitaryAggregates } from "../lib/militarySnapshots";
import {
  armyPopulationRatioPct,
  militaryRiskLevel,
  MILITARY_OVERREACH_THRESHOLD_PCT,
  MILITARY_RISK_LABELS,
} from "../lib/militaryPolitics";
import { aggregateSocialEffectsForUser } from "../lib/socialTechData";
import { loadActiveSatisfactionBuffs } from "../lib/productionTechData";
import { ensurePoliticalNote } from "../lib/politicalNote";
import { getPoliticsSettings, savePoliticsSettings } from "../lib/politicsSettings";
import {
  applyPlayerGovernmentChange,
  runPoliticsSettlement,
} from "../lib/politicsSettlement";

const router: IRouter = Router();

/** 同 military.ts 的 requirePlayer（session → 已建國的 nation）。 */
async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{ nation: PlayerNation; userId: string } | null> {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return null;
  }
  const userId = session.discordUserId;
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!nation) {
    res.status(400).json({ error: "尚未建國，請先在玩家首頁建立或接手國家" });
    return null;
  }
  return { nation, userId };
}

function serializeEntry(entry: PoliticsEntry) {
  return {
    id: entry.id,
    direction: entry.direction,
    // 舊制方向條目顯示方向標籤；新制 general 條目為 null（以加減成標籤呈現影響）。
    directionLabel: isPoliticsDirection(entry.direction)
      ? DIRECTION_LABELS[entry.direction]
      : null,
    entryType: entry.entryType,
    entryTypeLabel:
      ENTRY_TYPE_LABELS[entry.entryType as keyof typeof ENTRY_TYPE_LABELS] ??
      entry.entryType,
    title: entry.title,
    description: entry.description,
    modifiers: entry.modifiers.map((m) => ({ target: m.target, value: m.value })),
    durationTurns: entry.durationTurns,
    remainingTurns: entry.remainingTurns,
    status: entry.status,
    /** 目前強度 0–1（變革／事件淡化中）。 */
    strength: entryStrength(entry),
    createdAt: entry.createdAt.toISOString(),
  };
}

/** 政治總覽：三數值＋四方向（滿意度、待判定想法、現行條目、歷史、加減成總和）。 */
router.get("/politics/overview", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  const [
    settings,
    entries,
    pendingIdeas,
    pendingDecisionRows,
    social,
    growthMultiplier,
    satisfactionBuffs,
  ] = await Promise.all([
    getPoliticsSettings(),
    db
      .select()
      .from(politicsEntriesTable)
      .where(eq(politicsEntriesTable.nationId, nation.id))
      .orderBy(desc(politicsEntriesTable.createdAt))
      .limit(200),
    db
      .select()
      .from(politicsPendingIdeasTable)
      .where(eq(politicsPendingIdeasTable.nationId, nation.id)),
    db
      .select()
      .from(politicsPendingDecisionsTable)
      .where(eq(politicsPendingDecisionsTable.nationId, nation.id))
      .limit(1),
    aggregateSocialEffectsForUser(userId),
    getPopulationGrowthMultiplierPct(),
    loadActiveSatisfactionBuffs(userId),
  ]);

  const activeEntries = entries.filter((e) => e.status === "active");
  const state = computePoliticsState(
    nation,
    activeEntries,
    settings,
    satisfactionBuffs,
  );

  // 社會關鍵科技解鎖旗標：宗教／權利滿意度、顧問槽、可改制政體清單。
  // 文化（工人）自 Task #521 起開局即啟用，不再看造紙術。
  const enabledDirs = new Set(
    enabledPoliticsDirections({
      religionEnabled: social.religionSatisfactionEnabled,
      rightsEnabled: social.rightsSatisfactionEnabled,
    }),
  );
  const unlockedGovernments = social.unlockedGovernments
    .map((slug) => ({ slug, label: governmentLabel(slug) }))
    .filter((g): g is { slug: string; label: string } => g.label !== null);

  const note = await ensurePoliticalNote(nation);
  const pendingDecision = pendingDecisionRows[0] ?? null;

  // Task #402 — 軍方面向：軍隊占人口比與風險等級（伺服器計算，非 AI）。
  const [militaryAggregates, statsEra] = await Promise.all([
    computeNationMilitaryAggregates(),
    getStatsEraSlug(),
  ]);
  const armyPopulation = militaryAggregates.get(nation.id)?.armyPopulation ?? 0;
  const nationStats = await computeNationStats(nation.id, statsEra);
  const militaryRatioPct = armyPopulationRatioPct(
    armyPopulation,
    nationStats.population,
  );
  // 有效服從度 = 基底 + militaryObedience 政策偏移（夾 0–100）。
  const effectiveObedience = effectiveMilitaryObedience(
    nation.militaryObedience,
    activeEntries,
  );
  const riskLevel = militaryRiskLevel(
    militaryRatioPct,
    state.satisfactions["military"] ?? nation.satisfactionMilitary,
    effectiveObedience,
  );

  res.json({
    // 顯示用：最多小數點第一位（內部計算保留完整精度供回合結算使用）。
    stability: Math.round(state.stability * 10) / 10,
    unrest: state.unrest,
    warWeariness: state.warWeariness,
    attackModifierPct: Math.round(
      warWearinessAttackModifier(state.warWeariness) * 100,
    ),
    stabilityBonusPct: Math.round((state.stabilityMult - 1) * 100),
    // 有效人口增長率（%／回合；基礎 + 加減成，夾 ±上限，再套全域人口增長倍率）。
    populationGrowthRatePct:
      Math.round(
        scalePopulationGrowthRatePct(
          populationGrowthRatePct(state.populationGrowthPct, settings),
          growthMultiplier,
        ) * 10,
      ) / 10,
    ideaMaxLength: settings.ideaMaxLength,
    // ── Task #127：政府治理系統 ──
    government: nation.government,
    politicalNote: note,
    politicalSupport: Math.round(nation.politicalSupport * 10) / 10,
    governmentChangeAcceptance:
      Math.round(nation.governmentChangeAcceptance * 10) / 10,
    // Task #584 — 政變後政策封鎖剩餘回合數（> 0 時前端鎖定政策／決策提交）。
    coupPolicyLockTurns: nation.coupPolicyLockTurns,
    decisionMaxLength: settings.decisionMaxLength,
    decisionDifficulty: governmentDecisionDifficulty(nation.government),
    pendingDecision: pendingDecision
      ? {
          id: pendingDecision.id,
          decision: pendingDecision.decision,
          createdAt: pendingDecision.createdAt.toISOString(),
        }
      : null,
    social: {
      // Task #521 — 工人滿意度開局即啟用，恆為 true（保留欄位相容前端）。
      cultureEnabled: true,
      religionEnabled: social.religionSatisfactionEnabled,
      rightsEnabled: social.rightsSatisfactionEnabled,
      advisorSlotEnabled: social.advisorSlotEnabled,
      unlockedGovernments,
    },
    // Task #393 — 全國唯一一筆待判定政策想法（新制 general 或舊制遺留列皆算）。
    pendingIdea: pendingIdeas[0]
      ? {
          id: pendingIdeas[0].id,
          idea: pendingIdeas[0].idea,
          createdAt: pendingIdeas[0].createdAt.toISOString(),
        }
      : null,
    // Task #393 — 統一條目清單（最新在前；現行與歷史由前端依 status 區分）。
    activeEntries: activeEntries.map(serializeEntry),
    history: entries.slice(0, 60).map(serializeEntry),
    directions: POLITICS_DIRECTIONS.map((dir) => {
      const totals = state.directionTotals[dir];
      return {
        direction: dir,
        label: DIRECTION_LABELS[dir],
        satisfactionLabel: SATISFACTION_LABELS[dir],
        // 宗教／權利滿意度需社會關鍵科技解鎖，未解鎖時前端灰化。
        enabled: enabledDirs.has(dir),
        satisfaction: Math.round(state.satisfactions[dir] * 10) / 10,
        baseSatisfaction: baseSatisfaction(nation, dir),
        totals: {
          satisfaction: Math.round(totals.satisfaction * 10) / 10,
          stability: Math.round(totals.stability * 10) / 10,
          production: Math.round(totals.production * 10) / 10,
          tech: Math.round(totals.tech * 10) / 10,
          populationGrowth: Math.round(totals.populationGrowth * 10) / 10,
        },
      };
    }),
    // Task #402 — 軍方面板資訊（顯示時才捨入至一位小數）。
    military: {
      obedience: Math.round(effectiveObedience * 10) / 10,
      armyPopulationRatioPct: Math.round(militaryRatioPct * 10) / 10,
      thresholdPct: MILITARY_OVERREACH_THRESHOLD_PCT,
      riskLevel,
      riskLabel: MILITARY_RISK_LABELS[riskLevel],
    },
  });
});

/** Task #393 — 送出政策想法（全國一筆待判定、不分方向，回合結算時 AI 綜合判定）。 */
router.post("/politics/ideas", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  // Task #584 — 政變後政策封鎖期間不可提交政策想法。
  if (nation.coupPolicyLockTurns > 0) {
    res.status(403).json({
      error: `政變後政局動盪，暫時無法提交政策想法（剩餘 ${nation.coupPolicyLockTurns} 回合）`,
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const idea = body["idea"];
  const settings = await getPoliticsSettings();
  if (typeof idea !== "string" || idea.trim().length === 0) {
    res.status(400).json({ error: "請輸入政策想法" });
    return;
  }
  const trimmed = idea.trim();
  if (trimmed.length > settings.ideaMaxLength) {
    res
      .status(400)
      .json({ error: `政策想法最長 ${settings.ideaMaxLength} 字` });
    return;
  }

  // 前置檢查：全國一筆待判定（含舊制多方向遺留列）。部分唯一索引只涵蓋
  // direction='general'（正式 DB 有舊制遺留列，全欄唯一索引在 Publish 建不起來），
  // 舊制列擋新提案要靠這裡；general 列的併發雙重送出仍由索引兜底（409）。
  const existing = await db
    .select({ id: politicsPendingIdeasTable.id })
    .from(politicsPendingIdeasTable)
    .where(eq(politicsPendingIdeasTable.nationId, nation.id))
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({
      error: "已有待判定的政策想法，請先撤回或等待回合結算",
    });
    return;
  }

  const inserted = await db
    .insert(politicsPendingIdeasTable)
    .values({ nationId: nation.id, direction: GENERAL_DIRECTION, idea: trimmed })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    res.status(409).json({
      error: "已有待判定的政策想法，請先撤回或等待回合結算",
    });
    return;
  }

  // 事件驅動預產：新想法進場 → 佇列閒置時背景預先判定。
  notePregenWork();
  req.log.info({ nationId: nation.id }, "politics idea submitted");
  res.json({ ok: true });
});

/** Task #393 — 撤回待判定政策想法（全國唯一一筆，含舊制遺留列）。 */
router.delete("/politics/ideas", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const deleted = await db
    .delete(politicsPendingIdeasTable)
    .where(eq(politicsPendingIdeasTable.nationId, nation.id))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "目前沒有待判定的政策想法" });
    return;
  }
  // 事件驅動預產：撤回後觸發孤兒快取清理。
  notePregenWork();
  res.json({ ok: true });
});

/** 廢除自己的政策／傳統（變革與事件會自行淡化，不可手動廢除）。 */
router.post("/politics/entries/:id/repeal", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const entryId = Number(req.params.id);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: "條目編號不正確" });
    return;
  }

  const [entry] = await db
    .select()
    .from(politicsEntriesTable)
    .where(
      and(
        eq(politicsEntriesTable.id, entryId),
        eq(politicsEntriesTable.nationId, nation.id),
      ),
    )
    .limit(1);
  if (!entry) {
    res.status(404).json({ error: "找不到這個條目" });
    return;
  }
  if (entry.status !== "active") {
    res.status(400).json({ error: "此條目已不在生效中" });
    return;
  }
  if (entry.entryType !== "policy" && entry.entryType !== "tradition") {
    res.status(400).json({ error: "只有政策與傳統可以廢除" });
    return;
  }

  await db
    .update(politicsEntriesTable)
    .set({ status: "repealed", updatedAt: new Date() })
    .where(eq(politicsEntriesTable.id, entryId));

  req.log.info({ nationId: nation.id, entryId }, "politics entry repealed");
  res.json({ ok: true });
});

/** 送出政府決策（每國一筆待判定，回合結算時 AI 依政體＋支持度＋註記判定）。 */
router.post("/politics/decision", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  // Task #584 — 政變後政策封鎖期間不可提交政府決策。
  if (nation.coupPolicyLockTurns > 0) {
    res.status(403).json({
      error: `政變後政局動盪，暫時無法提交政府決策（剩餘 ${nation.coupPolicyLockTurns} 回合）`,
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const decision = body["decision"];
  const settings = await getPoliticsSettings();
  if (typeof decision !== "string" || decision.trim().length === 0) {
    res.status(400).json({ error: "請輸入政府決策內容" });
    return;
  }
  const trimmed = decision.trim();
  if (trimmed.length > settings.decisionMaxLength) {
    res
      .status(400)
      .json({ error: `政府決策最長 ${settings.decisionMaxLength} 字` });
    return;
  }

  const inserted = await db
    .insert(politicsPendingDecisionsTable)
    .values({ nationId: nation.id, decision: trimmed })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    res.status(409).json({
      error: "已有待判定的政府決策，請先撤回或等待回合結算",
    });
    return;
  }

  req.log.info({ nationId: nation.id }, "government decision submitted");
  res.json({ ok: true });
});

/** 撤回待判定的政府決策。 */
router.delete("/politics/decision", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const deleted = await db
    .delete(politicsPendingDecisionsTable)
    .where(eq(politicsPendingDecisionsTable.nationId, nation.id))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "目前沒有待判定的政府決策" });
    return;
  }
  res.json({ ok: true });
});

/**
 * 主動政體變更（Task #127）：接受度達 100 且目標政體已由社會科技解鎖時，改為玩家
 * 指定的政體。決定性（無隨機），競態安全。
 */
router.post("/politics/government-change", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  if (nation.governmentChangeAcceptance < 100) {
    res.status(400).json({
      error: "政體變更接受度尚未達到 100，無法主動變更政體",
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = body["government"];
  if (typeof target !== "string" || target.trim().length === 0) {
    res.status(400).json({ error: "請選擇目標政體" });
    return;
  }
  const targetSlug = target.trim();

  const social = await aggregateSocialEffectsForUser(userId);
  if (!social.unlockedGovernments.includes(targetSlug)) {
    res.status(400).json({ error: "目標政體尚未由社會關鍵科技解鎖" });
    return;
  }
  const targetLabel = governmentLabel(targetSlug);
  if (!targetLabel) {
    res.status(400).json({ error: "目標政體不正確" });
    return;
  }
  if (targetSlug === governmentSlugByLabel(nation.government)) {
    res.status(400).json({ error: "目標政體與現行政體相同" });
    return;
  }

  const ok = await applyPlayerGovernmentChange(nation, targetLabel);
  if (!ok) {
    res.status(409).json({
      error: "政體變更條件已改變，請重新整理後再試",
    });
    return;
  }

  req.log.info(
    { nationId: nation.id, targetSlug },
    "player-initiated government change",
  );
  res.json({ ok: true });
});

/** 政治歷史（時間軸；最新在前，最多 100 筆）。 */
router.get("/politics/history", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const rows = await db
    .select()
    .from(politicsHistoryTable)
    .where(eq(politicsHistoryTable.nationId, nation.id))
    .orderBy(desc(politicsHistoryTable.createdAt))
    .limit(100);
  res.json({
    history: rows.map((h) => ({
      id: h.id,
      eventType: h.eventType,
      title: h.title,
      description: h.description,
      createdAt: h.createdAt.toISOString(),
    })),
  });
});

// ── 管理端（requireAdmin raw-fetch，不進 OpenAPI spec） ──────────

/** 讀取內政參數（合併預設值後的完整設定），並附上目前程式預設值供比對／還原。 */
router.get("/politics/settings", requireAdmin, async (_req, res) => {
  res.json({
    settings: await getPoliticsSettings(),
    defaults: DEFAULT_POLITICS_SETTINGS,
  });
});

/** 全量更新內政參數（zod 驗證，超界一律 400，不靜默丟棄）。 */
router.put("/politics/settings", requireAdmin, async (req, res) => {
  const parsed = politicsSettingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({
      error: `參數不正確：${first?.path.join(".") ?? ""} ${first?.message ?? ""}`.trim(),
    });
    return;
  }
  await savePoliticsSettings(parsed.data);
  req.log.info("politics settings updated");
  res.json({ settings: parsed.data });
});

/**
 * 手動觸發內政回合結算。回合引擎（Task #32）尚未建置，
 * 建成後改由回合結算流程直接呼叫 runPoliticsSettlement()。
 */
router.post("/politics/settle", requireAdmin, async (req, res) => {
  try {
    const summary = await runPoliticsSettlement();
    res.json({ ok: true, summary });
  } catch (err) {
    req.log.error({ err }, "manual politics settlement failed");
    const message =
      err instanceof Error && err.message.includes("進行中")
        ? err.message
        : "內政回合結算失敗，請查看伺服器記錄";
    res.status(err instanceof Error && err.message.includes("進行中") ? 409 : 500)
      .json({ error: message });
  }
});

export default router;
