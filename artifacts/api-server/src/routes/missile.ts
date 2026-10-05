import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  diplomacyWarsTable,
  mapRegionsTable,
  missileStrikesTable,
  playerNationsTable,
  regionBuildingsTable,
  regionControlsTable,
  worldGameStateTable,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { getEraSlugs } from "../lib/nationStats";
import { eraCostScale } from "../lib/eraCostScale";
import { applyRegionPopulationDelta } from "../lib/regionPopulation";
import { createPlayerNotification } from "../lib/playerNotify";
import { pgErrorCode } from "../lib/playerValidation";
import {
  MISSILE_DEFS,
  MISSILE_TYPES,
  buildingLevelAfter,
  isMissileType,
  isMissileUnlocked,
  missileCost,
  missileMinTreasury,
  populationLoss,
  reservedAfter,
} from "../lib/missile";
import { mapRegionPopulation } from "../lib/missileRegion";

const router: IRouter = Router();

/** 與 routes/regionBuildings.ts 的 BUILDING_LOCK_NS 同值:導彈炸建築要和玩家建造/拆除互斥。 */
const BUILDING_LOCK_NS = 406_001;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
) {
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
    res.status(400).json({ error: "尚未建國，請先在玩家首頁建立或接手國家" });
    return null;
  }
  return { nation, userId: session.discordUserId };
}

async function loadWorld() {
  const [w] = await db
    .select({ gameDate: worldGameStateTable.gameDate, lastTurnAt: worldGameStateTable.lastTurnAt })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return {
    gameDate: w?.gameDate ?? "1900-01-01",
    turnKey: String(w?.lastTurnAt ? w.lastTurnAt.getTime() : 0),
  };
}

/** 與 nationId 交戰中的國家 id 清單(進行中的戰爭)。 */
async function enemiesOf(nationId: string): Promise<string[]> {
  const wars = await db
    .select({ a: diplomacyWarsTable.nationAId, b: diplomacyWarsTable.nationBId })
    .from(diplomacyWarsTable)
    .where(
      and(
        isNull(diplomacyWarsTable.endedAt),
        or(eq(diplomacyWarsTable.nationAId, nationId), eq(diplomacyWarsTable.nationBId, nationId)),
      ),
    );
  return [...new Set(wars.map((w) => (w.a === nationId ? w.b : w.a)))];
}

/**
 * GET /player/missiles — 導彈頁資料:是否解鎖、可射的三種導彈(費用/損失/是否負擔得起)、
 * 本回合是否已射、可攻擊的敵方地區清單。
 */
router.get("/player/missiles", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  try {
    const world = await loadWorld();
    const { currentEra } = await getEraSlugs();
    const unlocked = isMissileUnlocked(world.gameDate);
    const minTreasury = missileMinTreasury(eraCostScale(currentEra));
    const money = Number(nation.money);

    const [fired] = await db
      .select({ id: missileStrikesTable.id })
      .from(missileStrikesTable)
      .where(
        and(
          eq(missileStrikesTable.attackerNationId, nation.id),
          eq(missileStrikesTable.turnKey, world.turnKey),
        ),
      )
      .limit(1);

    const enemyIds = unlocked ? await enemiesOf(nation.id) : [];
    const targets = enemyIds.length
      ? await db
          .select({
            nationId: regionControlsTable.nationId,
            nationName: playerNationsTable.name,
            regionId: regionControlsTable.regionId,
            regionName: mapRegionsTable.name,
            percent: regionControlsTable.percent,
          })
          .from(regionControlsTable)
          .innerJoin(mapRegionsTable, eq(mapRegionsTable.id, regionControlsTable.regionId))
          .innerJoin(playerNationsTable, eq(playerNationsTable.id, regionControlsTable.nationId))
          .where(inArray(regionControlsTable.nationId, enemyIds))
      : [];

    res.json({
      unlocked,
      unlockYear: 1960,
      gameDate: world.gameDate,
      money,
      minTreasury,
      firedThisTurn: Boolean(fired),
      missiles: MISSILE_TYPES.map((t) => ({
        type: t,
        label: MISSILE_DEFS[t].label,
        costPct: MISSILE_DEFS[t].costPct,
        damagePct: MISSILE_DEFS[t].damagePct,
        cost: missileCost(money, t),
        affordable: money >= minTreasury,
      })),
      targets: targets.map((t) => ({
        nationId: t.nationId,
        nationName: t.nationName,
        regionId: t.regionId,
        regionName: t.regionName,
        percent: t.percent,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "load missiles failed");
    res.status(500).json({ error: "讀取導彈資料失敗" });
  }
});

/** GET /player/missiles/history — 我方發射與遭受的最近 30 筆。 */
router.get("/player/missiles/history", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  try {
    const rows = await db
      .select()
      .from(missileStrikesTable)
      .where(
        or(
          eq(missileStrikesTable.attackerNationId, nation.id),
          eq(missileStrikesTable.targetNationId, nation.id),
        ),
      )
      .orderBy(desc(missileStrikesTable.createdAt))
      .limit(30);
    res.json({
      strikes: rows.map((r) => ({
        id: r.id,
        direction: r.attackerNationId === nation.id ? "outgoing" : "incoming",
        attackerName: r.attackerName,
        targetName: r.targetName,
        regionName: r.regionName,
        missileType: r.missileType,
        missileLabel: isMissileType(r.missileType) ? MISSILE_DEFS[r.missileType].label : r.missileType,
        costMoney: r.costMoney,
        populationLost: r.populationLost,
        buildingsDowngraded: r.buildingsDowngraded,
        buildingsDestroyed: r.buildingsDestroyed,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "load missile history failed");
    res.status(500).json({ error: "讀取導彈紀錄失敗" });
  }
});

/**
 * POST /player/missiles/launch  { missileType, targetRegionId }
 *
 * 規則(皆在單一交易內、持有雙方國家鎖後檢查):
 *  1. 遊戲年份 ≥ 1960。
 *  2. 目標地區由「與我交戰中」的國家控制(多國共有時取控制率最高者)。
 *  3. 國庫 ≥ 門檻(時代縮放)。
 *  4. 每國每回合一發:missile_strikes (attacker, turn_key) 唯一索引,撞到即拒絕。
 *  5. 扣發射國國庫 costPct%(條件式 UPDATE 防併發超扣);目標地區人口、地區建築各扣 damagePct%;
 *     目標國國庫不動。建築降級/炸毀同步釋放 production_spent,維持占用不變量。
 */
router.post("/player/missiles/launch", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;
  try {
    const body = (req.body ?? {}) as { missileType?: unknown; targetRegionId?: unknown };
    if (!isMissileType(body.missileType)) throw new HttpError(400, "導彈種類不正確");
    const type = body.missileType;
    const regionId = Number(body.targetRegionId);
    if (!Number.isInteger(regionId) || regionId <= 0) throw new HttpError(400, "目標地區不正確");

    const world = await loadWorld();
    if (!isMissileUnlocked(world.gameDate)) {
      throw new HttpError(403, "導彈系統於 1960 年後解鎖");
    }
    const { currentEra, statsEra } = await getEraSlugs();
    const minTreasury = missileMinTreasury(eraCostScale(currentEra));

    const result = await db.transaction(async (tx) => {
      // ── 目標:該地區由哪些國家控制,挑交戰國中控制率最高者 ──
      const enemyIds = await enemiesOf(nation.id);
      if (enemyIds.length === 0) throw new HttpError(400, "目前沒有交戰中的國家，不能發射導彈");
      const controls = await tx
        .select({
          nationId: regionControlsTable.nationId,
          percent: regionControlsTable.percent,
        })
        .from(regionControlsTable)
        .where(
          and(
            eq(regionControlsTable.regionId, regionId),
            inArray(regionControlsTable.nationId, enemyIds),
          ),
        );
      if (controls.length === 0) {
        throw new HttpError(400, "目標地區不在交戰國控制下，只能攻擊交戰中國家的領土");
      }
      const targetNationId = [...controls].sort((a, b) => b.percent - a.percent)[0]!.nationId;

      // ── 鎖:雙方國家,依 id 排序取鎖避免死鎖;與建築建造/拆除同一把鎖 ──
      for (const id of [nation.id, targetNationId].sort()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${BUILDING_LOCK_NS}, hashtext(${id}))`);
      }

      const [target] = await tx
        .select({ id: playerNationsTable.id, name: playerNationsTable.name, discordUserId: playerNationsTable.discordUserId })
        .from(playerNationsTable)
        .where(eq(playerNationsTable.id, targetNationId))
        .limit(1);
      const [region] = await tx
        .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
        .from(mapRegionsTable)
        .where(eq(mapRegionsTable.id, regionId))
        .limit(1);
      if (!target || !region) throw new HttpError(404, "找不到目標");

      // ── 發射國國庫(鎖內重讀最新值)──
      const [me] = await tx
        .select({ money: playerNationsTable.money, name: playerNationsTable.name })
        .from(playerNationsTable)
        .where(eq(playerNationsTable.id, nation.id))
        .limit(1);
      const money = Number(me?.money ?? 0);
      if (money < minTreasury) {
        throw new HttpError(400, `國庫不足：發射導彈需要至少 ${minTreasury.toLocaleString("en-US")} 金的國庫`);
      }
      const cost = missileCost(money, type);
      if (cost <= 0) throw new HttpError(400, "國庫不足以發射");

      // ── 先寫發射紀錄:唯一索引擋「同回合第二發」(撞到 23505)──
      let strikeId: number;
      try {
        const [row] = await tx
          .insert(missileStrikesTable)
          .values({
            attackerNationId: nation.id,
            attackerName: me?.name ?? nation.name ?? "（未命名）",
            targetNationId: target.id,
            targetName: target.name ?? "（未命名）",
            regionId: region.id,
            regionName: region.name,
            missileType: type,
            turnKey: world.turnKey,
            costMoney: cost,
          })
          .returning({ id: missileStrikesTable.id });
        strikeId = row!.id;
      } catch (err) {
        if (pgErrorCode(err) === "23505") {
          throw new HttpError(409, "本回合已發射過導彈，每國每回合限射一發");
        }
        throw err;
      }

      // ── 扣款(條件式,避免併發超扣)──
      const paid = await tx
        .update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${cost}` })
        .where(and(eq(playerNationsTable.id, nation.id), sql`${playerNationsTable.money} >= ${cost}`))
        .returning({ id: playerNationsTable.id });
      if (paid.length === 0) throw new HttpError(400, "國庫不足以發射");

      // ── 人口:只扣目標地區。該地區「實際人口」= 時代人口×控制率 + 累積量 ──
      const popBefore = await mapRegionPopulation(tx, target.id, region.id, statsEra);
      const popLoss = populationLoss(popBefore, type);
      let popApplied = 0;
      if (popLoss > 0) {
        popApplied = -(await applyRegionPopulationDelta(tx, target.id, statsEra, -popLoss, [region.id]));
      }

      // ── 建築:該地區目標國的地區建築降級/炸毀,同步釋放生產力占用 ──
      const buildings = await tx
        .select()
        .from(regionBuildingsTable)
        .where(and(eq(regionBuildingsTable.regionId, region.id), eq(regionBuildingsTable.nationId, target.id)));
      let downgraded = 0;
      let destroyed = 0;
      let releasedTotal = 0;
      for (const b of buildings) {
        const newLevel = buildingLevelAfter(b.level, type);
        const { newReserved, released } = reservedAfter(b.level, newLevel, b.productionReserved);
        releasedTotal += released;
        if (newLevel <= 0) {
          await tx.delete(regionBuildingsTable).where(eq(regionBuildingsTable.id, b.id));
          destroyed += 1;
        } else {
          await tx
            .update(regionBuildingsTable)
            .set({ level: newLevel, productionReserved: newReserved })
            .where(eq(regionBuildingsTable.id, b.id));
          downgraded += 1;
        }
      }
      if (releasedTotal > 0) {
        await tx
          .update(playerNationsTable)
          .set({ productionSpent: sql`GREATEST(0, ${playerNationsTable.productionSpent} - ${releasedTotal})` })
          .where(eq(playerNationsTable.id, target.id));
      }

      await tx
        .update(missileStrikesTable)
        .set({ populationLost: popApplied, buildingsDowngraded: downgraded, buildingsDestroyed: destroyed })
        .where(eq(missileStrikesTable.id, strikeId));

      return {
        strikeId,
        cost,
        targetName: target.name ?? "（未命名）",
        targetDiscordUserId: target.discordUserId,
        attackerName: me?.name ?? nation.name ?? "（未命名）",
        regionName: region.name,
        populationLost: popApplied,
        buildingsDowngraded: downgraded,
        buildingsDestroyed: destroyed,
      };
    });

    req.log.info({ userId, type, regionId, ...result, targetDiscordUserId: undefined }, "missile launched");

    // 通知被炸的玩家(fire-and-forget;NPC 沒有 discordUserId 就略過)
    if (result.targetDiscordUserId) {
      void createPlayerNotification({
        discordUserId: result.targetDiscordUserId,
        type: "missile_strike",
        title: `${MISSILE_DEFS[type].label}襲擊 ${result.regionName}`,
        body: `${result.attackerName} 對你的領地 ${result.regionName} 發射${MISSILE_DEFS[type].label}：人口損失 ${result.populationLost.toLocaleString("en-US")}，${result.buildingsDowngraded} 座建築受損、${result.buildingsDestroyed} 座被摧毀。`,
        linkPath: "/game/military",
      }).catch((err) => req.log.warn({ err }, "missile notify failed"));
    }

    res.json({
      ok: true,
      missileLabel: MISSILE_DEFS[type].label,
      cost: result.cost,
      targetName: result.targetName,
      regionName: result.regionName,
      populationLost: result.populationLost,
      buildingsDowngraded: result.buildingsDowngraded,
      buildingsDestroyed: result.buildingsDestroyed,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "missile launch failed");
    res.status(500).json({ error: "發射失敗，請稍後再試" });
  }
});

export default router;
