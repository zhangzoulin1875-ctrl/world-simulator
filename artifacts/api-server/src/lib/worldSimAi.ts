import { type AiModelTier } from "./aiModels";
import { callGameAi } from "./gameAi";
import { logger } from "./logger";
import {
  MAX_PROPOSAL_OPERATIONS,
  parseWorldProposal,
  type WorldProposal,
} from "./worldSim";

/**
 * Task #176 — 世界模擬 AI 生成服務（quality 模型、zod 驗證 JSON）。
 *
 * 管理員以自然語言下達指令（例如「在東亞新增三個古典時代小國，彼此接壤」），
 * 本服務把「世界快照」(可編輯國家、玩家國家、地區空間、可用政體/時代) 組成
 * prompt，交給 quality 模型產生一份「世界提案」(WorldProposal)，再以 zod 嚴格
 * 驗證結構。**只產生提案、不寫入任何資料**——實際套用由 worldSimApply 的
 * preview/apply 負責（那裡才會把提案夾在時代上限並排除玩家國家）。
 *
 * 硬性規則會寫進 prompt：AI 只能新增/編輯/刪除 NPC 與無主國家、在非玩家國家之間
 * 重畫領土，絕不可觸及玩家國家或其領土。但 prompt 只是第一道防線——真正的保證在
 * validateWorldProposal（受保護國家把關 + Σ≤100 含玩家既有掌控）。
 */

/** 單一可編輯國家（NPC 或無主）在快照中的摘要。 */
export interface WorldSimNationSummary {
  /** 國家 uuid（updateNation / deleteNation 以此指向）。 */
  id: string;
  name: string | null;
  /** true = NPC；false = 無主國家（可被接手，仍可編輯）。 */
  isNpc: boolean;
  government: string | null;
  techEraMilitary: string | null;
  techEraSocial: string | null;
  techEraProduction: string | null;
  stability: number;
  unrest: number;
  /** 目前掌控地區（名稱 + 百分比）摘要。 */
  regionNames: string[];
}

/** 地區在快照中的摘要（含剩餘可分配空間）。 */
export interface WorldSimRegionSummary {
  id: number;
  name: string;
  macroRegion: string;
  /** 100 − 該地區目前所有掌控總和（含玩家），AI 只能填入這個空間。 */
  freePercent: number;
  /** 目前時代的人口／生產素質／科技點數（若提供，供 AI 判斷地區價值）。 */
  population?: number;
  production?: number;
  techPoints?: number;
}

export interface GenerateWorldProposalInput {
  /** 管理員自然語言指令。 */
  instruction: string;
  /** 世界目前年份。 */
  year: number;
  /** 世界目前時代 slug 與標籤。 */
  eraSlug: string;
  eraLabel: string;
  /** 可編輯國家（NPC + 無主）。 */
  editableNations: WorldSimNationSummary[];
  /** 玩家國家名稱（僅供 AI 感知世界；**絕不可被指向**）。 */
  protectedNationNames: string[];
  /** 有剩餘空間或與指令相關的地區（AI 分配領土用）。 */
  regions: WorldSimRegionSummary[];
  /** 可用政體標籤（zh-TW，必須從中挑選）。 */
  governments: string[];
  /** 可用時代 slug（科技時代欄位必須從中挑選；勿超過目前時代）。 */
  eraSlugs: string[];
}

/**
 * 純函式：從 AI 原始文字抽出並驗證出 WorldProposal。
 * 去除 ```json code fence → JSON.parse → parseWorldProposal（zod）。
 * 任何失敗都會丟出例外，交由呼叫端轉為 zh-TW 訊息，**絕不回傳半套資料**。
 * 抽出為獨立函式以便單元測試（不需真的呼叫 AI）。
 */
export function extractWorldProposalJson(raw: string): WorldProposal {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed: unknown = JSON.parse(cleaned);
  return parseWorldProposal(parsed);
}

function buildSystemPrompt(): string {
  return [
    "你是一款架空世界戰略遊戲的「世界模擬 AI」。管理員會以自然語言下達指令，你要產生一份「世界提案」，只回覆單一 JSON 物件（不要 code fence、不要任何前後說明文字）。",
    "",
    "JSON 結構：",
    '{"summary": "這份提案的繁體中文摘要（≤2000字，說明你做了什麼與理由）", "operations": [ ...操作陣列... ]}',
    "",
    "operations 每個元素為下列三種之一：",
    '1. 新增 NPC：{"op":"createNpc","tempId":"提案內唯一暫時代號","name":"國名(≤25字，只用文字與數字，不含空白與標點)","leaderName":領袖名或null,"government":政體或null,"techEraMilitary":時代slug或null,"techEraSocial":時代slug或null,"techEraProduction":時代slug或null,"stability":0-100整數,"unrest":0-100整數,"regions":[{"regionId":整數,"percent":1-100整數}]}（regions 至少一個）',
    '2. 編輯既有國家：{"op":"updateNation","nationId":"該國uuid",...其餘欄位皆選填，省略=不變；regions 提供=全量替換其領土、[]=釋出全部、省略=不動領土}',
    '3. 刪除既有國家：{"op":"deleteNation","nationId":"該國uuid"}',
    "",
    "硬性規則（違反會被系統整份拒絕）：",
    "1. 你只能新增／編輯／刪除「可編輯國家」（NPC 與無主國家），以及在它們之間重畫領土。",
    "2. 絕對不可以指向、修改、刪除任何「玩家國家」，也不可以動到玩家掌控的領土——即使間接也不行。",
    "3. 每個地區所有國家的掌控百分比總和不可超過 100。你只能使用各地區「剩餘空間 freePercent」；玩家既有掌控已從剩餘空間扣除，不可侵占。",
    "4. government 必須從「可用政體」清單挑選（原字串）；科技時代欄位必須從「可用時代」清單挑選，且不可超過世界目前時代。",
    "5. updateNation / deleteNation 的 nationId 必須是下方「可編輯國家」清單中的 uuid；createNpc 的 tempId 在本提案內不可重複。",
    `6. 單份提案操作數不可超過 ${MAX_PROPOSAL_OPERATIONS} 個。`,
    "7. 若某個可編輯國家正與玩家交戰（進行中的戰爭或戰役），系統會自動略過你對它的編輯／刪除／領土重畫，請不要浪費操作額度在這類國家上。",
    "8. 讓提案貼合管理員指令與世界的年代氛圍；名稱、領袖、政體、科技時代都要符合該時代與地理設定，力求可信且有故事性。",
  ].join("\n");
}

function buildUserPrompt(input: GenerateWorldProposalInput): string {
  const nationLines =
    input.editableNations.length > 0
      ? input.editableNations.map((n) => {
          const kind = n.isNpc ? "NPC" : "無主";
          const regions =
            n.regionNames.length > 0 ? n.regionNames.join("、") : "無領土";
          const tech = `軍事${n.techEraMilitary ?? "(沿用世界時代)"}／社會${
            n.techEraSocial ?? "(沿用世界時代)"
          }／生產${n.techEraProduction ?? "(沿用世界時代)"}`;
          return `- [${kind}] ${n.name ?? "(未命名)"} | id=${n.id} | 政體=${
            n.government ?? "無"
          } | 安定${n.stability}/動亂${n.unrest} | 科技時代=${tech} | 領土：${regions}`;
        })
      : ["（目前沒有可編輯的 NPC 或無主國家）"];

  const regionLines =
    input.regions.length > 0
      ? input.regions.map((r) => {
          const stats =
            r.population != null || r.production != null || r.techPoints != null
              ? ` | 人口${r.population ?? "?"}/生產${
                  r.production ?? "?"
                }/科技${r.techPoints ?? "?"}`
              : "";
          return `- id=${r.id} | ${r.name}（${r.macroRegion}）| 剩餘空間 ${r.freePercent}%${stats}`;
        })
      : ["（沒有可分配空間的地區）"];

  return [
    `管理員指令：${input.instruction}`,
    "",
    `世界目前年份：${input.year}　時代：${input.eraLabel}（${input.eraSlug}）`,
    "",
    "可用政體（government 必須原字串挑選）：",
    input.governments.join("、"),
    "",
    "可用時代 slug（科技時代欄位挑選，勿超過目前時代）：",
    input.eraSlugs.join("、"),
    "",
    "玩家國家（**絕不可指向或動到其領土**）：",
    input.protectedNationNames.length > 0
      ? input.protectedNationNames.join("、")
      : "（目前沒有玩家國家）",
    "",
    "可編輯國家（NPC 與無主，updateNation/deleteNation 以 id 指向）：",
    ...nationLines,
    "",
    "地區（regionId 與剩餘可分配空間 freePercent）：",
    ...regionLines,
    "",
    "僅回覆單一 JSON 物件。",
  ].join("\n");
}

/**
 * 產生並驗證一份世界提案。失敗（AI 輸出非 JSON 或結構不符）一律丟出 zh-TW
 * 例外，呼叫端回 502，且不寫入任何資料。
 *
 * modelTier 預設 "quality"（管理員隨選生成，重品質）；回合自動模擬傳 "bulk"
 * 以降低每回合成本（Task #176 T9）。prompt 與安全規則兩者共用同一份。
 */
export async function generateWorldProposal(
  input: GenerateWorldProposalInput,
  modelTier: AiModelTier = "quality",
): Promise<WorldProposal> {
  const message = await callGameAi("world_sim.proposal", modelTier, {
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";

  try {
    return extractWorldProposalJson(raw);
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 800) },
      "world sim proposal parse failed",
    );
    throw new Error("世界模擬 AI 回覆格式不正確，請調整指令後再試一次");
  }
}
