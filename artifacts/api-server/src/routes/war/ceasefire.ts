import { CIVIL_WAR_NO_CEASEFIRE_MESSAGE, notCivilWar } from "../../lib/civilWar";
import { type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  diplomacyWarsTable,
  playerNationsTable,
  type PlayerNation,
} from "@workspace/db";
import { endCampaignsForWar } from "../../lib/warEngine";
import {
  notifyCeasefireAccepted,
  notifyCeasefireProposed,
} from "../../lib/gameNotify";
import { parseId, requirePlayer } from "./shared";

async function loadWarForPlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{
  war: typeof diplomacyWarsTable.$inferSelect;
  nation: PlayerNation;
} | null> {
  const player = await requirePlayer(req, res);
  if (!player) return null;
  const id = parseId(req.params.id ?? "");
  if (id === null) {
    res.status(404).json({ error: "找不到指定的戰爭" });
    return null;
  }
  const [war] = await db
    .select()
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, id))
    .limit(1);
  if (!war) {
    res.status(404).json({ error: "找不到指定的戰爭" });
    return null;
  }
  if (war.nationAId !== player.nation.id && war.nationBId !== player.nation.id) {
    res.status(403).json({ error: "你不是這場戰爭的交戰方" });
    return null;
  }
  return { war, nation: player.nation };
}

async function loadNation(nationId: string): Promise<PlayerNation | null> {
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  return nation ?? null;
}

export function registerWarCeasefireRoutes(router: IRouter): void {
  // ── 停戰（外交） ───────────────────────────────────────────────

  router.post("/diplomacy/wars/:id/ceasefire", async (req, res) => {
    const ctx = await loadWarForPlayer(req, res);
    if (!ctx) return;
    const { war, nation } = ctx;
    if (war.endedAt) {
      res.status(400).json({ error: "戰爭已結束" });
      return;
    }
    if (war.isCivilWar) {
      res.status(409).json({ error: CIVIL_WAR_NO_CEASEFIRE_MESSAGE });
      return;
    }
    if (war.ceasefireProposedBy === nation.id) {
      res.json({ ok: true, warEnded: false, proposedByMe: true });
      return;
    }
    if (war.ceasefireProposedBy) {
      res
        .status(400)
        .json({ error: "對方已提出停戰，請直接接受對方的停戰提案" });
      return;
    }
    const updated = await db
      .update(diplomacyWarsTable)
      .set({ ceasefireProposedBy: nation.id })
      .where(
        and(
          eq(diplomacyWarsTable.id, war.id),
          isNull(diplomacyWarsTable.endedAt),
          isNull(diplomacyWarsTable.ceasefireProposedBy),
          notCivilWar(),
        ),
      )
      .returning();
    if (updated.length === 0) {
      res.status(409).json({ error: "戰爭狀態已變更，請重新整理後再試" });
      return;
    }
    const opponentId =
      war.nationAId === nation.id ? war.nationBId : war.nationAId;
    const opponent = await loadNation(opponentId);
    if (opponent?.discordUserId) {
      notifyCeasefireProposed({
        discordUserId: opponent.discordUserId,
        opponentName: nation.name ?? "未知國家",
      });
    }
    res.json({ ok: true, warEnded: false, proposedByMe: true });
  });

  router.post("/diplomacy/wars/:id/ceasefire/accept", async (req, res) => {
    const ctx = await loadWarForPlayer(req, res);
    if (!ctx) return;
    const { war, nation } = ctx;
    if (war.endedAt) {
      res.status(400).json({ error: "戰爭已結束" });
      return;
    }
    if (war.isCivilWar) {
      res.status(409).json({ error: CIVIL_WAR_NO_CEASEFIRE_MESSAGE });
      return;
    }
    if (!war.ceasefireProposedBy || war.ceasefireProposedBy === nation.id) {
      res.status(400).json({ error: "目前沒有對方的停戰提案可接受" });
      return;
    }
    const updated = await db
      .update(diplomacyWarsTable)
      .set({ endedAt: new Date(), ceasefireProposedBy: null })
      .where(
        and(eq(diplomacyWarsTable.id, war.id), isNull(diplomacyWarsTable.endedAt), notCivilWar()),
      )
      .returning();
    if (updated.length === 0) {
      res.status(400).json({ error: "戰爭已結束" });
      return;
    }
    try {
      await endCampaignsForWar(war.id, "ceasefire");
    } catch (err) {
      req.log.error({ err, warId: war.id }, "end campaigns for ceasefire failed");
    }
    const opponentId =
      war.nationAId === nation.id ? war.nationBId : war.nationAId;
    const opponent = await loadNation(opponentId);
    if (opponent?.discordUserId) {
      notifyCeasefireAccepted({
        discordUserId: opponent.discordUserId,
        opponentName: nation.name ?? "未知國家",
      });
    }
    res.json({ ok: true, warEnded: true, proposedByMe: false });
  });
}
