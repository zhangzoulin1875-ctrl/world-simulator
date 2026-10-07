import { z } from "zod";
import { callGameAiParsed } from "../gameAi";
import { logger } from "../logger";
import { ERAS, getEraIndex } from "../mapRegionEras";
import { STANCE_LABELS, type ParliamentStance } from "./core";

/**
 * 政黨命名：規則決定「有哪幾個立場、各占多少席」，AI 只負責取名與一句黨綱。
 * 立場、權重、席次、遵守判定都不由 AI 動；失敗／輸出不合格就整批退回模板名。
 */

export interface PartyNameRequest { id: string; stance: ParliamentStance; seats: number }
export interface PartyNameResult { id: string; name: string; description: string }

export interface PartyNameInput {
  eraSlug: string;
  /** buildNationContext 的國情快照。 */
  context: string;
  parties: readonly PartyNameRequest[];
  /** 同國上一屆議會的黨名，供 AI 延續命名風格；也用來避免與前任無故重名。 */
  previousNames?: readonly string[];
}

const NAME_MIN = 2;
const NAME_MAX = 12;
const DESC_MAX = 60;

/** 模板名的特徵：立場標籤去「派」字後直接接黨/聯盟/陣線。出現這種名字等於 AI 偷懶，視為不合格。 */
export function isTemplateName(name: string, stance: ParliamentStance): boolean {
  const base = STANCE_LABELS[stance].replace(/派$/, "");
  return new RegExp(`^${base}(黨|聯盟|陣線)$`).test(name.trim());
}

const FORBIDDEN = /(?:\p{Cc}|[<>{}\[\]\\"'`])/u;

export function validatePartyNames(
  raw: unknown,
  requested: readonly PartyNameRequest[],
): PartyNameResult[] {
  const schema = z.object({
    parties: z.array(z.object({
      id: z.string(),
      name: z.string().trim(),
      description: z.string().trim().max(DESC_MAX * 2).catch(""),
    })),
  });
  const parsed = schema.parse(raw);
  const byId = new Map(parsed.parties.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: PartyNameResult[] = [];
  for (const req of requested) {
    const p = byId.get(req.id);
    if (!p) throw new Error(`missing party ${req.id}`);
    const len = [...p.name].length;
    if (len < NAME_MIN || len > NAME_MAX) throw new Error(`bad name length: ${p.name}`);
    if (FORBIDDEN.test(p.name)) throw new Error(`bad chars in name: ${p.name}`);
    if (isTemplateName(p.name, req.stance)) throw new Error(`template-like name: ${p.name}`);
    if (seen.has(p.name)) throw new Error(`duplicate name: ${p.name}`);
    seen.add(p.name);
    const desc = FORBIDDEN.test(p.description) ? "" : [...p.description].slice(0, DESC_MAX).join("");
    out.push({ id: req.id, name: p.name, description: desc });
  }
  return out;
}

function parseJson(raw: string, requested: readonly PartyNameRequest[]): PartyNameResult[] {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  return validatePartyNames(JSON.parse(cleaned), requested);
}

export async function generatePartyNames(input: PartyNameInput): Promise<PartyNameResult[] | null> {
  if (input.parties.length === 0) return null;
  try {
    const era = ERAS[getEraIndex(input.eraSlug)]!;
    const system = [
      "你是一款架空世界戰略遊戲的政治設定師。請替議會裡的每個政黨取一個有個性的名字，並寫一句黨綱。僅回覆 JSON：",
      '{"parties":[{"id":"<原樣照抄>","name":"黨名(2~12字)","description":"一句黨綱(不超過50字)"}]}',
      "規則：",
      "1. 黨名要像真實歷史上的政黨：可用地名、人物稱號、象徵物、口號、歷史事件、理念（例如「赤鷹同盟」「南岸共濟會」「青銅議事團」），結尾可以是黨、會、盟、社、陣線、聯合、議事團等，不必都叫『黨』。",
      "2. 嚴禁直接把立場標籤加『黨』當名字（不可叫『和平黨』『擴軍黨』『商貿黨』『宗教黨』『世俗黨』『福利黨』這類）；立場要透過名字的意象或黨綱表達。",
      "3. 黨名必須符合當前時代的語感，不得出現時代錯置的詞（古代不要有『民主進步』『社會主義』等現代詞）。",
      "4. 每個黨名都要不同、風格彼此有差異；不得使用現實存在的政黨名稱。",
      "5. 黨綱要貼合該黨立場與國家現況，具體、不空泛，不得提到具體數值。",
      "6. 不得改動 id，數量必須與請求一致。",
    ].join("\n");
    const lines = input.parties.map((p) =>
      `- id=${p.id}｜立場：${STANCE_LABELS[p.stance]}｜席次：${p.seats}`);
    const user = [
      `當前時代：${era.label}`,
      input.context,
      "需要命名的政黨：",
      ...lines,
      input.previousNames && input.previousNames.length > 0
        ? `上一屆議會的黨名（可延續風格，但同立場的黨若沿用請照抄原名）：${input.previousNames.join("、")}`
        : "這是第一屆議會。",
      "僅回覆 JSON 物件。",
    ].join("\n");
    return await callGameAiParsed("parliament.party_names", "bulk", {
      system,
      messages: [{ role: "user", content: user }],
    }, (raw) => parseJson(raw, input.parties));
  } catch (err) {
    logger.warn({ err }, "party naming AI failed — fallback to template names");
    return null;
  }
}
