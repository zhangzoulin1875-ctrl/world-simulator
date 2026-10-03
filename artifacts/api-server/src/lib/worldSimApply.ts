import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
  regionControlsTable,
  mapRegionsTable,
  worldGameStateTable,
  worldSimAuditsTable,
  type WorldSimAuditChange,
} from "@workspace/db";
import {
  validateWorldProposal,
  type NormalizedUpdate,
  type NormalizedWorldPlan,
  type RegionControlRow,
  type WorldProposal,
  WorldProposalError,
} from "./worldSim";
import { REGION_CLAIM_LOCK_NS } from "./locks";
import { recordTerritoryChanges } from "./territoryHistory";
import { DEFAULT_ERA_SLUG } from "./mapRegionEras";

/**
 * Task #176 — AI 驅動 NPC 系統的「安全世界寫入層」。
 *
 * 這是整個系統的關鍵安全邊界：把 AI 產生、已結構驗證的 WorldProposal 套用到
 * DB。所有寫入都在單一交易內、以 advisory lock 序列化（手動生成與回合自動模擬
 * 互斥），並在交易內即時重讀「受保護 / 可編輯國家」與現有領土，交給
 * validateWorldProposal 把關。
 *
 * 硬性規則（多層防護）：
 *  1. validateWorldProposal 於鎖內以即時快照拒絕任何指向玩家國家的操作。
 *  2. 每一條 UPDATE/DELETE 的 SQL WHERE 都再帶上「is_npc = true OR
 *     discord_user_id IS NULL」的排除條件，並以 rowCount 斷言命中，否則整份
 *     交易 rollback（AI 絕不可能改到玩家列，即使驗證層被繞過）。
 *  3. 更新前以 SELECT ... FOR UPDATE 帶排除條件鎖定並確認該國仍可編輯。
 * 任何一步違規即丟出 WorldProposalError → 交易整體 rollback → 世界零變更。
 */

/** advisory lock 鍵：序列化所有世界寫入（手動 + 自動模擬）。 */
const WORLD_SIM_LOCK_KEY = "world-sim-apply";
/** 稽核紀錄保留筆數（超過即刪最舊）。 */
const AUDIT_RETENTION = 200;

/** 玩家國家排除條件：只允許命中 NPC（is_npc=true）或無主（discord_user_id IS NULL）。 */
const editableNationGuard = or(
  eq(playerNationsTable.isNpc, true),
  isNull(playerNationsTable.discordUserId),
);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WorldContext {
  protectedNationIds: Set<string>;
  editableNationIds: Set<string>;
  validRegionIds: Set<number>;
  currentControls: RegionControlRow[];
  /** id → 目前國名（稽核顯示用）。 */
  nameById: Map<string, string>;
  /** 世界目前時代 slug（NPC 科技指標夾取上限）。 */
  worldEraSlug: string;
}

/**
 * 於交易內讀出驗證所需的世界快照（所有國家分成受保護 / 可編輯、合法地區、
 * 現有領土）。手動套用時在 advisory lock 之後呼叫，確保快照與寫入一致。
 */
async function readWorldContext(tx: Tx): Promise<WorldContext> {
  const nations = await tx
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
    })
    .from(playerNationsTable);

  const protectedNationIds = new Set<string>();
  const editableNationIds = new Set<string>();
  const nameById = new Map<string, string>();
  for (const n of nations) {
    nameById.set(n.id, n.name ?? n.id);
    // 玩家國家 = 有擁有者且非 NPC；其餘（NPC 或無主）皆可編輯。
    if (!n.isNpc && n.discordUserId !== null) protectedNationIds.add(n.id);
    else editableNationIds.add(n.id);
  }

  const regions = await tx
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable);
  const validRegionIds = new Set(regions.map((r) => r.id));

  const controls = await tx
    .select({
      regionId: regionControlsTable.regionId,
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable);

  const [ws] = await tx
    .select({ currentEra: worldGameStateTable.currentEra })
    .from(worldGameStateTable)
    .limit(1);

  return {
    protectedNationIds,
    editableNationIds,
    validRegionIds,
    currentControls: controls,
    nameById,
    worldEraSlug: ws?.currentEra ?? DEFAULT_ERA_SLUG,
  };
}

/** 只有已提供（!== undefined）的欄位才進入 UPDATE set（null 代表清除，仍需寫入）。 */
function buildUpdateSet(u: NormalizedUpdate): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (u.name !== undefined) set.name = u.name;
  if (u.leaderName !== undefined) set.leaderName = u.leaderName;
  if (u.government !== undefined) set.government = u.government;
  if (u.techEraMilitary !== undefined) set.techEraMilitary = u.techEraMilitary;
  if (u.techEraSocial !== undefined) set.techEraSocial = u.techEraSocial;
  if (u.techEraProduction !== undefined)
    set.techEraProduction = u.techEraProduction;
  if (u.stability !== undefined) set.stability = u.stability;
  if (u.unrest !== undefined) set.unrest = u.unrest;
  return set;
}

/** 把一次更新的重點整理成一句 zh-TW 說明（稽核顯示用）。 */
function describeUpdate(u: NormalizedUpdate): string {
  const parts: string[] = [];
  if (u.name !== undefined) parts.push(`改名為「${u.name}」`);
  if (u.government !== undefined)
    parts.push(`政體→${u.government ?? "未定"}`);
  if (u.techEraMilitary !== undefined)
    parts.push(`軍事科技→${u.techEraMilitary ?? "沿用世界"}`);
  if (u.techEraSocial !== undefined)
    parts.push(`社會科技→${u.techEraSocial ?? "沿用世界"}`);
  if (u.techEraProduction !== undefined)
    parts.push(`生產科技→${u.techEraProduction ?? "沿用世界"}`);
  if (u.stability !== undefined) parts.push(`安定度→${u.stability}`);
  if (u.unrest !== undefined) parts.push(`動亂度→${u.unrest}`);
  if (u.regions !== undefined)
    parts.push(
      u.regions.length === 0
        ? "釋出全部領土"
        : `重畫領土（${u.regions.length} 區）`,
    );
  return parts.length > 0 ? parts.join("、") : "無變更";
}

/**
 * 純函式：把正規化計畫轉成可讀變更清單（稽核與「套用前預覽」共用單一事實來源，
 * 兩者顯示永遠一致）。順序與 applyWorldProposal 的寫入順序一致：刪除 → 編輯 → 新增。
 * nameById 提供國名（新 NPC 尚無 id，直接用提案名稱）。
 */
export function describeWorldPlan(
  plan: NormalizedWorldPlan,
  nameById: Map<string, string>,
): WorldSimAuditChange[] {
  const changes: WorldSimAuditChange[] = [];
  for (const nationId of plan.deletes) {
    changes.push({
      action: "deleteNation",
      nationName: nameById.get(nationId) ?? nationId,
      detail: "刪除國家（領土一併釋出）",
    });
  }
  for (const u of plan.updates) {
    changes.push({
      action: "updateNation",
      nationName: u.name ?? nameById.get(u.nationId) ?? u.nationId,
      detail: describeUpdate(u),
    });
  }
  for (const c of plan.creates) {
    changes.push({
      action: "createNpc",
      nationName: c.name,
      detail: `新增 NPC 國家，掌控 ${c.regions.length} 區`,
    });
  }
  return changes;
}

export interface ApplyWorldProposalInput {
  /** 已通過 parseWorldProposal 結構驗證的提案。 */
  proposal: WorldProposal;
  /** 來源：'manual'（管理員隨選）｜'auto'（回合自動模擬）。 */
  source: "manual" | "auto";
  /** 管理員原始指令；自動模擬時為歷史脈絡摘要。null = 無。 */
  instruction: string | null;
}

export interface ApplyWorldProposalResult {
  auditId: string;
  summary: string;
  createdNationIds: string[];
  updatedNationIds: string[];
  deletedNationIds: string[];
  changes: WorldSimAuditChange[];
  /**
   * 本次套用「觸及」的地區 id（新增／重畫的目標地區 + 因刪除或重畫而被釋出的
   * 原掌控地區）。供回合自動模擬判定「與玩家相關」的通知範圍（T12）。
   */
  touchedRegionIds: number[];
}

/**
 * 只讀預覽：於唯讀交易內讀取快照並語意驗證，回傳正規化計畫（不寫入任何資料）。
 * 供「預覽再套用」流程與回合前的乾跑使用。驗證失敗丟出 WorldProposalError。
 */
export async function previewWorldProposal(
  proposal: WorldProposal,
): Promise<{ plan: NormalizedWorldPlan; context: WorldContext }> {
  return await db.transaction(async (tx) => {
    const context = await readWorldContext(tx);
    const plan = validateWorldProposal(proposal, {
      protectedNationIds: context.protectedNationIds,
      editableNationIds: context.editableNationIds,
      validRegionIds: context.validRegionIds,
      currentControls: context.currentControls,
      maxTechEraSlug: context.worldEraSlug,
    });
    return { plan, context };
  });
}

/**
 * 套用世界提案（唯一的世界寫入入口）。全程單一交易 + advisory lock：
 * 讀快照 → 驗證 → 刪除 → 更新 → 新增 → 寫稽核 + 保留裁剪。任何違規整體 rollback。
 */
export async function applyWorldProposal(
  input: ApplyWorldProposalInput,
): Promise<ApplyWorldProposalResult> {
  const { proposal, source, instruction } = input;

  return await db.transaction(async (tx) => {
    // 1. 序列化所有世界寫入（手動 + 自動模擬互斥）。
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${WORLD_SIM_LOCK_KEY}))`,
    );

    // 1b. 對「將被新增／變更掌控」的地區，取得與建國相同的地區認領鎖（升冪排序
    //     避免死鎖），序列化世界寫入與玩家建國，杜絕單一地區 Σ>100 的競態
    //     （否則每小時等比縮減會連玩家份額一起縮，間接違反硬性規則）。
    const lockRegionIds = new Set<number>();
    for (const op of proposal.operations) {
      if (op.op === "createNpc") {
        for (const r of op.regions) lockRegionIds.add(r.regionId);
      } else if (op.op === "updateNation" && op.regions) {
        for (const r of op.regions) lockRegionIds.add(r.regionId);
      }
    }
    for (const regionId of [...lockRegionIds].sort((a, b) => a - b)) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${REGION_CLAIM_LOCK_NS}, ${regionId})`,
      );
    }

    // 2. 鎖內即時快照 → 驗證。
    const context = await readWorldContext(tx);
    const plan = validateWorldProposal(proposal, {
      protectedNationIds: context.protectedNationIds,
      editableNationIds: context.editableNationIds,
      validRegionIds: context.validRegionIds,
      currentControls: context.currentControls,
      maxTechEraSlug: context.worldEraSlug,
    });

    const deletedNationIds: string[] = [];
    const updatedNationIds: string[] = [];
    const createdNationIds: string[] = [];

    // 3. 刪除（帶排除條件 + rowCount 斷言：永不刪到玩家列）。
    for (const nationId of plan.deletes) {
      const deleted = await tx
        .delete(playerNationsTable)
        .where(and(eq(playerNationsTable.id, nationId), editableNationGuard))
        .returning({ id: playerNationsTable.id });
      if (deleted.length !== 1) {
        throw new WorldProposalError(
          `刪除國家失敗：找不到可刪除的 NPC／無主國家（代號 ${nationId}）`,
        );
      }
      deletedNationIds.push(nationId);
    }

    // 4. 更新（先 FOR UPDATE 帶排除條件鎖定確認可編輯，再改欄位 + 全量替換領土）。
    for (const u of plan.updates) {
      const locked = await tx
        .select({ id: playerNationsTable.id })
        .from(playerNationsTable)
        .where(and(eq(playerNationsTable.id, u.nationId), editableNationGuard))
        .for("update");
      if (locked.length !== 1) {
        throw new WorldProposalError(
          `更新國家失敗：找不到可編輯的 NPC／無主國家（代號 ${u.nationId}）`,
        );
      }

      const set = buildUpdateSet(u);
      if (Object.keys(set).length > 0) {
        const updated = await tx
          .update(playerNationsTable)
          .set(set)
          .where(and(eq(playerNationsTable.id, u.nationId), editableNationGuard))
          .returning({ id: playerNationsTable.id });
        if (updated.length !== 1) {
          throw new WorldProposalError(
            `更新國家失敗（代號 ${u.nationId}）`,
          );
        }
        // Task #481 — 管理員／AI 直接改動 techEra* 指標＝直接設定該國科技水準：
        // 同交易內清掉科技樹狀態（已研發節點＋領域狀態），下次 lazy init
        // （ensureNpcTechTreeInit）會依新指標重建。
        if (
          u.techEraMilitary !== undefined ||
          u.techEraSocial !== undefined ||
          u.techEraProduction !== undefined
        ) {
          await tx
            .delete(playerResearchedTreeNodesTable)
            .where(eq(playerResearchedTreeNodesTable.nationId, u.nationId));
          await tx
            .delete(playerTechTreeStateTable)
            .where(eq(playerTechTreeStateTable.nationId, u.nationId));
        }
      }

      if (u.regions !== undefined) {
        await tx
          .delete(regionControlsTable)
          .where(eq(regionControlsTable.nationId, u.nationId));
        if (u.regions.length > 0) {
          await tx.insert(regionControlsTable).values(
            u.regions.map((r) => ({
              regionId: r.regionId,
              nationId: u.nationId,
              percent: r.percent,
            })),
          );
        }
        // Task #392 — 同交易內記錄世界模擬的領土重畫（以套用前快照為 before）。
        const beforeByRegion = new Map(
          context.currentControls
            .filter((c) => c.nationId === u.nationId)
            .map((c) => [c.regionId, c.percent]),
        );
        const afterByRegion = new Map(
          u.regions.map((r) => [r.regionId, r.percent]),
        );
        const touchedRegions = new Set([
          ...beforeByRegion.keys(),
          ...afterByRegion.keys(),
        ]);
        await recordTerritoryChanges(
          tx,
          [...touchedRegions].map((regionId) => ({
            nationId: u.nationId,
            regionId,
            percentBefore: beforeByRegion.get(regionId) ?? 0,
            percentAfter: afterByRegion.get(regionId) ?? 0,
            changeType: "world_sim" as const,
            reason: `世界模擬：重畫「${context.nameById.get(u.nationId) ?? u.nationId}」的掌控地區`,
          })),
        );
      }

      updatedNationIds.push(u.nationId);
    }

    // 5. 新增 NPC（is_npc = true；領土隨後插入）。
    for (const c of plan.creates) {
      const values: Record<string, unknown> = {
        name: c.name,
        isNpc: true,
      };
      if (c.leaderName !== undefined) values.leaderName = c.leaderName;
      if (c.government !== undefined) values.government = c.government;
      if (c.techEraMilitary !== undefined)
        values.techEraMilitary = c.techEraMilitary;
      if (c.techEraSocial !== undefined)
        values.techEraSocial = c.techEraSocial;
      if (c.techEraProduction !== undefined)
        values.techEraProduction = c.techEraProduction;
      if (c.stability !== undefined) values.stability = c.stability;
      if (c.unrest !== undefined) values.unrest = c.unrest;

      const [created] = await tx
        .insert(playerNationsTable)
        .values(values as typeof playerNationsTable.$inferInsert)
        .returning({ id: playerNationsTable.id });
      if (!created) {
        throw new WorldProposalError(`新增 NPC 失敗（${c.name}）`);
      }
      if (c.regions.length > 0) {
        await tx.insert(regionControlsTable).values(
          c.regions.map((r) => ({
            regionId: r.regionId,
            nationId: created.id,
            percent: r.percent,
          })),
        );
        // Task #392 — 同交易內記錄世界模擬新增 NPC 的初始領土。
        await recordTerritoryChanges(
          tx,
          c.regions.map((r) => ({
            nationId: created.id,
            regionId: r.regionId,
            percentBefore: 0,
            percentAfter: r.percent,
            changeType: "world_sim" as const,
            reason: `世界模擬：新增 NPC「${c.name}」並指派初始領土`,
          })),
        );
      }

      createdNationIds.push(created.id);
    }

    // 6a. 彙整本次「觸及」的地區（供 T12 通知範圍判定）：新增／重畫的目標地區
    //     + 因刪除或重畫而釋出的原掌控地區（以套用前快照 currentControls 計）。
    const touched = new Set<number>();
    const freedNationIds = new Set<string>([
      ...plan.deletes,
      ...plan.updates.filter((u) => u.regions !== undefined).map((u) => u.nationId),
    ]);
    for (const c of context.currentControls) {
      if (freedNationIds.has(c.nationId)) touched.add(c.regionId);
    }
    for (const u of plan.updates) {
      if (u.regions) for (const r of u.regions) touched.add(r.regionId);
    }
    for (const c of plan.creates) {
      for (const r of c.regions) touched.add(r.regionId);
    }
    const touchedRegionIds = [...touched].sort((a, b) => a - b);

    // 6. 寫稽核紀錄（變更清單與「套用前預覽」共用同一 describeWorldPlan）。
    const changes = describeWorldPlan(plan, context.nameById);
    const [audit] = await tx
      .insert(worldSimAuditsTable)
      .values({
        source,
        instruction,
        summary: plan.summary,
        changes,
      })
      .returning({ id: worldSimAuditsTable.id });
    if (!audit) throw new WorldProposalError("寫入稽核紀錄失敗");

    // 7. 保留裁剪（僅保留最新 AUDIT_RETENTION 筆）。
    await tx.execute(sql`
      DELETE FROM world_sim_audits
      WHERE id NOT IN (
        SELECT id FROM world_sim_audits
        ORDER BY created_at DESC
        LIMIT ${AUDIT_RETENTION}
      )
    `);

    return {
      auditId: audit.id,
      summary: plan.summary,
      createdNationIds,
      updatedNationIds,
      deletedNationIds,
      changes,
      touchedRegionIds,
    };
  });
}
