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

/** 超過此距離（viewBox 單位）的戰線視為「遠程」，改畫弧線並截短。 */
export const LONG_FRONT_DIST = 120;
/** 遠程戰線最多畫出的長度（從攻方端算起），避免橫貫整張地圖。 */
export const LONG_FRONT_MAX_LEN = 150;

export interface ArcGeometry {
  /** 是否為弧線（false = 直線，沿用 computeArrow 的結果）。 */
  curved: boolean;
  /** SVG path d（直線時為 "M..L.."，弧線為二次貝茲 "M..Q.."）。 */
  d: string;
  headTipX: number;
  headTipY: number;
  headLeftX: number;
  headLeftY: number;
  headRightX: number;
  headRightY: number;
  /** 標籤錨點（曲線上 t=0.5 處）。 */
  midX: number;
  midY: number;
  /** 實際畫出的曲線是否被截短（遠程）。 */
  truncated: boolean;
}

/**
 * 戰線幾何：近距離用直線箭頭；遠距離（跨海登陸等）改成向上彎的弧線，
 * 並只畫從攻方端算起的前一段，尾端箭頭仍指向守方方向。
 * 皆為 viewBox 單位；trim/headLen 為上限（同 computeArrow）。
 * 輸入非有限數或兩點重合回傳 null。
 */
export function computeFrontPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  trim: number,
  headLen: number,
): ArcGeometry | null {
  if (![x1, y1, x2, y2, trim, headLen].every(Number.isFinite)) return null;
  const dist = Math.hypot(x2 - x1, y2 - y1);
  if (dist < 1e-6) return null;

  if (dist <= LONG_FRONT_DIST) {
    const a = computeArrow(x1, y1, x2, y2, trim, headLen);
    if (!a) return null;
    return {
      curved: false,
      d: `M${a.x1},${a.y1} L${a.x2},${a.y2}`,
      headTipX: a.x2,
      headTipY: a.y2,
      headLeftX: a.headLeftX,
      headLeftY: a.headLeftY,
      headRightX: a.headRightX,
      headRightY: a.headRightY,
      midX: a.midX,
      midY: a.midY,
      truncated: false,
    };
  }

  // 完整弧線的控制點：連線中點，垂直方向往「畫面上方」偏移
  const ux = (x2 - x1) / dist;
  const uy = (y2 - y1) / dist;
  let nx = -uy;
  let ny = ux;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const bulge = Math.min(dist * 0.22, 70);
  const cx = (x1 + x2) / 2 + nx * bulge;
  const cy = (y1 + y2) / 2 + ny * bulge;

  const bez = (t: number): [number, number] => {
    const m = 1 - t;
    return [
      m * m * x1 + 2 * m * t * cx + t * t * x2,
      m * m * y1 + 2 * m * t * cy + t * t * y2,
    ];
  };
  const tan = (t: number): [number, number] => {
    const dx = 2 * (1 - t) * (cx - x1) + 2 * t * (x2 - cx);
    const dy = 2 * (1 - t) * (cy - y1) + 2 * t * (y2 - cy);
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };

  // 截短：只畫到曲線上 t = tEnd 處（約 LONG_FRONT_MAX_LEN 長），起點略內縮
  const tEnd = Math.min(1, LONG_FRONT_MAX_LEN / (dist * 1.12));
  const tStart = Math.min(0.04, tEnd / 4);
  // 子曲線（de Casteljau 分割）：從 tStart 到 tEnd 的二次貝茲
  const p0 = bez(tStart);
  const pe = bez(tEnd);
  // 子曲線控制點 = 在 [tStart,tEnd] 區間的切線交點；以中點切線外推
  const tm = (tStart + tEnd) / 2;
  const pm = bez(tm);
  const qx = 2 * pm[0] - (p0[0] + pe[0]) / 2;
  const qy = 2 * pm[1] - (p0[1] + pe[1]) / 2;

  const [tx, ty] = tan(tEnd);
  const total = Math.hypot(pe[0] - p0[0], pe[1] - p0[1]);
  const h = Math.min(Math.max(headLen, 0), total * 0.3);
  const ang = Math.PI / 7;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const bx = -tx;
  const by = -ty;
  const mid = bez(tm);
  return {
    curved: true,
    d: `M${p0[0]},${p0[1]} Q${qx},${qy} ${pe[0]},${pe[1]}`,
    headTipX: pe[0],
    headTipY: pe[1],
    headLeftX: pe[0] + h * (bx * cos - by * sin),
    headLeftY: pe[1] + h * (bx * sin + by * cos),
    headRightX: pe[0] + h * (bx * cos + by * sin),
    headRightY: pe[1] + h * (-bx * sin + by * cos),
    midX: mid[0],
    midY: mid[1],
    truncated: tEnd < 1,
  };
}

/** 戰線標籤文字：「攻方 → 守方」。國名空白時以「?」代替，不顯示 undefined。 */
export function warFrontLabel(f: Pick<WarFront, "attackerNationName" | "defenderNationName">): string {
  const a = f.attackerNationName.trim() || "?";
  const d = f.defenderNationName.trim() || "?";
  return `${a} → ${d}`;
}
