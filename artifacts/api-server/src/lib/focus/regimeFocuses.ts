import { GOVERNMENTS } from "../governments";
import { AUTOCRACY_RED_REVOLUTION_LAND_SHARE, REGIME_EDGES, type RegimeEdge } from "./regimeGraph";
import type { FocusCondition, FocusDef, FocusEffect } from "./types";

/** 政體分類:決定轉型的代價與條件。 */
const AUTOCRATIC = new Set(["absolute_monarchy", "military_dictatorship", "theocracy", "socialist_council"]);
const DEMOCRATIC = new Set([
  "parliamentary",
  "parliamentary_republic",
  "presidential_democracy",
  "constitutional_monarchy",
  "council_system",
]);

const labelOf = (slug: string) => GOVERNMENTS.find((g) => g.slug === slug)?.label ?? slug;

/** 依軌道決定成本與回合(極端轉型更貴更慢)。 */
function costAndTurns(track: RegimeEdge["track"]): { cost: number; turns: number } {
  switch (track) {
    case "stable": return { cost: 9, turns: 5 };
    case "reform": return { cost: 13, turns: 7 };
    case "red": return { cost: 20, turns: 9 };
    case "black": return { cost: 21, turns: 10 };
  }
}

/** 客觀門檻(取代舊「接受度」):轉型必須有社會基礎。 */
function conditionsFor(edge: RegimeEdge): FocusCondition[] {
  switch (edge.track) {
    case "black":
      return [
        { kind: "leanAtLeast", side: "black", value: 50 },
        { kind: "militarySatisfactionAtLeast", value: 55 },
      ];
    case "red":
      return [
        { kind: "leanAtLeast", side: "red", value: 50 },
        { kind: "stabilityAtMost", value: 60 },
      ];
    case "reform":
      return [{ kind: "politicalSupportAtLeast", value: 55 }];
    case "stable":
      return [{ kind: "stabilityAtLeast", value: 40 }];
  }
}

/**
 * 轉型代價(每個國策必有至少一項,validateCatalog 會強制):
 *  - 走向集權:議會不滿(議會被架空)
 *  - 走向民主:軍方不滿(失去特權)
 *  - 極端路線另加穩定度與金錢(政局動盪、重整成本)
 */
function costEffectsFor(edge: RegimeEdge): FocusEffect[] {
  const out: FocusEffect[] = [];
  const toAutocratic = AUTOCRATIC.has(edge.to) && !AUTOCRATIC.has(edge.from);
  const toDemocratic = DEMOCRATIC.has(edge.to) && !DEMOCRATIC.has(edge.from);
  if (toAutocratic) out.push({ kind: "parliamentSatisfaction", value: -12 });
  else if (toDemocratic) out.push({ kind: "militarySatisfaction", value: -10 });
  else out.push({ kind: "grant", stat: "politicalSupport", value: -8 });

  if (edge.track === "black" || edge.track === "red") {
    out.push({ kind: "grant", stat: "stability", value: -12 });
    out.push({ kind: "grant", stat: "money", value: -1200 });
  } else if (edge.track === "reform") {
    out.push({ kind: "grant", stat: "money", value: -600 });
  }
  return out;
}

function toFocus(edge: RegimeEdge): FocusDef {
  const { cost, turns } = costAndTurns(edge.track);
  const from = labelOf(edge.from);
  const to = labelOf(edge.to);
  return {
    id: edge.focusId,
    domain: "regime",
    track: edge.track,
    slot: "main",
    title: `${from}轉${to}`,
    description: `推動國家由「${from}」轉型為「${to}」。這是一場牽動整個國家機器的改制,需要足夠的社會基礎,並承擔相應的政治代價。`,
    cost,
    turns,
    requires: [],
    governments: [edge.from],
    conditions: conditionsFor(edge),
    milestone: true,
    effects: [{ kind: "transition", toGovernment: edge.to }, ...costEffectsFor(edge)],
  };
}

/** 共產革命的國策 id:全系統唯一的革命入口(不屬於政體圖,任何政體的樹上都固定顯示) */
export const COMMUNIST_REVOLUTION_ID = "regime.communist_revolution";
/** 共產革命的政治點數成本(最貴的一個轉型國策,約為黑線的 1.4 倍) */
export const COMMUNIST_REVOLUTION_COST = 30;

/** 已經是紅線終點的政體,不需要再革命。 */
export const REVOLUTION_EXCLUDED_GOVERNMENTS: readonly string[] = ["council_system", "socialist_council"];

/**
 * 共產革命(2026-10-05 定案:和平改政體與革命分開)。
 * 不是政體圖的邊,而是獨立的通用國策:任何政體都能發動。
 * 完成後不換政體,而是由玩家當革命方開內戰,只留 35% 土地;打贏才改制為委員會制。
 */
export function buildCommunistRevolutionFocus(): FocusDef {
  const pct = Math.round(AUTOCRACY_RED_REVOLUTION_LAND_SHARE * 100);
  return {
    id: COMMUNIST_REVOLUTION_ID,
    domain: "regime",
    track: "red",
    slot: "main",
    title: "共產革命",
    description: `發動共產革命,推翻現有政權。革命政權只能掌握約 ${pct}% 的土地並與舊政權展開內戰,雙方不會停戰,直到一方被完全消滅。打贏後國家改制為委員會制;這是代價最高的一條路。`,
    cost: COMMUNIST_REVOLUTION_COST,
    turns: 12,
    requires: [],
    // 不設 governments = 任何政體(紅線終點用 REVOLUTION_EXCLUDED_GOVERNMENTS 在 view 層略過)
    conditions: [
      { kind: "leanAtLeast", side: "red", value: 65 },
      { kind: "stabilityAtMost", value: 45 },
    ],
    milestone: true,
    effects: [
      { kind: "revolution", ideology: "red", landShare: AUTOCRACY_RED_REVOLUTION_LAND_SHARE },
      // 革命 = 內戰:穩定度崩盤、資金被戰時徵用、軍方動搖
      { kind: "grant", stat: "stability", value: -20 },
      { kind: "grant", stat: "money", value: -2000 },
      { kind: "militarySatisfaction", value: -15 },
    ],
  };
}

/** 由政體圖產生全部轉型國策(圖和國策因此不可能不同步),再加上獨立的共產革命。 */
export function buildRegimeFocuses(edges: readonly RegimeEdge[] = REGIME_EDGES): FocusDef[] {
  return [...edges.map(toFocus), buildCommunistRevolutionFocus()];
}
