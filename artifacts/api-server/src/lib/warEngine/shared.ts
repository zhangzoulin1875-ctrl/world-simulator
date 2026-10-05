import {
  db,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  techTreeNodesTable,
  type GeneralSkill,
  type MilitaryTechBonus,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sumNationalBonusPct, type LegionSlot } from "../war";

/**
 * Task #105 — 戰役引擎：發起（玩家／NPC 共用）、24 小時週期 AI 結算、
 * 傷兵復原、NPC 主動開戰。獨立於每日回合引擎。
 */

// ── 常數 ───────────────────────────────────────────────────────

/** 傷兵復原迴圈 tick。 */
export const RECOVERY_TICK_MS = 10 * 60_000;
/** 每個 NPC 兩次主動開戰之間的最短間隔（小時）。 */
export const NPC_INITIATE_COOLDOWN_HOURS = 48;
/** 每次評估中，符合條件的 NPC 實際發起戰役的機率。 */
export const NPC_INITIATE_CHANCE = 0.25;
/**
 * NPC 自動組建軍團的兵力：人口 × 此比例，夾在上下限之間。
 *
 * Task #255 校調 — 兩個比例區分攻守：
 *  - 進攻方（NPC 主動開戰）沿用基礎比例，避免 NPC 進攻壓迫過強。
 *  - 防守方（含「攻打空地即建國」的 NPC，一律為防守方）採本土動員比例
 *    （較高），讓單一地區的空地 NPC 在早期時代仍能做出有意義的抵抗，而非
 *    一面倒。兩比例對「一般 NPC」與「空地 NPC」一致（同以人口換算），
 *    不引入兩者之間的相對失衡。
 * 下限自 2,000 提高至 5,000：邊陲小地區（早期時代多數落在下限）至少
 * 能編成像樣的守備隊，而非象徵性的兵力。
 */
export const NPC_TROOP_RATIO = 0.004;
export const NPC_DEFENDER_TROOP_RATIO = 0.008;
/**
 * 空地 NPC(攻打無人領土時就地建國/升格的防守方)的本土動員比例。
 * 這類 NPC 沒有常備軍,全靠民兵補到目標兵力;用一般防守比例(0.8%)時,工業到二戰約
 * 2.7 萬~4.9 萬、現代約 17 萬,對剛起步的玩家過強。改為 0.2%(約一般防守的 1/4),
 * 作為「輕量阻力」:工業 ~6.7 千、二戰 ~1.2 萬、現代 ~4.3 萬。下限仍為 NPC_TROOP_MIN。
 */
export const NPC_UNCLAIMED_DEFENDER_TROOP_RATIO = 0.002;
export const NPC_TROOP_MIN = 5_000;
export const NPC_TROOP_MAX = 3_000_000;

/**
 * NPC 開戰時自動組建的目標兵力(純函式,DB-free,供單元測試)。
 *  - 進攻方:人口 × NPC_TROOP_RATIO。
 *  - 一般防守方:人口 × NPC_DEFENDER_TROOP_RATIO。
 *  - 空地 NPC(攻打無人領土就地建國/升格的防守方):人口 × NPC_UNCLAIMED_DEFENDER_TROOP_RATIO。
 * 皆夾在 [NPC_TROOP_MIN, NPC_TROOP_MAX]。
 */
export function npcCampaignTroops(params: {
  population: number;
  isDefender: boolean;
  unclaimed?: boolean;
}): number {
  const ratio = params.isDefender
    ? params.unclaimed
      ? NPC_UNCLAIMED_DEFENDER_TROOP_RATIO
      : NPC_DEFENDER_TROOP_RATIO
    : NPC_TROOP_RATIO;
  return Math.min(
    NPC_TROOP_MAX,
    Math.max(NPC_TROOP_MIN, Math.floor(params.population * ratio)),
  );
}

/**
 * 追蹤「開戰後背景生成地形簡報」這類 fire-and-forget 的非同步工作。正式運行
 * 時無人等待（失敗僅記錄，不影響戰役）；但整合測試會在 pool.end() 前呼叫
 * flushWarBackgroundWork()，確保這些寫入在連線池關閉前落地，否則遲到的寫入
 * 會噴出 "Cannot use a pool after calling end on the pool" 汙染日誌、遮蔽真正
 * 的失敗。
 */
const pendingBackgroundWork = new Set<Promise<void>>();

export function trackBackgroundWork(work: Promise<void>): void {
  pendingBackgroundWork.add(work);
  void work.finally(() => {
    pendingBackgroundWork.delete(work);
  });
}

/** 等待所有進行中的背景工作完成（測試 teardown 用）。 */
export async function flushWarBackgroundWork(): Promise<void> {
  await Promise.allSettled([...pendingBackgroundWork]);
}

/** 引擎層錯誤：帶 HTTP 狀態碼與 zh-TW 訊息，路由直接轉發。 */
export class WarActionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── 科技加成（復原速度／復原率） ───────────────────────────────

export async function getRecoveryBonuses(
  discordUserId: string | null,
): Promise<{ speedPct: number; ratePct: number }> {
  if (!discordUserId) return { speedPct: 0, ratePct: 0 };
  const rows = await db
    .select({ effects: techTreeNodesTable.effects })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, playerResearchedTreeNodesTable.nationId),
    )
    .where(
      and(
        eq(playerNationsTable.discordUserId, discordUserId),
        eq(techTreeNodesTable.domain, "military"),
      ),
    );
  const techs = rows.map((r) => ({
    bonuses: (r.effects ?? []) as MilitaryTechBonus[],
  }));
  return {
    speedPct: sumNationalBonusPct(techs, "recoverySpeed"),
    ratePct: sumNationalBonusPct(techs, "recoveryRate"),
  };
}

export interface LoadedLegion {
  id: number;
  /** Task #453 — 軍團所屬國家（多國參戰時傷亡/傷兵/軍力扣減回各自國家）。 */
  nationId: string;
  slot: LegionSlot;
  morale: number;
  supply: number;
  garrisoningCity: boolean;
  /**
   * 僱傭兵軍團:戰力由 mercenary_states 即時推算(資料庫沒有單位列)。
   * 結算時傷亡一律歸零(只有士氣/補給會變),寫回時跳過單位列更新。
   */
  mercenary?: boolean;
  /** 武將系統 — 坐鎮武將（無 = undefined；只加成與其專精分類相同的兵種）。 */
  general?: {
    id: number;
    name: string;
    title: string;
    category: string;
    grade: number;
    skills: GeneralSkill[];
  };
  units: {
    unitRowId: number;
    templateId: number;
    name: string;
    category: string;
    quantity: number;
    wounded: number;
    attack: number;
    defense: number;
    hp: number;
    /** Task #412 — 兵種平衡數據（供 AI 分析軍種相剋；不參與伺服器數量結算）。 */
    speed: number;
    accuracy: number;
    /** melee | ranged */
    range: string;
    antiCavalryPct: number;
    antiRangedPct: number;
    siegePct: number;
    /** Task #625 — 兵種設計時代 slug（用於過時偵測）。 */
    eraSlug?: string;
    /** 武器系統 — 裝備武器名稱（未裝備為 undefined）。 */
    weaponName?: string;
    /** 武器系統 — 特殊技能名稱。 */
    weaponSkillName?: string;
    /** 武器系統 — 相容與否（戰報敘事用）。 */
    weaponCompatible?: boolean;
    /**
     * 武器系統 — 戰鬥乘數（weaponCombatMods 算出；未裝備 = 1）。
     */
    weaponOffenseMult?: number;
    weaponDefenseMult?: number;
    /**
     * 武將系統 — 坐鎮武將的戰鬥乘數（generalCombatMods 算出；只對該軍團
     * 內與武將專精分類相同的兵種生效；無武將/兵種不相容 = undefined）。
     */
    generalOffenseMult?: number;
    generalDefenseMult?: number;
    /** 本週期戰死數（applyCycleResult 內部累計用）。 */
    deadThisCycle?: number;
  }[];
}
