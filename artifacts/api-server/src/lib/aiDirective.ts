import { eq } from "drizzle-orm";
import { db, worldGameStateTable } from "@workspace/db";

/**
 * Task #233 — AI 外交/戰役判定的「管理員干預指令」存取與長度上限。
 *
 * 干預指令是單一全域自然語言方針（存於 world_game_state.ai_judgment_directive），
 * 會注入 NPC 外交（主動提案／條約回覆／對話）與戰役指令的 AI 提示，作為最高優先
 * 方針。空字串／未設定一律視為「無方針」（回 null）。
 */
export const AI_DIRECTIVE_MAX_LENGTH = 1000;

/** 讀取目前的干預指令；空字串／未設定回 null。 */
export async function getAiJudgmentDirective(): Promise<string | null> {
  const [row] = await db
    .select({ directive: worldGameStateTable.aiJudgmentDirective })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return normalizeDirective(row?.directive ?? null);
}

/** 純函式：去除頭尾空白，空字串回 null。 */
export function normalizeDirective(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
