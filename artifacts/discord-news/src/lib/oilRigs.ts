/** 油井頁面的純邏輯(無 React),方便單元測試。 */

export interface OilRigView {
  slug: string; name: string; sea: string; lng: number; lat: number;
  holder: { nationId: string; name: string | null; color: string | null } | null;
  heldSince: string | null;
  anchorRegions: string[];
}
export interface OilLeaderboardRow { nationId: string; name: string; color: string | null; score: number; heldRigs: number; pointsPerHour: number }
export interface OilOverview {
  winScore: number; frozen: boolean;
  season: { id: number; season_number: number; status: string; winner_nation_name: string | null; winner_score: number | null } | null;
  rigs: OilRigView[]; leaderboard: OilLeaderboardRow[];
}
export interface OilCampaignView {
  id: number; rigSlug: string; status: string; startedAt: string; settleAt: string; outcome: string | null;
  attackerNationId: string; defenderNationId: string | null;
  attackerShips: number; defenderShips: number; attackerPower: number; defenderPower: number;
  forecast: "attacker_wins" | "defender_wins";
  /** 攻方距離衰減後的有效戰力係數(0.4~1);attackerPower 已含此係數。舊版後端沒有此欄,視為 1。 */
  rangeFactor?: number;
  /** 各攻方國家的進攻距離(km;null = 查無地區座標,按最遠算)與各自係數。 */
  attackerDistances?: Array<{ nationId: string; km: number | null; factor: number }>;
}

/** 出兵資格查詢結果。距離不是門檻,只是戰力衰減:合格時帶 distanceKm / rangeFactor。 */
export interface OilEligibility {
  eligible: boolean; reason?: string; message?: string;
  distanceKm?: number | null; rangeFactor?: number;
}
export interface ShipView { templateId: number; name: string; owned: number; committed: number; woundedPool: number; available: number }

/** 剩餘時間文字。已到期顯示「結算中」(排程每分鐘掃一次,最多晚一分鐘)。 */
export function formatCountdown(settleAt: string | Date, now: Date = new Date()): string {
  const ms = new Date(settleAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "結算中";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h <= 0) return `${m} 分鐘`;
  return m === 0 ? `${h} 小時` : `${h} 小時 ${m} 分`;
}

/** 這座油井目前的角色:我是持有者 / 我是攻方 / 無關。 */
export type MyRole = "holder" | "attacker" | "defender" | "none";
export function myRoleFor(rig: OilRigView, campaign: OilCampaignView | undefined, myNationId: string | null): MyRole {
  if (!myNationId) return "none";
  if (campaign && campaign.status === "active") {
    if (campaign.attackerNationId === myNationId) return "attacker";
    if (campaign.defenderNationId === myNationId) return "defender";
  }
  return rig.holder?.nationId === myNationId ? "holder" : "none";
}

/** 能對這座油井做的動作(UI 決定顯示哪個按鈕)。凍結時一律只讀。 */
export type RigAction = "none" | "attack" | "reinforce";
export function actionFor(role: MyRole, campaign: OilCampaignView | undefined, frozen: boolean): RigAction {
  if (frozen) return "none";
  const active = campaign?.status === "active";
  if (active && (role === "attacker" || role === "defender")) return "reinforce";
  if (active) return "none";          // 別人正在打,不能介入
  return role === "holder" ? "none" : "attack"; // 沒戰役:非持有者可發起
}

export interface FleetInput { [templateId: number]: string }

/**
 * 把表單輸入轉成送出的 fleet,並做與後端同口徑的前置檢查(後端仍是最終防線,這裡只為即時回饋)。
 * 空白視為 0;非整數/負數/超過可派量都回錯誤文字。
 */
export function buildFleetPayload(
  input: FleetInput, ships: readonly ShipView[],
): { ok: true; fleet: Array<{ templateId: number; quantity: number }>; total: number } | { ok: false; error: string } {
  const byId = new Map(ships.map((s) => [s.templateId, s]));
  const fleet: Array<{ templateId: number; quantity: number }> = [];
  for (const [k, raw] of Object.entries(input)) {
    const text = String(raw ?? "").trim();
    if (text === "") continue;
    if (!/^\d+$/.test(text)) return { ok: false, error: "數量必須是正整數" };
    const q = Number(text);
    if (!Number.isSafeInteger(q)) return { ok: false, error: "數量過大" };
    if (q === 0) continue;
    const ship = byId.get(Number(k));
    if (!ship) return { ok: false, error: "包含無法派遣的艦種" };
    if (q > ship.available) return { ok: false, error: `${ship.name} 最多可派 ${ship.available} 艘` };
    fleet.push({ templateId: ship.templateId, quantity: q });
  }
  if (fleet.length === 0) return { ok: false, error: "請至少投入 1 艘艦" };
  return { ok: true, fleet, total: fleet.reduce((s, f) => s + f.quantity, 0) };
}

export const OUTCOME_LABEL: Record<string, string> = { attacker_wins: "攻方勝", defender_wins: "守方勝" };
export const OIL_ERROR_HINT: Record<string, string> = {
  NO_NAVAL_TECH: "世界時代尚未解鎖海戰技術。",
  NO_COASTAL_REGION: "你沒有控制任何沿海地區。",
  RIG_OUT_OF_RANGE: "這座油井不在你沿海地區的航程內。",
  RIG_BUSY: "這座油井已有進行中的戰役。",
  SEASON_FROZEN: "本賽季已結束,遊戲凍結中。",
  TOO_LATE: "戰役即將結算,無法再追加。",
  BAD_COMMIT: "艦隊數量超過可派遣量。",
};


// ── 距離衰減顯示 ─────────────────────────────────────────

/** 後端的衰減下限(與 api-server oilRigCore.OIL_DISTANCE_MIN_FACTOR 一致;只用於分級顯示,不參與計算)。 */
export const RANGE_FLOOR = 0.4;

export type RangeTier = "none" | "light" | "heavy" | "max";

/**
 * 係數 → 折扣分級,決定提示的語氣與顏色:
 *  none  ≥ 0.9  幾乎沒折扣(近海)
 *  light ≥ 0.7  輕微
 *  heavy > 下限  明顯,出兵前應多派艦
 *  max   = 下限  已到最大折扣(再遠也不會更差)
 * 非有限或超出 [0,1] 的值保守視為 max(壞資料不要顯示成「沒折扣」誤導玩家)。
 */
export function rangeTier(factor: number | undefined | null): RangeTier {
  if (factor === undefined || factor === null) return "none"; // 舊後端沒回這欄:不顯示折扣
  if (!Number.isFinite(factor) || factor < 0 || factor > 1) return "max";
  if (factor >= 0.9) return "none";
  if (factor >= 0.7) return "light";
  if (factor > RANGE_FLOOR + 1e-9) return "heavy";
  return "max";
}

/** 係數 → 「戰力 ×N%」字串(四捨五入到整數百分比)。壞值回空字串由呼叫端處理。 */
export function formatRangePercent(factor: number | undefined | null): string {
  if (factor === undefined || factor === null || !Number.isFinite(factor) || factor < 0 || factor > 1) return "";
  return `${Math.round(factor * 100)}%`;
}

/** 距離 → 「約 N km」。null = 查無座標。千分位用半形逗號。 */
export function formatDistance(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km) || km < 0) return "距離未知";
  return `約 ${Math.round(km).toLocaleString("en-US")} 公里`;
}

/**
 * 出兵前的衰減說明(給資格通過後的攻擊面板)。沒有折扣(none)時回 null,不顯示。
 * 例:{ tier: "heavy", text: "距離約 7,064 公里,你的戰力只剩 65%。可多派艦補足。" }
 */
export function rangeNotice(elig: Pick<OilEligibility, "distanceKm" | "rangeFactor"> | undefined): { tier: RangeTier; text: string } | null {
  if (!elig) return null;
  const tier = rangeTier(elig.rangeFactor);
  if (tier === "none") return null;
  const pct = formatRangePercent(elig.rangeFactor);
  const where = elig.distanceKm === null || elig.distanceKm === undefined ? "查無你的地區座標,按最遠計算" : `距離${formatDistance(elig.distanceKm)}`;
  const tail = tier === "max" ? "已是最大折扣(再遠也不會更低)。" : "可多派艦補足。";
  return { tier, text: `${where},你的戰力只剩 ${pct || "—"}。${tail}` };
}
