/**
 * 「全民皆兵」服務層:開啟 / 關閉 / 查詢 / 回合穩定度。規則見 totalMobilization.ts。
 *
 * 人口口徑:民兵是 player_armies 的一列(視為正規部隊),人口以 populationReserved 占用,
 * 同步累加 player_nations.population_spent。總人口不變、可用人口減少;解散(不論從軍事頁
 * 解散、關閉全民皆兵、或解除武裝)都走 releaseReservation,占用的人口如數補回。
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerArmiesTable,
  militaryUnitTemplatesTable,
  diplomacyWarsTable,
  totalMobilizationStatesTable,
  type TotalMobilizationState,
} from "@workspace/db";
import { isNull, ne, or } from "drizzle-orm";
import {
  canStartMobilization,
  levyAmount,
  militiaStatsForEra,
  MILITIA_POP_PER_UNIT,
  MOBILIZATION_STABILITY_PER_TURN,
} from "./totalMobilization";
import { computeNationStats, getEraSlugs } from "./nationStats";
import { hasActiveMercenaryContract, hasActiveCampaign, MercenaryError } from "./mercenaryService";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export const MILITIA_TEMPLATE_NAME = "全民皆兵民兵";

export async function getMobilizationState(
  nationId: string,
  ex: Executor = db,
): Promise<TotalMobilizationState | null> {
  const [row] = await ex
    .select()
    .from(totalMobilizationStatesTable)
    .where(eq(totalMobilizationStatesTable.nationId, nationId))
    .limit(1);
  return row ?? null;
}

export async function isMobilizationActive(nationId: string, ex: Executor = db): Promise<boolean> {
  return !!(await getMobilizationState(nationId, ex))?.active;
}

/** 該國是否處於戰爭(有任何未結束的 diplomacy_wars)。 */
export async function isNationAtWar(nationId: string, ex: Executor = db): Promise<boolean> {
  const [w] = await ex
    .select({ id: diplomacyWarsTable.id })
    .from(diplomacyWarsTable)
    .where(
      and(
        isNull(diplomacyWarsTable.endedAt),
        or(eq(diplomacyWarsTable.nationAId, nationId), eq(diplomacyWarsTable.nationBId, nationId)),
      ),
    )
    .limit(1);
  return !!w;
}

/** 取得或建立該玩家的民兵模板(依當前時代數值;已存在就更新成當前時代數值)。 */
async function upsertMilitiaTemplate(tx: Tx, userId: string, eraSlug: string): Promise<number> {
  const m = militiaStatsForEra(eraSlug);
  const [existing] = await tx
    .select({ id: militaryUnitTemplatesTable.id })
    .from(militaryUnitTemplatesTable)
    .where(
      and(
        eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId),
        eq(militaryUnitTemplatesTable.name, MILITIA_TEMPLATE_NAME),
      ),
    )
    .limit(1);
  const values = {
    category: "infantry",
    description: `${m.label}:全民皆兵徵召的平民,量大質低,不占生產力、不收維護費`,
    eraSlug,
    hp: m.hp,
    attack: m.attack,
    defense: m.defense,
    speed: m.speed,
    accuracy: m.accuracy,
    range: m.range,
    prodCostPer100: 0,
    popCostPerUnit: MILITIA_POP_PER_UNIT,
    moneyCostPerUnit: 0,
    upkeepPerUnit: 0,
    prodUpkeepPerUnit: 0,
    woodCostPerUnit: 0,
    oreCostPerUnit: 0,
    isDefault: false,
  };
  if (existing) {
    await tx.update(militaryUnitTemplatesTable).set(values).where(eq(militaryUnitTemplatesTable.id, existing.id));
    return existing.id;
  }
  const [row] = await tx
    .insert(militaryUnitTemplatesTable)
    .values({ ...values, name: MILITIA_TEMPLATE_NAME, ownerDiscordUserId: userId })
    .returning({ id: militaryUnitTemplatesTable.id });
  return row!.id;
}

export interface StartResult {
  levy: number;
  templateId: number;
  label: string;
}

/** 開啟全民皆兵:一個交易內鎖國家列 → 檢查 → 建軍 + 占用人口 → 標記狀態。 */
export async function startMobilization(nationId: string): Promise<StartResult> {
  const { statsEra } = await getEraSlugs();
  return db.transaction(async (tx) => {
    const [nation] = await tx
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update")
      .limit(1);
    if (!nation) throw new MercenaryError(404, "找不到國家");
    if (nation.isNpc) throw new MercenaryError(403, "NPC 國家不使用全民皆兵");
    if (!nation.discordUserId) throw new MercenaryError(400, "此國家沒有玩家");
    const stats = await computeNationStats(nation.id, statsEra);
    const levy = levyAmount(stats.population, nation.populationSpent);
    const state = await getMobilizationState(nation.id, tx);
    const check = canStartMobilization({
      isNpc: nation.isNpc,
      atWar: await isNationAtWar(nation.id, tx),
      alreadyActive: !!state?.active,
      hasActiveContract: await hasActiveMercenaryContract(nation.id, tx),
      stability: nation.stability,
      levy,
    });
    if (!check.ok) throw new MercenaryError(409, check.reason);

    const templateId = await upsertMilitiaTemplate(tx, nation.discordUserId, statsEra);
    // 三道閘,任何一道攔下就整筆回滾:
    // ① 國家列鎖(真 Postgres 序列化同國並發)。
    // ② 狀態翻轉:只有「未開啟 → 開啟」的那一次拿得到列。
    // ③ 民兵列唯一索引搶占 + 人口占用用「條件式 UPDATE」:只在人口仍足夠時才加,
    //    結果列數為 0 就視為被並發搶先而回滾,人口絕不會被占用兩次。
    const flipped = await tx
      .insert(totalMobilizationStatesTable)
      .values({ nationId: nation.id, active: true, lastLevy: levy, templateId, startedAt: new Date() })
      .onConflictDoUpdate({
        target: totalMobilizationStatesTable.nationId,
        set: { active: true, lastLevy: levy, templateId, startedAt: new Date(), updatedAt: new Date() },
        setWhere: eq(totalMobilizationStatesTable.active, false),
      })
      .returning({ nationId: totalMobilizationStatesTable.nationId });
    if (flipped.length === 0) throw new MercenaryError(409, "全民皆兵已經開啟");
    const claimed = await tx
      .insert(playerArmiesTable)
      .values({
        discordUserId: nation.discordUserId,
        templateId,
        quantity: levy,
        productionReserved: 0,
        populationReserved: levy * MILITIA_POP_PER_UNIT,
      })
      .onConflictDoNothing({
        target: [playerArmiesTable.discordUserId, playerArmiesTable.templateId],
      })
      .returning({ id: playerArmiesTable.id });
    if (claimed.length === 0) {
      throw new MercenaryError(409, "民兵尚未解散完畢,請先解散現有民兵再重新開啟");
    }
    // 人口占用:以「讀到的 populationSpent 值」做樂觀比對(CAS)。並發的另一個開啟若已先
    // 加過,值已變 → 本次 UPDATE 0 列 → 回滾。
    const spent = await tx
      .update(playerNationsTable)
      .set({ populationSpent: sql`${playerNationsTable.populationSpent} + ${levy * MILITIA_POP_PER_UNIT}` })
      .where(
        and(
          eq(playerNationsTable.id, nation.id),
          eq(playerNationsTable.populationSpent, nation.populationSpent),
        ),
      )
      .returning({ id: playerNationsTable.id });
    if (spent.length === 0) throw new MercenaryError(409, "人口狀態剛被更新,請重試");
    return { levy, templateId, label: militiaStatsForEra(statsEra).label };
  });
}

export interface StopResult {
  disbanded: number;
  releasedPopulation: number;
}

/**
 * 關閉全民皆兵並解散「可用」的民兵(未派遣前線的部分),人口如數補回。
 * 有進行中戰役時,派駐前線的民兵無法立即解散:狀態照樣關閉(停止扣穩定度),
 * 剩餘民兵留在軍中,之後可在軍事頁照一般規則解散。
 */
export async function stopMobilization(nationId: string): Promise<StopResult> {
  return db.transaction(async (tx) => {
    const [nation] = await tx
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update")
      .limit(1);
    if (!nation) throw new MercenaryError(404, "找不到國家");
    if (nation.isNpc) throw new MercenaryError(403, "NPC 國家不使用全民皆兵");
    const state = await getMobilizationState(nation.id, tx);
    if (!state?.active) throw new MercenaryError(409, "全民皆兵目前沒有開啟");
    let disbanded = 0;
    let released = 0;
    if (nation.discordUserId && state.templateId) {
      const inField = await hasActiveCampaign(nation.id, tx);
      const [army] = await tx
        .select()
        .from(playerArmiesTable)
        .where(
          and(
            eq(playerArmiesTable.discordUserId, nation.discordUserId),
            eq(playerArmiesTable.templateId, state.templateId),
          ),
        )
        .for("update")
        .limit(1);
      if (army) {
        // 派駐前線中的兵力(軍團單位 + 傷兵池)不可解散。
        const reserved = inField ? await reservedInField(tx, nation.id, nation.discordUserId, state.templateId) : 0;
        const toDisband = Math.max(0, army.quantity - reserved);
        if (toDisband > 0) {
          const popRelease =
            toDisband >= army.quantity
              ? army.populationReserved
              : Math.min(army.populationReserved, Math.floor((army.populationReserved * toDisband) / army.quantity));
          if (toDisband >= army.quantity) {
            await tx.delete(playerArmiesTable).where(eq(playerArmiesTable.id, army.id));
          } else {
            await tx
              .update(playerArmiesTable)
              .set({
                quantity: sql`${playerArmiesTable.quantity} - ${toDisband}`,
                populationReserved: sql`GREATEST(0, ${playerArmiesTable.populationReserved} - ${popRelease})`,
                updatedAt: new Date(),
              })
              .where(eq(playerArmiesTable.id, army.id));
          }
          await tx
            .update(playerNationsTable)
            .set({ populationSpent: sql`GREATEST(0, ${playerNationsTable.populationSpent} - ${popRelease})` })
            .where(eq(playerNationsTable.id, nation.id));
          disbanded = toDisband;
          released = popRelease;
        }
      }
    }
    await tx
      .update(totalMobilizationStatesTable)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(totalMobilizationStatesTable.nationId, nation.id));
    return { disbanded, releasedPopulation: released };
  });
}

/** 派駐前線(進行中戰役軍團)+ 傷兵池中的某兵種數量,與軍事頁解散路由同口徑。 */
async function reservedInField(tx: Tx, nationId: string, userId: string, templateId: number): Promise<number> {
  const r = await tx.execute(sql`
    SELECT (
      COALESCE((
        SELECT SUM(wclu.quantity + wclu.wounded)::bigint
        FROM war_campaign_legion_units wclu
        JOIN war_campaign_legions wcl ON wcl.id = wclu.legion_id
        JOIN war_campaigns wc ON wc.id = wcl.campaign_id
        WHERE wcl.nation_id = ${nationId} AND wclu.template_id = ${templateId} AND wc.status = 'active'
      ), 0) + COALESCE((
        SELECT pwu.wounded FROM player_wounded_units pwu
        WHERE pwu.discord_user_id = ${userId} AND pwu.template_id = ${templateId}
      ), 0)
    )::bigint AS n`);
  return Number((r.rows[0] as { n: string | number } | undefined)?.n ?? 0);
}

/**
 * 解除武裝(全軍解散、資源全退)時同步關閉全民皆兵。disarmNation 已經解散全部軍隊並退人口,
 * 這裡只需把狀態標成關閉,避免殘留「開啟中」繼續扣穩定度。
 */
export async function markMobilizationStopped(nationId: string, ex: Executor = db): Promise<void> {
  await ex
    .update(totalMobilizationStatesTable)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(totalMobilizationStatesTable.nationId, nationId));
}

/**
 * 回合結算用:把「開啟中」的民兵模板校正成當前時代數值與 0 成本。
 *  - 民兵卡片寫「隨時代成長」,但模板原本只在開啟那一刻寫入,開著不會成長,也吃不到平衡調整。
 *  - 自癒:任何外部批次(遷移、管理員下限批次)若把民兵的維護費/生產力成本改成非 0,
 *    下一回合就會被改回 0,避免再出現「說不收維護費卻被收」。
 * 條件式 UPDATE(只在數值不同時寫入),沒有變化就不產生寫入。
 */
export async function syncActiveMilitiaTemplate(nationId: string, eraSlug: string, ex: Executor = db): Promise<void> {
  const state = await getMobilizationState(nationId, ex);
  if (!state?.active || state.templateId == null) return;
  const m = militiaStatsForEra(eraSlug);
  await ex
    .update(militaryUnitTemplatesTable)
    .set({
      eraSlug,
      hp: m.hp,
      attack: m.attack,
      defense: m.defense,
      speed: m.speed,
      accuracy: m.accuracy,
      range: m.range,
      description: `${m.label}:全民皆兵徵召的平民,量大質低,不占生產力、不收維護費`,
      prodCostPer100: 0,
      moneyCostPerUnit: 0,
      upkeepPerUnit: 0,
      prodUpkeepPerUnit: 0,
      woodCostPerUnit: 0,
      oreCostPerUnit: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(militaryUnitTemplatesTable.id, state.templateId),
        or(
          ne(militaryUnitTemplatesTable.hp, m.hp),
          ne(militaryUnitTemplatesTable.attack, m.attack),
          ne(militaryUnitTemplatesTable.defense, m.defense),
          ne(militaryUnitTemplatesTable.accuracy, m.accuracy),
          ne(militaryUnitTemplatesTable.eraSlug, eraSlug),
          ne(militaryUnitTemplatesTable.upkeepPerUnit, 0),
          ne(militaryUnitTemplatesTable.prodUpkeepPerUnit, 0),
          ne(militaryUnitTemplatesTable.prodCostPer100, 0),
        ),
      ),
    );
}

/**
 * 回合結算用:這個國家本回合該不該被扣全民皆兵穩定度,並累計統計。
 * 回傳負的穩定度增量(未開啟 → 0)。戰爭結束不會自動關閉(由玩家決定何時解散)。
 */
export async function tickMobilizationStability(nationId: string, ex: Executor = db): Promise<number> {
  const updated = await ex
    .update(totalMobilizationStatesTable)
    .set({
      totalStabilityLost: sql`${totalMobilizationStatesTable.totalStabilityLost} + ${MOBILIZATION_STABILITY_PER_TURN}`,
    })
    .where(and(eq(totalMobilizationStatesTable.nationId, nationId), eq(totalMobilizationStatesTable.active, true)))
    .returning({ nationId: totalMobilizationStatesTable.nationId });
  return updated.length > 0 ? -MOBILIZATION_STABILITY_PER_TURN : 0;
}
