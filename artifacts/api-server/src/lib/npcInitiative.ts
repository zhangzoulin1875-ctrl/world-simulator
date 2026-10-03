import { z } from "zod";
import { eq, isNull } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  diplomacyRelationsTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  mapRegionsTable,
  mapRegionAdjacenciesTable,
  regionControlsTable,
} from "@workspace/db";
import { type AiModelTier } from "./aiModels";
import { callGameAi } from "./gameAi";
import { logger } from "./logger";
import {
  canonicalPair,
  isTreatyType,
  parseTreatyRegionSelection,
  type TreatyType,
} from "./diplomacy";
import {
  insertNpcTreatyProposal,
  declareWarByNpc,
} from "./treatyPropose";
import { notifyTreatyProposal } from "./diplomacyNotify";
import {
  decideNpcTreatyResponse,
  type NpcTreatyDecision,
} from "./diplomacyAi";
import { applyNpcTreatyDecision } from "./npcTreatyDecision";
import { buildNationGeoCultureContext } from "./nationGeoCulture";
import {
  createAlliance,
  joinAlliance,
  getNationAllianceIds,
  defaultAllianceName,
} from "./alliances";

/**
 * Task #176 T11 — NPC 自主外交（主動發起）。
 *
 * 在既有「NPC 條約回覆 AI」（只處理玩家提案）與「戰爭引擎 npcWarTick」（只推進
 * 已存在的 NPC↔玩家戰爭）之上，新增一層「NPC 主動發起」：AI（bulk 模型）依關係值
 * 決定哪些 NPC 主動對玩家／其他 NPC 提出條約，以及（僅在世界設定為敵對時）對關係
 * 惡劣的玩家宣戰。宣戰只插入 diplomacy_wars 列，實際戰役仍由 npcWarTick 依既有規則
 * 推進——**不繞過戰爭引擎**。
 *
 * 安全性：主動外交零資源承諾；宣戰只針對真人玩家（is_npc=false 且有 discordUserId），
 * 且經 declareWarByNpc 重查關係值 <0／阻擋條約／冷卻。NPC→NPC 條約提案會立即以既有
 * NPC 條約 AI 自動裁決（對案一律降為拒絕），避免懸置無人回覆的提案。
 */

/** 依強度回傳每回合主動外交／宣戰上限。 */
export interface InitiativeCaps {
  maxTreaties: number;
  maxWars: number;
}

export function initiativeCaps(intensity: number): InitiativeCaps {
  switch (intensity) {
    case 3:
      return { maxTreaties: 6, maxWars: 1 };
    case 2:
      return { maxTreaties: 4, maxWars: 1 };
    case 1:
    default:
      return { maxTreaties: 2, maxWars: 1 };
  }
}

/** canonical pair 的字串鍵（與 diplomacy_relations／diplomacy_wars 的儲存順序一致）。 */
export function pairKey(a: string, b: string): string {
  const { low, high } = canonicalPair(a, b);
  return `${low}:${high}`;
}

// ── AI 輸出結構（bulk 模型、zod 驗證） ─────────────────────────

/** Task #380 — 主動提案附帶的領土條件（名稱＋百分比；null/缺項＝整份轉移）。 */
const initiativeRegionSchema = z.object({
  name: z.string().min(1),
  percent: z.number().int().min(1).max(100).nullish(),
});

const initiativeSchema = z.object({
  actorId: z.string().min(1),
  targetId: z.string().min(1),
  kind: z.enum(["treaty", "war", "alliance"]),
  /** kind=treaty 時的條約類型 slug；於 sanitize 階段以 isTreatyType 嚴格驗證。 */
  treatyType: z.string().nullish(),
  durationDays: z.number().int().min(1).max(3650).nullish(),
  /** Task #380 — kind=treaty 可附帶一次性交換：金錢與領土（offer=行動 NPC 付出、request=索求對方）。 */
  offerMoney: z.number().int().min(0).nullish(),
  requestMoney: z.number().int().min(0).nullish(),
  offerRegions: z.array(initiativeRegionSchema).max(3).nullish(),
  requestRegions: z.array(initiativeRegionSchema).max(3).nullish(),
});

const initiativesResponseSchema = z.object({
  initiatives: z.array(initiativeSchema).max(50),
});

export type RawNpcInitiative = z.infer<typeof initiativeSchema>;

/**
 * 純函式：從 AI 原始文字抽出並驗證出主動外交清單（去 code fence → JSON → zod）。
 * 失敗丟出例外，交呼叫端記錄並略過本回合（絕不寫入半套資料）。
 */
export function extractNpcInitiatives(raw: string): RawNpcInitiative[] {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed: unknown = JSON.parse(cleaned);
  return initiativesResponseSchema.parse(parsed).initiatives;
}

// ── 純函式：計畫化（過濾違規、套用閘門與上限） ───────────────

export interface PlannedInitiative {
  actorId: string;
  targetId: string;
  kind: "treaty" | "war" | "alliance";
  treatyType?: TreatyType;
  durationDays: number | null;
  /** 條約對象是否為真人玩家（決定：通知玩家 vs NPC 自動裁決）。 */
  targetIsPlayer: boolean;
  /** Task #380 — 一次性交換（僅 kind=treaty；驗證失敗一律歸零/清空，不擋整筆提案）。 */
  offerMoney: number;
  requestMoney: number;
  offerRegionIds: number[];
  offerRegionPercents: Record<string, number>;
  requestRegionIds: number[];
  requestRegionPercents: Record<string, number>;
}

/** Task #380 — sanitize 用的領土／金錢脈絡（未提供時所有附帶條件一律剝除）。 */
export interface InitiativeTerritoryContext {
  /** 地區名稱（trim 後完全比對）→ 地區 id。 */
  regionIdByName: ReadonlyMap<string, number>;
  /** nationId → （regionId → 掌控 %）。 */
  heldByNation: ReadonlyMap<string, Map<number, number>>;
  /** nationId → 目前金錢（clamp offer/request 用）。 */
  moneyByNation: ReadonlyMap<string, number>;
}

/**
 * Task #380 — 純函式：把 AI 回覆的領土名單（名稱＋百分比）解析為 regionId 集合，
 * 並以 parseTreatyRegionSelection 驗證（≤10 區、百分比 1–100、必須是該側國家
 * 目前掌控的地區、百分比不得超過實際掌控份額）。任何一筆解析／驗證失敗 →
 * 整側清空（回傳空集合），提案仍照常送出但不帶該側領土。
 */
export function resolveInitiativeRegions(params: {
  regions: readonly { name: string; percent?: number | null }[] | null | undefined;
  regionIdByName: ReadonlyMap<string, number>;
  held: Map<number, number> | undefined;
}): { regionIds: number[]; regionPercents: Record<string, number> } {
  const empty = { regionIds: [], regionPercents: {} };
  const { regions, regionIdByName, held } = params;
  if (!regions || regions.length === 0 || !held) return empty;

  const rawIds: number[] = [];
  const rawPercents: Record<string, number> = {};
  for (const r of regions) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const id = name ? regionIdByName.get(name) : undefined;
    if (id === undefined) return empty;
    if (!rawIds.includes(id)) rawIds.push(id);
    if (r.percent !== undefined && r.percent !== null) {
      rawPercents[String(id)] = r.percent;
    }
  }
  const parsed = parseTreatyRegionSelection({
    rawRegionIds: rawIds,
    rawRegionPercents: rawPercents,
    held,
    sideLabel: "NPC 提案",
  });
  if (!parsed.ok) return empty;
  return { regionIds: parsed.regionIds, regionPercents: parsed.regionPercents };
}

/** Task #380 — clamp 金額到 [0, treasury]（非法值一律 0）。 */
export function clampInitiativeMoney(
  raw: number | null | undefined,
  treasury: number,
): number {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw <= 0 ||
    treasury <= 0
  ) {
    return 0;
  }
  return Math.min(raw, treasury);
}

export interface SanitizeInitiativesContext {
  /** 可主動行動者：NPC（is_npc=true）id。 */
  actorIds: ReadonlySet<string>;
  /** 可作為條約對象者：真人玩家 ∪ NPC（不含無主國家）。 */
  treatyTargetIds: ReadonlySet<string>;
  /** 真人玩家 id（宣戰對象、以及區分條約對象是否為玩家）。 */
  playerIds: ReadonlySet<string>;
  /** canonical pair 鍵 → 關係值。 */
  relationScores: ReadonlyMap<string, number>;
  /** 已有 proposed 提案的 pair（略過重複）。 */
  pendingPairs: ReadonlySet<string>;
  /** 交戰中的 pair。 */
  activeWarPairs: ReadonlySet<string>;
  /** 是否允許對玩家宣戰（世界旗標）。 */
  hostileToPlayers: boolean;
  caps: InitiativeCaps;
  /** Task #380 — 領土／金錢脈絡；未提供時 treaty 一律不帶附帶條件。 */
  territory?: InitiativeTerritoryContext;
}

/**
 * 純函式：把 AI 原始清單過濾成可安全執行的計畫。
 * 逐項套用：actor 須為 NPC、不可對自己、同一 pair 每回合至多一項、略過已有提案；
 * war 須開啟敵對旗標＋對象為玩家＋關係<0＋未交戰；treaty 對象須在名單內、未交戰。
 * 分別套用 treaty／war 數量上限。
 */
export function sanitizeInitiatives(
  raw: readonly RawNpcInitiative[],
  ctx: SanitizeInitiativesContext,
): PlannedInitiative[] {
  const planned: PlannedInitiative[] = [];
  const usedPairs = new Set<string>();
  let treaties = 0;
  let wars = 0;
  /** Task #380 — war/alliance（或無領土脈絡時的 treaty）一律零附帶。 */
  const noExchange = {
    offerMoney: 0,
    requestMoney: 0,
    offerRegionIds: [] as number[],
    offerRegionPercents: {} as Record<string, number>,
    requestRegionIds: [] as number[],
    requestRegionPercents: {} as Record<string, number>,
  };

  for (const it of raw) {
    const { actorId, targetId } = it;
    if (!ctx.actorIds.has(actorId)) continue;
    if (actorId === targetId) continue;
    const key = pairKey(actorId, targetId);
    if (usedPairs.has(key)) continue;
    if (ctx.pendingPairs.has(key)) continue;

    if (it.kind === "war") {
      if (!ctx.hostileToPlayers) continue;
      if (!ctx.playerIds.has(targetId)) continue;
      if (ctx.activeWarPairs.has(key)) continue;
      if ((ctx.relationScores.get(key) ?? 0) >= 0) continue;
      if (wars >= ctx.caps.maxWars) continue;
      wars++;
      usedPairs.add(key);
      planned.push({
        actorId,
        targetId,
        kind: "war",
        durationDays: null,
        targetIsPlayer: true,
        ...noExchange,
      });
      continue;
    }

    if (it.kind === "alliance") {
      // 聯盟僅在 NPC 之間即時結盟（對象須為 NPC，非玩家、非無主）；避免懸置邀請。
      if (!ctx.treatyTargetIds.has(targetId)) continue;
      if (ctx.playerIds.has(targetId)) continue;
      if (ctx.activeWarPairs.has(key)) continue;
      // 關係須為正向才結盟。
      if ((ctx.relationScores.get(key) ?? 0) <= 0) continue;
      if (treaties >= ctx.caps.maxTreaties) continue;
      treaties++;
      usedPairs.add(key);
      planned.push({
        actorId,
        targetId,
        kind: "alliance",
        durationDays: null,
        targetIsPlayer: false,
        ...noExchange,
      });
      continue;
    }

    // treaty
    if (!ctx.treatyTargetIds.has(targetId)) continue;
    if (ctx.activeWarPairs.has(key)) continue;
    if (treaties >= ctx.caps.maxTreaties) continue;
    // Task #214 — NPC 主動外交不提「自訂條約」（需玩家自訂條款與付款方向）；
    // 若 AI 誤輸出 custom，降級為互不侵犯。
    const type: TreatyType =
      isTreatyType(it.treatyType) && it.treatyType !== "custom"
        ? it.treatyType
        : "nonaggression";
    treaties++;
    usedPairs.add(key);

    // Task #380 — 附帶一次性交換：金錢 clamp 到各自國庫；領土以
    // parseTreatyRegionSelection 驗證（offer=行動 NPC 掌控、request=對象掌控），
    // 任何一側驗證失敗只剝除該側條件，不擋整筆提案。
    let exchange = noExchange;
    const terr = ctx.territory;
    if (terr) {
      const offer = resolveInitiativeRegions({
        regions: it.offerRegions,
        regionIdByName: terr.regionIdByName,
        held: terr.heldByNation.get(actorId),
      });
      const request = resolveInitiativeRegions({
        regions: it.requestRegions,
        regionIdByName: terr.regionIdByName,
        held: terr.heldByNation.get(targetId),
      });
      exchange = {
        offerMoney: clampInitiativeMoney(
          it.offerMoney,
          terr.moneyByNation.get(actorId) ?? 0,
        ),
        requestMoney: clampInitiativeMoney(
          it.requestMoney,
          terr.moneyByNation.get(targetId) ?? 0,
        ),
        offerRegionIds: offer.regionIds,
        offerRegionPercents: offer.regionPercents,
        requestRegionIds: request.regionIds,
        requestRegionPercents: request.regionPercents,
      };
    }

    planned.push({
      actorId,
      targetId,
      kind: "treaty",
      treatyType: type,
      durationDays: it.durationDays ?? null,
      targetIsPlayer: ctx.playerIds.has(targetId),
      ...exchange,
    });
  }

  return planned;
}

/**
 * 純函式：NPC→NPC 條約裁決的對案降級。對案會產生一筆「等待原提案 NPC 回覆」的
 * 新提案列，而沒有任何流程會回覆它（懸置）；故 NPC→NPC 一律把 counter 降為 reject。
 */
export function coerceNpcToNpcDecision(
  decision: NpcTreatyDecision,
): NpcTreatyDecision {
  if (decision.decision === "counter") {
    return {
      decision: "reject",
      note: decision.note,
      counter: null,
      relationDelta: decision.relationDelta,
    };
  }
  return decision;
}

// ── AI 服務（bulk 模型） ───────────────────────────────────────

export interface NpcActorSummary {
  id: string;
  name: string | null;
  government: string | null;
  stability: number;
  unrest: number;
  /** Task #233 — 治理風格（政治註記）；供 AI 決策參考。 */
  politicalNote: string | null;
  /** Task #233 — 外交態度（管理員設定或 AI 生成）；供 AI 決策參考。 */
  diplomaticAttitude: string | null;
  /** Task #380 — 目前金錢（offerMoney 上限）。 */
  money: number;
  /** Task #380 — 掌控地區（offerRegions 只能從中挑選；已依掌控 % 排序截前 8）。 */
  regions: { name: string; heldPercent: number }[];
}

export interface InitiativeCandidateSummary {
  id: string;
  name: string | null;
  kind: "player" | "npc";
  relationScore: number;
  atWar: boolean;
  hasActiveTreaty: boolean;
  hasPendingProposal: boolean;
  /** Task #380 — 與行動 NPC 領土相鄰、且對象掌控中的地區（requestRegions 只能從中挑選；截前 6）。 */
  adjacentRegions: { name: string; heldPercent: number }[];
}

export interface GenerateNpcInitiativesInput {
  year: number;
  eraLabel: string;
  hostileToPlayers: boolean;
  caps: InitiativeCaps;
  actors: NpcActorSummary[];
  candidatesByActor: {
    actorId: string;
    candidates: InitiativeCandidateSummary[];
  }[];
  /** Task #233 — 管理員干預指令（全域方針，最高優先）；null／未提供時不加入。 */
  adminDirective?: string | null;
}

function buildSystemPrompt(): string {
  return [
    "你是一款架空世界戰略遊戲的「NPC 外交 AI」。你要替 NPC 國家決定本回合是否主動對其他國家（玩家或其他 NPC）發起外交行動。只回覆單一 JSON 物件（不要 code fence、不要任何前後說明文字）。",
    "",
    "JSON 結構：",
    '{"initiatives":[ ...行動陣列... ]}',
    "",
    "每個行動為：",
    '{"actorId":"發起的 NPC uuid","targetId":"對象國家 uuid","kind":"treaty" / "war" / "alliance","treatyType":"nonaggression|military_access|guarantee（kind=treaty 時必填）","durationDays":條約時效天數整數或 null,"offerMoney":一次性附上的金錢整數≥0（可省略）,"requestMoney":要求對方一次性支付的金錢整數≥0（可省略）,"offerRegions":[{"name":"地區名稱","percent":1–100 的整數或 null(整份)}]（至多 3，可省略）,"requestRegions":同 offerRegions 格式（至多 3，可省略）}',
    "",
    "硬性規則（違反的行動會被系統丟棄）：",
    "1. actorId 必須是下方「可主動 NPC」清單中的 uuid。",
    "2. kind=treaty 的 targetId 必須出現在該 NPC 的候選清單；kind=war 的 targetId 必須是候選清單中標記為［玩家］者；kind=alliance 的 targetId 必須是候選清單中標記為［NPC］者。",
    "3. 只有在「允許對玩家宣戰＝是」時才可輸出 kind=war，且只能對關係值 < 0 的玩家宣戰。",
    "4. 不要對「進行中提案＝是」或「交戰＝是」的對象重複發起。",
    "5. 數量上限：treaty 與 alliance 合計 ≤ maxTreaties，war 總數 ≤ maxWars。寧缺勿濫，只在合理時發起。",
    "6. kind=alliance 表示「結成或加入聯盟」，只能對關係值 > 0 的 NPC 發起；聯盟成員之間不可互相宣戰，但不會自動參戰。系統會即時處理（雙方皆無聯盟則建立新聯盟，其一有聯盟則另一方加入）。",
    "7. 決策要貼合關係值與年代：關係佳→結盟（alliance）／軍事通行權／保障獨立；關係普通→互不侵犯；關係惡劣且允許→宣戰。",
    "8. 若某 NPC 標註了「外交態度」或「治理風格」，該 NPC 的決策傾向必須貼合其外交態度與治理風格（例如親善結盟、孤立自保、擴張好戰）。",
    "9. 若下方列出「世界管理員方針」，那是本場模擬的最高優先指示：所有 NPC 的決策都必須在合理範圍內盡量朝其方向靠攏，與上述傾向衝突時一律以管理員方針為準。",
    "10. 一次性交換（僅 kind=treaty 可帶）：offerMoney／offerRegions 是行動 NPC 付出、requestMoney／requestRegions 是要求對方付出。offerRegions 只能挑該 NPC「掌控地區」清單中的地區，requestRegions 只能挑該候選對象的「可索求的相鄰地區」清單中的地區；名稱必須與清單完全一致，percent 不得超過清單標示的掌控 %。offerMoney 不得超過該 NPC 目前金錢。",
    "11. 領土交換是重大提案：只在關係尚可且地緣合理時酌量提出（例如以金錢向相鄰國購買一小塊地、或以一塊地換取對方的地），一次至多 1–2 個地區或部分百分比，不要獅子大開口；索求領土時務必附上相稱的金錢或領土作交換，否則對方幾乎必拒。多數提案仍應不帶任何附帶條件。",
  ].join("\n");
}

function buildUserPrompt(input: GenerateNpcInitiativesInput): string {
  const lines: string[] = [
    `世界目前年份：${input.year}　時代：${input.eraLabel}`,
    `允許對玩家宣戰：${input.hostileToPlayers ? "是" : "否"}`,
    `數量上限：treaty ≤ ${input.caps.maxTreaties}，war ≤ ${input.caps.maxWars}`,
  ];
  if (input.adminDirective) {
    lines.push(
      "",
      `世界管理員方針（最高優先，務必遵循）：${input.adminDirective}`,
    );
  }
  lines.push("", "可主動 NPC（actorId 從中挑選）：");
  if (input.actors.length === 0) {
    lines.push("（無）");
  } else {
    for (const a of input.actors) {
      lines.push(
        `- ${a.name ?? "(未命名)"} | id=${a.id} | 政體=${
          a.government ?? "無"
        } | 安定${a.stability}/動亂${a.unrest} | 金錢=${a.money}`,
      );
      if (a.regions.length > 0) {
        lines.push(
          `    掌控地區（offerRegions 只能從中挑選）：${a.regions
            .map((r) => `${r.name}（掌控 ${r.heldPercent}%）`)
            .join("、")}`,
        );
      }
      if (a.diplomaticAttitude) {
        lines.push(`    外交態度：${a.diplomaticAttitude}`);
      }
      if (a.politicalNote) {
        lines.push(`    治理風格：${a.politicalNote}`);
      }
    }
  }
  lines.push("", "各 NPC 的候選對象與關係：");
  for (const group of input.candidatesByActor) {
    const actor = input.actors.find((a) => a.id === group.actorId);
    lines.push(`【${actor?.name ?? group.actorId}】`);
    if (group.candidates.length === 0) {
      lines.push("  （無候選對象）");
      continue;
    }
    for (const c of group.candidates) {
      const tag = c.kind === "player" ? "玩家" : "NPC";
      lines.push(
        `  → [${tag}] ${c.name ?? "(未命名)"} | id=${c.id} | 關係=${
          c.relationScore
        } | 交戰=${c.atWar ? "是" : "否"} | 已有條約=${
          c.hasActiveTreaty ? "是" : "否"
        } | 進行中提案=${c.hasPendingProposal ? "是" : "否"}`,
      );
      if (c.adjacentRegions.length > 0) {
        lines.push(
          `      可索求的相鄰地區（requestRegions 只能從中挑選）：${c.adjacentRegions
            .map((r) => `${r.name}（掌控 ${r.heldPercent}%）`)
            .join("、")}`,
        );
      }
    }
  }
  lines.push("", "僅回覆單一 JSON 物件。");
  return lines.join("\n");
}

/**
 * 產生 NPC 主動外交清單。解析失敗一律丟出例外（呼叫端記錄後略過本回合）。
 * 預設 bulk 模型（每回合成本考量）。
 */
export async function generateNpcInitiatives(
  input: GenerateNpcInitiativesInput,
  modelTier: AiModelTier = "bulk",
): Promise<RawNpcInitiative[]> {
  const message = await callGameAi("npc_initiative.proposals", modelTier, {
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });
  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";
  try {
    return extractNpcInitiatives(raw);
  } catch (err) {
    logger.error(
      { err, raw: raw.slice(0, 800) },
      "npc initiative parse failed",
    );
    throw new Error("NPC 外交 AI 回覆格式不正確");
  }
}

// ── 快照 ───────────────────────────────────────────────────────

interface NationRef {
  id: string;
  name: string | null;
  discordUserId: string | null;
  isNpc: boolean;
  politicalNote: string | null;
  diplomaticAttitude: string | null;
}

interface InitiativeSnapshot {
  actors: NpcActorSummary[];
  candidatesByActor: {
    actorId: string;
    candidates: InitiativeCandidateSummary[];
  }[];
  actorIds: Set<string>;
  treatyTargetIds: Set<string>;
  playerIds: Set<string>;
  relationScores: Map<string, number>;
  pendingPairs: Set<string>;
  activeWarPairs: Set<string>;
  nationById: Map<string, NationRef>;
  /** Task #380 — 領土／金錢脈絡（sanitize 驗證用）。 */
  territory: InitiativeTerritoryContext;
  /** Task #380 — 地區 id → 名稱（描述附帶領土用）。 */
  regionNameById: Map<number, string>;
}

async function buildNpcInitiativeSnapshot(): Promise<InitiativeSnapshot> {
  const nations = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
      government: playerNationsTable.government,
      stability: playerNationsTable.stability,
      unrest: playerNationsTable.unrest,
      politicalNote: playerNationsTable.politicalNote,
      diplomaticAttitude: playerNationsTable.diplomaticAttitude,
      money: playerNationsTable.money,
    })
    .from(playerNationsTable);

  // Task #380 — 地區名冊、各國掌控、相鄰關係（供 offer/request 領土的提示與驗證）。
  const [regionRows, controlRows, adjacencyRows] = await Promise.all([
    db
      .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
      .from(mapRegionsTable),
    db
      .select({
        nationId: regionControlsTable.nationId,
        regionId: regionControlsTable.regionId,
        percent: regionControlsTable.percent,
      })
      .from(regionControlsTable),
    db
      .select({
        regionId: mapRegionAdjacenciesTable.regionId,
        adjacentRegionId: mapRegionAdjacenciesTable.adjacentRegionId,
      })
      .from(mapRegionAdjacenciesTable),
  ]);
  const regionNameById = new Map<number, string>();
  const regionIdByName = new Map<string, number>();
  for (const r of regionRows) {
    regionNameById.set(r.id, r.name);
    regionIdByName.set(r.name.trim(), r.id);
  }
  const heldByNation = new Map<string, Map<number, number>>();
  for (const c of controlRows) {
    if (c.percent <= 0) continue;
    let held = heldByNation.get(c.nationId);
    if (!held) {
      held = new Map<number, number>();
      heldByNation.set(c.nationId, held);
    }
    held.set(c.regionId, c.percent);
  }
  const neighborsByRegion = new Map<number, number[]>();
  for (const a of adjacencyRows) {
    const list = neighborsByRegion.get(a.regionId);
    if (list) list.push(a.adjacentRegionId);
    else neighborsByRegion.set(a.regionId, [a.adjacentRegionId]);
  }
  const moneyByNation = new Map<string, number>();

  const actorIds = new Set<string>();
  const playerIds = new Set<string>();
  const npcIds = new Set<string>();
  const nationById = new Map<string, NationRef>();
  const actors: NpcActorSummary[] = [];

  /** 該國掌控地區清單（名稱＋掌控 %，依 % 由高到低，截前 limit 筆）。 */
  const describeHeld = (
    nationId: string,
    limit: number,
    filter?: (regionId: number) => boolean,
  ): { name: string; heldPercent: number }[] => {
    const held = heldByNation.get(nationId);
    if (!held) return [];
    return [...held.entries()]
      .filter(([regionId]) => (filter ? filter(regionId) : true))
      .sort((x, y) => y[1] - x[1])
      .slice(0, limit)
      .map(([regionId, pct]) => ({
        name: regionNameById.get(regionId) ?? `#${regionId}`,
        heldPercent: pct,
      }));
  };

  for (const n of nations) {
    moneyByNation.set(n.id, n.money);
    nationById.set(n.id, {
      id: n.id,
      name: n.name,
      discordUserId: n.discordUserId,
      isNpc: n.isNpc,
      politicalNote: n.politicalNote,
      diplomaticAttitude: n.diplomaticAttitude,
    });
    if (n.isNpc) {
      actorIds.add(n.id);
      npcIds.add(n.id);
      actors.push({
        id: n.id,
        name: n.name,
        government: n.government,
        stability: n.stability,
        unrest: n.unrest,
        politicalNote: n.politicalNote,
        diplomaticAttitude: n.diplomaticAttitude,
        money: n.money,
        regions: describeHeld(n.id, 8),
      });
    } else if (n.discordUserId !== null) {
      playerIds.add(n.id);
    }
    // 無主國家（!isNpc && discordUserId===null）不列入行動者，也不列入對象。
  }
  const treatyTargetIds = new Set<string>([...playerIds, ...npcIds]);

  const relations = await db
    .select({
      a: diplomacyRelationsTable.nationAId,
      b: diplomacyRelationsTable.nationBId,
      score: diplomacyRelationsTable.score,
    })
    .from(diplomacyRelationsTable);
  const relationScores = new Map<string, number>();
  for (const r of relations) relationScores.set(`${r.a}:${r.b}`, r.score);

  const proposed = await db
    .select({
      proposer: diplomacyTreatiesTable.proposerNationId,
      target: diplomacyTreatiesTable.targetNationId,
    })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.status, "proposed"));
  const pendingPairs = new Set<string>();
  for (const t of proposed) pendingPairs.add(pairKey(t.proposer, t.target));

  const activeTreatyRows = await db
    .select({
      proposer: diplomacyTreatiesTable.proposerNationId,
      target: diplomacyTreatiesTable.targetNationId,
    })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.status, "active"));
  const activeTreatyPairs = new Set<string>();
  for (const t of activeTreatyRows)
    activeTreatyPairs.add(pairKey(t.proposer, t.target));

  const wars = await db
    .select({
      a: diplomacyWarsTable.nationAId,
      b: diplomacyWarsTable.nationBId,
    })
    .from(diplomacyWarsTable)
    .where(isNull(diplomacyWarsTable.endedAt));
  const activeWarPairs = new Set<string>();
  for (const w of wars) activeWarPairs.add(`${w.a}:${w.b}`);

  const candidatesByActor = actors.map((actor) => {
    const actorHeld = heldByNation.get(actor.id);
    /** 對象掌控的地區中，與行動 NPC 領土相鄰者（地緣：可索求的鄰接地）。 */
    const isAdjacentToActor = (regionId: number): boolean => {
      if (!actorHeld) return false;
      const neighbors = neighborsByRegion.get(regionId);
      if (!neighbors) return false;
      return neighbors.some((nId) => actorHeld.has(nId));
    };
    const candidates: InitiativeCandidateSummary[] = [];
    for (const cid of treatyTargetIds) {
      if (cid === actor.id) continue;
      const cn = nationById.get(cid);
      if (!cn) continue;
      const key = pairKey(actor.id, cid);
      candidates.push({
        id: cid,
        name: cn.name,
        kind: playerIds.has(cid) ? "player" : "npc",
        relationScore: relationScores.get(key) ?? 0,
        atWar: activeWarPairs.has(key),
        hasActiveTreaty: activeTreatyPairs.has(key),
        hasPendingProposal: pendingPairs.has(key),
        adjacentRegions: describeHeld(cid, 6, isAdjacentToActor),
      });
    }
    return { actorId: actor.id, candidates };
  });

  return {
    actors,
    candidatesByActor,
    actorIds,
    treatyTargetIds,
    playerIds,
    relationScores,
    pendingPairs,
    activeWarPairs,
    nationById,
    territory: { regionIdByName, heldByNation, moneyByNation },
    regionNameById,
  };
}

// ── NPC→NPC 條約自動裁決 ───────────────────────────────────────

export async function resolveNpcToNpcTreaty(
  treatyId: number,
  ctx: {
    npcName: string;
    proposerName: string;
    treatyType: string;
    durationDays: number | null;
    relationScore: number;
    atWar: boolean;
    /** Task #233 — 受提案 NPC 的治理風格／外交態度與全域方針，注入 AI 判斷。 */
    politicalNote?: string | null;
    diplomaticAttitude?: string | null;
    adminDirective?: string | null;
    /** Task #369 — 提案國（對方）所在地區的地理人文脈絡，僅影響 NPC 回覆用語。 */
    counterpartGeoContext?: string | null;
    /** Task #380 — 提案的實際 offer/request 內容（金錢／科技／領土名稱），注入判斷 prompt。 */
    offerMoney?: number;
    offerTechPoints?: number;
    offerRegionNames?: string[];
    requestMoney?: number;
    requestTechPoints?: number;
    requestRegionNames?: string[];
  },
): Promise<void> {
  let decision: NpcTreatyDecision;
  try {
    decision = await decideNpcTreatyResponse({
      npcName: ctx.npcName,
      proposerName: ctx.proposerName,
      treatyType: ctx.treatyType,
      durationDays: ctx.durationDays,
      offerMoney: ctx.offerMoney ?? 0,
      offerTechPoints: ctx.offerTechPoints ?? 0,
      offerRegionNames: ctx.offerRegionNames ?? [],
      requestMoney: ctx.requestMoney ?? 0,
      requestTechPoints: ctx.requestTechPoints ?? 0,
      requestRegionNames: ctx.requestRegionNames ?? [],
      relationScore: ctx.relationScore,
      atWar: ctx.atWar,
      politicalNote: ctx.politicalNote ?? null,
      diplomaticAttitude: ctx.diplomaticAttitude ?? null,
      adminDirective: ctx.adminDirective ?? null,
      counterpartGeoContext: ctx.counterpartGeoContext ?? null,
    });
  } catch (err) {
    logger.error(
      { err, treatyId },
      "npc-to-npc treaty decision failed; auto-rejecting to avoid dangling proposal",
    );
    decision = {
      decision: "reject",
      note: "（NPC 外交判斷失敗，自動婉拒）",
      counter: null,
      relationDelta: 0,
    };
  }
  decision = coerceNpcToNpcDecision(decision);
  try {
    await applyNpcTreatyDecision(treatyId, decision);
  } catch (err) {
    // 併發下條約可能已被其他流程處理（409）；提案已非 proposed，不會懸置，僅記錄。
    logger.error({ err, treatyId }, "npc-to-npc treaty apply failed");
  }
}

// ── 每回合協調器 ───────────────────────────────────────────────

export interface NpcInitiativeTurnResult {
  treatiesProposed: number;
  warsDeclared: number;
  alliancesFormed: number;
}

/**
 * NPC↔NPC 即時結盟：依雙方目前所屬聯盟決定行為，全程無懸置邀請。
 * - 雙方皆無聯盟 → actor 建立新聯盟，target 加入。
 * - 僅一方有聯盟 → 另一方加入該方「最早加入」的聯盟。
 * - 雙方皆有聯盟 → 不動作（NPC 保守策略：不自動疊加多聯盟，避免聯盟氾濫）。
 * 回傳是否有實際結盟動作（供統計）。
 */
export async function resolveNpcAlliance(
  actorId: string,
  targetId: string,
  actorName: string | null,
): Promise<boolean> {
  const actorAllianceIds = await getNationAllianceIds(actorId);
  const targetAllianceIds = await getNationAllianceIds(targetId);
  const actorAllianceId = actorAllianceIds[0] ?? null;
  const targetAllianceId = targetAllianceIds[0] ?? null;

  if (actorAllianceId && targetAllianceId) {
    return false; // 兩方皆已有聯盟：NPC 不自動疊加。
  }
  if (actorAllianceId && !targetAllianceId) {
    const res = await joinAlliance(actorAllianceId, targetId);
    return res.ok;
  }
  if (!actorAllianceId && targetAllianceId) {
    const res = await joinAlliance(targetAllianceId, actorId);
    return res.ok;
  }
  // 兩方皆無聯盟：actor 建盟，target 加入。
  const created = await createAlliance(actorId, defaultAllianceName(actorName));
  if (!created.ok) return false;
  const joined = await joinAlliance(created.alliance.id, targetId);
  return joined.ok;
}

/**
 * 執行一次「NPC 主動外交」回合。由回合世界模擬（runWorldSimTurn）呼叫，包在獨立
 * try/catch 中，失敗不阻斷其他結算。
 */
export async function runNpcInitiativesTurn(params: {
  intensity: number;
  hostileToPlayers: boolean;
  year: number;
  eraLabel: string;
  /** Task #233 — 管理員干預指令（全域方針，最高優先）；注入 NPC 外交 AI 提示。 */
  adminDirective?: string | null;
}): Promise<NpcInitiativeTurnResult> {
  const caps = initiativeCaps(params.intensity);
  const snap = await buildNpcInitiativeSnapshot();
  if (snap.actors.length === 0) {
    return { treatiesProposed: 0, warsDeclared: 0, alliancesFormed: 0 };
  }
  const anyCandidate = snap.candidatesByActor.some(
    (g) => g.candidates.length > 0,
  );
  if (!anyCandidate)
    return { treatiesProposed: 0, warsDeclared: 0, alliancesFormed: 0 };

  const raw = await generateNpcInitiatives(
    {
      year: params.year,
      eraLabel: params.eraLabel,
      hostileToPlayers: params.hostileToPlayers,
      caps,
      actors: snap.actors,
      candidatesByActor: snap.candidatesByActor,
      adminDirective: params.adminDirective ?? null,
    },
    "bulk",
  );

  const planned = sanitizeInitiatives(raw, {
    actorIds: snap.actorIds,
    treatyTargetIds: snap.treatyTargetIds,
    playerIds: snap.playerIds,
    relationScores: snap.relationScores,
    pendingPairs: snap.pendingPairs,
    activeWarPairs: snap.activeWarPairs,
    hostileToPlayers: params.hostileToPlayers,
    caps,
    territory: snap.territory,
  });

  // Task #380 — 附帶領土的「名稱（xx%）」描述（NPC↔NPC 判斷 prompt 用）。
  const describeRegions = (
    ids: number[],
    percents: Record<string, number>,
  ): string[] =>
    ids.map((id) => {
      const name = snap.regionNameById.get(id) ?? `#${id}`;
      const pct = percents[String(id)];
      return pct !== undefined && pct < 100 ? `${name}（${pct}%）` : name;
    });

  let treatiesProposed = 0;
  let warsDeclared = 0;
  let alliancesFormed = 0;

  for (const p of planned) {
    try {
      const actor = snap.nationById.get(p.actorId);
      const target = snap.nationById.get(p.targetId);
      if (!actor || !target) continue;

      if (p.kind === "war") {
        const res = await declareWarByNpc({
          declarerNationId: p.actorId,
          declarerName: actor.name,
          target: {
            id: target.id,
            name: target.name,
            discordUserId: target.discordUserId,
          },
        });
        if (res.declared) warsDeclared++;
        continue;
      }

      if (p.kind === "alliance") {
        const formed = await resolveNpcAlliance(p.actorId, p.targetId, actor.name);
        if (formed) alliancesFormed++;
        continue;
      }

      // treaty
      const treatyType = p.treatyType ?? "nonaggression";
      // Task #380 — 一次性交換：offer=提案 NPC 付出、request=對方付出；
      // proposerIsPayer 必須為 true（非 custom 時 false 會翻轉 offer/request 方向）。
      const treaty = await insertNpcTreatyProposal({
        proposerNationId: p.actorId,
        targetNationId: p.targetId,
        type: treatyType,
        durationDays: p.durationDays,
        offerMoney: p.offerMoney,
        offerRegionIds: p.offerRegionIds,
        offerRegionPercents: p.offerRegionPercents,
        requestMoney: p.requestMoney,
        requestRegionIds: p.requestRegionIds,
        requestRegionPercents: p.requestRegionPercents,
        proposerIsPayer: true,
      });
      if (!treaty) continue; // 已有進行中提案（23505）→ 略過
      treatiesProposed++;

      if (p.targetIsPlayer) {
        notifyTreatyProposal({
          targetDiscordUserId: target.discordUserId,
          proposerNationName: actor.name,
          treatyType,
        });
      } else {
        // NPC → NPC：即時自動裁決（對案降為拒絕），避免懸置提案。
        await resolveNpcToNpcTreaty(treaty.id, {
          npcName: target.name ?? "",
          proposerName: actor.name ?? "",
          treatyType,
          durationDays: p.durationDays,
          // Task #380 — 帶上實際 offer/request 內容（金錢／領土）供 AI 判斷。
          offerMoney: p.offerMoney,
          offerRegionNames: describeRegions(
            p.offerRegionIds,
            p.offerRegionPercents,
          ),
          requestMoney: p.requestMoney,
          requestRegionNames: describeRegions(
            p.requestRegionIds,
            p.requestRegionPercents,
          ),
          relationScore:
            snap.relationScores.get(pairKey(p.actorId, p.targetId)) ?? 0,
          atWar: snap.activeWarPairs.has(pairKey(p.actorId, p.targetId)),
          politicalNote: target.politicalNote,
          diplomaticAttitude: target.diplomaticAttitude,
          adminDirective: params.adminDirective ?? null,
          // Task #369 — 提案國（actor）所在地區的地理人文脈絡，僅影響回覆用語。
          counterpartGeoContext: await buildNationGeoCultureContext(p.actorId),
        });
      }
    } catch (err) {
      logger.error({ err, initiative: p }, "npc initiative execution failed");
    }
  }

  return { treatiesProposed, warsDeclared, alliancesFormed };
}
