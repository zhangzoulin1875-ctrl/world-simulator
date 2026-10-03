import { z } from "zod";
import type { CabinetStyle } from "@workspace/db";
import type { AgencyLevel } from "../types";
import { agencyLevelHint, styleToPromptFragment } from "../style";
import { callGameAi } from "../../gameAi";
import { MAX_ORDER_QUANTITY } from "../../military";

/**
 * Task #244 — 元帥（軍事）領域：每回合軍務計畫的 bulk AI 規劃與 zod 驗證。
 *
 * 由 runDomain 呼叫，依玩家方針、執政風格與代理程度，從「已提供的候選清單」
 * 挑選當回合的軍務動作。AI 只負責「選擇與擬定」，實際花費／上限／授權與是否
 * 送審批一律由呼叫端把關。原 domains/military.ts 內的定義純搬移至此，行為不變。
 */

// ── AI 決策：本回合軍務計畫 ────────────────────────────────────

const planSchema = z.object({
  reasoning: z.string().trim().max(1000).optional().default(""),
  recruit: z
    .array(
      z.object({
        templateId: z.number().int().positive(),
        quantity: z.number().int().positive().max(MAX_ORDER_QUANTITY),
      }),
    )
    .max(5)
    .optional()
    .default([]),
  purchase: z
    .array(
      z.object({
        templateId: z.number().int().positive(),
        quantity: z.number().int().positive().max(MAX_ORDER_QUANTITY),
      }),
    )
    .max(5)
    .optional()
    .default([]),
  researchTechId: z.number().int().positive().nullable().optional().default(null),
  designUnit: z
    .object({
      category: z.string().trim().min(1),
      requirement: z.string().trim().min(1).max(500),
    })
    .nullable()
    .optional()
    .default(null),
  disband: z
    .array(
      z.object({
        templateId: z.number().int().positive(),
        quantity: z.number().int().positive().max(MAX_ORDER_QUANTITY),
      }),
    )
    .max(5)
    .optional()
    .default([]),
});

export type MilitaryPlan = z.infer<typeof planSchema>;

function parseAiJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

export interface PlanInput {
  nationName: string;
  eraLabel: string;
  directive: string;
  agencyLevel: AgencyLevel;
  style: CabinetStyle;
  enabledActionKeys: string[];
  resources: {
    availableProduction: number;
    availablePopulation: number;
    money: number;
    techPoints: number;
    remainingPurchaseCap: number;
  };
  templates: {
    id: number;
    name: string;
    categoryLabel: string;
    /** Task #557 — 每 100 單位生產力佔用（有效生產力維護費；招募＝購買同一公式）。 */
    prodReservePer100: number;
    popCostPerUnit: number;
    moneyCostPerUnit: number;
  }[];
  armies: { templateId: number; quantity: number }[];
  deck: { id: number; name: string; costPoints: number }[];
  designableCategories: { slug: string; label: string }[];
  /** Task #510 — 剩餘兵種設計次數（0 = 本回合不要規劃設計）。 */
  unitDesignCharges: number;
}

export async function decideMilitaryActions(input: PlanInput): Promise<MilitaryPlan> {
  const enabled = new Set(input.enabledActionKeys);
  const actionLines: string[] = [];
  if (enabled.has("recruit_units")) {
    actionLines.push(
      '- recruit：以生產力＋人口招募既有兵種，格式 "recruit": [{"templateId": 數字, "quantity": 數字}]',
    );
  }
  if (enabled.has("purchase_units")) {
    actionLines.push(
      '- purchase：以金錢購買既有兵種（受今日剩餘配額限制），格式 "purchase": [{"templateId": 數字, "quantity": 數字}]',
    );
  }
  if (enabled.has("research_tech")) {
    actionLines.push(
      '- research：自可研發牌組挑「一項」科技研發，格式 "researchTechId": 數字或 null',
    );
  }
  if (enabled.has("design_unit")) {
    actionLines.push(
      '- design：設計一個新兵種，格式 "designUnit": {"category": 類別代碼, "requirement": "設計需求"} 或 null',
    );
  }
  if (enabled.has("disband_units")) {
    actionLines.push(
      '- disband：提報裁撤過剩部隊（會送交玩家批准），格式 "disband": [{"templateId": 數字, "quantity": 數字}]',
    );
  }

  const systemPrompt = [
    `你是一款架空世界戰略遊戲中「${input.nationName}」的元帥（軍事最高指揮），負責每回合的軍事建設決策。請僅回覆 JSON 物件（不要 code fence、不要任何前後文字）。`,
    styleToPromptFragment(input.style),
    `代理程度：${agencyLevelHint(input.agencyLevel)}`,
    input.directive.trim()
      ? `玩家常駐方針（最高優先，務必遵循）：${input.directive.trim()}`
      : "玩家未設定常駐方針，請以穩健建軍為原則。",
    "決策原則：",
    "1. 只在「已授權的動作類型」內行動；未列出的類型一律不要輸出。",
    "2. 量力而為：招募看可用生產力與人口，購買看金錢與今日剩餘配額，研發／設計看科技點數。切勿規劃明顯超出資源的動作。",
    "3. 依方針與風格決定積極程度；越權傾向高、代理積極者可規劃較大動作，膽小者宜保守。",
    "4. 大動作可以規劃（系統會視情況送交玩家批准），但仍須合理。",
    "5. 沒有值得做的動作時，回傳空陣列／null 即可，不要硬湊。",
    "可用動作類型：",
    ...actionLines,
    'JSON 結構：{"reasoning": "一句話理由", "recruit": [...], "purchase": [...], "researchTechId": 數字或null, "designUnit": {...}或null, "disband": [...]}',
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = [
    `當前時代：${input.eraLabel}`,
    `可用資源：可用生產力 ${input.resources.availableProduction}／可用人口 ${input.resources.availablePopulation}／金錢 ${input.resources.money}／科技點數 ${input.resources.techPoints}／今日剩餘購買配額 ${input.resources.remainingPurchaseCap} 單位`,
    "",
    "── 可用兵種模板（templateId｜名稱｜類別｜每100單位生產力佔用｜每單位人口｜每單位金錢）──",
    input.templates.length > 0
      ? input.templates
          .map(
            (t) =>
              `${t.id}｜${t.name}｜${t.categoryLabel}｜${t.prodReservePer100}｜${t.popCostPerUnit}｜${t.moneyCostPerUnit}`,
          )
          .join("\n")
      : "（無）",
    "",
    "── 目前持有軍隊（templateId×數量）──",
    input.armies.length > 0
      ? input.armies.map((a) => `${a.templateId}×${a.quantity}`).join("、")
      : "（無）",
    ...(enabled.has("research_tech")
      ? [
          "",
          "── 可研發牌組（techId｜名稱｜點數成本）──",
          input.deck.length > 0
            ? input.deck
                .map((d) => `${d.id}｜${d.name}｜${d.costPoints}`)
                .join("\n")
            : "（本回合無可研發科技）",
        ]
      : []),
    ...(enabled.has("design_unit")
      ? [
          "",
          `── 可設計兵種類別（代碼｜名稱），剩餘設計次數 ${input.unitDesignCharges} 次（0 次時請回傳 designUnit: null）──`,
          input.designableCategories.length > 0
            ? input.designableCategories
                .map((c) => `${c.slug}｜${c.label}`)
                .join("\n")
            : "（無已解鎖類別）",
        ]
      : []),
    "",
    "僅回覆 JSON 物件。",
  ]
    .filter(Boolean)
    .join("\n");

  const message = await callGameAi("cabinet.military_planning", "bulk", {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  return planSchema.parse(parseAiJson(raw));
}
