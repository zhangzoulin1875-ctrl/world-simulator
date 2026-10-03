import { Router, type IRouter } from "express";
import { desc, eq, gt, sql } from "drizzle-orm";
import {
  db,
  warRegionCooldownsTable,
  worldGameStateTable,
  worldSimAuditsTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { aiRateLimit } from "../middlewares/aiRateLimit";
import { parseWorldProposal, WorldProposalError } from "../lib/worldSim";
import { generateWorldProposal } from "../lib/worldSimAi";
import { buildWorldSimSnapshot } from "../lib/worldSimSnapshot";
import {
  applyWorldProposal,
  previewWorldProposal,
  describeWorldPlan,
} from "../lib/worldSimApply";
import { AI_DIRECTIVE_MAX_LENGTH, normalizeDirective } from "../lib/aiDirective";
import { runAiJudgment } from "../lib/aiJudgment";
import {
  settleAllActiveCampaigns,
  applyGlobalWarCycleHours,
} from "../lib/warEngine";
import {
  tryAcquireAiJudgmentLock,
  releaseAiJudgmentLock,
} from "../lib/worldScheduler";
import {
  listNpcChatGuardEvents,
  summarizeNpcChatGuardEventsByPlayer,
  NPC_CHAT_GUARD_EVENT_RETENTION,
  type NpcChatGuardEventFilter,
} from "../lib/npcChatGuardLog";

/**
 * Task #176 — AI 驅動 NPC 世界模擬 admin API（requireAdmin raw-fetch，
 * **不在** 公開 OpenAPI spec，比照 npcNations／turn 模式）。
 *
 * 流程為「預覽再套用」：
 *  - POST /api/world-sim/propose：讀世界快照 → quality 模型生成提案 → 只讀預覽
 *    語意驗證（不寫入），回傳提案本體 + 可讀變更清單供管理員確認。加 aiRateLimit。
 *  - POST /api/world-sim/apply：管理員確認後把提案送回，於 advisory lock 交易內
 *    重讀快照再驗證後套用（世界零信任——即使快照在預覽後改變也安全）。
 *  - GET /api/world-sim/audits：檢視最近的 AI 世界變更稽核紀錄。
 *
 * 硬性安全規則由 worldSimApply / validateWorldProposal 保證：AI 只能新增／編輯／
 * 刪除 NPC 與無主國家並在它們之間重畫領土，**永不觸及玩家國家或其領土**。
 */
const router: IRouter = Router();

/** 稽核清單回傳筆數上限。 */
const AUDIT_LIST_LIMIT = 100;

/** 自動世界模擬強度上下限（1 低／2 中／3 高）。 */
const INTENSITY_MIN = 1;
const INTENSITY_MAX = 3;

/** 迴圈頻率上下限（分鐘）：1 分鐘 ～ 30 天。 */
const FREQ_MIN_MINUTES = 1;
const FREQ_MAX_MINUTES = 43200;

/** 戰役週期上下限（小時）：1 小時 ～ 30 天。 */
const WAR_CYCLE_MIN_HOURS = 1;
const WAR_CYCLE_MAX_HOURS = 720;

/** Task #412 — 全域戰爭參數上下限（與 lib/war.ts 常數一致）。 */
import {
  WAR_INTENSITY_MIN_PCT,
  WAR_INTENSITY_MAX_PCT,
  TERRITORY_CAPTURE_BASE_MIN_PCT,
  TERRITORY_CAPTURE_BASE_MAX_PCT,
} from "../lib/war";

/** 讀取自動世界模擬設定（world_game_state 單列 id=1）。 */
async function readWorldSimSettings() {
  const [state] = await db
    .select({
      enabled: worldGameStateTable.worldSimEnabled,
      intensity: worldGameStateTable.worldSimIntensity,
      hostileToPlayers: worldGameStateTable.worldSimHostileToPlayers,
      frequencyMinutes: worldGameStateTable.worldSimFrequencyMinutes,
      lastRunAt: worldGameStateTable.worldSimLastRunAt,
      nextRunAt: worldGameStateTable.worldSimNextRunAt,
      aiJudgmentEnabled: worldGameStateTable.aiJudgmentEnabled,
      aiJudgmentFrequencyMinutes:
        worldGameStateTable.aiJudgmentFrequencyMinutes,
      aiJudgmentLastRunAt: worldGameStateTable.aiJudgmentLastRunAt,
      aiJudgmentNextRunAt: worldGameStateTable.aiJudgmentNextRunAt,
      aiJudgmentDirective: worldGameStateTable.aiJudgmentDirective,
      warCycleHours: worldGameStateTable.warCycleHours,
      settlementBlackoutStartHour:
        worldGameStateTable.settlementBlackoutStartHour,
      settlementBlackoutEndHour: worldGameStateTable.settlementBlackoutEndHour,
      chatActionLevel: worldGameStateTable.npcChatActionLevel,
      warIntensityPct: worldGameStateTable.warIntensityPct,
      territoryCaptureBasePct: worldGameStateTable.territoryCaptureBasePct,
      // Task #570 — NPC 締約可提供資源的上限。
      npcTreatyStockCapPct: worldGameStateTable.npcTreatyStockCapPct,
      npcTreatyMaxRegions: worldGameStateTable.npcTreatyMaxRegions,
      npcTreatyRegionMaxPct: worldGameStateTable.npcTreatyRegionMaxPct,
      npcTreatyPerTurnCapPct: worldGameStateTable.npcTreatyPerTurnCapPct,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return state ?? null;
}

/** 讀取自動世界模擬設定。 */
router.get("/world-sim/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await readWorldSimSettings();
    if (!settings) {
      res.status(500).json({ error: "世界狀態尚未初始化" });
      return;
    }
    res.json({ settings });
  } catch (err) {
    req.log.error({ err }, "failed to read world sim settings");
    res.status(500).json({ error: "讀取自動世界模擬設定失敗" });
  }
});

/**
 * 更新自動世界模擬設定。欄位皆為選填（省略 = 不變）：
 * enabled（布林，總開關）、intensity（1–3）、hostileToPlayers（布林）。
 */
router.put("/world-sim/settings", requireAdmin, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    if (body["enabled"] !== undefined) {
      if (typeof body["enabled"] !== "boolean") {
        res.status(400).json({ error: "總開關必須是布林值" });
        return;
      }
      updates["worldSimEnabled"] = body["enabled"];
    }
    if (body["hostileToPlayers"] !== undefined) {
      if (typeof body["hostileToPlayers"] !== "boolean") {
        res.status(400).json({ error: "對玩家敵對開關必須是布林值" });
        return;
      }
      updates["worldSimHostileToPlayers"] = body["hostileToPlayers"];
    }
    if (body["intensity"] !== undefined) {
      const v = body["intensity"];
      if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < INTENSITY_MIN ||
        v > INTENSITY_MAX
      ) {
        res
          .status(400)
          .json({ error: `強度必須是 ${INTENSITY_MIN}–${INTENSITY_MAX} 的整數` });
        return;
      }
      updates["worldSimIntensity"] = v;
    }
    if (body["frequencyMinutes"] !== undefined) {
      const v = body["frequencyMinutes"];
      if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < FREQ_MIN_MINUTES ||
        v > FREQ_MAX_MINUTES
      ) {
        res.status(400).json({
          error: `NPC 自動演變頻率必須是 ${FREQ_MIN_MINUTES}–${FREQ_MAX_MINUTES} 分鐘的整數`,
        });
        return;
      }
      updates["worldSimFrequencyMinutes"] = v;
    }
    if (body["aiJudgmentEnabled"] !== undefined) {
      if (typeof body["aiJudgmentEnabled"] !== "boolean") {
        res.status(400).json({ error: "AI 外交/戰役判定開關必須是布林值" });
        return;
      }
      updates["aiJudgmentEnabled"] = body["aiJudgmentEnabled"];
    }
    if (body["aiJudgmentFrequencyMinutes"] !== undefined) {
      const v = body["aiJudgmentFrequencyMinutes"];
      if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < FREQ_MIN_MINUTES ||
        v > FREQ_MAX_MINUTES
      ) {
        res.status(400).json({
          error: `AI 外交/戰役判定頻率必須是 ${FREQ_MIN_MINUTES}–${FREQ_MAX_MINUTES} 分鐘的整數`,
        });
        return;
      }
      updates["aiJudgmentFrequencyMinutes"] = v;
    }
    if (body["warCycleHours"] !== undefined) {
      const v = body["warCycleHours"];
      if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < WAR_CYCLE_MIN_HOURS ||
        v > WAR_CYCLE_MAX_HOURS
      ) {
        res.status(400).json({
          error: `戰役週期必須是 ${WAR_CYCLE_MIN_HOURS}–${WAR_CYCLE_MAX_HOURS} 小時的整數`,
        });
        return;
      }
      updates["warCycleHours"] = v;
    }
    if (body["settlementBlackoutStartHour"] !== undefined) {
      const v = body["settlementBlackoutStartHour"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
        res
          .status(400)
          .json({ error: "結算靜默時段開始時間必須是 0–23 的整數" });
        return;
      }
      updates["settlementBlackoutStartHour"] = v;
    }
    if (body["settlementBlackoutEndHour"] !== undefined) {
      const v = body["settlementBlackoutEndHour"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
        res
          .status(400)
          .json({ error: "結算靜默時段結束時間必須是 0–23 的整數" });
        return;
      }
      updates["settlementBlackoutEndHour"] = v;
    }
    if (body["chatActionLevel"] !== undefined) {
      const v = body["chatActionLevel"];
      if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < INTENSITY_MIN ||
        v > INTENSITY_MAX
      ) {
        res.status(400).json({
          error: `NPC 對話行動等級必須是 ${INTENSITY_MIN}–${INTENSITY_MAX} 的整數`,
        });
        return;
      }
      updates["npcChatActionLevel"] = v;
    }
    if (body["warIntensityPct"] !== undefined) {
      const v = body["warIntensityPct"];
      if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < WAR_INTENSITY_MIN_PCT ||
        v > WAR_INTENSITY_MAX_PCT
      ) {
        res.status(400).json({
          error: `戰鬥激烈度倍率必須是 ${WAR_INTENSITY_MIN_PCT}–${WAR_INTENSITY_MAX_PCT} 的整數（%）`,
        });
        return;
      }
      updates["warIntensityPct"] = v;
    }
    if (body["territoryCaptureBasePct"] !== undefined) {
      const v = body["territoryCaptureBasePct"];
      if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < TERRITORY_CAPTURE_BASE_MIN_PCT ||
        v > TERRITORY_CAPTURE_BASE_MAX_PCT
      ) {
        res.status(400).json({
          error: `領土奪取基礎值必須是 ${TERRITORY_CAPTURE_BASE_MIN_PCT}–${TERRITORY_CAPTURE_BASE_MAX_PCT} 的整數（百分點）`,
        });
        return;
      }
      updates["territoryCaptureBasePct"] = v;
    }
    // Task #570 — NPC 締約可提供資源的上限（皆為整數）。
    const npcTreatyPctFields: Array<[string, string]> = [
      ["npcTreatyStockCapPct", "NPC 締約一次性庫存上限"],
      ["npcTreatyRegionMaxPct", "NPC 締約每區讓渡比例上限"],
      ["npcTreatyPerTurnCapPct", "NPC 締約每回合輸送上限"],
    ];
    for (const [key, label] of npcTreatyPctFields) {
      if (body[key] !== undefined) {
        const v = body[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) {
          res.status(400).json({ error: `${label}必須是 0–100 的整數（%）` });
          return;
        }
        updates[key] = v;
      }
    }
    if (body["npcTreatyMaxRegions"] !== undefined) {
      const v = body["npcTreatyMaxRegions"];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10) {
        res.status(400).json({
          error: "NPC 締約單一條約地區數上限必須是 0–10 的整數",
        });
        return;
      }
      updates["npcTreatyMaxRegions"] = v;
    }
    if (body["aiJudgmentDirective"] !== undefined) {
      const v = body["aiJudgmentDirective"];
      if (v !== null && typeof v !== "string") {
        res.status(400).json({ error: "AI 判定干預指令必須是文字或 null" });
        return;
      }
      if (typeof v === "string" && v.length > AI_DIRECTIVE_MAX_LENGTH) {
        res.status(400).json({
          error: `AI 判定干預指令過長（最多 ${AI_DIRECTIVE_MAX_LENGTH} 字）`,
        });
        return;
      }
      updates["aiJudgmentDirective"] = normalizeDirective(
        typeof v === "string" ? v : null,
      );
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "沒有任何要更新的欄位" });
      return;
    }

    // 讀取現值以偵測「頻率變更」與「停用→啟用」，據以重算 next_run_at，
    // 讓管理員調整的頻率／開關即時生效，而非苦等舊的（可能在未來的）到期點。
    // 重新啟用 → next_run_at = NULL（下次 tick 立即執行）；
    // 頻率變更 → next_run_at = NOW() + 新頻率（下一次即依新節奏）。
    const current = await readWorldSimSettings();
    if (!current) {
      res.status(500).json({ error: "世界狀態尚未初始化" });
      return;
    }
    if (updates["worldSimEnabled"] === true && current.enabled === false) {
      updates["worldSimNextRunAt"] = null;
    } else if (
      updates["worldSimFrequencyMinutes"] !== undefined &&
      updates["worldSimFrequencyMinutes"] !== current.frequencyMinutes
    ) {
      updates["worldSimNextRunAt"] = sql`NOW() + make_interval(mins => ${
        updates["worldSimFrequencyMinutes"] as number
      })`;
    }
    if (
      updates["aiJudgmentEnabled"] === true &&
      current.aiJudgmentEnabled === false
    ) {
      updates["aiJudgmentNextRunAt"] = null;
    } else if (
      updates["aiJudgmentFrequencyMinutes"] !== undefined &&
      updates["aiJudgmentFrequencyMinutes"] !==
        current.aiJudgmentFrequencyMinutes
    ) {
      updates["aiJudgmentNextRunAt"] = sql`NOW() + make_interval(mins => ${
        updates["aiJudgmentFrequencyMinutes"] as number
      })`;
    }

    updates["updatedAt"] = sql`NOW()`;

    // 戰役週期長度變更 → 立即統一套用到所有進行中的戰役（改 cycle_hours 並依新頻率
    // 重算 next_resolve_at），讓「AI 世界模擬」成為唯一的結算頻率設定。
    const warCycleChanged =
      updates["warCycleHours"] !== undefined &&
      updates["warCycleHours"] !== current.warCycleHours;

    const { affected } = await applyWorldSimSettingsInTransaction(updates, {
      warCycleHours: warCycleChanged
        ? (updates["warCycleHours"] as number)
        : undefined,
    });
    if (warCycleChanged) {
      req.log.info(
        { warCycleHours: updates["warCycleHours"], affected },
        "war cycle applied to all active campaigns",
      );
    }

    const fresh = await readWorldSimSettings();
    req.log.info({ updates: Object.keys(updates) }, "world sim settings updated");
    res.json({ settings: fresh });
  } catch (err) {
    req.log.error({ err }, "failed to update world sim settings");
    res.status(500).json({ error: "更新自動世界模擬設定失敗" });
  }
});

/**
 * 立即手動觸發一次 AI 戰役判定（等同回合引擎的 force 手動執行）：
 *  - NPC 開戰決策（對進行中戰爭發起戰役，npcWarTick）與戰役週期推進/結算（runAiJudgment）。
 *  - 強制結算目前所有進行中的戰役（不受下次結算時間限制）。
 * 註：NPC 主動外交提案／宣戰／結盟已停用，此處不再觸發 NPC 主動行動。
 * 無論 aiJudgmentEnabled 是否開啟都可執行；與背景 tick 共用同一同步重入鎖，
 * 若正在執行（背景 tick 或另一次手動點擊）→ 409 忙碌中提示，不會並行重跑。
 * 完成後推進 ai_judgment_last_run_at，並回傳判定摘要。
 */
router.post("/world-sim/run-now", requireAdmin, async (req, res) => {
  if (!tryAcquireAiJudgmentLock()) {
    res.status(409).json({ error: "AI 判定正在執行中，請稍後再試" });
    return;
  }
  try {
    const settings = await readWorldSimSettings();
    if (!settings) {
      res.status(500).json({ error: "世界狀態尚未初始化" });
      return;
    }

    const summary = await runAiJudgment();

    // 強制結算所有進行中戰役（不受到期時間限制）；覆蓋 runAiJudgment 內只結算到期者。
    const { settledCount } = await settleAllActiveCampaigns();
    if (settledCount > 0) summary.campaignsSettled = true;

    // 手動觸發也前進 last_run_at，讓「上次執行」時間反映此次手動判定。
    await db
      .update(worldGameStateTable)
      .set({ aiJudgmentLastRunAt: sql`NOW()`, updatedAt: sql`NOW()` })
      .where(eq(worldGameStateTable.id, 1));

    const fresh = await readWorldSimSettings();
    req.log.info({ summary, settledCount }, "ai judgment run manually");
    res.json({ summary: { ...summary, campaignsSettledCount: settledCount }, settings: fresh });
  } catch (err) {
    req.log.error({ err }, "manual ai judgment run failed");
    res.status(500).json({ error: "立即判定執行失敗，請稍後再試" });
  } finally {
    releaseAiJudgmentLock();
  }
});

/**
 * 一鍵解除所有仍在冷卻中的地區冷卻（war_region_cooldowns）。
 * 刪除 expires_at > NOW() 的列（已過期的列不需處理，發起戰役時本就會忽略）。
 * 回傳解除數量；冪等 — 沒有冷卻中的地區時回 0。
 */
router.post(
  "/world-sim/clear-region-cooldowns",
  requireAdmin,
  async (req, res) => {
    try {
      const cleared = await db
        .delete(warRegionCooldownsTable)
        .where(gt(warRegionCooldownsTable.expiresAt, sql`NOW()`))
        .returning({ regionId: warRegionCooldownsTable.regionId });
      req.log.info(
        { clearedCount: cleared.length },
        "war region cooldowns cleared manually",
      );
      res.json({ clearedCount: cleared.length });
    } catch (err) {
      req.log.error({ err }, "failed to clear war region cooldowns");
      res.status(500).json({ error: "解除地區冷卻失敗，請稍後再試" });
    }
  },
);

/**
 * 生成並預覽世界提案（不寫入）。加 aiRateLimit（5/min/IP）。
 * 驗證失敗（提案指向玩家、Σ>100 等）→ 400；AI 格式錯誤或其他 → 502。
 */
router.post(
  "/world-sim/propose",
  requireAdmin,
  aiRateLimit,
  async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const instruction =
      typeof body.instruction === "string" ? body.instruction.trim() : "";
    if (instruction === "") {
      res.status(400).json({ error: "請輸入世界模擬指令" });
      return;
    }
    if (instruction.length > 2000) {
      res.status(400).json({ error: "指令過長（最多 2000 字）" });
      return;
    }

    try {
      const snapshot = await buildWorldSimSnapshot();
      const proposal = await generateWorldProposal({ instruction, ...snapshot });
      const { plan, context } = await previewWorldProposal(proposal);
      const changes = describeWorldPlan(plan, context.nameById);
      res.json({
        proposal,
        summary: plan.summary,
        changes,
        counts: {
          creates: plan.creates.length,
          updates: plan.updates.length,
          deletes: plan.deletes.length,
        },
      });
    } catch (err) {
      if (err instanceof WorldProposalError) {
        res.status(400).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "world sim propose failed");
      res
        .status(502)
        .json({ error: "世界模擬生成失敗，請稍後再試或調整指令" });
    }
  },
);

/**
 * 套用管理員確認後的提案（唯一寫入入口）。提案結構會重新驗證，實際套用於
 * advisory lock 交易內重讀快照再語意驗證，故即使快照在預覽後改變也安全。
 */
router.post("/world-sim/apply", requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const instruction =
    typeof body.instruction === "string" && body.instruction.trim() !== ""
      ? body.instruction.trim().slice(0, 2000)
      : null;

  let proposal;
  try {
    proposal = parseWorldProposal(body.proposal);
  } catch {
    res.status(400).json({ error: "提案格式不正確，請重新生成" });
    return;
  }

  try {
    const result = await applyWorldProposal({
      proposal,
      source: "manual",
      instruction,
    });
    req.log.info(
      {
        auditId: result.auditId,
        created: result.createdNationIds.length,
        updated: result.updatedNationIds.length,
        deleted: result.deletedNationIds.length,
      },
      "world sim proposal applied",
    );
    res.json({ ok: true, result });
  } catch (err) {
    if (err instanceof WorldProposalError) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "world sim apply failed");
    res.status(500).json({ error: "套用世界提案失敗，請稍後再試" });
  }
});

/**
 * 把「world_game_state 全域設定更新」與「所有進行中戰役套用新週期」
 * (applyGlobalWarCycleHours) 包進同一個 DB 交易：若套用戰役階段拋錯，
 * world_game_state 的變更也一起還原，避免留下「設定已改但戰役未跟上」的半套狀態。
 *
 * `opts.applyWarCycle` 供測試注入會拋錯的 stub（預設走真正的 applyGlobalWarCycleHours）；
 * `opts.warCycleHours` 為 undefined 時不套用戰役（僅更新設定），affected 回 0。
 */
export async function applyWorldSimSettingsInTransaction(
  updates: Record<string, unknown>,
  opts: {
    warCycleHours?: number;
    applyWarCycle?: typeof applyGlobalWarCycleHours;
  } = {},
): Promise<{ affected: number }> {
  const applyWarCycle = opts.applyWarCycle ?? applyGlobalWarCycleHours;
  return db.transaction(async (tx) => {
    await tx
      .update(worldGameStateTable)
      .set(updates)
      .where(eq(worldGameStateTable.id, 1));

    let affected = 0;
    if (opts.warCycleHours !== undefined) {
      affected = await applyWarCycle(opts.warCycleHours, new Date(), tx);
    }
    return { affected };
  });
}

/** UUID 格式檢查（篩選參數用，避免無效字串進 DB 才炸型別）。 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 玩家名稱篩選字串長度上限。 */
const GUARD_PLAYER_NAME_FILTER_MAX = 100;

/**
 * Task #501 — 檢視最近的「玩家操縱 NPC 未遂」紀錄（新→舊，至多保留上限筆）。
 * 反操縱守門剔除 NPC 對話讓利動作時寫入；raw fetch、不進 OpenAPI spec。
 *
 * Task #505 — 可選玩家篩選（後端過濾）＋每玩家次數摘要：
 *  - `?playerNationId=<uuid>`：精確比對玩家國家 id。
 *  - `?playerName=<子字串>`：名稱快照不分大小寫子字串比對。
 *  - 回傳 `summary`（保留窗口內每玩家次數，多→少）與 `retention`（=200），
 *    供 UI 明示統計僅涵蓋最近保留的紀錄。
 */
router.get("/world-sim/npc-chat-guard-events", requireAdmin, async (req, res) => {
  try {
    const filter: NpcChatGuardEventFilter = {};

    const rawNationId = req.query.playerNationId;
    if (rawNationId !== undefined) {
      if (typeof rawNationId !== "string" || !UUID_RE.test(rawNationId)) {
        res.status(400).json({ error: "玩家國家 id 格式不正確" });
        return;
      }
      filter.playerNationId = rawNationId;
    }

    const rawName = req.query.playerName;
    if (rawName !== undefined) {
      if (typeof rawName !== "string") {
        res.status(400).json({ error: "玩家名稱篩選格式不正確" });
        return;
      }
      const trimmed = rawName.trim();
      if (trimmed.length > GUARD_PLAYER_NAME_FILTER_MAX) {
        res.status(400).json({
          error: `玩家名稱篩選長度不可超過 ${GUARD_PLAYER_NAME_FILTER_MAX} 字`,
        });
        return;
      }
      if (trimmed.length > 0) filter.playerName = trimmed;
    }

    const [events, summary] = await Promise.all([
      listNpcChatGuardEvents(filter),
      summarizeNpcChatGuardEventsByPlayer(),
    ]);
    res.json({
      retention: NPC_CHAT_GUARD_EVENT_RETENTION,
      summary,
      events: events.map((e) => ({
        id: e.id,
        playerNationId: e.playerNationId,
        npcNationId: e.npcNationId,
        playerName: e.playerName,
        npcName: e.npcName,
        actionType: e.actionType,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "npc chat guard events fetch failed");
    res.status(500).json({ error: "讀取操縱嘗試紀錄失敗，請稍後再試" });
  }
});

/** 檢視最近的 AI 世界變更稽核紀錄（新→舊）。 */
router.get("/world-sim/audits", requireAdmin, async (req, res) => {
  try {
    const audits = await db
      .select({
        id: worldSimAuditsTable.id,
        source: worldSimAuditsTable.source,
        instruction: worldSimAuditsTable.instruction,
        summary: worldSimAuditsTable.summary,
        changes: worldSimAuditsTable.changes,
        createdAt: worldSimAuditsTable.createdAt,
      })
      .from(worldSimAuditsTable)
      .orderBy(desc(worldSimAuditsTable.createdAt))
      .limit(AUDIT_LIST_LIMIT);

    res.json({
      audits: audits.map((a) => ({
        id: a.id,
        source: a.source,
        instruction: a.instruction,
        summary: a.summary,
        changes: a.changes,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "world sim audits fetch failed");
    res.status(500).json({ error: "讀取世界稽核紀錄失敗，請稍後再試" });
  }
});

export default router;
