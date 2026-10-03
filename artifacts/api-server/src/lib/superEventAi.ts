import { z } from "zod";
import type { MilitaryTechBonus } from "@workspace/db";
import { callGameAi, type AiFeatureKey } from "./gameAi";
import { logger } from "./logger";
import { ERAS, getEraIndex } from "./mapRegionEras";
import { buildTargetStatsGuidance } from "./superEventImpact";

/**
 * Task #333 — 超事件系統 AI 模組。
 *
 * 三個用途：
 * 1. generateSuperEvent — 依世界局勢生成一則新的重大國際事件（管理員手動或
 *    每回合自動生成用）。richer 敘事，用 quality 模型。
 * 2. judgeSuperEventTurn — 每回合判定進行中事件的本回合發展與數值影響（可能
 *    賦予跨時代關鍵科技、觸發 NPC 敵對傾向、宣告事件結束）。批次、用 bulk 模型。
 * 3. judgeSuperEventResponse — 判定玩家對事件的自由文字應對，回傳緩解／加成效果。
 *    批次、用 bulk 模型。
 *
 * 所有輸出經 zod 驗證與數值夾限；與內政／財政一致，AI 只給敘事與幅度，實際套用
 * 與夾限由伺服器（superEventSettlement）決定。解析失敗一律丟例外，由呼叫端記錄
 * 並跳過，絕不讓回合結算中斷。
 */

/** 本回合對受影響國家的數值影響（百分比／百分點，皆為每回合一次性）。 */
const effectSchema = z.object({
  /** 人口變動（%，套用於受影響地區人口；瘟疫、饑荒、移民等）。 */
  populationDeltaPct: z.number().min(-30).max(30).default(0),
  /** 生產素質變動（%，套用於受影響國家的生產力）。 */
  productivityDeltaPct: z.number().min(-30).max(30).default(0),
  /** 四大社會階級滿意度百分點偏移（農民／工人／貴族(資本家)／教士）。 */
  satisfactionFarmersDelta: z.number().int().min(-20).max(20).default(0),
  satisfactionWorkersDelta: z.number().int().min(-20).max(20).default(0),
  satisfactionNoblesDelta: z.number().int().min(-20).max(20).default(0),
  satisfactionClergyDelta: z.number().int().min(-20).max(20).default(0),
  /** 穩定度／暴動度百分點偏移。 */
  stabilityDelta: z.number().int().min(-20).max(20).default(0),
  unrestDelta: z.number().int().min(-20).max(20).default(0),
});

export type SuperEventEffect = z.infer<typeof effectSchema>;

const bonusTargetSchema = z.enum([
  "hp",
  "attack",
  "defense",
  "speed",
  "accuracy",
  "prodCost",
  "popCost",
  "moneyCost",
  "upkeep",
]);
const bonusCategorySchema = z
  .enum(["infantry", "ranged", "armor", "artillery", "ship", "air", "siege"])
  .nullable();
const bonusSchema = z.object({
  target: bonusTargetSchema,
  category: bonusCategorySchema.default(null),
  pct: z.number().min(-50).max(100),
});

const techGrantSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(300),
    /** 目標時代 slug（跨時代突破，通常領先當前時代）。 */
    era: z.string().trim().min(1).max(40),
    bonuses: z.array(bonusSchema).max(4).default([]),
  })
  .nullable()
  .default(null);

export type SuperEventTechGrant = z.infer<typeof techGrantSchema>;

/** 事件階段：爆發→擴散→高峰→消退→落幕。 */
const stageSchema = z
  .enum(["outbreak", "spreading", "peak", "receding", "ended"])
  .default("spreading");

const turnSchema = z.object({
  /** 本回合事件發展敘事。 */
  narrative: z.string().trim().min(1).max(500),
  effect: effectSchema,
  /** 本回合後事件推進到的階段。 */
  stage: stageSchema,
  /** 跨時代關鍵科技突破（僅在事件確實帶來科技躍進時給；否則 null）。 */
  grantTech: techGrantSchema,
  /** NPC 對受影響玩家的敵對傾向。 */
  npcHostility: z.enum(["none", "tension", "aggressive"]).default("none"),
  /** 事件本回合是否結束。 */
  end: z.boolean().default(false),
});

export type SuperEventTurnJudgement = z.infer<typeof turnSchema>;

const genSchema = z.object({
  title: z.string().trim().min(1).max(60),
  summary: z.string().trim().min(1).max(120),
  narrative: z.string().trim().min(1).max(600),
  category: z.string().trim().min(1).max(20),
  severity: z.number().int().min(1).max(100),
  /** 事件屬性：disaster 災難（負向）／opportunity 機會（正向）。 */
  kind: z.enum(["disaster", "opportunity"]).default("disaster"),
});

export type SuperEventGeneration = z.infer<typeof genSchema>;

const responseSchema = z.object({
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(400),
  /** 應對與事件的契合度 0–100（越高緩解／加成越明顯）。 */
  fitScore: z.number().min(0).max(100),
  effect: effectSchema,
});

export type SuperEventResponseJudgement = z.infer<typeof responseSchema>;

function parseAiJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

async function callModel(
  feature: AiFeatureKey,
  tier: "quality" | "bulk",
  system: string,
  user: string,
): Promise<string> {
  const message = await callGameAi(feature, tier, {
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = message.content[0];
  return block && block.type === "text" ? block.text : "";
}

const EFFECT_DOC = `"effect" 為本回合對受影響國家的數值影響（每回合一次性）：{"populationDeltaPct": -30~30, "productivityDeltaPct": -30~30, "satisfactionFarmersDelta": -20~20整數（農民滿意度）, "satisfactionWorkersDelta": -20~20整數（工人滿意度）, "satisfactionNoblesDelta": -20~20整數（貴族(資本家)滿意度）, "satisfactionClergyDelta": -20~20整數（教士滿意度）, "stabilityDelta": -20~20整數, "unrestDelta": -20~20整數}。populationDeltaPct/productivityDeltaPct 是百分比（例 -5 = 人口/生產力 −5%），其餘為百分點偏移。未受影響的欄位填 0。數值請與事件嚴重度相稱且保守（多數回合單項幅度不宜過大）。`;

/**
 * 依有無「地理人文背景」脈絡（geoContext）產生一段敘事文化導引：
 *  - 有 geoContext（regional／targeted／政治決策等綁定實際地區的事件）：附上該地區的
 *    地理人文背景，並要求敘事名稱／風格／典故貼合該地區真實文化，勿預設中華／中國風格。
 *  - 無 geoContext（global 全球型事件）：要求敘事保持文化中性與多元，勿預設單一
 *    （尤其中華／中國）文化視角。
 * geoContext 由 `nationGeoCulture.ts` 產出（本身已含「貼合地區、勿預設中華」的指示）。
 */
function geoCultureGuidance(geoContext?: string | null): string {
  const trimmed = geoContext?.trim();
  if (trimmed) {
    return `\n${trimmed}\n敘事的名稱、風格、典故與文化色彩需貼合上述地理人文背景，勿預設中華／中國風格。`;
  }
  return "\n【文化中性】此為全球型／跨文化事件，敘事需保持文化中性與多元，勿預設單一（尤其中華／中國）文化視角。";
}

/** 把 AI 給的科技加成夾限成 MilitaryTechBonus[]（整數 pct、範圍夾限）。 */
export function clampTechBonuses(
  bonuses: readonly { target: string; category: string | null; pct: number }[],
): MilitaryTechBonus[] {
  return bonuses.map((b) => ({
    target: b.target as MilitaryTechBonus["target"],
    category: b.category as MilitaryTechBonus["category"],
    pct: Math.max(-50, Math.min(100, Math.round(b.pct))),
  }));
}

/**
 * 生成一則新的超事件（重大國際事件）。管理員手動觸發或每回合自動生成用。
 * @param extraPrompt 管理端設定的生成提示詞／風格導引（可空）。
 */
export async function generateSuperEvent(params: {
  eraSlug: string;
  extraPrompt?: string | null;
  /** 世界局勢摘要（國家數、進行中事件等），供 AI 生成貼合局勢的事件。 */
  worldContext?: string;
  /** 指定要生成的屬性（disaster／opportunity）；不給則由 AI 自行決定。 */
  kindHint?: "disaster" | "opportunity" | null;
  /** 針對型事件的目標敘述（如某國名），供生成醜聞／政變／暗殺類事件。 */
  focus?: string | null;
  /**
   * 受影響地區的「地理人文背景」脈絡（regional／targeted／政治決策事件）。
   * 有值時敘事貼合該地區文化；空／未給時走全球型文化中性導引。
   */
  geoContext?: string | null;
  /** 管理員指定的目標數據欄位（null／空＝不限）；生成的敘事需聚焦這些面向。 */
  targetStats?: readonly string[] | null;
}): Promise<SuperEventGeneration> {
  const era = ERAS[getEraIndex(params.eraSlug)]!;

  const system = [
    "你是一款架空世界戰略遊戲的「超事件」生成 AI。超事件是重大國際事件，可能是全球性／跨國性（例如國際大瘟疫、跨大陸征服浪潮、宗教改革風潮、生產技術劇變、跨時代科技突破、全球天災或經濟震盪），也可能是針對單一國家的內政劇變（醜聞／政變／暗殺）。請生成一則新的超事件，僅回覆 JSON 物件（不要 code fence、不要任何前後文字）。",
    `JSON 欄位：{"title": "…（繁體中文，≤60字，事件名稱）", "summary": "…（繁體中文，一句話摘要，≤120字）", "narrative": "…（繁體中文，事件起因與初始局勢的敘事，≤600字）", "category": "…（繁體中文分類，2~6字，如 疾病／戰爭／宗教／科技／天災／經濟／醜聞／政變）", "severity": 1-100整數（事件嚴重度）, "kind": "disaster" 或 "opportunity"}`,
    "kind：disaster＝災難（負向衝擊，如瘟疫、天災、動亂）；opportunity＝機會（正向紅利，如資源熱潮、科技突破、移民潮、豐收）。敘事的走向需與 kind 一致。",
    "規則：事件需符合當前時代（不可出現超越時代太多的元素，除非本身就是科技突破類事件）；語氣如史詩級的世界大事紀；所有文字繁體中文（zh-TW）。",
  ].join("\n");

  const promptLine = params.extraPrompt?.trim()
    ? `\n管理員生成導引：${params.extraPrompt.trim()}`
    : "";
  const kindLine = params.kindHint
    ? `\n請生成「${params.kindHint === "opportunity" ? "機會（正向）" : "災難（負向）"}」屬性的事件（kind 設為 ${params.kindHint}）。`
    : "";
  const focusLine = params.focus?.trim()
    ? `\n此事件為針對單一國家的內政劇變（醜聞／政變／暗殺類），目標：${params.focus.trim()}。敘事聚焦該國內部後果。`
    : "";
  const worldLine = params.worldContext ? `\n${params.worldContext}` : "";
  const geoLine = geoCultureGuidance(params.geoContext);
  const targetGuidance = buildTargetStatsGuidance(params.targetStats);
  const targetLine = targetGuidance
    ? `\n${targetGuidance}事件的性質與敘事需能合理導致這些數據的變動。`
    : "";
  const user = `當前時代：${era.label}${promptLine}${kindLine}${focusLine}${worldLine}${geoLine}${targetLine}\n\n僅回覆 JSON 物件。`;

  const raw = await callModel("super_event.generate", "quality", system, user);
  try {
    return genSchema.parse(parseAiJson(raw));
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 500) },
      "AI super event generation parse failed",
    );
    throw new Error("AI 超事件生成結果格式不正確");
  }
}

/**
 * 判定進行中超事件的「本回合發展」與數值影響。批次呼叫（每個進行中事件一次），
 * 用 bulk 模型控制成本。
 */
export async function judgeSuperEventTurn(params: {
  eraSlug: string;
  title: string;
  category: string;
  severity: number;
  turnsElapsed: number;
  /** 事件屬性（災難／機會）：effect 方向需與之一致。 */
  kind: "disaster" | "opportunity";
  /** 目前階段 slug（outbreak/spreading/peak/receding/ended）。 */
  currentStage: string;
  /** 目前的整體敘事（前情提要）。 */
  narrative: string;
  /** 受影響國家的摘要（名稱／政體等）。 */
  affectedContext?: string;
  /** 玩家整體應對狀況摘要（已應對國家數／平均契合度）。 */
  responseSummary?: string;
  aiContext?: string | null;
  /** 已賦予過的跨時代科技名稱（避免重複賦予）。 */
  grantedTechNames?: readonly string[];
  /**
   * 受影響地區的「地理人文背景」脈絡（regional／targeted 事件）。
   * 有值時本回合發展敘事貼合該地區文化；空／未給時走全球型文化中性導引。
   */
  geoContext?: string | null;
  /** 管理員指定的目標數據欄位（null／空＝不限）；effect 僅能動這些欄位。 */
  targetStats?: readonly string[] | null;
}): Promise<SuperEventTurnJudgement> {
  const era = ERAS[getEraIndex(params.eraSlug)]!;
  const kindLabel = params.kind === "opportunity" ? "機會（正向）" : "災難（負向）";

  const system = [
    "你是一款架空世界戰略遊戲的「超事件」回合判定 AI。一則重大事件正在進行中，請判定它「本回合」的發展與對受影響國家的數值影響，僅回覆 JSON 物件（不要 code fence、不要任何前後文字）。",
    `JSON 欄位：{"narrative": "…（繁體中文，本回合事件發展敘事，≤500字）", "effect": {…}, "stage": "outbreak"|"spreading"|"peak"|"receding"|"ended", "grantTech": null 或 {"name": "…", "description": "…", "era": "時代slug", "bonuses": [{"target": "attack"|"defense"|"hp"|"speed"|"accuracy"|"prodCost"|"popCost"|"moneyCost"|"upkeep", "category": null 或 "infantry"|"ranged"|"armor"|"artillery"|"ship"|"air"|"siege", "pct": 數值}]}, "npcHostility": "none"|"tension"|"aggressive", "end": true/false}`,
    EFFECT_DOC,
    "effect 方向需與事件屬性一致：災難＝多為負向（人口／生產／滿意度／穩定度下降、暴動度上升）；機會＝多為正向（人口／生產／滿意度／穩定度上升、暴動度下降）。",
    ...(buildTargetStatsGuidance(params.targetStats)
      ? [buildTargetStatsGuidance(params.targetStats)]
      : []),
    "stage：事件本回合推進到的階段——outbreak（爆發，初期擴大）→spreading（擴散）→peak（高峰，最劇烈）→receding（消退，趨緩）→ended（落幕）。階段須合理推進，不可倒退太多；玩家應對得當（已應對且契合度高）可加速趨向 receding／ended，應對不佳則可能停留高峰或惡化。設 ended 時 end 也應為 true。",
    "grantTech：僅在此事件本回合確實帶來「跨時代關鍵科技突破」時給（否則一律 null）；era 為突破後的時代 slug（可領先當前時代），bonuses 為此科技帶來的軍事加成（最多 4 項，可空陣列）。同一事件不要重複賦予相同名稱的科技。",
    "npcHostility：此事件是否使 NPC 國家對受影響的玩家轉趨敵對——none=無、tension=關係緊張、aggressive=可能採取敵對行動（宣戰／出兵）。機會型事件通常為 none。",
    "end：事件是否於本回合落幕（已充分發展或影響消退則設 true）。",
    "數值影響需與嚴重度、階段相稱且逐回合演進。所有文字繁體中文（zh-TW）。",
  ].join("\n");

  const eras = ERAS.map((e) => `${e.slug}(${e.label})`).join("、");
  const grantedLine =
    params.grantedTechNames && params.grantedTechNames.length > 0
      ? `\n已賦予過的科技（勿重複）：${params.grantedTechNames.join("、")}`
      : "";
  const affectedLine = params.affectedContext
    ? `\n受影響國家：${params.affectedContext}`
    : "";
  const responseLine = params.responseSummary
    ? `\n玩家應對狀況：${params.responseSummary}`
    : "";
  const ctxLine = params.aiContext?.trim()
    ? `\n事件補充脈絡：${params.aiContext.trim()}`
    : "";
  const geoLine = geoCultureGuidance(params.geoContext);
  const user = [
    `當前時代：${era.label}`,
    `可用時代 slug：${eras}`,
    `事件名稱：${params.title}`,
    `事件分類：${params.category}`,
    `事件屬性：${kindLabel}`,
    `目前階段：${params.currentStage}`,
    `嚴重度：${params.severity}/100`,
    `已進行回合數：${params.turnsElapsed}`,
    `目前敘事：${params.narrative || "（事件剛爆發）"}`,
    affectedLine,
    responseLine,
    ctxLine,
    grantedLine,
    geoLine,
    "",
    "僅回覆 JSON 物件。",
  ].join("\n");

  const raw = await callModel("super_event.turn_judgment", "bulk", system, user);
  try {
    return turnSchema.parse(parseAiJson(raw));
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 500) },
      "AI super event turn judgement parse failed",
    );
    throw new Error("AI 超事件回合判定結果格式不正確");
  }
}

/**
 * 判定玩家對超事件的自由文字應對，回傳緩解／加成效果。批次、用 bulk 模型。
 */
export async function judgeSuperEventResponse(params: {
  eraSlug: string;
  eventTitle: string;
  eventCategory: string;
  eventNarrative: string;
  government: string | null;
  nationName: string | null;
  responseText: string;
  /**
   * 應對國的「地理人文背景」脈絡。有值時判定結果敘事貼合該國文化；
   * 空／未給時走全球型文化中性導引。
   */
  geoContext?: string | null;
  /** 管理員指定的目標數據欄位（null／空＝不限）；effect 僅能動這些欄位。 */
  targetStats?: readonly string[] | null;
}): Promise<SuperEventResponseJudgement> {
  const era = ERAS[getEraIndex(params.eraSlug)]!;
  const government = params.government ?? "未知政體";

  const system = [
    "你是一款架空世界戰略遊戲的「超事件應對」判定 AI。一個國家對一則進行中的重大國際事件提出了自由文字的應對措施，請評估其成效並產出結果，僅回覆 JSON 物件（不要 code fence、不要任何前後文字）。",
    `JSON 欄位：{"title": "…（繁體中文，≤60字）", "description": "…（繁體中文，判定結果與後果，≤400字）", "fitScore": 0-100整數（應對與事件、政體、時代的契合度）, "effect": {…}}`,
    EFFECT_DOC,
    "effect 代表此應對「額外」帶來的數值影響（相對於不作為）：得當的應對通常緩解負面（正向 effect）、不當或不切實際的應對可能反而惡化（負向 effect）。fitScore 越高，正向效果應越明顯。所有文字繁體中文（zh-TW）。",
    ...(buildTargetStatsGuidance(params.targetStats)
      ? [buildTargetStatsGuidance(params.targetStats)]
      : []),
  ].join("\n");

  const geoLine = geoCultureGuidance(params.geoContext);
  const user = [
    `當前時代：${era.label}`,
    `國家名稱：${params.nationName ?? "未命名國家"}`,
    `國家政體：${government}`,
    `事件名稱：${params.eventTitle}`,
    `事件分類：${params.eventCategory}`,
    `事件目前局勢：${params.eventNarrative || "（剛爆發）"}`,
    `玩家的應對措施：${params.responseText}`,
    geoLine,
    "",
    "僅回覆 JSON 物件。",
  ].join("\n");

  const raw = await callModel("super_event.response_judgment", "bulk", system, user);
  try {
    return responseSchema.parse(parseAiJson(raw));
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 500) },
      "AI super event response judgement parse failed",
    );
    throw new Error("AI 超事件應對判定結果格式不正確");
  }
}
