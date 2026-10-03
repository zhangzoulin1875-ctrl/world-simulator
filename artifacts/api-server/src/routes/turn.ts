import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, worldGameStateTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { ERAS, getEraIndex } from "../lib/mapRegionEras";
import {
  ERA_START_YEARS,
  MAX_GAME_YEAR,
  MIN_GAME_YEAR,
  buildGameDate,
  computeTurnProgress,
  eraForYear,
  normalizeTurnTimes,
  parseTurnTimes,
  runTurnUpdate,
  yearOfGameDate,
} from "../lib/turnEngine";
import { localDateString } from "../lib/time";
import { invalidateGlobalAveragePopulationCache } from "../lib/researchCost";

// ── 回合引擎管理端（requireAdmin raw-fetch，不進 OpenAPI spec） ──────────

const router: IRouter = Router();

async function readState() {
  const [state] = await db
    .select({
      currentEra: worldGameStateTable.currentEra,
      statsEra: worldGameStateTable.statsEra,
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      turnTimes: worldGameStateTable.turnTimes,
      yearsPerTurn: worldGameStateTable.yearsPerTurn,
      moneyIncomePct: worldGameStateTable.moneyIncomePct,
      populationGrowthMultiplierPct:
        worldGameStateTable.populationGrowthMultiplierPct,
      productionMultiplierPct: worldGameStateTable.productionMultiplierPct,
      techMultiplierPct: worldGameStateTable.techMultiplierPct,
      aheadEraCostMultiplier: worldGameStateTable.aheadEraCostMultiplier,
      lastTurnDate: worldGameStateTable.lastTurnDate,
      lastTurnAt: worldGameStateTable.lastTurnAt,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return state ?? null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function serializeState(state: NonNullable<Awaited<ReturnType<typeof readState>>>) {
  const year = yearOfGameDate(state.gameDate);
  const eraLabel = ERAS[getEraIndex(state.currentEra)]?.label ?? state.currentEra;
  const statsEra = state.statsEra ?? state.currentEra;
  const statsEraLabel = ERAS[getEraIndex(statsEra)]?.label ?? statsEra;
  const now = new Date();
  const today = localDateString(now);
  const turnTimes = normalizeTurnTimes(state.turnTimes);
  const progress = computeTurnProgress(
    turnTimes,
    now,
    state.lastTurnAt ?? null,
    today,
  );
  return {
    gameDate: state.gameDate,
    year,
    currentEra: state.currentEra,
    currentEraLabel: eraLabel,
    statsEra,
    statsEraLabel,
    turnTimes,
    yearsPerTurn: state.yearsPerTurn,
    moneyIncomePct: state.moneyIncomePct,
    populationGrowthMultiplierPct: state.populationGrowthMultiplierPct,
    productionMultiplierPct: state.productionMultiplierPct,
    techMultiplierPct: state.techMultiplierPct,
    aheadEraCostMultiplier: state.aheadEraCostMultiplier,
    lastTurnDate: state.lastTurnDate,
    lastTurnAt: state.lastTurnAt ? state.lastTurnAt.toISOString() : null,
    runsToday: progress.runsToday,
    totalRunsToday: progress.totalToday,
    nextTurnTime: progress.nextTime
      ? `${pad2(progress.nextTime.hour)}:${pad2(progress.nextTime.minute)}`
      : null,
    ranToday: state.lastTurnDate === today,
    eras: ERA_START_YEARS.map((e) => ({
      slug: e.slug,
      startYear: e.startYear,
      label: ERAS[getEraIndex(e.slug)]!.label,
    })),
  };
}

/** 讀取回合設定與目前世界狀態。 */
router.get("/turn/settings", requireAdmin, async (req, res) => {
  try {
    const state = await readState();
    if (!state) {
      res.status(500).json({ error: "世界狀態尚未初始化" });
      return;
    }
    res.json({ settings: serializeState(state) });
  } catch (err) {
    req.log.error({ err }, "failed to read turn settings");
    res.status(500).json({ error: "讀取回合設定失敗" });
  }
});

function intInRange(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    return null;
  }
  return v;
}

/**
 * 更新回合設定。欄位皆為選填（省略 = 不變）：
 * turnTimes（{hour,minute} 陣列，1–24 筆，每筆 時 0–23／分 0–59，排序去重）、
 * yearsPerTurn 1–100、moneyIncomePct 0–1000、productionMultiplierPct 0–1000、
 * techMultiplierPct 0–1000、aheadEraCostMultiplier 1–100、
 * year 1–9999（改年份會同時依年份重新推導時代，月日保留）、
 * syncEraStats（布林；true = 把「數據時代」同步為（新）當前時代，玩家數據
 * 依新時代預設重算。未勾選時改年份/時代不會動玩家數據）。
 */
router.put("/turn/settings", requireAdmin, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    let syncEraStats = false;
    if (body["syncEraStats"] !== undefined) {
      if (typeof body["syncEraStats"] !== "boolean") {
        res.status(400).json({ error: "syncEraStats 必須是布林值" });
        return;
      }
      syncEraStats = body["syncEraStats"];
    }

    if (body["turnTimes"] !== undefined) {
      const parsed = parseTurnTimes(body["turnTimes"]);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      updates["turnTimes"] = parsed.times;
      // turn_hour/turn_minute 保留作相容／顯示：同步為第一個時刻。
      updates["turnHour"] = parsed.times[0]!.hour;
      updates["turnMinute"] = parsed.times[0]!.minute;
    }
    if (body["yearsPerTurn"] !== undefined) {
      const v = intInRange(body["yearsPerTurn"], 1, 100);
      if (v === null) {
        res.status(400).json({ error: "每回合年數必須是 1–100 的整數" });
        return;
      }
      updates["yearsPerTurn"] = v;
    }
    if (body["moneyIncomePct"] !== undefined) {
      const v = intInRange(body["moneyIncomePct"], 0, 1000);
      if (v === null) {
        res.status(400).json({ error: "金錢收入比例必須是 0–1000 的整數" });
        return;
      }
      updates["moneyIncomePct"] = v;
    }
    if (body["populationGrowthMultiplierPct"] !== undefined) {
      const v = intInRange(body["populationGrowthMultiplierPct"], 0, 100);
      if (v === null) {
        res.status(400).json({ error: "人口增長倍率必須是 0–100 的整數" });
        return;
      }
      updates["populationGrowthMultiplierPct"] = v;
    }
    if (body["productionMultiplierPct"] !== undefined) {
      const v = intInRange(body["productionMultiplierPct"], 0, 1000);
      if (v === null) {
        res.status(400).json({ error: "生產力基礎倍率必須是 0–1000 的整數" });
        return;
      }
      updates["productionMultiplierPct"] = v;
    }
    if (body["techMultiplierPct"] !== undefined) {
      const v = intInRange(body["techMultiplierPct"], 0, 1000);
      if (v === null) {
        res.status(400).json({ error: "科技點數基礎倍率必須是 0–1000 的整數" });
        return;
      }
      updates["techMultiplierPct"] = v;
    }
    if (body["aheadEraCostMultiplier"] !== undefined) {
      const v = intInRange(body["aheadEraCostMultiplier"], 1, 100);
      if (v === null) {
        res
          .status(400)
          .json({ error: "領先時代研發成本倍率必須是 1–100 的整數" });
        return;
      }
      updates["aheadEraCostMultiplier"] = v;
    }

    let yearUpdate: number | null = null;
    if (body["year"] !== undefined) {
      const v = intInRange(body["year"], MIN_GAME_YEAR, MAX_GAME_YEAR);
      if (v === null) {
        res.status(400).json({
          error: `年份必須是 ${MIN_GAME_YEAR}–${MAX_GAME_YEAR} 的整數`,
        });
        return;
      }
      yearUpdate = v;
    }

    if (Object.keys(updates).length === 0 && yearUpdate === null && !syncEraStats) {
      res.status(400).json({ error: "沒有任何要更新的欄位" });
      return;
    }

    const state = await readState();
    if (!state) {
      res.status(500).json({ error: "世界狀態尚未初始化" });
      return;
    }

    if (yearUpdate !== null) {
      // 改年份 → 同一筆 UPDATE 一併寫入依年份推導的時代（單一事實來源）。
      // 「數據時代」stats_era 只在管理員勾選同步預設時才跟著改，
      // 否則玩家數據沿用原本的數據時代、不會被重設成新時代預設值。
      updates["gameDate"] = buildGameDate(yearUpdate, state.gameDate.slice(4));
      updates["currentEra"] = eraForYear(yearUpdate);
    }
    if (syncEraStats) {
      updates["statsEra"] =
        yearUpdate !== null ? eraForYear(yearUpdate) : state.currentEra;
    }
    updates["updatedAt"] = sql`NOW()`;

    await db
      .update(worldGameStateTable)
      .set(updates)
      .where(eq(worldGameStateTable.id, 1));

    // 全域倍率變動時保守地失效人口快取（人口基準不受生產倍率影響，
    // 但其他設定如時代變更可能連帶影響地區人口統計資料）。
    if (updates["productionMultiplierPct"] !== undefined) {
      invalidateGlobalAveragePopulationCache();
    }

    const fresh = await readState();
    req.log.info({ updates: Object.keys(updates) }, "turn settings updated");
    res.json({ settings: fresh ? serializeState(fresh) : null });
  } catch (err) {
    req.log.error({ err }, "failed to update turn settings");
    res.status(500).json({ error: "更新回合設定失敗" });
  }
});

/** 手動執行回合（force：不受一天一次限制，可多次執行；並發中 → 409）。 */
router.post("/turn/run", requireAdmin, async (req, res) => {
  try {
    const summary = await runTurnUpdate(new Date(), { force: true });
    if (!summary.ran) {
      const message =
        summary.reason === "in_flight"
          ? "回合正在執行中，請稍候"
          : "世界狀態尚未初始化，無法執行回合";
      res.status(409).json({ error: message, summary });
      return;
    }
    req.log.info({ dateLabel: summary.dateLabel }, "manual turn executed");
    res.json({ ok: true, summary });
  } catch (err) {
    req.log.error({ err }, "manual turn failed");
    res.status(500).json({ error: "回合執行失敗，請查看伺服器記錄" });
  }
});

export default router;
