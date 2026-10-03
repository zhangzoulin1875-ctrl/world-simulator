/**
 * 跨路由／服務共用的 advisory-lock 命名空間常數。
 *
 * 同一資源必須用同一把鎖，否則不同寫入路徑各鎖各的，等於沒鎖。集中在此避免
 * magic number 漂移。
 */

/**
 * 地區認領鎖：`pg_advisory_xact_lock(REGION_CLAIM_LOCK_NS, regionId)`。
 *
 * 建國（`routes/player.ts`）與 AI 世界寫入（`lib/worldSimApply.ts`）對「同一地區」
 * 的掌控變更皆須先取得此鎖，序列化以避免單一地區 Σ(percent) > 100 的競態
 * （否則每小時 regionControlHealth 等比縮減時會連玩家的份額一起縮，間接違反
 * 「AI 絕不更動玩家領土」的硬性規則）。
 */
export const REGION_CLAIM_LOCK_NS = 42_030;

/**
 * 聯盟成員鎖：`pg_advisory_xact_lock(ALLIANCE_LOCK_NS, hashtext(nationId))`。
 *
 * 建立／加入／退出／踢除／解散聯盟時，對「涉及的國家」序列化，避免併發下同一國家
 * 同時被寫入兩個聯盟、或創始國移交與退出交錯造成孤兒聯盟。最終的「一國一聯盟」
 * 不變量仍由 alliance_members.nation_id 唯一索引保證（乾淨 409）；此鎖降低競態窗口。
 */
export const ALLIANCE_LOCK_NS = 42_031;
