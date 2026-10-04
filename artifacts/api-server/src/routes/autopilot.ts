import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  autopilotSettingsTable,
  playerNationsTable,
  AUTOPILOT_STYLES,
  type PlayerNation,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import {
  getAutopilotSettings,
  invalidateAutopilotCache,
} from "../lib/autopilotState";

const router: IRouter = Router();

const DIRECTIVE_MAX = 500;

async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{ nation: PlayerNation; userId: string } | null> {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return null;
  }
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, session.discordUserId))
    .limit(1);
  if (!nation) {
    res.status(400).json({ error: "尚未建國，無法啟用託管" });
    return null;
  }
  return { nation, userId: session.discordUserId };
}

function publicView(row: Awaited<ReturnType<typeof getAutopilotSettings>>) {
  return {
    enabled: row?.enabled ?? false,
    style: row?.style ?? "balanced",
    directive: row?.directive ?? "",
    enabledAt: row?.enabledAt ?? null,
    turnsRun: row?.turnsRun ?? 0,
    recentActions: row?.recentActions ?? [],
  };
}

/** 讀取託管狀態（含最近行動紀錄）。 */
router.get("/player/autopilot", async (req, res) => {
  const ctx = await requirePlayer(req, res);
  if (!ctx) return;
  res.json(publicView(await getAutopilotSettings(ctx.nation.id)));
});

/**
 * 啟用 AI 全權託管。啟用後玩家所有寫入操作被伺服器鎖定（423），
 * 只能呼叫 /player/autopilot/disable 解除。
 */
router.post("/player/autopilot/enable", async (req, res) => {
  const ctx = await requirePlayer(req, res);
  if (!ctx) return;
  const body = (req.body ?? {}) as { style?: unknown; directive?: unknown };
  const style =
    typeof body.style === "string" &&
    (AUTOPILOT_STYLES as readonly string[]).includes(body.style)
      ? body.style
      : "balanced";
  const directiveRaw = typeof body.directive === "string" ? body.directive : "";
  const directive = directiveRaw.trim().slice(0, DIRECTIVE_MAX);

  const existing = await getAutopilotSettings(ctx.nation.id);
  if (existing?.enabled) {
    res.status(409).json({ error: "已在託管中" });
    return;
  }
  await db
    .insert(autopilotSettingsTable)
    .values({
      nationId: ctx.nation.id,
      enabled: true,
      style,
      directive,
      enabledAt: new Date(),
      turnsRun: 0,
      recentActions: [],
    })
    .onConflictDoUpdate({
      target: autopilotSettingsTable.nationId,
      set: {
        enabled: true,
        style,
        directive,
        enabledAt: new Date(),
        turnsRun: 0,
        recentActions: [],
      },
    });
  invalidateAutopilotCache(ctx.userId);
  res.json(publicView(await getAutopilotSettings(ctx.nation.id)));
});

/** 解除託管（鎖定期間唯一允許的寫入之一）。 */
router.post("/player/autopilot/disable", async (req, res) => {
  const ctx = await requirePlayer(req, res);
  if (!ctx) return;
  await db
    .update(autopilotSettingsTable)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(autopilotSettingsTable.nationId, ctx.nation.id));
  invalidateAutopilotCache(ctx.userId);
  res.json(publicView(await getAutopilotSettings(ctx.nation.id)));
});

export default router;
