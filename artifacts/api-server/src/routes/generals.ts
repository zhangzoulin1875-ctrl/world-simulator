import { Router, type IRouter } from "express";
import { asc, eq, sql } from "drizzle-orm";
import {
  db,
  generalsTable,
  generalDrawsTable,
  playerNationsTable,
  warCampaignLegionsTable,
  warCampaignsTable,
  type General,
  type PlayerNation,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { aiRateLimit } from "../middlewares/aiRateLimit";
import { computeAdjustedNationStats, getEraSlugs } from "../lib/nationStats";
import {
  computeAvailableProduction,
} from "../lib/economy";
import { loadCurrentTurnRecruitSpend } from "../lib/recruitSpend";
import {
  categoryLabel,
  isMilitaryCategory,
  MILITARY_CATEGORIES,
  type MilitaryCategory,
} from "../lib/military";
import { logger } from "../lib/logger";
import {
  GENERAL_CAP_RECRUITED,
  GENERAL_MAX_GRADE,
  drawCost,
  upgradeCost,
  upgradeSuccessPct,
  generalCombatMods,
} from "../lib/generals";
import {
  buildFallbackGeneralCard,
  generateGeneralCard,
  loadDominantCultureProfile,
  takeGeneralFromPool,
} from "../lib/generalAi";
import { callGameAi } from "../lib/gameAi";
import { notePregenWork } from "../lib/aiPregenWorker";
import { z } from "zod";

const router: IRouter = Router();

/** Error that maps to an HTTP status inside a transaction (throw → rollback). */
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

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

/** 當回合述詞：last_turn_at 為 NULL（從未跑回合）時全部視為當回合。 */
const CURRENT_TURN_PREDICATE = sql`(
  (SELECT last_turn_at FROM world_game_state WHERE id = 1) IS NULL
  OR ${generalDrawsTable.createdAt} >
     (SELECT last_turn_at FROM world_game_state WHERE id = 1)
)`;

interface CostSnapshot {
  money: number;
  production: number;
  availableProduction: number;
}

async function costSnapshot(nation: PlayerNation): Promise<CostSnapshot> {
  const { statsEra } = await getEraSlugs();
  const stats = await computeAdjustedNationStats(nation, statsEra);
  const currentTurnSpend = await loadCurrentTurnRecruitSpend(nation.id);
  const availableProduction = computeAvailableProduction({
    production: stats.production,
    productionSpent: nation.productionSpent,
    currentTurnSpend,
  });
  const cost = drawCost(nation.money, availableProduction);
  return { money: cost.money, production: cost.production, availableProduction };
}

/** 序列化（前端卡面）。 */
function serializeGeneral(g: General) {
  return {
    id: g.id,
    name: g.name,
    title: g.title,
    background: g.background,
    category: g.category,
    categoryLabel: categoryLabel(
      isMilitaryCategory(g.category) ? g.category : "infantry",
      g.eraSlug,
    ),
    grade: g.grade,
    status: g.status,
    skills: g.skills ?? [],
    eraSlug: g.eraSlug,
    assignedLegionId: g.assignedLegionId,
    upgradeNarrative: g.upgradeNarrative ?? null,
    combatMods: generalCombatMods({ grade: g.grade, skills: g.skills ?? [] }),
  };
}

/** 該國本回合已抽了嗎（quota：一回合一張）。 */
async function hasDrawnThisTurn(nationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: generalDrawsTable.id })
    .from(generalDrawsTable)
    .where(
      sql`${eq(generalDrawsTable.ownerNationId, nationId)} AND ${eq(
        generalDrawsTable.kind,
        "draw",
      )} AND ${CURRENT_TURN_PREDICATE}`,
    )
    .limit(1);
  return row !== undefined;
}

/** 可指派軍團選項：該國參與中戰役的所有軍團（含已坐鎮武將 id）。 */
async function assignmentOptions(nationId: string) {
  const rows = await db
    .select({
      legionId: warCampaignLegionsTable.id,
      campaignId: warCampaignLegionsTable.campaignId,
      slot: warCampaignLegionsTable.slot,
      generalId: generalsTable.id,
      generalName: generalsTable.name,
    })
    .from(warCampaignLegionsTable)
    .innerJoin(
      warCampaignsTable,
      eq(warCampaignsTable.id, warCampaignLegionsTable.campaignId),
    )
    .leftJoin(
      generalsTable,
      eq(generalsTable.assignedLegionId, warCampaignLegionsTable.id),
    )
    .where(
      sql`${eq(warCampaignLegionsTable.nationId, nationId)} AND ${eq(
        warCampaignsTable.status,
        "active",
      )}`,
    );
  return rows.map((r) => ({
    legionId: r.legionId,
    campaignId: r.campaignId,
    slot: r.slot,
    assignedGeneralId: r.generalId,
    assignedGeneralName: r.generalName,
  }));
}

/** GET /military/generals — 武將列表 + 配額/成本/指派資訊。 */
router.get("/military/generals", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  try {
    const [rows, cost, drawn, options] = await Promise.all([
      db
        .select()
        .from(generalsTable)
        .where(
          sql`${eq(generalsTable.ownerNationId, nation.id)} AND ${sql`${generalsTable.status} <> 'dismissed'`}`,
        )
        .orderBy(asc(generalsTable.id)),
      costSnapshot(nation),
      hasDrawnThisTurn(nation.id),
      assignmentOptions(nation.id),
    ]);
    const recruited = rows.filter((r) => r.status === "recruited").length;
    res.json({
      generals: rows.map(serializeGeneral),
      quota: {
        cap: GENERAL_CAP_RECRUITED,
        recruited,
        candidates: rows.filter(
          (r) => r.status === "candidate" || r.status === "generating",
        ).length,
        drawnThisTurn: drawn,
      },
      costs: {
        drawMoney: cost.money,
        drawProduction: cost.production,
      },
      assignmentOptions: options,
    });
  } catch (err) {
    logger.error({ err }, "GET /military/generals failed");
    res.status(500).json({ error: "無法載入武將資料" });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 背景生成（池空時用）：先把 placeholder 列（status=generating）回應給前端，
 * HTTP 請求不等待 AI；之後在背景重試幾輪，完成後把同一列改成候選卡。
 * 玩家切換頁面／分頁不會中斷——生成狀態完全在伺服器，下次輪詢就看到結果。
 * 全部重試仍失敗時落地保底卡（非 AI），確保已付出的抽取成本一定換到武將、
 * 不會卡在「生成中」。WHERE status='generating' 防止與遣返競態（玩家若已
 * 遣返這張候選，背景結果到達時會是 0 筆更新，直接放棄）。
 */
function startBackgroundGeneralGeneration(params: {
  generalId: number;
  eraSlug: string;
  category: MilitaryCategory;
  cultureProfile: string;
}): void {
  const { generalId, eraSlug, category, cultureProfile } = params;
  void (async () => {
    const retryDelaysMs = [0, 5_000, 15_000, 45_000];
    for (let i = 0; i < retryDelaysMs.length; i++) {
      if (retryDelaysMs[i]! > 0) await sleep(retryDelaysMs[i]!);
      try {
        const card = await generateGeneralCard({
          eraSlug,
          category,
          cultureProfile,
          attempts: 2,
        });
        const updated = await db
          .update(generalsTable)
          .set({
            name: card.name,
            title: card.title,
            background: card.background,
            skills: card.skills,
            status: "candidate",
          })
          .where(
            sql`${eq(generalsTable.id, generalId)} AND ${eq(
              generalsTable.status,
              "generating",
            )}`,
          )
          .returning();
        if (updated.length === 0) {
          logger.info(
            { generalId },
            "background general generation landed but candidate already left 'generating' (dismissed?) — discarded",
          );
        }
        return;
      } catch (err) {
        logger.warn(
          { err, generalId, attempt: i + 1 },
          "background general generation attempt failed",
        );
      }
    }
    // 全部重試仍失敗 → 保底卡（非 AI）。
    try {
      const card = buildFallbackGeneralCard({ eraSlug, category, cultureProfile });
      await db
        .update(generalsTable)
        .set({
          name: card.name,
          title: card.title,
          background: card.background,
          skills: card.skills,
          status: "candidate",
        })
        .where(
          sql`${eq(generalsTable.id, generalId)} AND ${eq(
            generalsTable.status,
            "generating",
          )}`,
        );
    } catch (err) {
      logger.error({ err, generalId }, "background general fallback failed");
    }
  })();
}

/**
 * POST /military/generals/draw — 抽取（5% 國庫 + 5% 可用生產力，一回合一張）。
 * 優先發預產池（零延遲，直接拿到候選卡）；池空時立即回一張「生成中」候選卡，
 * AI 敘事在背景生成（不卡 HTTP 請求、不怕玩家切頁），完成後原地更新成候選卡。
 */
router.post("/military/generals/draw", aiRateLimit, async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  try {
    if (await hasDrawnThisTurn(nation.id)) {
      res.status(409).json({ error: "本回合已經抽取過武將了" });
      return;
    }
    const { currentEra } = await getEraSlugs();
    const cultureProfile = await loadDominantCultureProfile(nation.id);
    const snapshot = await costSnapshot(nation);

    // 交易：條件式扣款取列鎖（同國序列化）→ 鎖內複查配額 → 插入流量列 →
    // 生產力複查。任一步失敗整筆回滾（退款且不佔配額）。
    await db.transaction(async (t) => {
      const updated = await t
        .update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${snapshot.money}` })
        .where(
          sql`${eq(playerNationsTable.id, nation.id)} AND ${playerNationsTable.money} >= ${snapshot.money}`,
        )
        .returning();
      if (updated.length === 0) {
        throw new HttpError(
          400,
          `金錢不足（需 ${snapshot.money.toLocaleString("en-US")}）`,
        );
      }
      // 列鎖後重讀：同回合並發抽取在此序列化（與招募路由同款模式）。
      const [dup] = await t
        .select({ id: generalDrawsTable.id })
        .from(generalDrawsTable)
        .where(
          sql`${eq(generalDrawsTable.ownerNationId, nation.id)} AND ${eq(
            generalDrawsTable.kind,
            "draw",
          )} AND ${CURRENT_TURN_PREDICATE}`,
        )
        .limit(1);
      if (dup) {
        throw new HttpError(409, "本回合已經抽取過武將了");
      }
      await t.insert(generalDrawsTable).values({
        ownerNationId: nation.id,
        kind: "draw",
        moneySpent: snapshot.money,
        productionSpent: snapshot.production,
      });
      // 生產力精確複查（取得列鎖後重讀當回合流量；含剛插入的列）。
      const { statsEra } = await getEraSlugs();
      const stats = await computeAdjustedNationStats(nation, statsEra);
      const spent = await loadCurrentTurnRecruitSpend(nation.id, t);
      const available = computeAvailableProduction({
        production: stats.production,
        productionSpent: nation.productionSpent,
        currentTurnSpend: spent,
      });
      if (available < 0) {
        throw new HttpError(
          400,
          `生產力不足（需 ${snapshot.production.toLocaleString("en-US")}）`,
        );
      }
    });

    // 發牌：池優先（零延遲，直接是候選卡）；池空則發「生成中」卡，背景補敘事。
    const card = await takeGeneralFromPool({ eraSlug: currentEra, cultureProfile });
    if (card) notePregenWork(); // 池卡被抽走 → 喚醒預產 worker 補位

    const category =
      card?.category ??
      (MILITARY_CATEGORIES[
        Math.floor(Math.random() * MILITARY_CATEGORIES.length)
      ]! as string);

    const [created] = await db
      .insert(generalsTable)
      .values({
        ownerNationId: nation.id,
        name: card?.name ?? "（生成中…）",
        title: card?.title ?? "",
        background: card?.background ?? "",
        category,
        grade: 1,
        status: card ? "candidate" : "generating",
        skills: card?.skills ?? [],
        eraSlug: currentEra,
      })
      .returning();

    if (!card) {
      startBackgroundGeneralGeneration({
        generalId: created!.id,
        eraSlug: currentEra,
        category: category as MilitaryCategory,
        cultureProfile,
      });
    }

    res.json({
      general: serializeGeneral(created!),
      spent: { money: snapshot.money, production: snapshot.production },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, "POST /military/generals/draw failed");
    res.status(500).json({ error: "抽取失敗，請再試一次" });
  }
});

/** POST /military/generals/:id/recruit — 候選 → 招募（上限 8）。 */
router.post("/military/generals/:id/recruit", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const generalId = Number(req.params.id);
  try {
    const result = await db.transaction(async (t) => {
      const [{ n }] = await t
        .select({ n: sql<string>`COUNT(*)` })
        .from(generalsTable)
        .where(
          sql`${eq(generalsTable.ownerNationId, nation.id)} AND ${eq(
            generalsTable.status,
            "recruited",
          )}`,
        );
      if (Number(n) >= GENERAL_CAP_RECRUITED) {
        throw new HttpError(
          400,
          `已達武將上限（${GENERAL_CAP_RECRUITED} 名）；請先遣返一名再招募`,
        );
      }
      const updated = await t
        .update(generalsTable)
        .set({ status: "recruited" })
        .where(
          sql`${eq(generalsTable.id, generalId)} AND ${eq(
            generalsTable.ownerNationId,
            nation.id,
          )} AND ${eq(generalsTable.status, "candidate")}`,
        )
        .returning();
      if (updated.length === 0) {
        throw new HttpError(404, "找不到該名候選武將");
      }
      return updated[0]!;
    });
    res.json({ general: serializeGeneral(result) });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, "POST recruit general failed");
    res.status(500).json({ error: "招募失敗" });
  }
});

/** POST /military/generals/:id/dismiss — 遣返（候選或已招募皆可；不退資源）。 */
router.post("/military/generals/:id/dismiss", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const generalId = Number(req.params.id);
  try {
    const updated = await db
      .update(generalsTable)
      .set({ status: "dismissed", assignedLegionId: null })
      .where(
        sql`${eq(generalsTable.id, generalId)} AND ${eq(
          generalsTable.ownerNationId,
          nation.id,
        )} AND ${sql`${generalsTable.status} <> 'dismissed'`}`,
      )
      .returning();
    if (updated.length === 0) {
      res.status(404).json({ error: "找不到該名武將" });
      return;
    }
    res.json({ general: serializeGeneral(updated[0]!) });
  } catch (err) {
    logger.error({ err }, "POST dismiss general failed");
    res.status(500).json({ error: "遣返失敗" });
  }
});

/** POST /military/generals/:id/upgrade — 升階（指數成本/成功率；失敗照扣）。 */
router.post("/military/generals/:id/upgrade", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const generalId = Number(req.params.id);
  try {
    const [general] = await db
      .select()
      .from(generalsTable)
      .where(
        sql`${eq(generalsTable.id, generalId)} AND ${eq(
          generalsTable.ownerNationId,
          nation.id,
        )}`,
      )
      .limit(1);
    if (!general || general.status !== "recruited") {
      res.status(404).json({ error: "找不到該名已招募武將（候選請先招募）" });
      return;
    }
    if (general.grade >= GENERAL_MAX_GRADE) {
      res.status(400).json({ error: "已達最高品級" });
      return;
    }
    const snapshot = await costSnapshot(nation);
    const cost = upgradeCost(
      nation.money,
      snapshot.availableProduction,
      general.grade,
    );
    const successPct = upgradeSuccessPct(general.grade);

    // 交易：扣款 + 流量列 + 擲骰 + 品級更新（全部原子）。
    const result = await db.transaction(async (t) => {
      const updated = await t
        .update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${cost.money}` })
        .where(
          sql`${eq(playerNationsTable.id, nation.id)} AND ${playerNationsTable.money} >= ${cost.money}`,
        )
        .returning();
      if (updated.length === 0) {
        throw new HttpError(
          400,
          `金錢不足（需 ${cost.money.toLocaleString("en-US")}）`,
        );
      }
      await t.insert(generalDrawsTable).values({
        ownerNationId: nation.id,
        kind: "upgrade",
        moneySpent: cost.money,
        productionSpent: cost.production,
      });
      // 生產力複查（列鎖後重讀；升階失敗不退——先擲骰再複查，任一失敗皆回滾）。
      const { statsEra } = await getEraSlugs();
      const stats = await computeAdjustedNationStats(nation, statsEra);
      const spent = await loadCurrentTurnRecruitSpend(nation.id, t);
      const available = computeAvailableProduction({
        production: stats.production,
        productionSpent: nation.productionSpent,
        currentTurnSpend: spent,
      });
      if (available < 0) {
        throw new HttpError(
          400,
          `生產力不足（需 ${cost.production.toLocaleString("en-US")}）`,
        );
      }
      const success = Math.floor(Math.random() * 100) < successPct;
      if (!success) {
        return { general, success: false, successPct };
      }
      const [upgraded] = await t
        .update(generalsTable)
        .set({ grade: general.grade + 1 })
        .where(eq(generalsTable.id, general.id))
        .returning();
      return { general: upgraded!, success: true, successPct };
    });

    // 成功時補一段升階敘事（AI 非同步失敗容忍——拿不到就維持原值）。
    if (result.success) {
      try {
        const narrative = await upgradeNarrative(result.general);
        await db
          .update(generalsTable)
          .set({ upgradeNarrative: narrative })
          .where(eq(generalsTable.id, result.general.id));
        result.general = { ...result.general, upgradeNarrative: narrative };
      } catch (err) {
        logger.warn({ err }, "upgrade narrative generation failed");
      }
    }

    res.json({
      general: serializeGeneral(result.general),
      success: result.success,
      successPct,
      spent: cost,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, "POST upgrade general failed");
    res.status(500).json({ error: "升階失敗" });
  }
});

const upgradeNarrativeSchema = z.object({
  narrative: z.string().trim().min(1).max(300),
});

/** 升階敘事（一小段史官風格文字；失敗由呼叫端容忍）。 */
async function upgradeNarrative(general: General): Promise<string> {
  const message = await callGameAi("general.gacha", "bulk", {
    system: [
      "你是一款架空歷史戰略遊戲的史官 AI。請為武將的晉升寫一小段繁體中文敘事",
      "（≤300字，史書風格，不得超自然），僅回覆 JSON：",
      '{"narrative": "..."}',
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: `武將：${general.name}（${general.title}，品級升至 ${general.grade}）\n背景：${general.background.slice(0, 300)}`,
      },
    ],
  });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return upgradeNarrativeSchema.parse(JSON.parse(cleaned)).narrative;
}

const assignBodySchema = z.object({
  campaignId: z.number().int(),
  slot: z.enum(["A", "B", "C"]),
});

/** POST /military/generals/:id/assign — 指派到軍團（A/B/C，一軍團一名）。 */
router.post("/military/generals/:id/assign", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const generalId = Number(req.params.id);
  try {
    const body = assignBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "參數不正確" });
      return;
    }
    const { campaignId, slot } = body.data;
    const result = await db.transaction(async (t) => {
      const [legion] = await t
        .select({
          id: warCampaignLegionsTable.id,
          campaignId: warCampaignLegionsTable.campaignId,
          status: warCampaignsTable.status,
        })
        .from(warCampaignLegionsTable)
        .innerJoin(
          warCampaignsTable,
          eq(warCampaignsTable.id, warCampaignLegionsTable.campaignId),
        )
        .where(
          sql`${eq(warCampaignLegionsTable.campaignId, campaignId)} AND ${eq(
            warCampaignLegionsTable.nationId,
            nation.id,
          )} AND ${eq(warCampaignLegionsTable.slot, slot)}`,
        )
        .limit(1);
      if (!legion || legion.status !== "active") {
        throw new HttpError(404, "找不到該軍團（戰役須進行中）");
      }
      // 條件式 UPDATE：武將須為已招募、屬於本國、未遣返；unique index
      // （generals_assigned_legion_uidx）另保證一軍團一名武將。
      try {
        const updated = await t
          .update(generalsTable)
          .set({ assignedLegionId: legion.id })
          .where(
            sql`${eq(generalsTable.id, generalId)} AND ${eq(
              generalsTable.ownerNationId,
              nation.id,
            )} AND ${eq(generalsTable.status, "recruited")}`,
          )
          .returning();
        if (updated.length === 0) {
          throw new HttpError(404, "找不到該名已招募武將");
        }
        return updated[0]!;
      } catch (err) {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code?: unknown }).code === "23505"
        ) {
          throw new HttpError(409, "該軍團已有其他武將坐鎮");
        }
        throw err;
      }
    });
    res.json({ general: serializeGeneral(result) });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ err }, "POST assign general failed");
    res.status(500).json({ error: "指派失敗" });
  }
});

/** POST /military/generals/:id/unassign — 解除指派。 */
router.post("/military/generals/:id/unassign", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const generalId = Number(req.params.id);
  try {
    const updated = await db
      .update(generalsTable)
      .set({ assignedLegionId: null })
      .where(
        sql`${eq(generalsTable.id, generalId)} AND ${eq(
          generalsTable.ownerNationId,
          nation.id,
        )} AND ${sql`${generalsTable.assignedLegionId} IS NOT NULL`}`,
      )
      .returning();
    if (updated.length === 0) {
      res.status(404).json({ error: "該武將目前沒有指揮軍團" });
      return;
    }
    res.json({ general: serializeGeneral(updated[0]!) });
  } catch (err) {
    logger.error({ err }, "POST unassign general failed");
    res.status(500).json({ error: "解除指派失敗" });
  }
});

export default router;
