import type { TechTreeDomain, TechTreeNode } from "@workspace/db";
import { getEraIndex, isEraSlug, ERAS } from "./mapRegionEras";

/**
 * Task #469 — 全球統一線性科技樹的純函式（可研發判定、時代推進、
 * 分配比例驗證）。DB 存取在 techTreeData.ts；此處零副作用、可單元測試。
 *
 * 規則：
 * - 節點可研發 ⇔ 節點時代 ≤ 領域目前時代（只擋未來時代）
 *   且線內前一節點已研發（第一個節點無前置）
 *   且（支線第一個節點）掛點節點已研發。
 * - 領域時代推進 ⇔ 目前時代「全部主幹線節點」都已研發（支線不計）。
 */

export const TECH_TREE_DOMAIN_LABELS: Readonly<
  Record<TechTreeDomain, string>
> = {
  social: "社會",
  production: "生產",
  military: "軍事",
};

export function isTechTreeDomain(value: string): value is TechTreeDomain {
  return value === "social" || value === "production" || value === "military";
}

// ── 分配比例 ──────────────────────────────────────────────────────────

export interface TechTreeAllocation {
  social: number;
  production: number;
  military: number;
}

export const DEFAULT_ALLOCATION: Readonly<TechTreeAllocation> = {
  social: 34,
  production: 33,
  military: 33,
};

/** 驗證分配比例：三領域皆為 0–100 整數且合計 = 100。回 zh-TW 錯誤或 null。 */
export function validateAllocation(
  alloc: TechTreeAllocation,
): string | null {
  const entries: [string, number][] = [
    ["社會", alloc.social],
    ["生產", alloc.production],
    ["軍事", alloc.military],
  ];
  for (const [label, v] of entries) {
    if (!Number.isInteger(v) || v < 0 || v > 100) {
      return `${label}領域分配比例必須是 0–100 的整數`;
    }
  }
  const sum = alloc.social + alloc.production + alloc.military;
  if (sum !== 100) {
    return `三領域分配比例合計必須等於 100（目前為 ${sum}）`;
  }
  return null;
}

// ── 節點狀態 ──────────────────────────────────────────────────────────

export type TechTreeNodeStatus =
  | "researched" // 已研發
  | "researching" // 進行中
  | "available" // 可開始研發
  | "locked"; // 前置未滿足（線內前置／支線掛點／時代未到）

/** 節點狀態明細（鎖定原因供前端顯示）。 */
export interface TechTreeNodeStatusDetail {
  status: TechTreeNodeStatus;
  /** 鎖定原因（zh-TW；非 locked 時為 null）。 */
  lockedReason: string | null;
}

interface NodeLike {
  id: number;
  eraSlug: string;
  lineKey: string;
  lineKind: string;
  sortOrder: number;
  branchFromNodeId: number | null;
}

/** 線內前一節點（sortOrder 嚴格小於且最大者；無 → null）。 */
export function previousNodeInLine<T extends NodeLike>(
  node: T,
  lineNodes: readonly T[],
): T | null {
  let prev: T | null = null;
  for (const n of lineNodes) {
    if (n.sortOrder >= node.sortOrder) continue;
    if (!prev || n.sortOrder > prev.sortOrder) prev = n;
  }
  return prev;
}

/** 支線掛點：整條線第一個節點（sortOrder 最小）的 branch_from_node_id。 */
export function lineBranchAnchorId<T extends NodeLike>(
  lineNodes: readonly T[],
): number | null {
  let first: T | null = null;
  for (const n of lineNodes) {
    if (!first || n.sortOrder < first.sortOrder) first = n;
  }
  return first?.branchFromNodeId ?? null;
}

/**
 * 計算一個領域全部節點的狀態。nodes 必須是同一領域（可跨時代）。
 */
export function computeNodeStatuses(params: {
  nodes: readonly TechTreeNode[];
  researchedIds: ReadonlySet<number>;
  domainEraSlug: string;
  activeNodeId: number | null;
}): Map<number, TechTreeNodeStatusDetail> {
  const { nodes, researchedIds, domainEraSlug, activeNodeId } = params;
  const byLine = new Map<string, TechTreeNode[]>();
  for (const n of nodes) {
    const key = `${n.eraSlug}|${n.lineKey}`;
    const list = byLine.get(key) ?? [];
    list.push(n);
    byLine.set(key, list);
  }
  const domainEraIdx = isEraSlug(domainEraSlug)
    ? getEraIndex(domainEraSlug)
    : 0;

  const out = new Map<number, TechTreeNodeStatusDetail>();
  for (const n of nodes) {
    if (researchedIds.has(n.id)) {
      out.set(n.id, { status: "researched", lockedReason: null });
      continue;
    }
    if (activeNodeId !== null && n.id === activeNodeId) {
      out.set(n.id, { status: "researching", lockedReason: null });
      continue;
    }
    // 特殊授予節點（如超事件跨時代科技，lineKind = "event"）：
    // 只能由事件／管理員授予，永不可自行研發。
    if (n.lineKind !== "main" && n.lineKind !== "branch") {
      out.set(n.id, {
        status: "locked",
        lockedReason: "特殊科技（事件授予），無法自行研發",
      });
      continue;
    }
    // 時代守門：只擋未來時代（沿用三牌組時代守門精神）。
    if (isEraSlug(n.eraSlug) && getEraIndex(n.eraSlug) > domainEraIdx) {
      out.set(n.id, {
        status: "locked",
        lockedReason: "領域時代尚未到達此節點所屬時代",
      });
      continue;
    }
    const lineNodes = byLine.get(`${n.eraSlug}|${n.lineKey}`) ?? [];
    // 支線掛點守門（整條支線都要求掛點已研發）。
    const anchorId = lineBranchAnchorId(lineNodes);
    if (n.lineKind === "branch" && anchorId !== null && !researchedIds.has(anchorId)) {
      out.set(n.id, {
        status: "locked",
        lockedReason: "支線掛點科技尚未研發",
      });
      continue;
    }
    // 線內線性前置。
    const prev = previousNodeInLine(n, lineNodes);
    if (prev && !researchedIds.has(prev.id)) {
      out.set(n.id, {
        status: "locked",
        lockedReason: "線內前一項科技尚未研發",
      });
      continue;
    }
    out.set(n.id, { status: "available", lockedReason: null });
  }
  return out;
}

/** 節點是否可開始研發（單點判定；語義同 computeNodeStatuses）。 */
export function isNodeResearchable(params: {
  node: TechTreeNode;
  domainNodes: readonly TechTreeNode[];
  researchedIds: ReadonlySet<number>;
  domainEraSlug: string;
}): { ok: boolean; reason: string | null } {
  const statuses = computeNodeStatuses({
    nodes: params.domainNodes,
    researchedIds: params.researchedIds,
    domainEraSlug: params.domainEraSlug,
    activeNodeId: null,
  });
  const detail = statuses.get(params.node.id);
  if (!detail) return { ok: false, reason: "節點不存在" };
  if (detail.status === "available") return { ok: true, reason: null };
  if (detail.status === "researched") {
    return { ok: false, reason: "此科技已研發完成" };
  }
  return { ok: false, reason: detail.lockedReason ?? "無法研發" };
}

// ── 時代推進 ──────────────────────────────────────────────────────────

/** 指定時代的主幹線節點是否全部研發完成（無主幹線節點 → 不推進）。 */
export function isEraMainLinesComplete(params: {
  nodes: readonly TechTreeNode[];
  researchedIds: ReadonlySet<number>;
  eraSlug: string;
}): boolean {
  const mains = params.nodes.filter(
    (n) => n.eraSlug === params.eraSlug && n.lineKind === "main",
  );
  if (mains.length === 0) return false;
  return mains.every((n) => params.researchedIds.has(n.id));
}

/**
 * 由目前領域時代出發，依「主幹線全研發」規則盡可能往後推進，回傳最終時代
 * （可能一次跨多個時代；已在最後時代或未達標 → 原時代）。
 */
export function advanceDomainEra(params: {
  nodes: readonly TechTreeNode[];
  researchedIds: ReadonlySet<number>;
  currentEraSlug: string;
}): string {
  let era = params.currentEraSlug;
  if (!isEraSlug(era)) return era;
  let idx = getEraIndex(era);
  while (
    idx + 1 < ERAS.length &&
    isEraMainLinesComplete({
      nodes: params.nodes,
      researchedIds: params.researchedIds,
      eraSlug: era,
    })
  ) {
    idx += 1;
    era = ERAS[idx]!.slug;
  }
  return era;
}
