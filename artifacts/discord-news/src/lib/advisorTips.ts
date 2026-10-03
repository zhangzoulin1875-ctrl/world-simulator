/**
 * Task #306 — 看板顧問閒置小tip 的「題庫選擇」純函式。
 *
 * 首頁沒有待辦提醒時，顧問會隨機彈出一則小tip。優先使用玩家自訂說話風格
 * 產生的 advisorTips；當該清單為空（未設定風格、或 AI 尚未產生）時，退回
 * 內建固定題庫。抽離成純函式以便單元測試（元件本身無法在 tsx --test 下渲染）。
 */

/** 沒有玩家自訂 tips 時使用的內建固定題庫。 */
export const BUILTIN_TIPS: readonly string[] = [
  "別忘了每回合到經濟頁檢查稅收與預算的平衡。",
  "低稅率能安撫民心，但國庫也會跟著吃緊喔。",
  "地圖上相鄰的地區才能發動戰役，先看清楚邊界再出兵。",
  "外交關係良好時，締結同盟或互不侵犯條約會更順利。",
  "科技點數累積得夠多，就能解鎖新時代的兵種與政體。",
  "軍隊有上限，招募前先確認人口與生產力夠不夠。",
  "傷兵會隨回合慢慢歸隊，別急著把他們當陣亡處理。",
  "安定度高時生產力與科技都會加成，內政別荒廢。",
  "動亂度太高可能引發政變，記得留意四大滿意度。",
  "預算分配低於 5% 的項目，該領域的滿意度會下降。",
  "宣戰前先確認關係值為負，否則無法對該國開戰。",
  "無主國家可以被接手——地圖上也許有現成的國家等你。",
  "內閣可以幫你自動處理小決策，重大事項才需要你批准。",
  "多留意世界新聞，別人的興衰往往是你的機會。",
  "厭戰度過高會削弱軍隊，長期戰爭要適時停火休養。",
];

/**
 * 選出閒置小tip 的題庫：有玩家自訂 tips 就用自訂的，否則退回內建題庫。
 * @param customTips 玩家自訂風格產生的 tips（可能為 undefined／空陣列）。
 * @param builtin 內建固定題庫（預設 BUILTIN_TIPS）。
 */
export function resolveTipPool(
  customTips: readonly string[] | undefined | null,
  builtin: readonly string[] = BUILTIN_TIPS,
): readonly string[] {
  return customTips && customTips.length > 0 ? customTips : builtin;
}
