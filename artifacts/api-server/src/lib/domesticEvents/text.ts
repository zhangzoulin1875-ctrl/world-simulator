import { and, eq } from "drizzle-orm";
import { db, domesticEventsTable, parliamentStateTable, playerNationsTable, type DomesticEventChoiceView } from "@workspace/db";
import { runWithAiPriority, AI_PRIORITY_PREGEN } from "@workspace/integrations-anthropic-ai";
import { AiQuotaExceededError, callGameAi } from "../gameAi";
import { getCurrentEraSlug } from "../nationStats";
import { logger } from "../logger";
import { buildStoryFacts, type StoryFacts } from "../focus/focusStory";
import { getEventDef, type DomesticEventDef } from "./core";

/**
 * 國內事件的文字改寫(2026-10-05):模板文字先上線,背景再用 AI 換成更貼合國情的敘述。
 *
 * 安全設計:
 *  - AI 只看得到「事件種類、政體、各項指標的高低描述」,看不到國名、領導人,更看不到任何效果數字;
 *  - AI 只能改寫 標題 / 敘述 / 三個選項的 label 與 hint;選項 id 與效果永遠以程式目錄為準;
 *  - 輸出必須是嚴格 JSON 且選項 id 與目錄完全一致,否則整份丟棄,保留模板文字。
 */

export const TITLE_MAX = 24;
export const BODY_MAX = 140;
export const LABEL_MAX = 26;
export const HINT_MAX = 40;

export interface EventText {
  title: string;
  body: string;
  choices: DomesticEventChoiceView[];
}

export function buildEventPrompt(def: DomesticEventDef, f: StoryFacts): string {
  const list = def.choices
    .map((c) => `- ${c.id}(${c.style === "comply" ? "順應" : c.style === "crackdown" ? "強硬鎮壓" : "拖延或折衷"}):原文「${c.label}」`)
    .join("\n");
  return `你是一款歷史架空戰略遊戲的事件撰稿人。請為下面這個國內事件改寫文字,讓它貼合國家目前的處境。

事件:${def.title}
原始敘述:${def.body}
選項(id 必須原樣保留):
${list}

國家處境(只有高低描述,沒有具體數字):
- 政體:${f.governmentLabel}
- 國內穩定:${f.stability}
- 政治支持:${f.politicalSupport}
- 軍方情緒:${f.militaryMood}
- 議會情緒:${f.parliamentMood}

輸出規則:
- 只輸出一個 JSON 物件,不要 Markdown、不要任何其他文字。格式:
  {"title":"...","body":"...","choices":[{"id":"...","label":"...","hint":"..."}, ...]}
- title 不超過 ${TITLE_MAX} 字;body 不超過 ${BODY_MAX} 字;label 不超過 ${LABEL_MAX} 字;hint 不超過 ${HINT_MAX} 字。
- choices 必須恰好包含上面列出的每一個 id,順序與風格不變;label 是玩家會做的事,hint 是一句話說明代價(不要寫任何數字)。
- 不要出現國名、人名、領導人;用「本國」「政府」「議會」等泛稱。
- 語氣像新聞或官方公報,不要誇張,不要提到遊戲、數值或選項效果。`;
}

const clip = (s: unknown, max: number): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? null : t; // 超長 = 不合格,整份丟棄(不硬截,避免斷句怪異)
};

/** 解析並嚴格驗證 AI 回傳;任何不合格都回 null(保留模板) */
export function parseEventText(raw: string, def: DomesticEventDef): EventText | null {
  let t = raw.trim().replace(/^```[a-z]*\n?|```$/gi, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  t = t.slice(a, b + 1);
  let obj: unknown;
  try { obj = JSON.parse(t); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const title = clip(o["title"], TITLE_MAX);
  const body = clip(o["body"], BODY_MAX);
  if (!title || !body || !Array.isArray(o["choices"])) return null;
  const incoming = o["choices"] as unknown[];
  if (incoming.length !== def.choices.length) return null;
  const choices: DomesticEventChoiceView[] = [];
  for (const base of def.choices) {
    const hit = incoming.find((c) => c && typeof c === "object" && (c as Record<string, unknown>)["id"] === base.id) as Record<string, unknown> | undefined;
    if (!hit) return null;
    const label = clip(hit["label"], LABEL_MAX);
    const hint = clip(hit["hint"], HINT_MAX);
    if (!label || !hint) return null;
    choices.push({ id: base.id, label, hint });
  }
  // 文字裡不能冒出具體數字(避免 AI 亂編「穩定 -30」誤導玩家)
  const all = [title, body, ...choices.flatMap((c) => [c.label, c.hint])].join(" ");
  if (/[0-9０-９]{2,}|[+\-−]\s?[0-9]/.test(all)) return null;
  return { title, body, choices };
}

/**
 * 背景改寫一個事件(不用 await 呼叫;失敗就保留模板)。
 * 只處理仍是 pending 且還沒改寫過的事件;改寫過用 ai_rewritten 標記,不會重複花 AI 額度。
 */
export async function rewriteEventText(
  eventId: string,
  ai: typeof callGameAi = callGameAi,
): Promise<"ai" | "template" | "skipped"> {
  const [ev] = await db.select().from(domesticEventsTable).where(eq(domesticEventsTable.id, eventId));
  if (!ev || ev.status !== "pending" || ev.aiRewritten !== 0) return "skipped";
  const def = getEventDef(ev.kind);
  if (!def) return "skipped";
  // 先標記,避免同一事件被重複排程
  const claimed = await db
    .update(domesticEventsTable)
    .set({ aiRewritten: 1 })
    .where(and(eq(domesticEventsTable.id, eventId), eq(domesticEventsTable.aiRewritten, 0)))
    .returning({ id: domesticEventsTable.id });
  if (claimed.length === 0) return "skipped";

  const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, ev.nationId));
  if (!n) return "skipped";
  const [par] = await db.select({ s: parliamentStateTable.satisfaction }).from(parliamentStateTable).where(eq(parliamentStateTable.nationId, ev.nationId));
  const facts = buildStoryFacts(n, par?.s ?? 60, await getCurrentEraSlug());

  let text: EventText | null = null;
  try {
    const message = await runWithAiPriority(AI_PRIORITY_PREGEN, () =>
      ai("domestic.event", "bulk", { messages: [{ role: "user", content: buildEventPrompt(def, facts) }] }),
    );
    const block = message.content.find((b) => b.type === "text");
    text = parseEventText(block && block.type === "text" ? block.text : "", def);
  } catch (err) {
    if (!(err instanceof AiQuotaExceededError)) logger.warn({ err, eventId }, "domestic event AI rewrite failed; keeping template");
  }
  if (!text) return "template";
  // 玩家可能在 AI 回來前就處理了;只在仍 pending 時覆蓋
  await db
    .update(domesticEventsTable)
    .set({ title: text.title, body: text.body, choices: text.choices })
    .where(and(eq(domesticEventsTable.id, eventId), eq(domesticEventsTable.status, "pending")));
  return "ai";
}

type Queuer = (eventId: string) => void;
const defaultQueuer: Queuer = (eventId) => {
  void rewriteEventText(eventId).catch((err) => {
    logger.error({ err, eventId }, "domestic event rewrite crashed (ignored)");
  });
};
let queuer: Queuer = defaultQueuer;

/** 測試用:換掉背景排程(傳 null 還原) */
export function setEventTextQueuerForTest(fn: Queuer | null): void {
  queuer = fn ?? defaultQueuer;
}

export function queueEventRewrite(eventId: string): void {
  queuer(eventId);
}
