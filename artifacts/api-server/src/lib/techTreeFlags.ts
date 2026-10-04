/**
 * 舊科技樹總開關(零依賴,避免 techTreeTurn / npcTechTree / techTreeResearch
 * 之間的 import 循環)。
 *
 * false = 下線(現況):
 * - 回合結算不再把科研點灌進任何節點,也不消耗庫存科技點;
 * - 研發 / 取消 / 分配 API 與內閣選研一律回 410 或空候選;
 * - 關鍵技術改由 eraUnlockedTech.ts 依世界時代自動解鎖。
 *
 * 舊資料表全數保留,改回 true 並恢復前端即可還原整條舊管線。
 */
export const TECH_TREE_RESEARCH_ENABLED = false;
