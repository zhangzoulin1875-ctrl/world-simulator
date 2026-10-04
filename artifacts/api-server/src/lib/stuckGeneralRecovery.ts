import { sql } from "drizzle-orm";
import { db, generalsTable } from "@workspace/db";
import { logger } from "./logger";
import { buildFallbackGeneralCard, loadDominantCultureProfile } from "./generalAi";
import { isMilitaryCategory } from "./military";

/**
 * 「生成中」武將卡的開機回收。
 *
 * 抽取時池空會先發一張 status='generating' 的卡，AI 敘事交給「記憶體內」的背景
 * 任務（startBackgroundGeneralGeneration，最多重試約 65 秒後走備援卡）。但服務
 * 在背景任務完成前被殺（Render 免費版閒置休眠／重新部署）時，任務隨程序消失，
 * 卡片永遠停在 generating：前端把 generating 卡的按鈕 disabled，玩家既不能招募
 * 也不能解散，還白花一回合的抽取配額與 5% 國庫。
 *
 * 本函式在開機時把「停留超過 minAgeMs」的 generating 卡用不靠 AI 的備援卡原地補成
 * candidate。門檻遠大於背景任務正常耗時，不會搶在存活中的任務之前；更新一律帶
 * `WHERE status='generating'`，與背景任務、玩家解散互相 no-op，不會覆蓋別人的結果。
 */
export const STUCK_GENERATING_MIN_AGE_MS = 10 * 60 * 1000;

export async function recoverStuckGeneratingGenerals(
  minAgeMs: number = STUCK_GENERATING_MIN_AGE_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - minAgeMs);
  const stuck = await db
    .select({
      id: generalsTable.id,
      ownerNationId: generalsTable.ownerNationId,
      category: generalsTable.category,
      eraSlug: generalsTable.eraSlug,
    })
    .from(generalsTable)
    .where(
      sql`${generalsTable.status} = 'generating' AND ${generalsTable.createdAt} < ${cutoff.toISOString()}`,
    );

  let recovered = 0;
  for (const g of stuck) {
    try {
      const category = isMilitaryCategory(g.category) ? g.category : "infantry";
      const cultureProfile = await loadDominantCultureProfile(g.ownerNationId);
      const card = buildFallbackGeneralCard({
        eraSlug: g.eraSlug,
        category,
        cultureProfile,
      });
      const updated = await db
        .update(generalsTable)
        .set({
          name: card.name,
          title: card.title,
          background: card.background,
          skills: card.skills,
          status: "candidate",
        })
        .where(sql`${generalsTable.id} = ${g.id} AND ${generalsTable.status} = 'generating'`)
        .returning({ id: generalsTable.id });
      if (updated.length > 0) recovered += 1;
    } catch (err) {
      logger.warn({ err, generalId: g.id }, "stuck general recovery failed for one card");
    }
  }
  if (recovered > 0) {
    logger.info({ recovered, scanned: stuck.length }, "recovered stuck 'generating' generals with fallback cards");
  }
  return recovered;
}
