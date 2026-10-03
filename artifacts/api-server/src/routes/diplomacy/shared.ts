import { type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, playerNationsTable, type PlayerNation } from "@workspace/db";
import { getSession, readSessionToken } from "../../lib/sessions";

export async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{ nation: PlayerNation; userId: string } | null> {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return null;
  }
  const userId = session.discordUserId;
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!nation) {
    res.status(400).json({ error: "尚未建國，請先在玩家首頁建立或接手國家" });
    return null;
  }
  return { nation, userId };
}

export async function loadNationOr404(
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  nationId: string,
): Promise<PlayerNation | null> {
  if (!/^[0-9a-f-]{36}$/i.test(nationId)) {
    res.status(400).json({ error: "國家 id 不正確" });
    return null;
  }
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  if (!nation) {
    res.status(404).json({ error: "找不到這個國家" });
    return null;
  }
  return nation;
}
