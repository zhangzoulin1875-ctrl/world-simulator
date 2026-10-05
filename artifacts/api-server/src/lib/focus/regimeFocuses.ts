import { GOVERNMENTS } from "../governments";
import { REGIME_EDGES, type RegimeEdge } from "./regimeGraph";
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
function costAndTurns(track: RegimeEdge["track"], revolution = false): { cost: number; turns: number } {
  if (revolution) return { cost: 45, turns: 12 }; // 獨裁國家的紅色革命:最貴最慢
  switch (track) {
    case "stable": return { cost: 14, turns: 5 };
    case "reform": return { cost: 20, turns: 7 };
    case "red": return { cost: 30, turns: 9 };
    case "black": return { cost: 32, turns: 10 };
  }
}

/** 客觀門檻(取代舊「接受度」):轉型必須有社會基礎。 */
function conditionsFor(edge: RegimeEdge): FocusCondition[] {
  if (edge.revolution) {
    // 獨裁下要真的民怨沸騰、紅線思潮壓過政權才敢起事
    return [
      { kind: "leanAtLeast", side: "red", value: 65 },
      { kind: "stabilityAtMost", value: 45 },
    ];
  }
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
  if (edge.revolution) {
    // 革命 = 內戰:穩定度崩盤、資金被戰時徵用,且只拿得到一部分土地
    return [
      { kind: "grant", stat: "stability", value: -20 },
      { kind: "grant", stat: "money", value: -2000 },
      { kind: "militarySatisfaction", value: -15 },
    ];
  }
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
  const { cost, turns } = costAndTurns(edge.track, !!edge.revolution);
  const from = labelOf(edge.from);
  const to = labelOf(edge.to);
  return {
    id: edge.focusId,
    domain: "regime",
    track: edge.track,
    slot: "main",
    title: `${from}轉${to}`,
    description: edge.revolution
      ? `發動共產革命,推翻「${from}」。革命政權只能掌握約 ${Math.round(edge.revolution.landShare * 100)}% 的土地並與舊政權展開內戰,雙方不會停戰,直到一方被完全消滅。這是代價最高的一條路。`
      : `推動國家由「${from}」轉型為「${to}」。這是一場牽動整個國家機器的改制,需要足夠的社會基礎,並承擔相應的政治代價。`,
    cost,
    turns,
    requires: [],
    governments: [edge.from],
    conditions: conditionsFor(edge),
    milestone: true,
    ...(edge.revolution ? { unavailableReason: "奪權內戰機制尚未開放" } : {}),
    effects: [{ kind: "transition", toGovernment: edge.to }, ...costEffectsFor(edge)],
  };
}

/** 由政體圖產生全部轉型國策(圖和國策因此不可能不同步)。 */
export function buildRegimeFocuses(edges: readonly RegimeEdge[] = REGIME_EDGES): FocusDef[] {
  return edges.map(toFocus);
}
