import { z } from "zod";
import { callGameAiParsed } from "../gameAi";
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

/** 數字欄位寬鬆化：接受 "75"、72.5，夾在 0–100 並四捨五入（模型常回字串或小數）。 */
const score = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().finite().transform((n) => Math.max(0, Math.min(100, Math.round(n)))),
);

/** 文字欄位寬鬆化：超長就截斷而不是整批作廢（「一句話」常寫超長）。 */
const text = (max: number) =>
  z.string().trim().min(1).transform((s) => (s.length > max ? s.slice(0, max) : s));

const candidateSchema = z.object({
  name: text(40),
  origin: text(200),
  style: z.object({
    overreach: score,
    timidity: score,
    description: text(300),
  }),
});

// 至少 3 位才可用；多於 3 位只取前三位（過去 4 位或 2 位都會整批失敗）。
const candidatesSchema = z.object({
  candidates: z.array(candidateSchema).min(3).transform((a) => a.slice(0, 3)),
});

export interface GeneratedCandidate {
  name: string;
  origin: string;
  style: CabinetStyle;
}

function parseAiJson(raw: string): unknown {
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // 模型偶爾在 JSON 前後多寫說明文字：取第一個 { 到最後一個 }。
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a > 0 || (b >= 0 && b < cleaned.length - 1)) {
    if (a >= 0 && b > a) cleaned = cleaned.slice(a, b + 1);
  }
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
    "1. 人物應與該國掌控的領土、城市在歷史上有淵源（例如控制安地斯高地就取材印加與前印加人物，控制尼羅河流域就取材埃及人物，控制關中才取材秦漢人物）。",
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

  let parsed: z.infer<typeof candidatesSchema>;
  try {
    parsed = await callGameAiParsed(
      "cabinet.candidates",
      "quality",
      { system: systemPrompt, messages: [{ role: "user", content: userPrompt }] },
      (raw) => candidatesSchema.parse(parseAiJson(raw)),
    );
  } catch (err) {
    logger.error({ err }, "cabinet minister candidates parse failed after retries");
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
