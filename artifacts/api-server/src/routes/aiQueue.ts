import { Router, type IRouter } from "express";
import { getAiQueueStats } from "@workspace/integrations-anthropic-ai";

/**
 * AI 佇列即時狀態（公開唯讀）。前端輪詢這裡顯示「AI 排隊中：N 件，
 * 預計約 X」的提示，讓玩家在觸發 AI 操作前對等待時間有預期。
 * 只含佇列深度與估算毫秒數，不含任何機敏資訊。
 */
const router: IRouter = Router();

router.get("/api/ai-queue", (_req, res) => {
  res.json(getAiQueueStats());
});

export default router;
