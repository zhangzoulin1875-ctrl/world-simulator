import { Router, type IRouter } from "express";
import { eq, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  nationSatisfactionBuffsTable,
  nationPopulationBuffsTable,
  worldGameStateTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import {
  parseGiftRequest,
  giftTargetLabel,
  giftSatisfactionDirections,
  parseStartingResourcesUpdate,
  GIFT_RESOURCE_SPECS,
  STARTING_TECH_POINTS_MAX,
  STARTING_MONEY_MAX,
  FOUNDING_PRODUCTION_CAP_MAX,
  type GiftRequest,
  type GiftTarget,
} from "../lib/gifts";
import { notifyGiftReceived } from "../lib/gameNotify";

/**
 * 管理員普發／贈送資源給玩家或 NPC。
 *
 * - Admin only（requireAdmin，Bearer ADMIN_TOKEN）；前端 raw fetch，不進
 *   OpenAPI spec（與其他管理端點一致）。
 * - 永久資源（科技點數／金錢）：只加值（amount ≥ 1），以單一原子 UPDATE
 *   （SET x = LEAST(x + amount, 上限)）遞增，併發安全、免 read-modify-write；
 *   相加先轉 bigint 再封頂，避免 int4 溢位。
 * - 暫時 buff（滿意度／人口增長率，Task #355）：以 discord_user_id 為鍵寫入
 *   buff 表，指定持續回合數，回合引擎每回合遞減、歸零後自動失效還原。因此只影響
 *   有主玩家國家；NPC／無主國家（無 Discord 帳號）自動略過。
 * - 發放後對每個受影響且有主的國家寫站內通知；NPC／無主國家自動略過。
 */
const router: IRouter = Router();

/** 依對象組出 WHERE 條件；全體國家（all）回傳 undefined（不加 WHERE）。 */
function targetWhere(target: GiftTarget): SQL | undefined {
  switch (target.type) {
    case "nation":
      return eq(playerNationsTable.id, target.nationId);
    case "allPlayers":
      return isNotNull(playerNationsTable.discordUserId);
    case "allNpcs":
      return eq(playerNationsTable.isNpc, true);
    case "all":
      return undefined;
  }
}

interface AffectedNation {
  id: string;
  name: string | null;
  discordUserId: string | null;
}

/** 永久資源（科技點數／金錢）：單一原子 UPDATE 遞增並封頂，回傳受影響國家。 */
async function applyPermanentGift(
  request: GiftRequest,
): Promise<AffectedNation[]> {
  const { resource, amount, target } = request;
  const spec = GIFT_RESOURCE_SPECS[resource];
  const column =
    resource === "techPoints"
      ? playerNationsTable.techPoints
      : playerNationsTable.money;
  // 先轉 bigint 相加再封頂（LEAST），回寫時 int8→int4 由 Postgres 隱式轉換。
  const nextValue = sql`LEAST(${column}::bigint + ${amount}::bigint, ${spec.max}::bigint)`;
  const setPatch =
    resource === "techPoints"
      ? { techPoints: nextValue }
      : { money: nextValue };

  const where = targetWhere(target);
  const update = db.update(playerNationsTable).set(setPatch);
  return (where ? update.where(where) : update).returning({
    id: playerNationsTable.id,
    name: playerNationsTable.name,
    discordUserId: playerNationsTable.discordUserId,
  });
}

/**
 * 暫時 buff（滿意度／人口增長率）：找出受影響「有主」國家，逐一寫入 buff 列。
 * NPC／無主（無 discord_user_id）自動略過 — buff 以 discord_user_id 為鍵。
 */
async function applyTemporaryGift(
  request: GiftRequest,
): Promise<AffectedNation[]> {
  const { resource, amount, target, durationTurns, direction } = request;
  // 只選有主國家（buff 表 FK → player_nations.discord_user_id）。
  const baseWhere = targetWhere(target);
  const ownedWhere = isNotNull(playerNationsTable.discordUserId);
  const where = baseWhere ? sql`${baseWhere} AND ${ownedWhere}` : ownedWhere;
  const owned = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      discordUserId: playerNationsTable.discordUserId,
    })
    .from(playerNationsTable)
    .where(where);

  const turns = durationTurns ?? 0;
  for (const nation of owned) {
    if (!nation.discordUserId) continue;
    if (resource === "satisfaction") {
      const dirs = giftSatisfactionDirections(direction ?? "all");
      await db.insert(nationSatisfactionBuffsTable).values(
        dirs.map((d) => ({
          discordUserId: nation.discordUserId as string,
          direction: d,
          satisfactionOffset: amount,
          remainingTurns: turns,
          source: "admin_gift",
        })),
      );
    } else {
      await db.insert(nationPopulationBuffsTable).values({
        discordUserId: nation.discordUserId,
        growthPct: amount,
        remainingTurns: turns,
        source: "admin_gift",
      });
    }
  }
  return owned;
}

router.post("/gifts", requireAdmin, async (req, res) => {
  const parsed = parseGiftRequest((req.body ?? {}) as Record<string, unknown>);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { resource, amount, target, note, durationTurns, direction } =
    parsed.request;

  // 指定國家：先確認存在，避免發到 0 列卻回成功。
  if (target.type === "nation") {
    const [found] = await db
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, target.nationId))
      .limit(1);
    if (!found) {
      res.status(404).json({ error: "找不到這個國家" });
      return;
    }
  }

  const spec = GIFT_RESOURCE_SPECS[resource];
  const affected = spec.temporary
    ? await applyTemporaryGift(parsed.request)
    : await applyPermanentGift(parsed.request);

  // 通知有主玩家（NPC／無主國家無 Discord 帳號 → 自動略過）。
  let notifiedCount = 0;
  for (const nation of affected) {
    if (nation.discordUserId) {
      notifiedCount += 1;
      notifyGiftReceived({
        discordUserId: nation.discordUserId,
        resource,
        amount,
        note,
        durationTurns,
        direction,
      });
    }
  }

  req.log.info(
    {
      resource,
      amount,
      durationTurns,
      direction,
      target: target.type,
      affectedCount: affected.length,
      notifiedCount,
    },
    "admin distributed resource gift",
  );

  res.json({
    ok: true,
    resource,
    amount,
    durationTurns,
    direction,
    targetLabel: giftTargetLabel(target),
    affectedCount: affected.length,
    notifiedCount,
  });
});

/**
 * Task #504 — 開局資源設定：讀取目前的開局科技點數／金錢（自創建國時套用）。
 * Admin only、raw fetch、不進 OpenAPI spec。
 */
router.get("/gifts/starting-resources", requireAdmin, async (_req, res) => {
  const [row] = await db
    .select({
      startingTechPoints: worldGameStateTable.startingTechPoints,
      startingMoney: worldGameStateTable.startingMoney,
      foundingProductionCap: worldGameStateTable.foundingProductionCap,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  res.json({
    startingTechPoints: row?.startingTechPoints ?? 200,
    startingMoney: row?.startingMoney ?? 5000,
    foundingProductionCap: row?.foundingProductionCap ?? 10000,
    maxTechPoints: STARTING_TECH_POINTS_MAX,
    maxMoney: STARTING_MONEY_MAX,
    maxFoundingProductionCap: FOUNDING_PRODUCTION_CAP_MAX,
  });
});

/** Task #504 — 更新開局資源設定（非負整數、上限防呆，錯誤訊息 zh-TW）。 */
router.put("/gifts/starting-resources", requireAdmin, async (req, res) => {
  const parsed = parseStartingResourcesUpdate(
    (req.body ?? {}) as Record<string, unknown>,
  );
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { startingTechPoints, startingMoney, foundingProductionCap } = parsed.update;
  const setPayload: {
    startingTechPoints: number;
    startingMoney: number;
    foundingProductionCap?: number;
  } = { startingTechPoints, startingMoney };
  if (foundingProductionCap !== undefined) setPayload.foundingProductionCap = foundingProductionCap;
  const [updated] = await db
    .update(worldGameStateTable)
    .set(setPayload)
    .where(eq(worldGameStateTable.id, 1))
    .returning({
      startingTechPoints: worldGameStateTable.startingTechPoints,
      startingMoney: worldGameStateTable.startingMoney,
      foundingProductionCap: worldGameStateTable.foundingProductionCap,
    });
  if (!updated) {
    res.status(500).json({ error: "世界狀態尚未初始化，請稍後再試" });
    return;
  }
  req.log.info(
    { startingTechPoints, startingMoney, foundingProductionCap },
    "admin updated starting resources",
  );
  res.json({
    ok: true,
    startingTechPoints: updated.startingTechPoints,
    startingMoney: updated.startingMoney,
    foundingProductionCap: updated.foundingProductionCap,
  });
});

export default router;
