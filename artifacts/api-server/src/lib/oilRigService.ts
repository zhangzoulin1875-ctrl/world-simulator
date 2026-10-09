/**
 * 廢棄油井服務層:種子、開季、計分結算、結束賽季。
 * 計分結算在單一交易內鎖定 active 賽季列(FOR UPDATE),
 * 並行呼叫(回合引擎 + 管理員手動)只會有一個真正計分,不會重複加分。
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { OIL_RIG_SEEDS } from "./oilRigSeeds";
import { OIL_WIN_SCORE, hoursBetween, scoreGain, pickWinner } from "./oilRigCore";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 確保 16 座油井存在(只補缺,不覆寫持有者與守軍強度)。冪等。 */
export async function seedOilRigs(): Promise<number> {
  let added = 0;
  for (const r of OIL_RIG_SEEDS) {
    const res = await db.execute(sql`
      INSERT INTO oil_rigs (slug, name, sea, lng, lat)
      VALUES (${r.slug}, ${r.name}, ${r.sea}, ${r.lng}, ${r.lat})
      ON CONFLICT (slug) DO NOTHING
    `);
    added += Number((res as { rowCount?: number }).rowCount ?? 0);
  }
  return added;
}

/** 確保存在一個賽季(沒有任何賽季時開第 1 季)。冪等,並行安全(部分唯一索引兜底)。 */
export async function ensureFirstSeason(now: Date = new Date()): Promise<void> {
  await db.execute(sql`
    INSERT INTO oil_seasons (season_number, status, started_at, last_scored_at)
    SELECT 1, 'active', ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    WHERE NOT EXISTS (SELECT 1 FROM oil_seasons)
    ON CONFLICT DO NOTHING
  `);
}

export interface OilScoreResult {
  scored: boolean;
  reason?: "no_active_season" | "already_scored";
  hours?: number;
  gains?: { nationId: string; heldCount: number; gain: number; score: number }[];
  winner?: { nationId: string; nationName: string | null; score: number } | null;
}

/**
 * 一次計分結算。`now` 可注入以利測試。
 *  1. 鎖定 active 賽季,算出距 last_scored_at 的小時數(有上限、時鐘倒退不扣分)。
 *  2. 依各國目前佔領數加分,upsert 進 oil_scores。
 *  3. 前進 last_scored_at(無論有無加分,避免下次重複補算同一段時間)。
 *  4. 若有人 ≥ 10000:同一交易內結束賽季(寫勝者快照、轉 cooldown)。
 */
export async function settleOilScores(now: Date = new Date()): Promise<OilScoreResult> {
  const nowIso = now.toISOString();
  return db.transaction(async (tx: Tx) => {
    const seasonRows = await tx.execute(sql`
      SELECT id, last_scored_at FROM oil_seasons WHERE status = 'active' FOR UPDATE
    `);
    const season = (seasonRows.rows as { id: number; last_scored_at: string | Date }[])[0];
    if (!season) return { scored: false, reason: "no_active_season" } as OilScoreResult;

    const prev = new Date(season.last_scored_at);
    const hours = hoursBetween(prev, now);

    // 「認領」這段時間:compare-and-swap。只有把 last_scored_at 從我讀到的舊值換成新值的那個呼叫
    // 能繼續計分;並行的其他呼叫會因舊值已被換掉而得到 0 列,直接放棄。
    // 這不依賴 FOR UPDATE 的鎖語意,在任何隔離層級與連線模型下都正確。
    // hours = 0(時鐘倒退或同一時刻)時不前進時間,避免把 last_scored_at 往回拉造成日後重複補算。
    if (hours <= 0) return { scored: true, hours: 0, gains: [], winner: null };
    const claim = await tx.execute(sql`
      UPDATE oil_seasons SET last_scored_at = ${nowIso}::timestamptz
      WHERE id = ${season.id} AND status = 'active' AND last_scored_at = ${prev.toISOString()}::timestamptz
      RETURNING id
    `);
    if (claim.rows.length === 0) return { scored: false, reason: "already_scored" } as OilScoreResult;

    const heldRows = await tx.execute(sql`
      SELECT holder_nation_id AS nation_id, count(*)::int AS held
      FROM oil_rigs WHERE holder_nation_id IS NOT NULL GROUP BY holder_nation_id
    `);
    const gains: NonNullable<OilScoreResult["gains"]> = [];
    for (const row of heldRows.rows as { nation_id: string; held: number }[]) {
      const gain = scoreGain(row.held, hours);
      if (gain <= 0) continue;
      const up = await tx.execute(sql`
        INSERT INTO oil_scores (season_id, nation_id, score, reached_at)
        VALUES (${season.id}, ${row.nation_id}::uuid, ${gain}, ${nowIso}::timestamptz)
        ON CONFLICT (season_id, nation_id)
        DO UPDATE SET score = oil_scores.score + EXCLUDED.score, reached_at = EXCLUDED.reached_at
        RETURNING score
      `);
      gains.push({ nationId: row.nation_id, heldCount: row.held, gain, score: Number((up.rows[0] as { score: number }).score) });
    }

    const scoreRows = await tx.execute(sql`
      SELECT nation_id, score, reached_at FROM oil_scores WHERE season_id = ${season.id} AND score >= ${OIL_WIN_SCORE}
    `);
    const winnerId = pickWinner(
      (scoreRows.rows as { nation_id: string; score: number; reached_at: string | Date }[]).map((r) => ({
        nationId: r.nation_id, score: Number(r.score), reachedAt: new Date(r.reached_at),
      })),
    );
    if (!winnerId) return { scored: true, hours, gains, winner: null };

    const winnerScore = Number((scoreRows.rows as { nation_id: string; score: number }[]).find((r) => r.nation_id === winnerId)!.score);
    const nameRow = await tx.execute(sql`SELECT name FROM player_nations WHERE id = ${winnerId}::uuid`);
    const nationName = (nameRow.rows[0] as { name?: string | null } | undefined)?.name ?? null;
    await tx.execute(sql`
      UPDATE oil_seasons SET status = 'cooldown', ended_at = ${nowIso}::timestamptz,
        winner_nation_id = ${winnerId}::uuid, winner_nation_name = ${nationName}, winner_score = ${winnerScore}
      WHERE id = ${season.id}
    `);
    return { scored: true, hours, gains, winner: { nationId: winnerId, nationName, score: winnerScore } };
  });
}


// ── 賽季凍結 ────────────────────────────────────────────────
// 達 10000 分後賽季進入 cooldown:玩家只能看榜單與地圖,不能操作,等管理員手動重置。
// 這是遊戲規則,不是便利功能,所以查詢失敗時「沿用上一次已知狀態」而不是放行。
const FROZEN_CACHE_MS = 5_000;
let frozenCache: { value: boolean; at: number } | null = null;

export function _resetFrozenCacheForTest(): void { frozenCache = null; }

/** 目前是否處於賽季凍結(最新賽季為 cooldown)。5 秒快取;查詢失敗沿用上次已知值,從未成功過則視為未凍結。 */
export async function isSeasonFrozen(nowMs: number = Date.now()): Promise<boolean> {
  if (frozenCache && nowMs - frozenCache.at < FROZEN_CACHE_MS) return frozenCache.value;
  try {
    const r = await db.execute(sql`SELECT status FROM oil_seasons ORDER BY season_number DESC LIMIT 1`);
    const value = (r.rows[0] as { status?: string } | undefined)?.status === "cooldown";
    frozenCache = { value, at: nowMs };
    return value;
  } catch {
    return frozenCache?.value ?? false;
  }
}

export interface ResetResult { ok: boolean; error?: string; seasonNumber?: number }

/**
 * 管理員手動重置:只有 cooldown 才能重置。開下一季(seasonNumber+1),
 * 所有油井歸為無人佔領,國家與地圖「保留不動」。重置範圍刻意只到油井與積分。
 */
export async function resetOilSeason(now: Date = new Date()): Promise<ResetResult> {
  const nowIso = now.toISOString();
  const result = await db.transaction(async (tx: Tx): Promise<ResetResult> => {
    const cur = await tx.execute(sql`SELECT id, season_number, status FROM oil_seasons ORDER BY season_number DESC LIMIT 1 FOR UPDATE`);
    const row = cur.rows[0] as { id: number; season_number: number; status: string } | undefined;
    if (!row) return { ok: false, error: "尚無賽季" };
    if (row.status !== "cooldown") return { ok: false, error: "賽季尚未結束,不能重置" };
    const next = row.season_number + 1;
    // 部分唯一索引保證不會同時有兩個 active;並行重置時第二個會撞 season_number 唯一索引而失敗
    const ins = await tx.execute(sql`
      INSERT INTO oil_seasons (season_number, status, started_at, last_scored_at)
      VALUES (${next}, 'active', ${nowIso}::timestamptz, ${nowIso}::timestamptz)
      ON CONFLICT (season_number) DO NOTHING RETURNING id
    `);
    if (ins.rows.length === 0) return { ok: false, error: "賽季已被重置" };
    await tx.execute(sql`UPDATE oil_rigs SET holder_nation_id = NULL, held_since = NULL`);
    return { ok: true, seasonNumber: next };
  });
  frozenCache = null; // 立刻解凍,不等快取過期
  return result;
}

// ── 油井艦隊鎖定 ────────────────────────────────────────────
type Q = Pick<typeof db, "execute">;

/**
 * 某國在「進行中油井戰役」中被鎖定的艦數(依兵種模板)。
 * 陸戰的「可派遣量」要把這個也算進「已佔用」,否則同一艘船能陸戰、油井各出一次。
 * 只算 status='active':戰役結算或取消後立刻釋放。
 * 接受 tx 或 db,讓陸戰交易內讀到一致視圖。
 *
 * 刻意不吞錯誤:啟動時遷移全部完成才開始服務,表必定存在。若真的缺表,大聲失敗比靜默放行
 * 重複派兵安全;而且在交易內吞錯誤會留下 aborted 的交易,更難除錯。
 */
export async function oilLockedByTemplate(nationId: string, q: Q = db): Promise<Map<number, number>> {
  const r = await q.execute(sql`
    SELECT f.template_id AS template_id, SUM(f.quantity)::text AS total
    FROM oil_campaign_fleets f
    JOIN oil_campaigns c ON c.id = f.campaign_id
    WHERE f.nation_id = ${nationId}::uuid AND c.status = 'active'
    GROUP BY f.template_id
  `);
  const m = new Map<number, number>();
  for (const row of r.rows as Array<{ template_id: number; total: string }>) m.set(Number(row.template_id), Number(row.total));
  return m;
}
