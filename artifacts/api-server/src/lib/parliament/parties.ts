import { type ParliamentStance, type ParliamentTier, type PartyInput, STANCE_LABELS } from "./core";

/**
 * 規則式組黨（確定性、不靠 AI）：依國家現況給各立場「勢力權重」，
 * 再取最強的幾個立場成黨。AI 之後只負責黨名/敘述潤飾。
 */
export interface NationFacts {
  nationName: string;
  tier: ParliamentTier;
  /** 0–100 */
  stability: number;
  warWeariness: number;
  /** 軍方滿意度 0–100 */
  militarySatisfaction: number;
  atWar: boolean;
  /** 人口稅率(%) */
  taxRatePct: number;
  governmentSlug: string | null;
}

const PALETTE = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400", "#16a085"];

export function partyCountForTier(tier: ParliamentTier): number {
  return tier === "autocracy" ? 1 : tier === "semi" ? 3 : 5;
}

/** 數值消毒：非有限數回預設值，並夾在合理範圍，避免 NaN 一路污染權重與席次。 */
function num(v: number, dflt: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
}

export function stanceWeights(raw: NationFacts): Record<Exclude<ParliamentStance, "loyalist">, number> {
  const f: NationFacts = {
    ...raw,
    stability: num(raw.stability, 50, 0, 100),
    warWeariness: num(raw.warWeariness, 0, 0, 100),
    militarySatisfaction: num(raw.militarySatisfaction, 50, 0, 100),
    taxRatePct: num(raw.taxRatePct, 1, 0, 100),
  };
  const w: Record<Exclude<ParliamentStance, "loyalist">, number> = {
    militarist: 20, pacifist: 20, fiscal_hawk: 20, welfare: 20, religious: 15, secular: 15, mercantile: 20,
  };
  if (f.atWar) { w.militarist += 25; w.pacifist += Math.round(f.warWeariness / 3); }
  else w.pacifist += 10;
  w.militarist += Math.round((f.militarySatisfaction - 50) / 4);
  w.fiscal_hawk += Math.max(0, (f.taxRatePct - 1) * 6);
  w.welfare += Math.round((60 - f.stability) / 3);
  const slug = f.governmentSlug ?? "";
  if (slug === "theocracy") { w.religious += 40; w.secular -= 10; }
  if (slug === "plutocracy") { w.mercantile += 30; w.fiscal_hawk += 10; }
  if (slug === "socialist_council") { w.welfare += 30; w.mercantile -= 10; }
  if (slug === "aristocracy") { w.religious += 10; w.militarist += 10; }
  for (const k of Object.keys(w) as (keyof typeof w)[]) w[k] = Math.max(1, Math.round(w[k]));
  return w;
}

const NAME_SUFFIX = ["黨", "黨", "黨", "聯盟", "陣線", "黨"];

export function buildParties(f: NationFacts): PartyInput[] {
  if (f.tier === "autocracy") {
    return [{ id: "p0", name: `${f.nationName}愛國黨`, stance: "loyalist", weight: 1 }];
  }
  const n = partyCountForTier(f.tier);
  const ranked = (Object.entries(stanceWeights(f)) as [Exclude<ParliamentStance, "loyalist">, number][])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
  return ranked.map(([stance, weight], i) => ({
    id: `p${i}`,
    name: `${STANCE_LABELS[stance].replace(/派$/, "")}${NAME_SUFFIX[i % NAME_SUFFIX.length]}`,
    stance,
    weight,
  }));
}

export function partyColor(i: number): string { return PALETTE[i % PALETTE.length]!; }
