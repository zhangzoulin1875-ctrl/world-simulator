import { eq } from "drizzle-orm";
import { db, playerNationsTable, type PlayerNation } from "@workspace/db";
import { generatePoliticalNote } from "./politicsAi";
import { getCurrentEraSlug } from "./nationStats";
import { buildNationGeoCultureContext } from "./nationGeoCulture";
import { logger } from "./logger";

/**
 * Task #127 — 政治註記懶惰生成（共用）。
 *
 * note 為 null 時依政體／時代生成並持久化，回傳最終 note；AI 失敗回 null
 * （呼叫端下次再重試），絕不中斷流程。
 *
 * 預設只為「有主玩家國家」生成（政治總覽用——NPC 不會看政治頁）；外交模擬
 * 需要 NPC 自身的治理風格作為決策脈絡，故以 allowNpc 讓 NPC 也生成一次並
 * 快取於 political_note 欄位，後續外交回覆沿用。
 */
export async function ensurePoliticalNote(
  nation: PlayerNation,
  opts: { allowNpc?: boolean } = {},
): Promise<string | null> {
  if (nation.politicalNote !== null) return nation.politicalNote;
  if (nation.discordUserId === null && !opts.allowNpc) return null;
  try {
    const geoContext = await buildNationGeoCultureContext(nation.id);
    const note = await generatePoliticalNote({
      government: nation.government,
      eraSlug: await getCurrentEraSlug(),
      nationName: nation.name,
      leaderName: nation.leaderName,
      geoContext,
    });
    await db
      .update(playerNationsTable)
      .set({ politicalNote: note })
      .where(eq(playerNationsTable.id, nation.id));
    return note;
  } catch (err) {
    logger.error(
      { err, nationId: nation.id },
      "lazy political note generation failed — will retry next call",
    );
    return null;
  }
}
