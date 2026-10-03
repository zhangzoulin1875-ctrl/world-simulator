import { z } from "zod";
import { ERAS } from "./mapRegionEras";
import { GOVERNMENTS } from "./governments";
import { normalizeNpcTechEra } from "./npcTech";
import { EXPECTED_REGION_COUNT } from "./mapConstants.generated";

/**
 * Task #176 — AI 驅動 NPC 系統的純粹提案模型與驗證（無 DB 相依，可單元測試）。
 *
 * 「世界提案」(WorldProposal) 是 AI 產生、管理員預覽後套用的一組世界變更操作，
 * 只能新增／編輯／刪除 NPC 與無主國家，並在非玩家國家之間重畫領土。
 *
 * 硬性規則（本模組的存在理由）：AI 絕不可更動玩家國家
 * （is_npc = false 且 discord_user_id NOT NULL）或其 region_controls。
 * validateWorldProposal 以傳入的「受保護國家 id 集合」把關：任何操作只要指向
 * 受保護國家，整份提案即被拒絕。領土 Σ≤100/地區 亦把玩家既有掌控計入，
 * 使 AI 無法擠壓玩家已持有的地盤。
 */

/** 國名／領袖名長度上限（與建國一致）。 */
export const MAX_NATION_NAME_LEN = 40;
/** 單份提案操作數上限（成本與安全上限）。 */
export const MAX_PROPOSAL_OPERATIONS = 200;
/** 地區數上限（世界共 373 區）。 */
export const MAX_REGION_ASSIGNMENTS = EXPECTED_REGION_COUNT;

const ERA_SLUGS = ERAS.map((e) => e.slug) as [string, ...string[]];
const GOVERNMENT_LABELS = GOVERNMENTS.map((g) => g.label) as [
  string,
  ...string[],
];

/** 語意驗證失敗（zh-TW 訊息）；路由據此回 400/409。 */
export class WorldProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldProposalError";
  }
}

// ── zod 提案結構 ──

const regionAssignmentSchema = z.object({
  regionId: z.number().int().positive(),
  percent: z.number().int().min(1).max(100),
});
export type RegionAssignment = z.infer<typeof regionAssignmentSchema>;

const eraSlugSchema = z.enum(ERA_SLUGS);
const governmentLabelSchema = z.enum(GOVERNMENT_LABELS);
const nationNameSchema = z.string().trim().min(1).max(MAX_NATION_NAME_LEN);
const leaderNameSchema = z.string().trim().max(MAX_NATION_NAME_LEN);
const stat0to100 = z.number().int().min(0).max(100);

const createNpcOpSchema = z.object({
  op: z.literal("createNpc"),
  /** 提案內臨時識別字，用來在稽核／預覽中對應（套用時忽略）。 */
  tempId: z.string().trim().min(1).max(64),
  name: nationNameSchema,
  leaderName: leaderNameSchema.nullable().optional(),
  government: governmentLabelSchema.nullable().optional(),
  techEraMilitary: eraSlugSchema.nullable().optional(),
  techEraSocial: eraSlugSchema.nullable().optional(),
  techEraProduction: eraSlugSchema.nullable().optional(),
  stability: stat0to100.optional(),
  unrest: stat0to100.optional(),
  regions: z.array(regionAssignmentSchema).min(1).max(MAX_REGION_ASSIGNMENTS),
});

const updateNationOpSchema = z.object({
  op: z.literal("updateNation"),
  nationId: z.string().uuid(),
  name: nationNameSchema.optional(),
  leaderName: leaderNameSchema.nullable().optional(),
  government: governmentLabelSchema.nullable().optional(),
  techEraMilitary: eraSlugSchema.nullable().optional(),
  techEraSocial: eraSlugSchema.nullable().optional(),
  techEraProduction: eraSlugSchema.nullable().optional(),
  stability: stat0to100.optional(),
  unrest: stat0to100.optional(),
  /** 提供 = 全量替換該國領土（[] = 釋出全部）；省略 = 不變。 */
  regions: z.array(regionAssignmentSchema).max(MAX_REGION_ASSIGNMENTS).optional(),
});

const deleteNationOpSchema = z.object({
  op: z.literal("deleteNation"),
  nationId: z.string().uuid(),
});

export const worldOpSchema = z.discriminatedUnion("op", [
  createNpcOpSchema,
  updateNationOpSchema,
  deleteNationOpSchema,
]);
export type WorldOp = z.infer<typeof worldOpSchema>;

export const worldProposalSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  operations: z.array(worldOpSchema).min(1).max(MAX_PROPOSAL_OPERATIONS),
});
export type WorldProposal = z.infer<typeof worldProposalSchema>;

/**
 * 從未知輸入解析出 WorldProposal（結構驗證）。失敗丟出 zod 錯誤，
 * 呼叫端（AI 服務／路由）自行轉為 zh-TW 訊息。
 */
export function parseWorldProposal(raw: unknown): WorldProposal {
  return worldProposalSchema.parse(raw);
}

// ── 正規化後的套用計畫（供 T3 套用層消費） ──

export interface NormalizedCreate {
  tempId: string;
  name: string;
  leaderName?: string | null;
  government?: string | null;
  techEraMilitary?: string | null;
  techEraSocial?: string | null;
  techEraProduction?: string | null;
  stability?: number;
  unrest?: number;
  regions: RegionAssignment[];
}

export interface NormalizedUpdate {
  nationId: string;
  name?: string;
  leaderName?: string | null;
  government?: string | null;
  techEraMilitary?: string | null;
  techEraSocial?: string | null;
  techEraProduction?: string | null;
  stability?: number;
  unrest?: number;
  /** 提供 = 全量替換領土；省略 = 不動領土。 */
  regions?: RegionAssignment[];
}

export interface NormalizedWorldPlan {
  summary: string;
  creates: NormalizedCreate[];
  updates: NormalizedUpdate[];
  deletes: string[];
}

/** 既有 region_controls 一列（純資料）。 */
export interface RegionControlRow {
  regionId: number;
  nationId: string;
  percent: number;
}

export interface WorldProposalContext {
  /** 玩家國家 id（is_npc=false 且 discord_user_id NOT NULL）；絕不可被觸及。 */
  protectedNationIds: ReadonlySet<string>;
  /** 可編輯國家 id（現有 NPC 或無主國家）。 */
  editableNationIds: ReadonlySet<string>;
  /** 合法地區 id（373 區）。 */
  validRegionIds: ReadonlySet<number>;
  /** 目前所有 region_controls（含玩家列，用於 Σ≤100 計算）。 */
  currentControls: readonly RegionControlRow[];
  /**
   * 世界目前時代 slug（world_game_state.current_era）。提供時，NPC 三領域科技
   * 指標會被夾在 [classical, 此時代]，確保 AI 產生的 NPC 科技不超越當前時代；
   * 省略（純結構單元測試）時不夾取。
   */
  maxTechEraSlug?: string;
}

/**
 * 純函式：把正規化計畫套到既有 controls 上，回傳「每地區控制比例總和」。
 * - 刪除的國家：移除其所有列。
 * - 有 regions 的更新：先移除該國所有既有列，再加入新列。
 * - 無 regions 的更新：該國列不變。
 * - 新增國家：以 tempId 為身分加入其列。
 * 玩家（受保護）國家的列一律原封不動保留，計入總和。
 */
export function applyPlanToControls(
  currentControls: readonly RegionControlRow[],
  plan: NormalizedWorldPlan,
): Map<number, number> {
  const deleted = new Set(plan.deletes);
  const replacedNationIds = new Set(
    plan.updates.filter((u) => u.regions !== undefined).map((u) => u.nationId),
  );

  // regionId -> 總和
  const sums = new Map<number, number>();
  const add = (regionId: number, percent: number) => {
    sums.set(regionId, (sums.get(regionId) ?? 0) + percent);
  };

  for (const row of currentControls) {
    if (deleted.has(row.nationId)) continue;
    if (replacedNationIds.has(row.nationId)) continue; // 由新列取代
    add(row.regionId, row.percent);
  }
  for (const u of plan.updates) {
    if (u.regions === undefined) continue;
    for (const r of u.regions) add(r.regionId, r.percent);
  }
  for (const c of plan.creates) {
    for (const r of c.regions) add(r.regionId, r.percent);
  }
  return sums;
}

function assertRegionList(
  regions: RegionAssignment[],
  validRegionIds: ReadonlySet<number>,
  who: string,
): void {
  const seen = new Set<number>();
  for (const r of regions) {
    if (!validRegionIds.has(r.regionId)) {
      throw new WorldProposalError(`${who}：地區代號 ${r.regionId} 不存在`);
    }
    if (seen.has(r.regionId)) {
      throw new WorldProposalError(
        `${who}：地區代號 ${r.regionId} 重複指派`,
      );
    }
    seen.add(r.regionId);
  }
}

/** 空字串領袖名視為清除（null），與 npcNations 的正規化慣例一致。 */
function normalizeLeaderName(
  v: string | null | undefined,
): string | null | undefined {
  if (v === undefined || v === null) return v;
  return v === "" ? null : v;
}

/**
 * 語意驗證 + 正規化。任何違規（指向玩家國家、未知國家、地區重複／不存在、
 * 某地區 Σ>100 等）皆丟出 WorldProposalError（zh-TW），呼叫端整份拒絕。
 * 成功回傳正規化計畫，供套用層直接執行。
 */
export function validateWorldProposal(
  proposal: WorldProposal,
  ctx: WorldProposalContext,
): NormalizedWorldPlan {
  const creates: NormalizedCreate[] = [];
  const updates: NormalizedUpdate[] = [];
  const deletes: string[] = [];

  const seenTempIds = new Set<string>();
  const targetedNationIds = new Set<string>();

  // 科技時代夾取：未提供世界時代上限時原樣通過；提供時把 NPC 科技指標夾在
  // [classical, 世界時代]。保留 undefined（更新語意「不變」）與 null（「沿用
  // 世界時代」）語意，避免把「不變」誤寫成「清除」。
  const clampTechEra = (
    v: string | null | undefined,
  ): string | null | undefined => {
    if (v === undefined) return undefined;
    if (ctx.maxTechEraSlug === undefined) return v;
    return normalizeNpcTechEra(v, ctx.maxTechEraSlug);
  };

  for (const op of proposal.operations) {
    if (op.op === "createNpc") {
      if (seenTempIds.has(op.tempId)) {
        throw new WorldProposalError(`臨時識別字 ${op.tempId} 重複`);
      }
      seenTempIds.add(op.tempId);
      assertRegionList(op.regions, ctx.validRegionIds, `新增國家「${op.name}」`);
      creates.push({
        tempId: op.tempId,
        name: op.name,
        leaderName: normalizeLeaderName(op.leaderName),
        government: op.government,
        techEraMilitary: clampTechEra(op.techEraMilitary),
        techEraSocial: clampTechEra(op.techEraSocial),
        techEraProduction: clampTechEra(op.techEraProduction),
        stability: op.stability,
        unrest: op.unrest,
        regions: op.regions,
      });
      continue;
    }

    // updateNation / deleteNation：均指向既有國家 id
    const nationId = op.nationId;
    if (ctx.protectedNationIds.has(nationId)) {
      throw new WorldProposalError(
        `AI 不得修改玩家國家（國家代號 ${nationId}）`,
      );
    }
    if (!ctx.editableNationIds.has(nationId)) {
      throw new WorldProposalError(
        `指定的國家不存在或無法編輯（國家代號 ${nationId}）`,
      );
    }
    if (targetedNationIds.has(nationId)) {
      throw new WorldProposalError(
        `同一國家（代號 ${nationId}）被多個操作指向`,
      );
    }
    targetedNationIds.add(nationId);

    if (op.op === "deleteNation") {
      deletes.push(nationId);
      continue;
    }

    // updateNation
    if (op.regions !== undefined) {
      assertRegionList(op.regions, ctx.validRegionIds, `編輯國家（代號 ${nationId}）`);
    }
    updates.push({
      nationId,
      name: op.name,
      leaderName: normalizeLeaderName(op.leaderName),
      government: op.government,
      techEraMilitary: clampTechEra(op.techEraMilitary),
      techEraSocial: clampTechEra(op.techEraSocial),
      techEraProduction: clampTechEra(op.techEraProduction),
      stability: op.stability,
      unrest: op.unrest,
      regions: op.regions,
    });
  }

  const plan: NormalizedWorldPlan = {
    summary: proposal.summary,
    creates,
    updates,
    deletes,
  };

  // 領土 Σ≤100/地區（含玩家既有掌控）
  const sums = applyPlanToControls(ctx.currentControls, plan);
  for (const [regionId, total] of sums) {
    if (total > 100) {
      throw new WorldProposalError(
        `地區代號 ${regionId} 控制比例總和為 ${total}%，超過 100%`,
      );
    }
  }

  return plan;
}
