import { z } from "zod";
import { callGameAi } from "./gameAi";
import { logger } from "./logger";

/**
 * Task #184 — 每回合新聞整理 AI（bulk 模型、zod 驗證 JSON）。
 *
 * 回合結算末段把當回合各來源的原始事件（宣戰／締約／時代推進／NPC 興亡／重大
 * 政治）餵給 bulk 模型，請它挑出「值得刊登」的重大事件、以旁觀國際媒體語氣改寫
 * 成精簡繁中新聞條目。只回傳 AI 判定為重大者（可少於輸入、亦可為空）。
 *
 * 失敗（AI 非 JSON 或結構不符）一律丟出例外，由呼叫端（gameNews.runTurnNews）在
 * 獨立 try/catch 吞掉——絕不阻斷回合本身。
 */

/** 允許的新聞分類。 */
export const NEWS_CATEGORIES = [
  "war",
  "treaty",
  "era",
  "rise_fall",
  "politics",
  "world",
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

/** 交給 AI 的單筆原始事件。 */
export interface RawNewsEvent {
  category: NewsCategory;
  /** 一句話描述原始事實（zh-TW），供 AI 判斷重要性與改寫。 */
  fact: string;
}

export interface CurateNewsInput {
  year: number;
  eraLabel: string;
  events: RawNewsEvent[];
  /** 最多回傳幾則（避免單回合過量）。 */
  maxItems: number;
}

/** AI 回傳的單筆新聞。 */
export interface CuratedNewsItem {
  category: NewsCategory;
  title: string;
  body: string;
  significance: "major" | "minor";
}

const curatedItemSchema = z.object({
  category: z.enum(NEWS_CATEGORIES),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(600),
  /** AI 對事件重要性的判定；呼叫端只保留 major。 */
  significance: z.enum(["major", "minor"]),
});

const curatedListSchema = z.object({
  items: z.array(curatedItemSchema),
});

function buildSystemPrompt(): string {
  return [
    "你是一款架空世界戰略遊戲的國際新聞編輯 AI。",
    "會給你「本回合發生的原始事件清單」，請以中立旁觀的國際／國內媒體語氣，",
    "挑出其中『重大、值得刊登』的事件，改寫成精簡的繁體中文（台灣）新聞條目。",
    "規則：",
    "- 只保留重大事件（例如宣戰、締結同盟、時代推進、國家興亡、政變／政體更替）；瑣碎或例行事件請略過。",
    "- 為每則新聞標註 significance：\"major\"（重大、值得刊登）或 \"minor\"（次要）；只有 major 會被採用。",
    "- 忠於事實，不得杜撰未提供的國名、數字或結果。",
    "- title 為簡短標題（不超過約 30 字）；body 為 1～3 句報導。",
    "- category 必須沿用該事件原本的分類。",
    "- 全部使用繁體中文（台灣），僅專有名詞可保留原文。",
    "- 僅回覆單一 JSON 物件 {\"items\":[{category,title,body,significance}...]}，不要 code fence、不要任何前後文字；若無重大事件則回 {\"items\":[]}。",
  ].join("\n");
}

function buildUserPrompt(input: CurateNewsInput): string {
  const eventLines = input.events.map(
    (e, i) => `${i + 1}. [${e.category}] ${e.fact}`,
  );
  return [
    `世界目前年份：西元 ${input.year} 年　時代：${input.eraLabel}`,
    `最多挑選 ${input.maxItems} 則最重要的事件。`,
    "",
    "本回合原始事件：",
    ...eventLines,
    "",
    '僅回覆單一 JSON 物件，形如 {"items":[{"category":"war","title":"...","body":"..."}]}。',
  ].join("\n");
}

function parseCuratedJson(raw: string): CuratedNewsItem[] {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed = curatedListSchema.parse(JSON.parse(cleaned));
  return parsed.items;
}

/**
 * 請 bulk 模型從原始事件中挑出重大者並改寫成新聞。回傳可能為空陣列（無重大
 * 事件）。失敗丟出例外。
 */
export async function curateGameNews(
  input: CurateNewsInput,
): Promise<CuratedNewsItem[]> {
  const message = await callGameAi("game_news.turn_news", "bulk", {
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";

  try {
    return parseCuratedJson(raw)
      .filter((item) => item.significance === "major")
      .slice(0, input.maxItems);
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 800) },
      "game news curation parse failed",
    );
    throw new Error("每回合新聞 AI 回覆格式不正確");
  }
}
