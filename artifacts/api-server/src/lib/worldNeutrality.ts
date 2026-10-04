/**
 * 世界中立化：遊戲是「全球架空歷史」，玩家可以在任何地區開局。
 * 時代顯示名稱（ERAS[].label）帶有中國朝代括號（秦朝、漢朝…）是給介面用的，
 * 一旦原樣放進 AI prompt，AI 會把所有玩家都當成中國人，連在南美洲的國家
 * 都拿「秦朝工藝」「中原文化」當基準。
 *
 * 這裡集中處理：
 *  1. stripChineseDynasty：把 AI 看到的時代標籤去掉中國朝代括號。
 *  2. WORLD_NEUTRALITY_PREAMBLE：所有 AI 呼叫的 system prompt 共同前言。
 */

/** 「古典時代(秦朝)」→「古典時代」；全形／半形括號都處理。 */
const DYNASTY_PAREN =
  /\s*[(（]\s*(?:秦|漢|唐|宋|元|明|清|隋|晉|三國|魏晉|南北朝|五代|春秋|戰國|西周|東周|商|夏)[朝代]?[^()（）]{0,6}[)）]/g;

export function stripChineseDynasty(text: string): string {
  return text.replace(DYNASTY_PAREN, "");
}

/** 時代名稱 → 給 AI 看的中立版本。 */
export function eraLabelForAi(label: string): string {
  return stripChineseDynasty(label);
}

export const WORLD_NEUTRALITY_PREAMBLE = [
  "【世界中立原則（最高優先，適用所有判斷與敘事）】",
  "- 這是全球架空歷史遊戲：玩家可能在世界任何地區建國（美洲、非洲、歐洲、中東、南亞、大洋洲、東亞皆有），不可預設玩家位於中國或東亞，也不可以中原王朝（秦漢唐宋明清）作為時代、科技、文化、制度、裝備、礦產或貿易的基準。",
  "- 「當前時代」只代表全球科技與社會發展的大致階段，不代表玩家所在地有某個朝代。文化、名稱、典故、制度一律以『玩家國家實際掌控地區』的在地文明為準；若未提供地區資訊，使用中性、跨文化的描述，不要預設中華風格。",
  "- 不得因『該地區在真實歷史上與其他地區沒有貿易、交通或技術交流』、『該地區原本沒有某種動物、礦產、作物或技術』而駁回或貶低玩家的請求——這是架空歷史，貿易、征服、外交與遊戲內資源都可以讓玩家取得同時代世界上已存在的物資與技術。只有『該技術在當前年份世界上根本尚未出現』才算超時代。",
  "- 舉例與類比請用多元文化（例如：青銅短劍、黑曜石刃、鐵製長矛、藤盾、投石索、長弓、彎刀皆可），不要只拿中國兵器或朝代舉例。",
].join("\n");

/** 把中立前言接在既有 system prompt 之前（已含則不重複加）。 */
export function withWorldNeutrality(system: string | undefined): string {
  if (!system) return WORLD_NEUTRALITY_PREAMBLE;
  if (system.includes("【世界中立原則")) return system;
  return `${WORLD_NEUTRALITY_PREAMBLE}\n\n${system}`;
}
