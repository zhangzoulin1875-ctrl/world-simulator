import { z } from "zod";
import { callGameAi } from "../../gameAi";
import { logger } from "../../logger";

/**
 * Task #243 — 內政大臣每回合代理規劃 AI（bulk 模型、zod 驗證 JSON）。
 *
 * 每回合每位在任內政大臣呼叫一次，依玩家方針、執政風格與代理程度，從「已提供的
 * 候選清單」中挑選當回合要推動的內政行動（科技研發、財政稅制、預算、城市建築、
 * 城牆升級）。AI 只負責「選擇與擬定」，實際花費／上限／授權與是否送審批一律由
 * 呼叫端以既有規則與純函式把關。解析失敗直接丟錯（呼叫端 catch 後略過該回合）。
 */

/** 提供給 AI 的科技候選（牌組中的 3 選 1）。 */
export interface TechOption {
  id: number;
  name: string;
  cost: number;
}

/** 提供給 AI 的城市建築候選。 */
export interface BuildOption {
  cityId: number;
  cityName: string;
  buildingType: string;
  buildingName: string;
  cost: number;
  /** 該城興建前剩餘可用建築槽（用來判定是否用到最後一格）。 */
  remainingSlots: number;
}

/** 提供給 AI 的既有建築（可拆除）候選。 */
export interface DemolishOption {
  buildingId: number;
  cityId: number;
  cityName: string;
  buildingType: string;
  buildingName: string;
}

/** 提供給 AI 的城牆升級候選。 */
export interface WallOption {
  cityId: number;
  cityName: string;
  tier: string;
  tierLabel: string;
  cost: number;
}

/** 提供給 AI 的糧食報告摘要（Task #435 — 糧食政策代理判斷用）。 */
export interface FoodBrief {
  production: number;
  consumption: number;
  balance: number;
  famine: boolean;
  mobilization: boolean;
  rationing: boolean;
  outputBonusPct: number;
  rationSavingPct: number;
  satisfactionCostPerTurn: number;
}

export interface InteriorPlanInput {
  nationName: string | null;
  eraLabel: string;
  directive: string;
  stylePrompt: string;
  agencyHint: string;
  /** 玩家已授權（或大臣可越界提案）的行動 zh-TW 標籤。 */
  actionMenu: string[];
  treasury: number;
  techPoints: number;
  taxRatePct: number;
  socialHand: TechOption[];
  productionHand: TechOption[];
  buildOptions: BuildOption[];
  demolishOptions: DemolishOption[];
  wallOptions: WallOption[];
  /** 糧食報告摘要（null = 本回合不考慮糧食政策）。 */
  food: FoodBrief | null;
  /** 國情快照（minimal：戰爭狀態＋現行制度）；null = 載入失敗時省略。 */
  context?: string | null;
}

export interface InteriorPlan {
  researchSocialTechId: number | null;
  researchProductionTechId: number | null;
  fiscalPolicy: string | null;
  building: { cityId: number; buildingType: string } | null;
  demolish: { buildingId: number } | null;
  wall: { cityId: number } | null;
  /** 糧食政策切換（null = 不動；欄位 null = 該開關不動）。 */
  foodPolicy: {
    mobilization: boolean | null;
    rationing: boolean | null;
  } | null;
  note: string;
}

const planSchema = z.object({
  researchSocialTechId: z.number().int().positive().nullable(),
  researchProductionTechId: z.number().int().positive().nullable(),
  fiscalPolicy: z.string().trim().max(200).nullable(),
  building: z
    .object({
      cityId: z.number().int().positive(),
      buildingType: z.string().trim().min(1),
    })
    .nullable(),
  demolish: z.object({ buildingId: z.number().int().positive() }).nullable(),
  wall: z.object({ cityId: z.number().int().positive() }).nullable(),
  foodPolicy: z
    .object({
      mobilization: z.boolean().nullable(),
      rationing: z.boolean().nullable(),
    })
    .nullable()
    // 舊 prompt 快取或模型漏欄位時視為「不動」，不整份丟錯。
    .catch(null)
    .default(null),
  note: z.string().trim().max(300),
});

function parseAiJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function techLines(label: string, techs: TechOption[]): string {
  if (techs.length === 0) return `${label}：（無可研發項目）`;
  return `${label}：${techs
    .map((t) => `#${t.id} ${t.name}（${t.cost.toLocaleString("en-US")}點）`)
    .join("、")}`;
}

export async function planInteriorActions(
  input: InteriorPlanInput,
): Promise<InteriorPlan> {
  const systemPrompt = [
    "你是一款架空世界戰略遊戲的「內政大臣」，代理玩家治理國家內政。請依玩家的常駐方針、你的執政風格與代理程度，規劃「本回合」要推動的內政行動。僅回覆 JSON 物件（不要 code fence、不要任何前後文字）。",
    'JSON 結構：{"researchSocialTechId": 要研發的社會科技id或null, "researchProductionTechId": 要研發的生產科技id或null, "fiscalPolicy": "財政稅制政策自由文字（繁體中文，≤200字，用於加稅/減稅/稅制改革）或null", "building": {"cityId":城市id,"buildingType":"建築type"}或null, "demolish": {"buildingId":要拆除的建築id}或null, "wall": {"cityId":城市id}或null, "foodPolicy": {"mobilization":要開啟true/要關閉false/不動null, "rationing":要開啟true/要關閉false/不動null}或null, "note": "本回合施政重點一句話（繁體中文，≤300字）"}',
    "規劃原則：",
    "1. 只能從下方提供的候選清單挑選（科技只能挑牌組中的、建築／城牆只能挑清單中的城市與類型）；沒有合適項目就填 null。清單外的一律不得選。",
    "2. 嚴格遵循玩家方針與你的執政風格。方針指向什麼就優先推動什麼；方針未提及的領域保守處理。",
    "3. 量入為出：留意國庫與科技點數餘額，不要規劃明顯負擔不起的行動（實際仍會被系統擋下）。",
    "4. 你只負責「選擇」，是否需玩家批准由系統依規則決定，你不需自行判斷。",
    "5. 每項行動每回合至多規劃一筆（建築、城牆各一）。",
    "6. 糧食政策：僅在下方有提供糧食報告時可切換；每項開啟中的政策每回合都扣人民滿意度，饑荒（或缺口逼近）時才開啟「全民動員」（增產）或「配給制」（省糧），糧食充裕時應關閉不必要的政策止血滿意度；已是目標狀態就填 null 不動。",
  ].join("\n");

  const userPrompt = [
    `國家：${input.nationName ?? "（未命名）"}`,
    `當前時代：${input.eraLabel}`,
    input.stylePrompt,
    `代理程度：${input.agencyHint}`,
    `玩家常駐方針：${input.directive.trim() || "（未設定，請以穩健發展為預設方向）"}`,
    `可代理行動：${input.actionMenu.length > 0 ? input.actionMenu.join("、") : "（無）"}`,
    `國庫金錢：${input.treasury.toLocaleString("en-US")}；科技點數：${input.techPoints.toLocaleString("en-US")}；目前稅率：${input.taxRatePct}%`,
    techLines("可研發社會科技（3選1牌組）", input.socialHand),
    techLines("可研發生產科技（3選1牌組）", input.productionHand),
    input.buildOptions.length > 0
      ? `可興建城市建築：${input.buildOptions
          .map(
            (b) =>
              `城市#${b.cityId}${b.cityName}→${b.buildingName}[${b.buildingType}]（${b.cost.toLocaleString("en-US")}金）`,
          )
          .join("、")}`
      : "可興建城市建築：（無）",
    input.demolishOptions.length > 0
      ? `可拆除既有建築（不退款）：${input.demolishOptions
          .map(
            (d) =>
              `建築#${d.buildingId}（城市#${d.cityId}${d.cityName}的${d.buildingName}[${d.buildingType}]）`,
          )
          .join("、")}`
      : "可拆除既有建築：（無）",
    input.wallOptions.length > 0
      ? `可升級城牆：${input.wallOptions
          .map(
            (w) =>
              `城市#${w.cityId}${w.cityName}→${w.tierLabel}（${w.cost.toLocaleString("en-US")}金）`,
          )
          .join("、")}`
      : "可升級城牆：（無）",
    ...(input.context ? [`國家現況：${input.context}`] : []),
    input.food
      ? `糧食報告：產出 ${Math.round(input.food.production).toLocaleString("en-US")}／消耗 ${Math.round(input.food.consumption).toLocaleString("en-US")}／結餘 ${Math.round(input.food.balance).toLocaleString("en-US")}${input.food.famine ? "（⚠️ 饑荒中）" : ""}。政策現況：全民動員=${input.food.mobilization ? "開啟" : "關閉"}（產量 +${input.food.outputBonusPct}%）、配給制=${input.food.rationing ? "開啟" : "關閉"}（消耗 −${input.food.rationSavingPct}%）；每項開啟中的政策每回合人民滿意度 −${input.food.satisfactionCostPerTurn}。`
      : "糧食報告：（本回合不考慮糧食政策，foodPolicy 請填 null）",
    "",
    "僅回覆 JSON 物件。",
  ].join("\n");

  const message = await callGameAi("cabinet.interior", "bulk", {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";

  let parsed: z.infer<typeof planSchema>;
  try {
    parsed = planSchema.parse(parseAiJson(raw));
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 500) },
      "cabinet interior plan parse failed",
    );
    throw new Error("內政大臣規劃格式不正確");
  }

  const fiscal =
    parsed.fiscalPolicy && parsed.fiscalPolicy.trim().length > 0
      ? parsed.fiscalPolicy.trim()
      : null;

  return {
    researchSocialTechId: parsed.researchSocialTechId,
    researchProductionTechId: parsed.researchProductionTechId,
    fiscalPolicy: fiscal,
    building: parsed.building,
    demolish: parsed.demolish,
    wall: parsed.wall,
    foodPolicy: parsed.foodPolicy,
    note: parsed.note,
  };
}
