import { Router, type IRouter } from "express";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
  techTreeNodesTable,
  type TechTreeNodeEffect,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { isEraSlug } from "../lib/mapRegionEras";
import { isTechTreeDomain } from "../lib/techTree";
import { validateTechTreeEffects } from "../lib/techTreeEffectVocab";
import { pgErrorCode } from "../lib/playerValidation";

/**
 * Task #469 — 全球統一線性科技樹管理員 CRUD（admin token、raw fetch、不進
 * OpenAPI spec）。改動即時同步到全球（所有國家共用同一棵樹）。
 *
 * - GET    /admin/tech-tree            全部節點（含被研發數／進行中數統計）。
 * - POST   /admin/tech-tree/nodes      新增節點（插入／開支線由欄位組合決定）。
 * - PUT    /admin/tech-tree/nodes/:id  編輯節點（含移動：改 era／line／排序）。
 * - DELETE /admin/tech-tree/nodes/:id  刪除節點；已被研發或研發中 → 409，
 *          帶 ?force=1 才會連引用一併清理（研發紀錄 cascade、進行中歸零）。
 */

const router: IRouter = Router();

const LINE_KINDS = ["main", "branch"] as const;

interface NodeBody {
  domain: string;
  eraSlug: string;
  lineKey: string;
  lineLabel: string;
  lineKind: string;
  sortOrder: number;
  name: string;
  description: string;
  baseCost: number;
  effects: TechTreeNodeEffect[];
  keySlug: string | null;
  branchFromNodeId: number | null;
}

/** 解析並驗證節點欄位（create 需全欄位；update 只驗有帶的欄位）。 */
function parseNodeBody(
  raw: unknown,
  mode: "create" | "update",
): { ok: true; value: Partial<NodeBody> } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "請提供節點資料" };
  }
  const body = raw as Record<string, unknown>;
  const out: Partial<NodeBody> = {};

  const has = (k: string) => mode === "create" || k in body;

  if (has("domain")) {
    const v = String(body.domain ?? "");
    if (!isTechTreeDomain(v)) {
      return { ok: false, error: "領域必須是 social／production／military" };
    }
    out.domain = v;
  }
  if (has("eraSlug")) {
    const v = String(body.eraSlug ?? "");
    if (!isEraSlug(v)) return { ok: false, error: `無效的時代：${v}` };
    out.eraSlug = v;
  }
  if (has("lineKey")) {
    const v = String(body.lineKey ?? "").trim();
    if (!v) return { ok: false, error: "請提供線的識別字（lineKey）" };
    out.lineKey = v;
  }
  if (has("lineLabel")) {
    const v = String(body.lineLabel ?? "").trim();
    if (!v) return { ok: false, error: "請提供線的顯示名稱（lineLabel）" };
    out.lineLabel = v;
  }
  if (has("lineKind")) {
    const v = String(body.lineKind ?? "");
    if (!(LINE_KINDS as readonly string[]).includes(v)) {
      return { ok: false, error: "線種必須是 main（主幹線）或 branch（支線）" };
    }
    out.lineKind = v;
  }
  if (has("sortOrder")) {
    const v = Number(body.sortOrder);
    if (!Number.isInteger(v)) {
      return { ok: false, error: "線內順序（sortOrder）必須是整數" };
    }
    out.sortOrder = v;
  }
  if (has("name")) {
    const v = String(body.name ?? "").trim();
    if (!v) return { ok: false, error: "請提供科技名稱" };
    out.name = v;
  }
  if (has("description")) {
    out.description = String(body.description ?? "");
  }
  if (has("baseCost")) {
    const v = Number(body.baseCost);
    if (!Number.isInteger(v) || v < 1) {
      return { ok: false, error: "基準成本必須是 ≥1 的整數" };
    }
    out.baseCost = v;
  }
  if (has("effects")) {
    const v = body.effects ?? [];
    if (
      !Array.isArray(v) ||
      v.some((e) => typeof e !== "object" || e === null || Array.isArray(e))
    ) {
      return { ok: false, error: "效果（effects）必須是物件陣列" };
    }
    out.effects = v as TechTreeNodeEffect[];
  }
  if (has("keySlug")) {
    const v = body.keySlug;
    if (v === null || v === undefined || String(v).trim() === "") {
      out.keySlug = null;
    } else {
      out.keySlug = String(v).trim();
    }
  }
  if (has("branchFromNodeId")) {
    const v = body.branchFromNodeId;
    if (v === null || v === undefined) {
      out.branchFromNodeId = null;
    } else {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, error: "支線掛點（branchFromNodeId）必須是節點編號" };
      }
      out.branchFromNodeId = n;
    }
  }
  return { ok: true, value: out };
}

/** 掛點必須存在且屬同領域（避免跨領域支線）。 */
async function validateBranchAnchor(
  branchFromNodeId: number,
  domain: string,
  selfId: number | null,
): Promise<string | null> {
  if (selfId !== null && branchFromNodeId === selfId) {
    return "支線掛點不能是節點自己";
  }
  const [anchor] = await db
    .select({ id: techTreeNodesTable.id, domain: techTreeNodesTable.domain })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.id, branchFromNodeId))
    .limit(1);
  if (!anchor) return `支線掛點節點不存在（#${branchFromNodeId}）`;
  if (anchor.domain !== domain) return "支線掛點必須屬於同一領域";
  return null;
}

/** 全部節點＋引用統計。 */
router.get("/admin/tech-tree", requireAdmin, async (_req, res) => {
  const [nodes, researchedCounts, activeCounts] = await Promise.all([
    db
      .select()
      .from(techTreeNodesTable)
      .orderBy(
        asc(techTreeNodesTable.domain),
        asc(techTreeNodesTable.eraSlug),
        asc(techTreeNodesTable.lineKey),
        asc(techTreeNodesTable.sortOrder),
        asc(techTreeNodesTable.id),
      ),
    db
      .select({
        nodeId: playerResearchedTreeNodesTable.nodeId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(playerResearchedTreeNodesTable)
      .groupBy(playerResearchedTreeNodesTable.nodeId),
    db
      .select({
        nodeId: playerTechTreeStateTable.activeNodeId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(playerTechTreeStateTable)
      .where(isNotNull(playerTechTreeStateTable.activeNodeId))
      .groupBy(playerTechTreeStateTable.activeNodeId),
  ]);
  const researchedBy = new Map(researchedCounts.map((r) => [r.nodeId, r.count]));
  const activeBy = new Map(activeCounts.map((r) => [r.nodeId, r.count]));
  res.json({
    nodes: nodes.map((n) => ({
      ...n,
      researchedCount: researchedBy.get(n.id) ?? 0,
      activeCount: activeBy.get(n.id) ?? 0,
    })),
  });
});

/** 新增節點。 */
router.post("/admin/tech-tree/nodes", requireAdmin, async (req, res) => {
  const parsed = parseNodeBody(req.body, "create");
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const v = parsed.value as NodeBody;
  if (isTechTreeDomain(v.domain)) {
    const effectsErr = validateTechTreeEffects(v.domain, v.effects ?? []);
    if (effectsErr) {
      res.status(400).json({ error: effectsErr });
      return;
    }
  }
  if (v.branchFromNodeId !== null) {
    const err = await validateBranchAnchor(v.branchFromNodeId, v.domain, null);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
  }
  try {
    const [node] = await db
      .insert(techTreeNodesTable)
      .values({
        domain: v.domain,
        eraSlug: v.eraSlug,
        lineKey: v.lineKey,
        lineLabel: v.lineLabel,
        lineKind: v.lineKind,
        sortOrder: v.sortOrder,
        name: v.name,
        description: v.description ?? "",
        baseCost: v.baseCost,
        effects: v.effects ?? [],
        keySlug: v.keySlug ?? null,
        branchFromNodeId: v.branchFromNodeId ?? null,
      })
      .returning();
    req.log.info({ nodeId: node.id, domain: node.domain }, "tech tree node created");
    res.status(201).json({ node });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      res.status(409).json({ error: `關鍵科技識別字已被使用：${v.keySlug}` });
      return;
    }
    throw err;
  }
});

/** 編輯節點（含移動／重排／開支線）。 */
router.put("/admin/tech-tree/nodes/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "無效的節點編號" });
    return;
  }
  const [existing] = await db
    .select()
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "節點不存在" });
    return;
  }
  const parsed = parseNodeBody(req.body, "update");
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const v = parsed.value;
  if (Object.keys(v).length === 0) {
    res.status(400).json({ error: "沒有任何要更新的欄位" });
    return;
  }
  const nextDomain = v.domain ?? existing.domain;
  if (("effects" in v || nextDomain !== existing.domain) && isTechTreeDomain(nextDomain)) {
    const nextEffects = v.effects ?? (existing.effects as unknown[]) ?? [];
    const effectsErr = validateTechTreeEffects(nextDomain, nextEffects);
    if (effectsErr) {
      res.status(400).json({ error: effectsErr });
      return;
    }
  }
  const nextBranchFrom =
    "branchFromNodeId" in v ? (v.branchFromNodeId ?? null) : existing.branchFromNodeId;
  if (nextBranchFrom !== null) {
    const err = await validateBranchAnchor(nextBranchFrom, nextDomain, id);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
  }
  try {
    const [node] = await db
      .update(techTreeNodesTable)
      .set({ ...v, updatedAt: sql`NOW()` })
      .where(eq(techTreeNodesTable.id, id))
      .returning();
    req.log.info({ nodeId: id }, "tech tree node updated");
    res.json({ node });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      res.status(409).json({ error: `關鍵科技識別字已被使用：${v.keySlug}` });
      return;
    }
    throw err;
  }
});

/**
 * 刪除節點。已被研發／研發中的節點沒帶 force 一律 409（避免誤刪清掉玩家
 * 進度）；force=1 時在同一交易內：進行中研發歸零（activeNodeId FK 為
 * SET NULL，但快照與進度要一併清乾淨）→ 刪節點（研發紀錄 cascade、
 * 支線掛點 SET NULL）。
 */
router.delete("/admin/tech-tree/nodes/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "無效的節點編號" });
    return;
  }
  const force = req.query.force === "1" || req.query.force === "true";

  const [existing] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "節點不存在" });
    return;
  }

  const [[researched], [active]] = await Promise.all([
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(playerResearchedTreeNodesTable)
      .where(eq(playerResearchedTreeNodesTable.nodeId, id)),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(playerTechTreeStateTable)
      .where(eq(playerTechTreeStateTable.activeNodeId, id)),
  ]);
  const researchedCount = researched?.count ?? 0;
  const activeCount = active?.count ?? 0;

  if (!force && (researchedCount > 0 || activeCount > 0)) {
    res.status(409).json({
      error: `此節點已被 ${researchedCount} 國研發、${activeCount} 國研發中；確認要連引用一併刪除請帶 force=1`,
      researchedCount,
      activeCount,
    });
    return;
  }

  await db.transaction(async (tx) => {
    // 進行中研發：歸零快照與進度（FK SET NULL 只清 activeNodeId）。
    await tx
      .update(playerTechTreeStateTable)
      .set({
        activeNodeId: null,
        costSnapshot: null,
        progressPoints: 0,
        updatedAt: sql`NOW()`,
      })
      .where(eq(playerTechTreeStateTable.activeNodeId, id));
    await tx.delete(techTreeNodesTable).where(eq(techTreeNodesTable.id, id));
  });
  req.log.info(
    { nodeId: id, researchedCount, activeCount, force },
    "tech tree node deleted",
  );
  res.json({ ok: true, researchedCount, activeCount });
});

export default router;
