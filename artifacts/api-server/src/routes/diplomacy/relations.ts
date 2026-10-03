import { Router, type IRouter } from "express";
import { and, desc, eq, gte, or } from "drizzle-orm";
import { db, diplomacyRelationEventsTable } from "@workspace/db";
import {
  describeRelationAction,
  npcHistoryStatusLabel,
  relationEventsPruneCutoff,
  treatyTypeLabel,
} from "../../lib/diplomacy";
import { fetchNpcTreatyHistory } from "../../lib/npcTreatyHistory";
import { loadNpcTreatyCaps } from "../../lib/npcTreatyCapData";
import { requirePlayer, loadNationOr404 } from "./shared";

const router: IRouter = Router();

// ── NPC 提案記憶（玩家可見；Task #90） ─────────────────────────
// 讓玩家在締約分頁看到 NPC 記得哪些近期已結束的提案（與 NPC 判斷
// prompt 用的是同一個查詢 fetchNpcTreatyHistory，資料保證一致）。
// 只對 NPC 對象開放；玩家對玩家的提案不受 NPC 記憶影響，故回 400。

router.get(
  "/diplomacy/nations/:nationId/npc-treaty-history",
  async (req, res) => {
    const player = await requirePlayer(req, res);
    if (!player) return;
    const target = await loadNationOr404(res, req.params["nationId"] ?? "");
    if (!target) return;
    if (!target.isNpc) {
      res.status(400).json({ error: "該國不是 NPC 國家，沒有提案記憶紀錄" });
      return;
    }

    const rows = await fetchNpcTreatyHistory({
      myNationId: player.nation.id,
      npcNationId: target.id,
    });
    res.json({
      entries: rows.map((r) => ({
        type: r.type,
        typeLabel: treatyTypeLabel(r.type),
        status: r.status,
        statusLabel: npcHistoryStatusLabel(r.status),
        durationDays: r.durationDays,
        offerMoney: r.offerMoney,
        offerTechPoints: r.offerTechPoints,
        offerRegionCount: r.offerRegionIds.length,
        proposedByNpc: r.proposedByNpc,
        responseNote: r.responseNote,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  },
);

// ── NPC 締約資源上限（Task #570） ──────────────────────────────
// 條約表單在對象為 NPC 時顯示各資源目前可要求的最大值（與提案守門
// 用的是同一個 loadNpcTreatyCaps，保證一致）。只對 NPC 對象開放。

router.get("/diplomacy/nations/:nationId/treaty-caps", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const target = await loadNationOr404(res, req.params["nationId"] ?? "");
  if (!target) return;
  if (!target.isNpc) {
    res.status(400).json({ error: "該國不是 NPC 國家，沒有締約資源上限" });
    return;
  }

  const caps = await loadNpcTreatyCaps(target);
  res.json({ caps });
});

// ── 近期互動紀錄（Task #92） ───────────────────────────────────
// 交流分頁顯示與選定國家的近期關係動作（送禮／侮辱／設館／撤館），
// 雙向、新→舊。資料來自 diplomacy_relation_events（保留窗 30 天，
// 由 relation-event prune 迴圈清理），最多回傳 30 筆。

const RELATION_EVENTS_UI_MAX_ENTRIES = 30;

router.get(
  "/diplomacy/nations/:nationId/relation-events",
  async (req, res) => {
    const player = await requirePlayer(req, res);
    if (!player) return;
    const target = await loadNationOr404(res, req.params["nationId"] ?? "");
    if (!target) return;
    const myId = player.nation.id;
    if (target.id === myId) {
      res.status(400).json({ error: "無法查詢與自己的互動紀錄" });
      return;
    }

    // 只回傳保留窗（30 天）內的紀錄；即使清理迴圈尚未跑過，也不外洩窗外舊紀錄。
    const cutoff = relationEventsPruneCutoff();

    const rows = await db
      .select({
        id: diplomacyRelationEventsTable.id,
        action: diplomacyRelationEventsTable.action,
        actorNationId: diplomacyRelationEventsTable.actorNationId,
        createdAt: diplomacyRelationEventsTable.createdAt,
      })
      .from(diplomacyRelationEventsTable)
      .where(
        and(
          gte(diplomacyRelationEventsTable.createdAt, cutoff),
          or(
            and(
              eq(diplomacyRelationEventsTable.actorNationId, myId),
              eq(diplomacyRelationEventsTable.targetNationId, target.id),
            ),
            and(
              eq(diplomacyRelationEventsTable.actorNationId, target.id),
              eq(diplomacyRelationEventsTable.targetNationId, myId),
            ),
          ),
        ),
      )
      .orderBy(desc(diplomacyRelationEventsTable.createdAt))
      .limit(RELATION_EVENTS_UI_MAX_ENTRIES);

    res.json({
      events: rows.map((r) => {
        const known = describeRelationAction(r.action);
        return {
          id: r.id,
          action: r.action,
          actionLabel: known?.label ?? r.action,
          byMe: r.actorNationId === myId,
          delta: known?.delta ?? 0,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    });
  },
);

export default router;
