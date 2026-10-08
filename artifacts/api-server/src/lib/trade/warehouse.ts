/**
 * 貿易系統 — 倉庫報告(純函式、DB-free,階段 2 倉庫頁用)。
 *
 * 輸入:國家目前的木材/礦石(player_nations 欄位)、nation_goods 庫存、
 * 控制的地區(名稱+比例)、stats 時代。輸出:每種貨物的庫存、每回合產量、
 * 產量來源地區。每回合產量重用 production.ts 的同一套計算,所以頁面顯示
 * 的「每回合 +N」必然等於回合引擎實際入帳的量(與 1-C 糧食同一原則)。
 *
 * 糧食不在此:它有自己的結算(腐敗/上限/饑荒)與專屬頁籤,倉庫只放連結。
 */
import { GOODS, GOOD_SLUGS, type GoodSlug } from "./goods";
import { isGoodUnlocked } from "./stock";
import {
  regionSpecialtyOutput,
  nationSpecialtyOutput,
  type ControlledRegion,
  type SpecialtyGood,
} from "./production";

export interface WarehouseSource {
  regionName: string;
  /** 控制比例 0–100。 */
  percent: number;
  /** 該地區對此貨物的每回合產量(已套比例與解鎖)。 */
  perTurn: number;
  /** 是否主產(強度 3)。 */
  major: boolean;
}

export interface WarehouseGood {
  slug: Exclude<GoodSlug, "food">;
  label: string;
  tier: "basic" | "industrial" | "luxury";
  /** 目前庫存。 */
  stock: number;
  /** 每回合特產入帳量(已套解鎖)。 */
  perTurn: number;
  /** false = 目前時代尚未解鎖(例如工業前的石油),產量固定 0。 */
  unlocked: boolean;
  /** 解鎖時代 slug,無限制為 null。 */
  unlockEra: string | null;
  /** 產量來源(由大到小)。 */
  sources: WarehouseSource[];
}

export interface WarehouseInput {
  wood: number;
  ore: number;
  /** nation_goods 內的庫存(不含 food 也可)。 */
  goods: Partial<Record<GoodSlug, number>>;
  regions: readonly ControlledRegion[];
  statsEra: string;
  baseOutput?: number;
}

function nonNeg(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export function buildWarehouse(input: WarehouseInput): WarehouseGood[] {
  const total = nationSpecialtyOutput(input.regions, input.statsEra, input.baseOutput);
  const out: WarehouseGood[] = [];

  for (const slug of GOOD_SLUGS) {
    if (slug === "food") continue;
    const def = GOODS[slug];
    const good = slug as SpecialtyGood;
    const stock =
      slug === "wood" ? nonNeg(input.wood)
      : slug === "ore" ? nonNeg(input.ore)
      : nonNeg(input.goods[slug]);

    const sources: WarehouseSource[] = [];
    for (const r of input.regions) {
      const o = regionSpecialtyOutput(r, input.statsEra, input.baseOutput);
      const perTurn = o[good] ?? 0;
      if (perTurn <= 0) continue;
      sources.push({
        regionName: r.name,
        percent: Math.min(100, Math.max(0, Math.round(r.percent))),
        perTurn,
        // 主產 = 全控時為強度 3 × 基準量;用「滿控產量」判斷避免被比例影響。
        major:
          (regionSpecialtyOutput({ name: r.name, percent: 100 }, input.statsEra, input.baseOutput)[good] ?? 0) >=
          3 * (input.baseOutput ?? 10),
      });
    }
    sources.sort((a, b) => b.perTurn - a.perTurn || a.regionName.localeCompare(b.regionName));

    out.push({
      slug: slug as WarehouseGood["slug"],
      label: def.label,
      tier: def.tier,
      stock,
      perTurn: nonNeg(total[good]),
      unlocked: isGoodUnlocked(slug, input.statsEra),
      unlockEra: def.unlockEra,
      sources,
    });
  }
  return out;
}
