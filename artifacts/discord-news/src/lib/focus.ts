import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type FocusTrack = "stable" | "black" | "red" | "reform";
export type FocusDomain = "military" | "economy" | "interior" | "diplomacy" | "regime";
export type FocusCardStatus = "available" | "locked" | "active" | "completed";

export interface FocusCard {
  id: string;
  title: string;
  description: string;
  domain: FocusDomain;
  track: FocusTrack;
  slot: "main" | "side";
  cost: number;
  turns: number;
  milestone: boolean;
  status: FocusCardStatus;
  lockedReason: string | null;
  permanentlyLocked: boolean;
  conditions: string[];
  benefits: string[];
  costs: string[];
  transitionTo: string | null;
}

export interface ActiveFocus {
  id: string;
  title: string;
  slot: "main" | "side";
  progress: number;
  totalTurns: number;
  remainingTurns: number | null;
  canCancel: true;
  refundOnCancel: number;
}

export interface TreeNode {
  slug: string;
  label: string;
  /** 全景欄位:0 建國起點 / 1 中繼 / 2 終點 */
  stage: 0 | 1 | 2;
  /** 終點所屬路線(只有 stage = 2 才有) */
  line: "red" | "black" | "stable" | null;
  layer: number | null;
  isFounding: boolean;
  isCurrent: boolean;
  /** 以我為根:0 目前 / 1 我抽到的分支 / 2 再往下一步(預覽);範圍外為 null */
  depth: 0 | 1 | 2 | null;
}

export interface TreeEdge {
  from: string;
  to: string;
  track: FocusTrack;
  focusId: string;
  walkable: boolean;
  notDrawn: boolean;
}

/** 共產革命:樹上固定的單獨分支(不是政體間的邊,不佔隨機名額) */
export interface RevolutionBranch {
  focusId: string;
  winGovernment: string;
}

export interface FocusTreeData {
  currentGovernment: string | null;
  revolution: RevolutionBranch | null;
  limited: boolean;
  nodes: TreeNode[];
  edges: TreeEdge[];
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
  active: ActiveFocus[];
  focuses: FocusCard[];
  tree: FocusTreeData;
  /** 發動背景故事(focusId -> 故事);還沒寫好的不在裡面 */
  stories: Record<string, FocusStory>;
}

export interface FocusStory {
  story: string;
  /** ai = AI 依國家處境寫的;template = AI 不可用時的固定句 */
  source: "ai" | "template";
}

/**
 * 故事區塊的顯示狀態:
 *  - 有故事 -> ready
 *  - 沒有,且這個國策正在進行 -> writing(背景還在寫,下次刷新就會出現)
 *  - 其他 -> none(還沒推行過,不顯示)
 */
export function storyState(
  stories: Record<string, FocusStory>, focusId: string, isActive: boolean,
): { kind: "ready"; story: FocusStory } | { kind: "writing" } | { kind: "none" } {
  const s = stories[focusId];
  if (s) return { kind: "ready", story: s };
  return isActive ? { kind: "writing" } : { kind: "none" };
}

export const FOCUS_QUERY_KEY = ["focus"] as const;

async function readError(res: Response): Promise<Error> {
  let msg = `請求失敗(${res.status})`;
  try {
    const j = await res.json();
    if (j && typeof j.error === "string") msg = typeof j.detail === "string" && j.detail ? `${j.error}(${j.detail})` : j.error;
  } catch { /* 非 JSON 回應:沿用預設訊息 */ }
  return new Error(msg);
}

async function fetchFocus(): Promise<FocusView> {
  const res = await fetch("/api/focus", { credentials: "include" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

async function postFocus(path: "start" | "cancel", focusId: string): Promise<{ view: FocusView }> {
  const res = await fetch(`/api/focus/${path}`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ focusId }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export function useFocus(enabled = true) {
  return useQuery({ queryKey: FOCUS_QUERY_KEY, queryFn: fetchFocus, enabled, staleTime: 15_000, refetchInterval: 60_000 });
}

function useFocusMutation(path: "start" | "cancel") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (focusId: string) => postFocus(path, focusId),
    onSuccess: (res) => {
      // 伺服器回傳最新畫面,直接寫入快取,免再打一次 GET
      qc.setQueryData(FOCUS_QUERY_KEY, res.view);
      // 政治點數/支持度等會變,連動刷新國家資料與政治總覽
      qc.invalidateQueries({ queryKey: ["player-nation"] });
    },
  });
}
export const useStartFocus = () => useFocusMutation("start");
export const useCancelFocus = () => useFocusMutation("cancel");

// ── 顯示用的純函式(可單元測試)────────────────────────────────

export const TRACK_LABEL: Record<FocusTrack, string> = {
  stable: "穩定路線",
  reform: "改革路線",
  black: "黑線",
  red: "紅線",
};

/** 軌道顏色:只用在小徽章上,不鋪滿畫面。 */
export const TRACK_STYLE: Record<FocusTrack, string> = {
  stable: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
  reform: "border-sky-400/40 bg-sky-500/15 text-sky-200",
  black: "border-zinc-300/40 bg-zinc-500/25 text-zinc-100",
  red: "border-red-400/40 bg-red-500/20 text-red-200",
};

/** 國策按軌道分組,顯示順序固定:穩定 → 改革 → 黑 → 紅。 */
export function groupByTrack(focuses: readonly FocusCard[]): Array<{ track: FocusTrack; items: FocusCard[] }> {
  const order: FocusTrack[] = ["stable", "reform", "black", "red"];
  return order
    .map((track) => ({ track, items: focuses.filter((f) => f.track === track) }))
    .filter((g) => g.items.length > 0);
}

/** 進度百分比(0-100),總回合為 0 時回 0,不會 NaN。 */
export function progressPct(progress: number, totalTurns: number): number {
  if (!(totalTurns > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((progress / totalTurns) * 100)));
}

/** 「還需幾回合」的說明文字;停擺(null)時提示原因。 */
export function remainingText(remaining: number | null): string {
  if (remaining === null) return "進度停擺(議會滿意度過低)";
  if (remaining <= 0) return "即將完成";
  return `約 ${remaining} 回合`;
}

/** 傾向值條的寬度(夾在 0-100)。 */
export function leanPct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}


// ---------- 政體樹排版(純函式,不碰 DOM) ----------

export type TreeMode = "rooted" | "full";

export interface LaidNode extends TreeNode { col: number; row: number }
export interface LaidEdge extends TreeEdge {
  /** 回邊:指向同層或更前面的欄(有環時用虛線淡色畫,避免打亂層級) */
  back: boolean;
  /** 預覽邊:第 2 層往下的邊(換政體後會重抽,只是參考) */
  preview: boolean;
}
export interface TreeLayout { cols: LaidNode[][]; nodes: LaidNode[]; edges: LaidEdge[] }

/**
 * 依模式排版:
 *  - rooted:欄 = depth(0/1/2),只放 depth 非 null 的節點;邊只畫兩端都在範圍內的
 *  - full:欄 = stage(0 建國起點 / 1 中繼 / 2 終點);畫全部邊
 * 同欄內:rooted 目前政體優先;full 終點欄依路線(穩定 → 黑 → 紅)分組,其餘依名稱穩定排序。
 */
export function layoutTree(tree: FocusTreeData, mode: TreeMode, selected: string | null = null): TreeLayout {
  const colOf = (n: TreeNode): number | null => (mode === "rooted" ? n.depth : n.stage);
  const picked = tree.nodes.filter((n) => colOf(n) !== null);
  const colIds = [...new Set(picked.map((n) => colOf(n) as number))].sort((a, b) => a - b);
  const colIndex = new Map(colIds.map((c, i) => [c, i]));
  const cols: LaidNode[][] = colIds.map(() => []);
  for (const n of picked) {
    const col = colIndex.get(colOf(n) as number)!;
    cols[col]!.push({ ...n, col, row: 0 });
  }
  const lineRank = (n: TreeNode) => (n.line === "stable" ? 0 : n.line === "black" ? 1 : n.line === "red" ? 2 : 3);
  for (const c of cols) {
    c.sort((a, b) =>
      (mode === "rooted" ? Number(b.isCurrent) - Number(a.isCurrent) : lineRank(a) - lineRank(b))
      || a.label.localeCompare(b.label, "zh-Hant"));
    c.forEach((n, i) => { n.row = i; });
  }
  const nodes = cols.flat();
  const bySlug = new Map(nodes.map((n) => [n.slug, n]));
  const edges: LaidEdge[] = [];
  for (const e of tree.edges) {
    const a = bySlug.get(e.from), b = bySlug.get(e.to);
    if (!a || !b) continue;
    // 一律不畫回邊(同欄或往前):畫出來只會穿過其他節點變蜘蛛網,回頭的路改在明細文字列出
    if (b.col <= a.col) continue;
    if (mode === "rooted") {
      if (b.col !== a.col + 1) continue;
      if (a.col === 1 && !a.isCurrent && a.depth === 1 && b.depth !== 2) continue;
    } else if (selected === null || (e.from !== selected && e.to !== selected)) {
      // 全景:預設不畫任何線(43 條全畫就是蜘蛛網),點選某個政體才顯示它的進出線
      continue;
    }
    edges.push({ ...e, back: false, preview: mode === "rooted" && a.col >= 1 });
  }
  return { cols, nodes, edges };
}
