import { z } from "zod";
import { AiQuotaExceededError, callGameAi } from "./gameAi";
import { logger } from "./logger";

/**
 * Task #303 — 看板顧問小tips 生成模組。
 * 玩家存檔自訂「說話風格」時，用 bulk 模型一次產生一批（20–30 則）符合該
 * 風格的遊戲小tips；成功才回傳，失敗直接丟錯（呼叫端回 502 並保留舊tips）。
 * 產出經 zod 驗證，絕不回傳半套資料。
 */

const MIN_TIPS = 20;
const MAX_TIPS = 30;
export const ADVISOR_STYLE_MAX = 200;

const tipsSchema = z.object({
  tips: z
    .array(z.string().trim().min(2).max(80))
    .min(10)
    .max(40),
});

/** 從一段自由文字取出 JSON 物件（容忍模型多包了 ```json 圍欄）。 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  return JSON.parse(body);
}

/**
 * 依玩家自訂說話風格產生一批繁體中文遊戲小tips。
 * @throws 若 AI 呼叫或解析失敗（呼叫端應回 502 並保留既有tips）。
 */
export async function generateAdvisorTips(style: string): Promise<string[]> {
  const prompt = `你是一款「架空世界模擬器」策略遊戲首頁的「看板顧問」角色。玩家可以在這個回合制建國遊戲裡經營國家：建國、世界地圖、軍事、外交、政治、經濟。

請以下面這個「說話風格」人設，產生 ${MIN_TIPS} 到 ${MAX_TIPS} 則簡短的遊戲小提示（tips）。每則都要：
- 使用繁體中文（台灣）。
- 貼合這個遊戲的玩法（建國、地圖、軍事、外交、政治、經濟、回合），給玩家實用或有趣的提醒。
- 完全符合下方指定的說話風格與語氣（人設）。
- 每則不超過 40 個字，是一句可以獨立顯示在對話泡泡裡的短句。
- 內容彼此不重複。

【說話風格人設】
${style}

只輸出 JSON，格式為：{"tips": ["...", "...", ...]}。不要輸出任何其他文字或說明。`;

  let raw = "";
  try {
    const message = await callGameAi("advisor.tips", "bulk", {
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content.find((b) => b.type === "text");
    raw = block && block.type === "text" ? block.text : "";
  } catch (err) {
    // 配額超限是可辨識的營運限制，保留原錯誤讓路由回明確 zh-TW 訊息。
    if (err instanceof AiQuotaExceededError) throw err;
    logger.error({ err }, "advisor tips AI call failed");
    throw new Error("顧問小提示產生失敗，請稍後再試（已保留原本的提示）");
  }

  let parsed: z.infer<typeof tipsSchema>;
  try {
    parsed = tipsSchema.parse(extractJson(raw));
  } catch (err) {
    logger.error({ err, raw }, "advisor tips parse/validation failed");
    throw new Error("顧問小提示產生失敗，請稍後再試（已保留原本的提示）");
  }

  // 去除重複、截去空白，最多保留 MAX_TIPS 則。
  const seen = new Set<string>();
  const tips: string[] = [];
  for (const t of parsed.tips) {
    const clean = t.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    tips.push(clean);
    if (tips.length >= MAX_TIPS) break;
  }
  if (tips.length === 0) {
    throw new Error("顧問小提示產生失敗，請稍後再試（已保留原本的提示）");
  }
  return tips;
}
