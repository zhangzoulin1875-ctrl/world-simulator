import { and, eq } from "drizzle-orm";
import { db, focusTextOverridesTable, parliamentStateTable, playerNationsTable } from "@workspace/db";
import { runWithAiPriority, AI_PRIORITY_PREGEN } from "@workspace/integrations-anthropic-ai";
import { AiQuotaExceededError, callGameAi } from "../gameAi";
import { getCurrentEraSlug } from "../nationStats";
import { logger } from "../logger";
import { getFocusDef } from "./catalog";
import type { FocusDef } from "./types";

/**
 * 國策「發動背景故事」(帶入感):玩家推行國策時,依國家客觀狀態請 AI 寫一小段開場故事。
 *
 * 設計重點:
 *  - 絕不阻塞推行:排進背景佇列(低優先,不擠掉即時遊戲 AI),失敗/額度滿就寫模板句。
 *  - 每國每國策只一筆(focus_text_overrides 唯一索引),寫過不重寫。
 *  - 國名、領導人、玩家名稱一律不進 prompt(沿用專案規則);只給政體、數值區間、時代與國策本身。
 *  - 只為玩家生成;NPC 不經 startFocus,所以不耗額度。
 */

export type StorySource = "ai" | "template";

/** 餵給 AI 的國家客觀事實:全部是分級後的描述,不含名稱 */
export interface StoryFacts {
  governmentLabel: string;
  eraSlug: string;
  stability: string;
  politicalSupport: string;
  militaryMood: string;
  parliamentMood: string;
}

/** 0-100 數值 -> 文字分級(避免 AI 直接複述數字,也讓 prompt 固定、可測) */
export function band(v: number): string {
  if (v >= 80) return "很高";
  if (v >= 60) return "偏高";
  if (v >= 40) return "普通";
  if (v >= 20) return "偏低";
  return "很低";
}

export function buildStoryFacts(
  n: { government: string | null; stability: number; politicalSupport: number; satisfactionMilitary: number },
  parliamentSatisfaction: number,
  eraSlug: string,
): StoryFacts {
  return {
    governmentLabel: n.government ?? "未知政體",
    eraSlug,
    stability: band(n.stability),
    politicalSupport: band(n.politicalSupport),
    militaryMood: band(n.satisfactionMilitary),
    parliamentMood: band(parliamentSatisfaction),
  };
}

export const STORY_MAX_CHARS = 260;

export function buildStoryPrompt(def: Pick<FocusDef, "title" | "description" | "track" | "turns">, f: StoryFacts): string {
  const trackHint =
    def.track === "red" ? "這是一條激進的紅線(左翼/革命)路線"
    : def.track === "black" ? "這是一條強硬的黑線(集權/軍事)路線"
    : def.track === "reform" ? "這是一條漸進的改革路線"
    : "這是一條求穩的路線";
  return `你是架空世界歷史小說的旁白。請為下面這項國策寫一段「發動背景故事」,讓玩家有身歷其境的感覺。

國策:${def.title}
國策說明:${def.description}
${trackHint},預計推行約 ${def.turns} 個回合。

這個國家目前的處境(已分級,不要照抄字詞):
- 現行政體:${f.governmentLabel}
- 社會穩定:${f.stability}
- 政府支持度:${f.politicalSupport}
- 軍方情緒:${f.militaryMood}
- 議會情緒:${f.parliamentMood}

寫作要求:
- 繁體中文,一段話,${STORY_MAX_CHARS} 字以內,敘事口吻,交代「為什麼在這個時刻要走這一步」。
- 要讓處境影響故事(例如穩定很低就寫動盪,軍方情緒低就寫軍方的不滿)。
- 不要出現任何真實國家、真實人物、具體國名或領導人姓名;用「政府」「議會」「軍方」「民眾」等泛稱。
- 不要列點、不要標題、不要加引號或 Markdown,不要提到數值或「分級」。
- 只輸出故事本文。`;
}

/** 清理 AI 輸出:去掉程式碼框/引號/多餘空白,並裁到長度上限 */
export function cleanStory(raw: string): string | null {
  let t = raw.trim().replace(/^```[a-z]*\n?|```$/gi, "").trim();
  t = t.replace(/^["「『]+|["」』]+$/g, "").replace(/\s+/g, " ").trim();
  if (t.length < 20) return null; // 太短 = 失敗輸出
  if (t.length > STORY_MAX_CHARS) t = `${t.slice(0, STORY_MAX_CHARS - 1)}…`;
  return t;
}

/** AI 不可用時的降級模板(依路線與處境,至少有一句能讀的開場) */
export function templateStory(def: Pick<FocusDef, "title" | "track">, f: StoryFacts): string {
  const mood = f.stability === "很低" || f.stability === "偏低" ? "局勢動盪、人心浮動" : f.stability === "很高" || f.stability === "偏高" ? "國內大致安定" : "國內局勢尚稱平穩";
  const why =
    def.track === "red" ? "民間累積的不滿終於找到了出口"
    : def.track === "black" ? "強硬派認為只有集中權力才能穩住局面"
    : def.track === "reform" ? "朝野都意識到舊制度已經跟不上時代"
    : "決策者判斷此時應當穩紮穩打";
  return `${mood}。${why},政府決定推行「${def.title}」。這將牽動整個國家機器,成敗要看接下來幾個回合。`;
}

export interface StoryRow {
  focusId: string;
  story: string;
  source: StorySource;
}

/** 讀取這個國家已寫好的故事(前端顯示用) */
export async function getStoriesForNation(nationId: string): Promise<Map<string, StoryRow>> {
  const rows = await db.select().from(focusTextOverridesTable).where(eq(focusTextOverridesTable.nationId, nationId));
  return new Map(rows.filter((r) => r.flavor).map((r) => [r.focusId, { focusId: r.focusId, story: r.flavor!, source: r.source as StorySource }]));
}

async function saveStory(nationId: string, def: FocusDef, story: string, source: StorySource): Promise<void> {
  await db
    .insert(focusTextOverridesTable)
    .values({ nationId, focusId: def.id, title: def.title, description: def.description, flavor: story, source })
    .onConflictDoNothing();
}

/**
 * 產生並保存故事(可被 await;呼叫端通常用 queueFocusStory 丟背景)。
 * 已經有故事就直接略過(不重抽);AI 失敗/額度滿/輸出太短 -> 存模板。
 * 回傳最後存進去的來源,方便測試。
 */
export async function generateFocusStory(
  nationId: string,
  focusId: string,
  ai: typeof callGameAi = callGameAi,
): Promise<StorySource | "exists" | "skipped"> {
  const def = getFocusDef(focusId);
  if (!def) return "skipped";
  const [exists] = await db
    .select({ id: focusTextOverridesTable.id })
    .from(focusTextOverridesTable)
    .where(and(eq(focusTextOverridesTable.nationId, nationId), eq(focusTextOverridesTable.focusId, focusId)));
  if (exists) return "exists";

  const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  if (!n) return "skipped";
  const [par] = await db.select({ s: parliamentStateTable.satisfaction }).from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  const facts = buildStoryFacts(n, par?.s ?? 60, await getCurrentEraSlug());

  let story: string | null = null;
  try {
    const message = await runWithAiPriority(AI_PRIORITY_PREGEN, () =>
      ai("focus.story", "bulk", { messages: [{ role: "user", content: buildStoryPrompt(def, facts) }] }),
    );
    const block = message.content.find((b) => b.type === "text");
    story = cleanStory(block && block.type === "text" ? block.text : "");
  } catch (err) {
    if (!(err instanceof AiQuotaExceededError)) logger.warn({ err, nationId, focusId }, "focus story AI failed; using template");
  }
  const source: StorySource = story ? "ai" : "template";
  await saveStory(nationId, def, story ?? templateStory(def, facts), source);
  return source;
}

type StoryQueuer = (nationId: string, focusId: string) => void;

const defaultQueuer: StoryQueuer = (nationId, focusId) => {
  void generateFocusStory(nationId, focusId).catch((err) => {
    logger.error({ err, nationId, focusId }, "focus story generation crashed (ignored)");
  });
};

let queuer: StoryQueuer = defaultQueuer;

/**
 * 測試用:換掉「排背景故事」的動作(傳 null 還原)。
 * 整合測試會大量呼叫 startFocus,不換掉的話每次都會真的去打 AI 並在測試清理資料時還在背景寫入,
 * 造成跨測試檔的資料競爭。
 */
export function setStoryQueuerForTest(fn: StoryQueuer | null): void {
  queuer = fn ?? defaultQueuer;
}

/** 推行國策後丟到背景:不等結果、不丟錯,絕不影響推行本身 */
export function queueFocusStory(nationId: string, focusId: string): void {
  queuer(nationId, focusId);
}
