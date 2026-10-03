/**
 * Task #333 — 超事件系統的每回合結算。
 *
 * 由回合引擎每回合呼叫一次（politics/economy 結算之後）。流程：
 * 1. 依 settings.autoGenerateChancePct 擲骰，機率命中則 AI 生成一則新的全球事件。
 * 2. 逐一處理所有 active 事件：AI 判定本回合發展與數值影響 → 套用到受影響國家
 *    （人口／生產素質／滿意度／穩定度／暴動度）→ 可能賦予跨時代關鍵科技、觸發
 *    NPC 敵對行動 → 判定玩家的待判定應對 → 寫入回合紀錄 → 更新／結束事件。
 *
 * 與其他結算一致：AI 只給敘事與幅度，實際套用與夾限由本模組決定；單一事件或
 * 單一國家出錯只記 log 並跳過，絕不讓回合結算中斷。
 *
 * 本檔為 barrel：實作已拆分至 ./superEventSettlement/ 資料夾，這裡照舊 re-export
 * 所有既有公開符號，讓原路徑的 import（index.ts、routes、tests）維持不變。
 */

export type { SuperEventSettlementSummary } from "./superEventSettlement/types";
export { runSuperEventSettlement } from "./superEventSettlement/runner";
export { settleEvent } from "./superEventSettlement/settleEvent";
export { loadAffectedPlayers } from "./superEventSettlement/affectedNations";
export { notifyNewSuperEvent } from "./superEventSettlement/notify";
export {
  POLITICS_SUPER_EVENT_CHANCE_PCT,
  maybeTriggerPoliticalSuperEvent,
} from "./superEventSettlement/generate";
export { buildEffectSummary } from "./superEventSettlement/applyEffect";
export { buildResponseSummary } from "./superEventSettlement/responses";
