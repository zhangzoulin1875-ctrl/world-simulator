import { and, eq, isNotNull } from "drizzle-orm";
import {
  db,
  worldGameStateTable,
  regionControlsTable,
  playerNationsTable,
  mapRegionAdjacenciesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { generateWorldProposal } from "./worldSimAi";
import { buildWorldSimSnapshot } from "./worldSimSnapshot";
import { applyWorldProposal } from "./worldSimApply";
import { notifyWorldChanged } from "./gameNotify";

/**
 * Task #176 — 回合自動世界模擬（每日回合結算末段掛勾）。
 *
 * 世界依「強度」設定自然演進：AI（bulk 模型）依當前年份／時代產生一份提案，
 * 經 worldSimApply 的硬性安全層套用（只動 NPC／無主國家與其領土，絕不觸及玩家）。
 * 隨後找出鄰近變動的玩家並各發一則彙總通知。
 *
 * **不 import turnEngine**（年份由快照自行由 gameDate 解析），避免循環相依。
 */

export interface IntensityCaps {
  /** 本回合最多操作數（createNpc + updateNation + deleteNation 總和）。 */
  maxOperations: number;
  /** 本回合最多新增勢力數（createNpc）。 */
  maxCreates: number;
}

/** 純函式：依強度（1 低／2 中／3 高）回傳每回合操作與新增上限。 */
export function intensityCaps(intensity: number): IntensityCaps {
  switch (intensity) {
    case 3:
      return { maxOperations: 24, maxCreates: 4 };
    case 2:
      return { maxOperations: 12, maxCreates: 2 };
    case 1:
    default:
      return { maxOperations: 6, maxCreates: 1 };
  }
}

/**
 * 純函式：組出回合自動模擬的歷史脈絡指令（含當前年份／時代風味與數量上限）。
 * 與隨選生成共用同一份 prompt 與安全規則，只是 instruction 由系統自動帶入。
 */
export function buildAutoSimInstruction(params: {
  year: number;
  eraSlug: string;
  eraLabel: string;
  intensity: number;
}): string {
  const { year, eraLabel, intensity } = params;
  const caps = intensityCaps(intensity);
  const pace =
    intensity >= 3
      ? "劇烈：大國崛起與衰亡、邊界重畫、新勢力誕生都可能發生"
      : intensity === 2
        ? "中等：局部勢力消長、少量新興勢力、既有 NPC 領土微調"
        : "和緩：以既有 NPC 的小幅領土與國力變化為主，偶爾出現新勢力";
  return [
    `這是架空世界在西元 ${year} 年（${eraLabel}）的自然歷史推演。`,
    "請以歷史學家的視角，讓世界局勢自然演進：可讓 NPC／無主勢力擴張、衰退、",
    "分裂、合併、興起或滅亡，並據此重畫他們掌控的地區。",
    `本回合演進節奏為「${pace}」。`,
    `硬性數量限制：本回合最多 ${caps.maxOperations} 項操作，其中最多新增 ${caps.maxCreates} 個新勢力（createNpc）；請勿超過。`,
    "務必遵守系統安全規則：僅可新增／編輯／刪除 NPC 或無主國家並移動它們的領土，",
    "絕對不可指向或觸及任何玩家國家與其領土；領土僅能填入各地區仍空缺的比例。",
    "變化需符合該時代的科技與文明水準，避免超越當前時代。",
  ].join("\n");
}

export interface FindAffectedPlayersInput {
  /** 本回合被世界變動觸及的地區 id。 */
  touchedRegionIds: readonly number[];
  /** map_region_adjacencies（雙向皆列出或單向皆可，此處對稱處理）。 */
  adjacency: readonly { regionId: number; adjacentRegionId: number }[];
  /** 玩家掌控列（僅含真人玩家）。 */
  playerControls: readonly { regionId: number; discordUserId: string }[];
}

/**
 * 純函式：找出「受本回合世界變動影響」的玩家 discordUserId（去重）。
 * 影響區 = 被觸及地區 ∪ 其相鄰地區；玩家只要掌控影響區內任一地區即納入。
 */
export function findAffectedPlayers(input: FindAffectedPlayersInput): string[] {
  const touched = new Set(input.touchedRegionIds);
  if (touched.size === 0) return [];
  const impact = new Set<number>(touched);
  for (const a of input.adjacency) {
    if (touched.has(a.regionId)) impact.add(a.adjacentRegionId);
    if (touched.has(a.adjacentRegionId)) impact.add(a.regionId);
  }
  const affected = new Set<string>();
  for (const c of input.playerControls) {
    if (impact.has(c.regionId)) affected.add(c.discordUserId);
  }
  return [...affected];
}

export interface WorldSimTurnSummary {
  ran: boolean;
  reason?: "in_flight" | "over_cap" | "ai_failed";
  auditId?: string;
  operations?: number;
  created?: number;
  updated?: number;
  deleted?: number;
  notifiedPlayers?: number;
  summary?: string;
}

// 同步佔鎖（先佔再 await）：自動排程與管理員 force 同時觸發時避免重入。
let worldSimTickRunning = false;

/**
 * Task #228 — 執行一次「NPC 自動演變」（政體／領導人／領地變更、釋地成無主、
 * NPC 科技時代推進）。由 worldScheduler 的獨立背景迴圈（可調頻率）驅動，或由
 * 管理員 force-run 呼叫；到期判定與啟用開關由排程器的原子認領負責，故此處不再
 * 檢查 enabled。NPC 主動外交／開戰已移至 AI 判定迴圈（runAiJudgment）。
 * 程序內以同步鎖防重入；全程失敗不阻斷其他工作（呼叫端已包 try/catch）。
 */
export async function runWorldSimEvolution(): Promise<WorldSimTurnSummary> {
  if (worldSimTickRunning) return { ran: false, reason: "in_flight" };
  worldSimTickRunning = true;
  try {
    const [state] = await db
      .select({
        intensity: worldGameStateTable.worldSimIntensity,
      })
      .from(worldGameStateTable)
      .where(eq(worldGameStateTable.id, 1))
      .limit(1);
    const intensity = state?.intensity ?? 1;
    const caps = intensityCaps(intensity);

    const snapshot = await buildWorldSimSnapshot();

    // Task #481 — NPC 科技改於回合引擎沿全球科技樹逐格研發（techTreeTurn），
    // 這裡不再整代推進時代指標。
    const instruction = buildAutoSimInstruction({
      year: snapshot.year,
      eraSlug: snapshot.eraSlug,
      eraLabel: snapshot.eraLabel,
      intensity,
    });

    let proposal;
    try {
      proposal = await generateWorldProposal({ instruction, ...snapshot }, "bulk");
    } catch (err) {
      logger.error({ err }, "world-sim evolution: AI generation failed");
      return { ran: false, reason: "ai_failed" };
    }

    // 程式端硬性上限（AI 未遵守時的後盾）：超過即整份拒絕、跳過本回合套用。
    const createCount = proposal.operations.filter(
      (o) => o.op === "createNpc",
    ).length;
    if (
      proposal.operations.length > caps.maxOperations ||
      createCount > caps.maxCreates
    ) {
      logger.warn(
        { ops: proposal.operations.length, creates: createCount, caps },
        "world-sim evolution: proposal exceeded intensity caps; skipping application",
      );
      return { ran: false, reason: "over_cap" };
    }

    const result = await applyWorldProposal({
      proposal,
      source: "auto",
      instruction,
    });

    // 通知：找出鄰近變動的玩家，每人一則彙總通知（失敗不阻斷回合）。
    let notifiedPlayers = 0;
    try {
      if (result.touchedRegionIds.length > 0) {
        const [adjacency, controls] = await Promise.all([
          db
            .select({
              regionId: mapRegionAdjacenciesTable.regionId,
              adjacentRegionId: mapRegionAdjacenciesTable.adjacentRegionId,
            })
            .from(mapRegionAdjacenciesTable),
          db
            .select({
              regionId: regionControlsTable.regionId,
              discordUserId: playerNationsTable.discordUserId,
            })
            .from(regionControlsTable)
            .innerJoin(
              playerNationsTable,
              eq(regionControlsTable.nationId, playerNationsTable.id),
            )
            .where(
              and(
                isNotNull(playerNationsTable.discordUserId),
                eq(playerNationsTable.isNpc, false),
              ),
            ),
        ]);
        const playerControls = controls.flatMap((c) =>
          c.discordUserId === null
            ? []
            : [{ regionId: c.regionId, discordUserId: c.discordUserId }],
        );
        const affected = findAffectedPlayers({
          touchedRegionIds: result.touchedRegionIds,
          adjacency,
          playerControls,
        });
        for (const discordUserId of affected) {
          notifyWorldChanged({ discordUserId, summary: result.summary });
        }
        notifiedPlayers = affected.length;
      }
    } catch (err) {
      logger.error({ err }, "world-sim turn: player notification failed");
    }

    return {
      ran: true,
      auditId: result.auditId,
      operations: proposal.operations.length,
      created: result.createdNationIds.length,
      updated: result.updatedNationIds.length,
      deleted: result.deletedNationIds.length,
      notifiedPlayers,
      summary: result.summary,
    };
  } finally {
    worldSimTickRunning = false;
  }
}
