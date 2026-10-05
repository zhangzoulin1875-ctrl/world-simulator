import { eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  parliamentStateTable,
  focusStatesTable,
  focusActiveTable,
  focusCompletedTable,
} from "@workspace/db";
import { computeNationStats, getCurrentEraSlug } from "../nationStats";
import { parliamentTier } from "../parliament/core";
import { governmentSlugByLabel, governmentLabel } from "../governments";
import { getCatalog, getFocusDef } from "./catalog";
import { describeCondition } from "./conditions";
import {
  estimateRemainingTurns,
  focusSpeedMultiplier,
  pointsCap,
  politicalPointsPerTurn,
  type FocusSlot,
} from "./core";
import { isCostEffect, type FocusDef, type FocusEffect } from "./types";
import { evaluateStart } from "./service";
import { describeEffect } from "./describe";
import { COMMUNIST_REVOLUTION_ID, REVOLUTION_EXCLUDED_GOVERNMENTS } from "./regimeFocuses";
import { ensureBranches } from "./branchService";
import { logger } from "../logger";
import { buildFocusTree, type FocusTreeData } from "./treeView";

type Nation = typeof playerNationsTable.$inferSelect;

export type FocusCardStatus = "available" | "locked" | "active" | "completed";

export interface FocusCard {
  id: string;
  title: string;
  description: string;
  domain: FocusDef["domain"];
  track: FocusDef["track"];
  slot: FocusSlot;
  cost: number;
  turns: number;
  milestone: boolean;
  status: FocusCardStatus;
  /** status = locked 時說明為什麼現在不能啟動(給玩家看的原因)。 */
  lockedReason: string | null;
  /** 不是永久鎖(例如點數不足、條件未達)→ 之後有機會解鎖;永久鎖=互斥已選了另一條。 */
  permanentlyLocked: boolean;
  conditions: string[];
  benefits: string[];
  costs: string[];
  /** 轉型國策的目標政體名稱。 */
  transitionTo: string | null;
}

export interface FocusView {
  points: number;
  pointsPerTurn: number;
  pointsCap: number;
  parliamentSatisfaction: number;
  speedMultiplier: number;
  stalled: boolean;
  policyLockTurns: number;
  blackLean: number;
  redLean: number;
  active: Array<{
    id: string;
    title: string;
    slot: FocusSlot;
    progress: number;
    totalTurns: number;
    remainingTurns: number | null;
    canCancel: true;
    refundOnCancel: number;
  }>;
  focuses: FocusCard[];
  /** 政體樹畫面資料(以我為根 / 全景兩種視角共用) */
  tree: FocusTreeData;
}

const describeAll = (effects: FocusEffect[]) => ({
  benefits: effects.filter((e) => !isCostEffect(e)).map(describeEffect),
  costs: effects.filter((e) => isCostEffect(e)).map(describeEffect),
});

/** 唯讀:組出畫面所需的全部資料。啟動規則與 startFocus 共用 evaluateStart,不會分叉。 */
export async function getFocusView(nation: Nation): Promise<FocusView> {
  const eraSlug = await getCurrentEraSlug();
  const [fresh] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nation.id));
  const n = fresh ?? nation;
  const [state] = await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, n.id));
  const actives = await db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, n.id));
  const done = await db.select({ id: focusCompletedTable.focusId }).from(focusCompletedTable).where(eq(focusCompletedTable.nationId, n.id));
  const [par] = await db.select({ s: parliamentStateTable.satisfaction }).from(parliamentStateTable).where(eq(parliamentStateTable.nationId, n.id));

  const sat = par?.s ?? 60;
  const points = state?.points ?? 0;
  const blackLean = state?.blackLean ?? 0;
  const redLean = state?.redLean ?? 0;
  const tier = parliamentTier(governmentSlugByLabel(n.government));
  const stats = await computeNationStats(n.id, eraSlug).catch(() => ({ population: 0 }));
  const perTurn = politicalPointsPerTurn({ tier, population: stats.population, satisfaction: sat });

  const completed = new Set(done.map((d) => d.id));
  const activeMap = new Map<FocusSlot, string>(actives.map((a) => [a.slot as FocusSlot, a.focusId]));
  const activeIds = new Set(actives.map((a) => a.focusId));
  // 隨機分支:第一次看樹時才抽並存起來,之後固定不變(見 branchService)
  const slugNow = governmentSlugByLabel(n.government);
  // 抽選失敗(例如資料庫暫時性錯誤)不該讓整個國策頁壞掉:降級成「不套用樹限制」,錯誤只記日誌
  let branches: Set<string> | null = null;
  if (slugNow) {
    try { branches = new Set(await ensureBranches(n.id, slugNow)); }
    catch (err) { logger.error({ err, nationId: n.id, slugNow }, "focus branch draw failed; showing without tree limit"); }
  }
  const facts = {
    branches,
    governmentLabel: n.government,
    eraSlug,
    completed,
    active: activeMap,
    points,
    coupPolicyLockTurns: n.coupPolicyLockTurns,
    conditionFacts: {
      politicalSupport: n.politicalSupport,
      stability: n.stability,
      militarySatisfaction: n.satisfactionMilitary,
      parliamentSatisfaction: sat,
      blackLean,
      redLean,
    },
  };

  const focuses: FocusCard[] = [];
  for (const def of getCatalog()) {
    const verdict = evaluateStart(def, facts);
    // 政體不符 / 時代未到 / 沒抽到的分支:對這個國家不可見,直接略過(否則 43 個轉型國策全是雜訊)
    if (!verdict.ok && (verdict.reason === "government_not_allowed" || verdict.reason === "era_locked" || verdict.reason === "not_in_tree")) continue;
    // 共產革命是通用入口;已經是紅線終點的政體不需要(也不該)再看到它
    if (def.id === COMMUNIST_REVOLUTION_ID && REVOLUTION_EXCLUDED_GOVERNMENTS.includes(governmentSlugByLabel(n.government) ?? "")) continue;

    let status: FocusCardStatus = "available";
    if (completed.has(def.id)) status = "completed";
    else if (activeIds.has(def.id)) status = "active";
    else if (!verdict.ok) status = "locked";

    const permanentlyLocked = !verdict.ok && verdict.reason === "excluded_by_completed";
    const { benefits, costs } = describeAll(def.effects.filter((e) => e.kind !== "transition"));
    const tr = def.effects.find((e) => e.kind === "transition");
    focuses.push({
      id: def.id,
      title: def.title,
      description: def.description,
      domain: def.domain,
      track: def.track,
      slot: def.slot,
      cost: def.cost,
      turns: def.turns,
      milestone: !!def.milestone,
      status,
      lockedReason: status === "locked" && !verdict.ok ? verdict.message : null,
      permanentlyLocked,
      conditions: (def.conditions ?? []).map(describeCondition),
      benefits,
      costs,
      transitionTo: tr && tr.kind === "transition" ? governmentLabel(tr.toGovernment) : null,
    });
  }

  return {
    points,
    pointsPerTurn: perTurn,
    pointsCap: pointsCap(perTurn),
    parliamentSatisfaction: sat,
    speedMultiplier: focusSpeedMultiplier(sat),
    stalled: focusSpeedMultiplier(sat) <= 0,
    policyLockTurns: n.coupPolicyLockTurns,
    blackLean,
    redLean,
    active: actives.map((a) => ({
      id: a.focusId,
      title: getFocusDef(a.focusId)?.title ?? a.focusId,
      slot: a.slot as FocusSlot,
      progress: a.progress,
      totalTurns: a.totalTurns,
      remainingTurns: estimateRemainingTurns(a.progress, a.totalTurns, sat),
      canCancel: true as const,
      refundOnCancel: Math.floor(a.spentPoints * 0.5),
    })),
    focuses,
    tree: buildFocusTree(slugNow, branches),
  };
}
