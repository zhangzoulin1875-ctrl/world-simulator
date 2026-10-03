import { logger } from "../logger";

// ── 迴圈啟動 ───────────────────────────────────────────────────

export function startWarEngineLoops(): void {
  // Task #228 — 戰役週期結算（settleDueCampaigns）與 NPC 開戰決策（npcWarTick）
  // 已移至 AI 判定迴圈（runAiJudgment，可調頻率）。
  // 全國傷兵池復原已改為回合制（每回合由 turnEngine 呼叫 recoveryTick），
  // 不再需要定時 loop。
  logger.info("war engine loops started (recovery now turn-driven)");
}
