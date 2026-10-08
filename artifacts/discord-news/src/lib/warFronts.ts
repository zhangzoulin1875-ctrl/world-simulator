/**
 * 戰線可視化（地圖）：把進行中戰役轉成「攻方地區 → 守方地區」的箭頭資料。
 * 純函式、不依賴 React，方便單元測試。
 */

export interface WarCampaignInput {
  id: number;
  attackerRegionId: number;
  defenderRegionId: number;
  attackerNationName: string;
  defenderNationName: string;
}

export interface WarFront {
  id: number;
  attackerRegionName: string;
  defenderRegionName: string;
  attackerNationName: string;
  defenderNationName: string;
}

/**
 * 以 regionId → 地區名稱 的對照，把戰役轉成戰線。
 * 任一端找不到地區的戰役會被略過（不丟錯、不畫半截箭頭）；
 * 兩端為同一地區的戰役也略過（無方向可畫）。
 */
export function buildWarFronts(
  campaigns: readonly WarCampaignInput[],
  regionNameById: ReadonlyMap<number, string>,
): WarFront[] {
  const out: WarFront[] = [];
  for (const c of campaigns) {
    const a = regionNameById.get(c.attackerRegionId);
    const d = regionNameById.get(c.defenderRegionId);
    if (!a || !d || a === d) continue;
    out.push({
      id: c.id,
      attackerRegionName: a,
      defenderRegionName: d,
      attackerNationName: c.attackerNationName,
      defenderNationName: c.defenderNationName,
    });
  }
  return out;
}

export interface ArrowGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 箭頭尖端兩側的點（在 x2,y2 附近）。 */
  headLeftX: number;
  headLeftY: number;
  headRightX: number;
  headRightY: number;
  midX: number;
  midY: number;
}

/**
 * 計算從 (x1,y1) 指向 (x2,y2) 的箭頭幾何。
 * trim：起訖兩端各向內縮的「上限」；實際內縮不超過兩點距離的 18%，
 *   相鄰小區（中心很近）因此不會被吃光，仍保有可見的線段。
 * headLen：箭頭尖兩翼長度「上限」；實際不超過線段長度的 45%。
 * 皆為 viewBox 單位（呼叫端自行除以縮放 k）。
 * 兩點完全重合或輸入非有限數回傳 null，避免畫出反向或 NaN 的箭頭。
 */
export function computeArrow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  trim: number,
  headLen: number,
): ArrowGeometry | null {
  if (![x1, y1, x2, y2, trim, headLen].every(Number.isFinite)) return null;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  const t = Math.min(Math.max(trim, 0), len * 0.18);
  const sx = x1 + ux * t;
  const sy = y1 + uy * t;
  const ex = x2 - ux * t;
  const ey = y2 - uy * t;
  const shaft = len - 2 * t;
  const h = Math.min(Math.max(headLen, 0), shaft * 0.45);
  const ang = Math.PI / 7;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const bx = -ux;
  const by = -uy;
  return {
    x1: sx,
    y1: sy,
    x2: ex,
    y2: ey,
    headLeftX: ex + h * (bx * cos - by * sin),
    headLeftY: ey + h * (bx * sin + by * cos),
    headRightX: ex + h * (bx * cos + by * sin),
    headRightY: ey + h * (-bx * sin + by * cos),
    midX: (sx + ex) / 2,
    midY: (sy + ey) / 2,
  };
}

/** 戰線標籤文字：「攻方 → 守方」。國名空白時以「?」代替，不顯示 undefined。 */
export function warFrontLabel(f: Pick<WarFront, "attackerNationName" | "defenderNationName">): string {
  const a = f.attackerNationName.trim() || "?";
  const d = f.defenderNationName.trim() || "?";
  return `${a} → ${d}`;
}
