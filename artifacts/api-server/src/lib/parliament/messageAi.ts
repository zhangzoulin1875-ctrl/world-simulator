import { z } from "zod";
import { callGameAiParsed } from "../gameAi";
import { logger } from "../logger";
import { ERAS, getEraIndex } from "../mapRegionEras";
import { STANCE_LABELS, type ParliamentStance } from "./core";

/**
 * 議會意見（抗議＋要求）由 AI 依「當前國情與國際局勢」撰寫，不再套固定模板。
 * 立場（誰執政、要求哪一類政策）仍由規則決定——遵守判定靠立場，AI 只負責措辭，
 * 不能改數值或改立場。失敗／額度用罄／輸出不可用 → 回傳 null，由呼叫端退回模板。
 */
const schema = z.object({
  protest: z.string().trim().min(8).max(160),
  demand: z.string().trim().min(6).max(120).nullable(),
});

export interface ParliamentMessageInput {
  eraSlug: string;
  stance: ParliamentStance;
  partyName: string;
  /** 民主／半專制才有要求；專制為 false，只寫一句抗議。 */
  wantsDemand: boolean;
  /** buildNationContext 的國情快照（戰爭、國力、糧食、現行制度）。 */
  context: string;
  /** 國際局勢摘要（戰爭對象、鄰近強國等），可為空字串。 */
  worldSituation: string;
  /** 議會滿意度 0–100，決定語氣緩急。 */
  satisfaction: number;
}

function parseJson(raw: string): unknown {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  return schema.parse(JSON.parse(cleaned));
}

export async function generateParliamentMessage(
  input: ParliamentMessageInput,
): Promise<{ protest: string; demandText: string | null } | null> {
  try {
    const era = ERAS[getEraIndex(input.eraSlug)]!;
    const system = [
      "你是一款架空世界戰略遊戲的議會書記。請替執政黨寫一則議會意見，僅回覆 JSON：",
      '{"protest": "一句議會對政府現況的抗議或表態（繁體中文，不超過80字）", "demand": "一句具體要求，說明接下來三回合希望政府做什麼（不超過60字）；若不需要要求填 null"}',
      "規則：",
      "1. 意見必須貼合『國家現況』與『國際局勢』：有戰爭就談戰局與戰爭疲勞；承平就談承平時期真正的隱憂（財政、民生、鄰國動向、邊防、商路…），不得憑空說連年征戰。",
      "2. 必須符合該黨立場的訴求方向，但要具體、有時代感，不要籠統套話；每次寫法要有變化。",
      "3. 不得提到具體數字獎懲、不得指定遊戲數值、不得要求玩家做超出該立場訴求的事。",
      "4. 滿意度低時語氣急迫嚴厲，高時溫和建議。",
    ].join("\n");
    const user = [
      `當前時代：${era.label}`,
      `執政黨：${input.partyName}（立場：${STANCE_LABELS[input.stance]}）`,
      `議會滿意度：${Math.round(input.satisfaction)}/100`,
      input.context,
      input.worldSituation ? `國際局勢：${input.worldSituation}` : "國際局勢：無特別情報",
      input.wantsDemand ? "請同時寫抗議與要求。" : "只需抗議，demand 填 null。",
      "僅回覆 JSON 物件。",
    ].join("\n");
    const out = (await callGameAiParsed("politics.settlement", "bulk", {
      system,
      messages: [{ role: "user", content: user }],
    }, (raw) => parseJson(raw) as z.infer<typeof schema>)) as z.infer<typeof schema>;
    return { protest: out.protest, demandText: input.wantsDemand ? out.demand : null };
  } catch (err) {
    logger.warn({ err }, "parliament AI message failed — fallback to template");
    return null;
  }
}
