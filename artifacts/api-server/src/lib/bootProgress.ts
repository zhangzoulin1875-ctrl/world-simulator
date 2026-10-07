/**
 * 開機進度追蹤。
 *
 * 為什麼需要：伺服器先開 port 再跑幾十步遷移（讓 Render 健康檢查通過），遷移完才啟動機器人、
 * 看門狗、回合迴圈。若其中一步卡住，port 還開著、/healthz 仍回 200、Render 不會重啟，
 * 但後面的一切都沒啟動——而且外部完全看不出來。這裡記錄每一步的開始／完成時間，
 * 並曝露「目前卡在哪一步、卡多久」，讓 /healthz/bot 能直接告訴你原因。
 */
import { logger } from "./logger";

export const SLOW_STEP_WARN_MS = 60_000;

export interface BootSnapshot {
  phase: "starting" | "migrating" | "running" | "failed";
  currentStep: string | null;
  currentStepForSec: number | null;
  completedSteps: number;
  failedSteps: Array<{ name: string; error: string }>;
  slowestStep: { name: string; ms: number } | null;
  backgroundStartedAt: string | null;
  bootedForSec: number;
}

const t = {
  bootAt: Date.now(),
  phase: "starting" as BootSnapshot["phase"],
  currentStep: null as string | null,
  currentStepAt: 0,
  completed: 0,
  failed: [] as Array<{ name: string; error: string }>,
  slowest: null as { name: string; ms: number } | null,
  backgroundAt: null as number | null,
};

/** 測試用：重設狀態。 */
export function __resetBootProgressForTest(): void {
  t.bootAt = Date.now(); t.phase = "starting"; t.currentStep = null; t.currentStepAt = 0;
  t.completed = 0; t.failed = []; t.slowest = null; t.backgroundAt = null;
}

export function bootPhase(phase: BootSnapshot["phase"]): void {
  t.phase = phase;
}

export function markBackgroundStarted(): void {
  t.backgroundAt = Date.now();
  t.phase = "running";
  t.currentStep = null;
}

/**
 * 執行一個開機步驟並記錄。步驟拋錯時照樣往上拋（維持原本行為），只多記一筆；
 * 超過 SLOW_STEP_WARN_MS 還沒結束就記一次警告（不中斷步驟）。
 */
export async function bootStep<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  t.currentStep = name;
  t.currentStepAt = Date.now();
  const started = t.currentStepAt;
  const warn = setTimeout(() => {
    logger.warn({ step: name, seconds: Math.round((Date.now() - started) / 1000) }, "Startup step is taking very long");
  }, SLOW_STEP_WARN_MS);
  warn.unref();
  try {
    return await fn();
  } catch (err) {
    t.failed.push({ name, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
    throw err;
  } finally {
    clearTimeout(warn);
    const ms = Date.now() - started;
    t.completed += 1;
    if (!t.slowest || ms > t.slowest.ms) t.slowest = { name, ms };
    if (t.currentStep === name) t.currentStep = null;
  }
}

export function getBootSnapshot(now = Date.now()): BootSnapshot {
  return {
    phase: t.phase,
    currentStep: t.currentStep,
    currentStepForSec: t.currentStep ? Math.round((now - t.currentStepAt) / 1000) : null,
    completedSteps: t.completed,
    failedSteps: t.failed.slice(-5),
    slowestStep: t.slowest,
    backgroundStartedAt: t.backgroundAt ? new Date(t.backgroundAt).toISOString() : null,
    bootedForSec: Math.round((now - t.bootAt) / 1000),
  };
}
