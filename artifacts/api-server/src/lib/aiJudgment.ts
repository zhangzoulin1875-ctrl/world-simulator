import { logger } from "./logger";
import { npcWarTick, settleDueCampaigns } from "./warEngine";

/**
 * AI 戰役判定（由 worldScheduler 依管理員設定頻率驅動）。
 *
 * 統一驅動兩件事，各自獨立 try/catch，任一失敗不阻斷其他：
 *  1. NPC 開戰決策（npcWarTick，依既有規則對進行中戰爭發起戰役）。
 *  2. 戰役週期推進/結算（settleDueCampaigns，結算到期的戰役週期）。
 *
 * 註：NPC 主動行動（runNpcInitiativesTurn — 自行提案條約／宣戰／結盟）已停用。
 * NPC 不再自行發動外交或戰爭，只會在既有戰爭中應戰；NPC 仍會回應玩家主動送來的
 * 條約與對話（見 diplomacyAi 的 decideNpcTreatyResponse／decideNpcChatReply）。
 */
export interface AiJudgmentSummary {
  npcWarTicked: boolean;
  campaignsSettled: boolean;
}

export async function runAiJudgment(): Promise<AiJudgmentSummary> {
  const summary: AiJudgmentSummary = {
    npcWarTicked: false,
    campaignsSettled: false,
  };

  // 1) NPC 開戰決策（對進行中戰爭發起戰役）。
  try {
    await npcWarTick();
    summary.npcWarTicked = true;
  } catch (err) {
    logger.error({ err }, "ai judgment: npc war tick failed");
  }

  // 2) 戰役週期推進/結算。
  try {
    await settleDueCampaigns();
    summary.campaignsSettled = true;
  } catch (err) {
    logger.error({ err }, "ai judgment: campaign settlement failed");
  }

  return summary;
}
