import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  aiAbuseRecordsTable,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  playerNationsTable,
} from "@workspace/db";
import { z } from "zod";
import { requireAdmin } from "../middlewares/requireAdmin";
import { notifyAbusePunished } from "../lib/gameNotify";
import {
  ABUSE_DOMAINS,
  MODIFIER_SOURCES,
  UNIT_CATEGORIES,
  computeUnitCategoryAverages,
  enrichAbuseRecordActors,
  gameBalanceSettingsSchema,
  getGameBalanceSettings,
  saveGameBalanceSettings,
  type AbuseDomain,
} from "../lib/gameBalance";

/**
 * Task #451 — 遊戲平衡管理 admin API（requireAdmin raw-fetch，**不在**
 * 公開 OpenAPI spec，比照 world-sim／npcNations 模式）。
 *
 *  - GET  /api/game-balance/settings：目前設定（DB 覆寫與預設合併後的全量）。
 *  - PUT  /api/game-balance/settings：全量寫入（zod 驗證、超界 400 zh-TW）。
 *  - GET  /api/game-balance/unit-averages：各兵種類別全庫平均（夾限基準預覽）。
 *  - GET  /api/game-balance/abuse-records：濫用紀錄（domain／nationId／
 *    discordUserId 過濾 + limit）。
 */
const router: IRouter = Router();

const ABUSE_LIST_DEFAULT_LIMIT = 100;
const ABUSE_LIST_MAX_LIMIT = 500;

router.get("/game-balance/settings", requireAdmin, async (_req, res) => {
  const settings = await getGameBalanceSettings();
  res.json({ settings, modifierSources: MODIFIER_SOURCES });
});

router.put("/game-balance/settings", requireAdmin, async (req, res) => {
  const parsed = gameBalanceSettingsSchema.safeParse(req.body?.settings);
  if (!parsed.success) {
    res.status(400).json({
      error: "設定格式不正確或數值超出允許範圍",
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    });
    return;
  }
  if (
    Object.values(parsed.data.modifierSources).some(
      (s) => s.minDelta > s.maxDelta,
    )
  ) {
    res.status(400).json({ error: "來源夾限下限不可大於上限" });
    return;
  }
  await saveGameBalanceSettings(parsed.data);
  req.log.info("game balance settings updated");
  res.json({ ok: true, settings: parsed.data });
});

/**
 * POST /api/game-balance/apply-prod-cost-floor
 * 將所有 prod_cost_per_100 低於目前 prodCostPer100Min 的兵種設計提升到下限值。
 * 回傳 { ok, updated, floor }。
 */
router.post(
  "/game-balance/apply-prod-cost-floor",
  requireAdmin,
  async (req, res) => {
    const settings = await getGameBalanceSettings();
    const u = settings.unitDesign;
    const recruitFloor = u.prodCostPer100Min;
    const occupyFloor = u.prodUpkeepPerUnitMin ?? recruitFloor;

    // prodCostPer100 is an INTEGER column — ceil the floor so fractional settings
    // still result in a valid integer being written (e.g. 0.0001 → 1).
    const recruitIntFloor = Math.max(1, Math.ceil(recruitFloor));

    const [r1, r2] = await Promise.all([
      db
        .update(militaryUnitTemplatesTable)
        .set({ prodCostPer100: recruitIntFloor })
        .where(lt(militaryUnitTemplatesTable.prodCostPer100, recruitIntFloor)),
      db
        .update(militaryUnitTemplatesTable)
        .set({ prodUpkeepPerUnit: occupyFloor })
        .where(lt(militaryUnitTemplatesTable.prodUpkeepPerUnit, occupyFloor)),
    ]);
    const updatedRecruit = r1.rowCount ?? 0;
    const updatedOccupy = r2.rowCount ?? 0;
    req.log.info(
      { recruitFloor, occupyFloor, updatedRecruit, updatedOccupy },
      "apply prod cost floor to unit templates",
    );
    res.json({
      ok: true,
      updatedRecruit,
      updatedOccupy,
      recruitFloor: recruitIntFloor,
      occupyFloor,
    });
  },
);

router.get(
  "/game-balance/unit-averages",
  requireAdmin,
  async (_req, res) => {
    const averages: Record<string, unknown> = {};
    for (const category of UNIT_CATEGORIES) {
      averages[category] = await computeUnitCategoryAverages(category);
    }
    res.json({ averages });
  },
);

const abuseQuerySchema = z.object({
  domain: z.enum(ABUSE_DOMAINS).optional(),
  nationId: z.string().uuid().optional(),
  discordUserId: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ABUSE_LIST_MAX_LIMIT)
    .default(ABUSE_LIST_DEFAULT_LIMIT),
});

router.get(
  "/game-balance/abuse-records",
  requireAdmin,
  async (req, res) => {
    const parsed = abuseQuerySchema.safeParse({
      domain: req.query.domain || undefined,
      nationId: req.query.nationId || undefined,
      discordUserId: req.query.discordUserId || undefined,
      limit: req.query.limit || undefined,
    });
    if (!parsed.success) {
      res.status(400).json({ error: "查詢參數不正確" });
      return;
    }
    const { domain, nationId, discordUserId, limit } = parsed.data;
    const conditions = [
      domain
        ? eq(aiAbuseRecordsTable.domain, domain satisfies AbuseDomain)
        : undefined,
      nationId ? eq(aiAbuseRecordsTable.nationId, nationId) : undefined,
      discordUserId
        ? eq(aiAbuseRecordsTable.discordUserId, discordUserId)
        : undefined,
    ].filter((c) => c !== undefined);
    const records = await db
      .select()
      .from(aiAbuseRecordsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(aiAbuseRecordsTable.createdAt))
      .limit(limit);
    // Task #519 — 讀取時批次補上行為人（玩家名稱＋目前國家名稱）。
    res.json({ records: await enrichAbuseRecordActors(records) });
  },
);

// ── Task #459 — 撤銷/補償被判定濫用的玩家損失 ─────────────────────

const revertBodySchema = z.object({
  /** 退款金額（國庫加回）。 */
  money: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
  /** 四民滿意度＋軍方滿意度一律回補的百分點。 */
  satisfactionDelta: z.coerce.number().int().min(0).max(100).default(0),
  stabilityDelta: z.coerce.number().int().min(0).max(100).default(0),
  /** 暴動值下修的百分點。 */
  unrestDelta: z.coerce.number().int().min(0).max(100).default(0),
  /** Task #547 — 厭戰度下修（回補）的百分點。 */
  warWearinessDelta: z.coerce.number().int().min(0).max(100).default(0),
  note: z.string().trim().max(500).optional(),
});

router.post(
  "/game-balance/abuse-records/:id/revert",
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "紀錄 ID 不正確" });
      return;
    }
    const parsed = revertBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "補償參數不正確或超出允許範圍" });
      return;
    }
    const {
      money,
      satisfactionDelta,
      stabilityDelta,
      unrestDelta,
      warWearinessDelta,
      note,
    } = parsed.data;

    const [record] = await db
      .select()
      .from(aiAbuseRecordsTable)
      .where(eq(aiAbuseRecordsTable.id, id))
      .limit(1);
    if (!record) {
      res.status(404).json({ error: "找不到這筆濫用紀錄" });
      return;
    }
    if (record.revertedAt) {
      res.status(409).json({ error: "這筆紀錄已經撤銷過，不能重複補償" });
      return;
    }
    // Task #547 — 與加重處罰互斥：已加重的紀錄不能再撤銷補償。
    if (record.punishedAt) {
      res.status(409).json({ error: "這筆紀錄已加重處罰，不能再撤銷補償" });
      return;
    }

    const hasCompensation =
      money > 0 ||
      satisfactionDelta > 0 ||
      stabilityDelta > 0 ||
      unrestDelta > 0 ||
      warWearinessDelta > 0;
    if (hasCompensation && !record.nationId) {
      res.status(400).json({
        error: "這筆紀錄沒有關聯國家，無法套用補償（仍可送出全 0 僅標記撤銷）",
      });
      return;
    }

    const compensation = {
      money,
      satisfactionDelta,
      stabilityDelta,
      unrestDelta,
      warWearinessDelta,
    };

    try {
      await db.transaction(async (tx) => {
        // 一次性撤銷閘：conditional UPDATE，同時撤銷只會有一方成功。
        const claimed = await tx
          .update(aiAbuseRecordsTable)
          .set({
            revertedAt: new Date(),
            revertNote: note ?? null,
            compensation,
          })
          .where(
            and(
              eq(aiAbuseRecordsTable.id, id),
              isNull(aiAbuseRecordsTable.revertedAt),
              isNull(aiAbuseRecordsTable.punishedAt),
            ),
          )
          .returning({ id: aiAbuseRecordsTable.id });
        if (claimed.length === 0) {
          throw new RevertConflictError(
            "這筆紀錄已經撤銷或已加重處罰，不能重複操作",
          );
        }

        if (hasCompensation && record.nationId) {
          const updated = await tx
            .update(playerNationsTable)
            .set({
              money: sql`${playerNationsTable.money} + ${money}`,
              satisfactionFarmers: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionFarmers} + ${satisfactionDelta}))`,
              satisfactionWorkers: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionWorkers} + ${satisfactionDelta}))`,
              satisfactionNobles: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionNobles} + ${satisfactionDelta}))`,
              satisfactionClergy: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionClergy} + ${satisfactionDelta}))`,
              satisfactionMilitary: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionMilitary} + ${satisfactionDelta}))`,
              stability: sql`LEAST(100, GREATEST(0, ${playerNationsTable.stability} + ${stabilityDelta}))`,
              unrest: sql`LEAST(100, GREATEST(0, ${playerNationsTable.unrest} - ${unrestDelta}))`,
              warWeariness: sql`LEAST(100, GREATEST(0, ${playerNationsTable.warWeariness} - ${warWearinessDelta}))`,
            })
            .where(eq(playerNationsTable.id, record.nationId))
            .returning({ id: playerNationsTable.id });
          if (updated.length === 0) {
            throw new RevertNationGoneError(
              "關聯國家已不存在，無法套用補償（可送出全 0 僅標記撤銷）",
            );
          }
        }
      });
    } catch (err) {
      if (err instanceof RevertConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof RevertNationGoneError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }

    req.log.info(
      { recordId: id, nationId: record.nationId, compensation },
      "abuse record reverted with compensation",
    );
    const [updatedRecord] = await db
      .select()
      .from(aiAbuseRecordsTable)
      .where(eq(aiAbuseRecordsTable.id, id))
      .limit(1);
    res.json({ ok: true, record: updatedRecord });
  },
);

class RevertConflictError extends Error {}
class RevertNationGoneError extends Error {}

// ── Task #547 — 逐案加重處罰（只限 war_order 紀錄；與撤銷互斥、一次性） ──

const punishBodySchema = z.object({
  /** 罰款金額（國庫扣除，SQL clamp ≥0）。 */
  money: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
  /** 四民滿意度＋軍方滿意度一律下修的百分點。 */
  satisfactionDelta: z.coerce.number().int().min(0).max(100).default(0),
  /** 穩定度下修的百分點。 */
  stabilityDelta: z.coerce.number().int().min(0).max(100).default(0),
  /** 暴動值上修的百分點。 */
  unrestDelta: z.coerce.number().int().min(0).max(100).default(0),
  /** 厭戰度上修的百分點。 */
  warWearinessDelta: z.coerce.number().int().min(0).max(100).default(0),
  /** 全國常備軍額外傷亡（各兵種數量的 %，floor、SQL clamp ≥0）。 */
  armyCasualtyPct: z.coerce.number().int().min(0).max(100).default(0),
  note: z.string().trim().max(500).optional(),
});

router.post(
  "/game-balance/abuse-records/:id/punish",
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "紀錄 ID 不正確" });
      return;
    }
    const parsed = punishBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "處罰參數不正確或超出允許範圍" });
      return;
    }
    const {
      money,
      satisfactionDelta,
      stabilityDelta,
      unrestDelta,
      warWearinessDelta,
      armyCasualtyPct,
      note,
    } = parsed.data;

    const [record] = await db
      .select()
      .from(aiAbuseRecordsTable)
      .where(eq(aiAbuseRecordsTable.id, id))
      .limit(1);
    if (!record) {
      res.status(404).json({ error: "找不到這筆濫用紀錄" });
      return;
    }
    if (record.domain !== "war_order") {
      res.status(400).json({ error: "只有戰爭指令濫用紀錄可以加重處罰" });
      return;
    }
    if (record.punishedAt) {
      res.status(409).json({ error: "這筆紀錄已經加重處罰過，不能重複處罰" });
      return;
    }
    if (record.revertedAt) {
      res.status(409).json({ error: "這筆紀錄已撤銷補償，不能再加重處罰" });
      return;
    }

    const hasNationPenalty =
      money > 0 ||
      satisfactionDelta > 0 ||
      stabilityDelta > 0 ||
      unrestDelta > 0 ||
      warWearinessDelta > 0;
    if (hasNationPenalty && !record.nationId) {
      res.status(400).json({
        error: "這筆紀錄沒有關聯國家，無法套用國家處罰（仍可送出全 0 僅標記）",
      });
      return;
    }
    if (armyCasualtyPct > 0 && !record.discordUserId) {
      res.status(400).json({
        error: "這筆紀錄沒有關聯玩家，無法套用軍隊傷亡處罰",
      });
      return;
    }

    const punishment = {
      money,
      satisfactionDelta,
      stabilityDelta,
      unrestDelta,
      warWearinessDelta,
      armyCasualtyPct,
    };

    try {
      await db.transaction(async (tx) => {
        // 一次性加重閘：conditional UPDATE，與撤銷互斥（兩欄皆需為 NULL）。
        const claimed = await tx
          .update(aiAbuseRecordsTable)
          .set({
            punishedAt: new Date(),
            punishNote: note ?? null,
            punishment,
          })
          .where(
            and(
              eq(aiAbuseRecordsTable.id, id),
              isNull(aiAbuseRecordsTable.punishedAt),
              isNull(aiAbuseRecordsTable.revertedAt),
            ),
          )
          .returning({ id: aiAbuseRecordsTable.id });
        if (claimed.length === 0) {
          throw new PunishConflictError(
            "這筆紀錄已經加重處罰或已撤銷，不能重複操作",
          );
        }

        if (hasNationPenalty && record.nationId) {
          const updated = await tx
            .update(playerNationsTable)
            .set({
              money: sql`GREATEST(0, ${playerNationsTable.money} - ${money})`,
              satisfactionFarmers: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionFarmers} - ${satisfactionDelta}))`,
              satisfactionWorkers: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionWorkers} - ${satisfactionDelta}))`,
              satisfactionNobles: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionNobles} - ${satisfactionDelta}))`,
              satisfactionClergy: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionClergy} - ${satisfactionDelta}))`,
              satisfactionMilitary: sql`LEAST(100, GREATEST(0, ${playerNationsTable.satisfactionMilitary} - ${satisfactionDelta}))`,
              stability: sql`LEAST(100, GREATEST(0, ${playerNationsTable.stability} - ${stabilityDelta}))`,
              unrest: sql`LEAST(100, GREATEST(0, ${playerNationsTable.unrest} + ${unrestDelta}))`,
              warWeariness: sql`LEAST(100, GREATEST(0, ${playerNationsTable.warWeariness} + ${warWearinessDelta}))`,
            })
            .where(eq(playerNationsTable.id, record.nationId))
            .returning({ id: playerNationsTable.id });
          if (updated.length === 0) {
            throw new PunishNationGoneError(
              "關聯國家已不存在，無法套用國家處罰（可送出全 0 僅標記）",
            );
          }
        }

        // 全國常備軍額外傷亡：各兵種數量各扣 floor(quantity × pct / 100)。
        if (armyCasualtyPct > 0 && record.discordUserId) {
          await tx
            .update(playerArmiesTable)
            .set({
              quantity: sql`GREATEST(0, ${playerArmiesTable.quantity} - FLOOR(${playerArmiesTable.quantity} * ${armyCasualtyPct} / 100.0)::int)`,
            })
            .where(eq(playerArmiesTable.discordUserId, record.discordUserId));
        }
      });
    } catch (err) {
      if (err instanceof PunishConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof PunishNationGoneError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }

    // 站內通知被處罰玩家（有關聯玩家時）。
    if (record.discordUserId) {
      const detailParts: string[] = [];
      if (money > 0) detailParts.push(`罰款 ${money.toLocaleString()}`);
      if (satisfactionDelta > 0)
        detailParts.push(`各滿意度 −${satisfactionDelta}`);
      if (stabilityDelta > 0) detailParts.push(`穩定度 −${stabilityDelta}`);
      if (unrestDelta > 0) detailParts.push(`暴動值 +${unrestDelta}`);
      if (warWearinessDelta > 0)
        detailParts.push(`厭戰度 +${warWearinessDelta}`);
      if (armyCasualtyPct > 0)
        detailParts.push(`常備軍傷亡 ${armyCasualtyPct}%`);
      notifyAbusePunished({
        discordUserId: record.discordUserId,
        detail: detailParts.length > 0 ? detailParts.join("、") : "（僅標記）",
        note: note ?? null,
      });
    }

    req.log.info(
      { recordId: id, nationId: record.nationId, punishment },
      "abuse record punished",
    );
    const [updatedRecord] = await db
      .select()
      .from(aiAbuseRecordsTable)
      .where(eq(aiAbuseRecordsTable.id, id))
      .limit(1);
    res.json({ ok: true, record: updatedRecord });
  },
);

class PunishConflictError extends Error {}
class PunishNationGoneError extends Error {}

export default router;
