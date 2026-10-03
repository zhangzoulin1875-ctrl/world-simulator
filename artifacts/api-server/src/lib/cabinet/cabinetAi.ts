import { z } from "zod";
import { callGameAi } from "../gameAi";
import { logger } from "../logger";
import type { CabinetStyle } from "@workspace/db";
import {
  CABINET_DOMAIN_LABELS,
  CABINET_DOMAIN_SCOPES,
  type CabinetDomain,
} from "./types";

/**
 * Task #242 — 內閣大臣生成 AI（quality 模型、zod 驗證 JSON）。
 * 依國家掌控領土的歷史人物，一次生成三位候選大臣供玩家挑選。
 * 每位大臣具有執政風格（越權傾向／膽小程度／風格敘述）。
 * 解析失敗直接丟錯（呼叫端回 502），絕不寫入半套資料。
 */

const candidateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  origin: z.string().trim().min(1).max(200),
  style: z.object({
    overreach: z.number().int().min(0).max(100),
    timidity: z.number().int().min(0).max(100),
    description: z.string().trim().min(1).max(300),
  }),
});

const candidatesSchema = z.object({
  candidates: z.array(candidateSchema).length(3),
});

export interface GeneratedCandidate {
  name: string;
  origin: string;
  style: CabinetStyle;
}

function parseAiJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

export async function generateMinisterCandidates(params: {
  domain: CabinetDomain;
  nationName: string | null;
  eraLabel: string;
  regionNames: string[];
  cityNames: string[];
}): Promise<GeneratedCandidate[]> {
  const { domain, nationName, eraLabel, regionNames, cityNames } = params;
  const domainLabel = CABINET_DOMAIN_LABELS[domain];
  const domainScope = CABINET_DOMAIN_SCOPES[domain];

  const systemPrompt = [
    `你是一款架空世界戰略遊戲的內閣人事 AI。玩家要為國家任命一位「${domainLabel}」（掌管${domainScope}）。請依該國掌控領土對應的真實歷史人物，生成三位風格迥異的候選人，僅回覆 JSON 物件（不要 code fence、不要任何前後文字）。`,
    'JSON 結構：{"candidates": [{"name": "人物姓名（繁體中文，≤40字，可取材自真實歷史人物或以其為原型改編）", "origin": "出身背景一句話（繁體中文，說明其時代、地域與事蹟，≤200字）", "style": {"overreach": 越權傾向(整數0-100), "timidity": 膽小程度(整數0-100), "description": "執政風格一句話（繁體中文，≤300字）"}}, ...三位]}',
    "生成原則：",
    "1. 人物應與該國掌控的領土、城市在歷史上有淵源（例如控制關中就取材秦漢人物）。",
    `2. 三位候選人須符合「${domainLabel}」的職能（${domainScope}），但性格與執政風格明顯不同（例如一位果敢越權、一位謹慎保守、一位均衡務實）。`,
    "3. overreach（越權傾向）越高＝越可能自作主張、超出授權；timidity（膽小程度）越高＝越保守迴避風險。三位的數值應拉開差距。",
    "4. 貼合當前時代氛圍，避免出現與時代明顯不符的現代術語。",
    "5. 必須剛好三位，且欄位齊全。",
  ].join("\n");

  const userPrompt = [
    `國家：${nationName ?? "（未命名）"}`,
    `職位：${domainLabel}（${domainScope}）`,
    `當前時代：${eraLabel}`,
    `掌控地區：${regionNames.length > 0 ? regionNames.join("、") : "（暫無）"}`,
    `境內城市：${cityNames.length > 0 ? cityNames.join("、") : "（暫無）"}`,
    "",
    "僅回覆 JSON 物件。",
  ].join("\n");

  const message = await callGameAi("cabinet.candidates", "quality", {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";

  let parsed: z.infer<typeof candidatesSchema>;
  try {
    parsed = candidatesSchema.parse(parseAiJson(raw));
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 500) },
      "cabinet minister candidates parse failed",
    );
    throw new Error("內閣人選生成格式不正確，請再試一次");
  }

  return parsed.candidates.map((c) => ({
    name: c.name,
    origin: c.origin,
    style: {
      overreach: c.style.overreach,
      timidity: c.style.timidity,
      description: c.style.description,
    },
  }));
}
