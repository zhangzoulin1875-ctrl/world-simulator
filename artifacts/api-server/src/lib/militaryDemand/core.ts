/**
 * 軍方進攻要求:純邏輯核心(不碰資料庫,可單元測試)
 *
 * 規格(2026-10-04 使用者確認):
 *  - 每回合 20% 機率,軍方要求進攻某地區;拒絕則軍方滿意度 -15
 *  - 軍方滿意度 < 50:不再詢問,直接開戰
 *  - 軍方滿意度 < 15:政變(60% 沿用現有軍方政變,40% 獨立出軍閥國家內戰)
 *  - 民主國家軍方永遠不提要求
 *  - 目標優先序:關係最差 > 無主地 > 弱國;自動開戰不會打盟友
 *  - 要求有時限:DEMAND_DEADLINE_TURNS 個回合內未回應,視同拒絕(扣分一次),
 *    不再能靠拖延逃避代價(2026-10-07 確認:2 回合)
 *
 * 軍方滿意度一律指「有效值」(基底 + 政策條目加成 + 管理員偏移),也就是玩家在政治頁
 * 看到的數字;判定、API、前端顯示必須同一個數字,不可混用資料庫基底值。
 */

export type MilitaryTier = "autocracy" | "semi" | "democracy";

export const DEMAND_CHANCE_PCT = 20;
export const REFUSE_PENALTY = 15;
export const AUTO_WAR_BELOW = 50;
export const COUP_BELOW = 15;
/** 政變中沿用現有軍方政變機制的機率(其餘為軍閥分裂) */
export const COUP_CLASSIC_SHARE = 0.6;
/** 軍方要求的回應時限(回合數):到期未回應視同拒絕。 */
export const DEMAND_DEADLINE_TURNS = 2;

/** 要求是否已逾時。currentTick、dueTick 皆為該國 parliament_state.tick。 */
export function isDemandExpired(currentTick: number, dueTick: number | null | undefined): boolean {
  if (dueTick === null || dueTick === undefined) return false;
  return currentTick >= dueTick;
}

/** 剩餘回合數(最小 0),供前端倒數。 */
export function demandTurnsLeft(currentTick: number, dueTick: number | null | undefined): number | null {
  if (dueTick === null || dueTick === undefined) return null;
  return Math.max(0, dueTick - currentTick);
}

export type MilitaryAction =
  | { kind: "none" }
  | { kind: "coup"; variant: "classic" | "warlord" }
  | { kind: "auto_war" }
  | { kind: "demand" };

/**
 * 決定本回合軍方要做什麼。優先序:政變 > 自動開戰 > 提出要求。
 * satisfaction 必須是「有效值」(玩家畫面上看到的數字)。
 * rand 回傳 [0,1),可注入以利測試。
 * 已有待回應的要求時,不再擲新的(避免堆疊)。
 */
export function decideMilitaryAction(input: {
  tier: MilitaryTier;
  satisfaction: number;
  hasPendingDemand: boolean;
  rand: () => number;
}): MilitaryAction {
  const { tier, satisfaction, hasPendingDemand, rand } = input;
  // 民主國家:軍方永遠無要求(也不會自動開戰,政變仍沿用既有軍方機制,不在此處理)
  if (tier === "democracy") return { kind: "none" };

  if (satisfaction < COUP_BELOW) {
    return { kind: "coup", variant: rand() < COUP_CLASSIC_SHARE ? "classic" : "warlord" };
  }
  if (satisfaction < AUTO_WAR_BELOW) return { kind: "auto_war" };
  if (hasPendingDemand) return { kind: "none" };
  if (rand() * 100 < DEMAND_CHANCE_PCT) return { kind: "demand" };
  return { kind: "none" };
}

/** 拒絕後的新軍方滿意度(0 到 100 夾限) */
export function afterRefuse(satisfaction: number): number {
  return Math.max(0, Math.min(100, satisfaction - REFUSE_PENALTY));
}

// ── 目標選擇 ───────────────────────────────────────────────

export interface TargetCandidate {
  regionId: number;
  regionName: string;
  /** 該地區目前的主要控制國;null = 無主地 */
  ownerNationId: string | null;
  /** 與我方的關係分數(無紀錄視為 0);無主地忽略 */
  relationScore: number;
  /** 對方軍力(人口計);無主地忽略 */
  ownerArmy: number;
  /** 是否為盟友(同盟或有效軍事同盟條約) */
  isAlly: boolean;
  /** 是否被條約禁止開戰(互不侵犯、附庸等) */
  warBlocked: boolean;
  /** 近期剛打完的冷卻 */
  recentWar: boolean;
}

/** 弱國:軍力不足我方的這個比例 */
export const WEAK_RATIO = 0.8;

function tierOf(c: TargetCandidate, myArmy: number): 1 | 2 | 3 | null {
  if (c.isAlly || c.warBlocked || c.recentWar) return null;
  if (c.ownerNationId === null) return 2; // 無主地
  if (c.relationScore < 0) return 1; // 關係最差(負分才算)
  if (c.ownerArmy < myArmy * WEAK_RATIO) return 3; // 弱國
  return null;
}

/**
 * 依優先序挑一個目標:
 *  1. 關係為負者,分數最低(最差)者優先
 *  2. 無主地(同層取地區 id 最小,結果穩定)
 *  3. 軍力低於我方 80% 的弱國,越弱越優先
 * 完全沒有合適目標回傳 null(此時不提要求、也不自動開戰)。
 */
export function pickTarget(cands: readonly TargetCandidate[], myArmy: number): TargetCandidate | null {
  const scored = cands
    .map((c) => ({ c, t: tierOf(c, myArmy) }))
    .filter((x): x is { c: TargetCandidate; t: 1 | 2 | 3 } => x.t !== null);
  if (scored.length === 0) return null;
  scored.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (a.t === 1) return a.c.relationScore - b.c.relationScore || a.c.regionId - b.c.regionId;
    if (a.t === 3) return a.c.ownerArmy - b.c.ownerArmy || a.c.regionId - b.c.regionId;
    return a.c.regionId - b.c.regionId;
  });
  return scored[0]!.c;
}
