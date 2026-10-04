import type { FocusDef } from "./types";

/**
 * 範例目錄(僅用來驗證資料結構與驗證器,不是最終內容)。
 * 展示:互斥分岔、每個國策都有代價、里程碑解鎖能力、
 *       黑/紅線累積傾向值、轉型國策(取代舊政體變更接受度)。
 * 最終內容會依政體分批撰寫(每政體 6-8 個特色國策)。
 */
export const SAMPLE_CATALOG: FocusDef[] = [
  // ── 根:王權 ────────────────────────────────────────────
  {
    id: "regime.royal_decree",
    domain: "regime", track: "stable", slot: "main",
    title: "王命通行", description: "以王命統一號令,各地官員必須直接向王廷負責。",
    cost: 6, turns: 4, requires: [], governments: ["absolute_monarchy"],
    effects: [
      { kind: "modifier", stat: "pointsPerTurn", value: 1 },
      { kind: "parliamentSatisfaction", value: -6 },
    ],
  },
  // ── 第一分岔:軍事路線(互斥三選一)────────────────────────
  {
    id: "mil.standing_army",
    domain: "military", track: "stable", slot: "main",
    title: "常備軍制", description: "建立職業化的常備軍,平時也維持高戰備。",
    cost: 10, turns: 6, requires: ["regime.royal_decree"], exclusiveGroup: "mil_doctrine_1",
    effects: [
      { kind: "modifier", stat: "recruitSpeed", value: 25 },
      { kind: "modifier", stat: "armyUpkeep", value: 15 },
    ],
  },
  {
    id: "mil.levy_mobilization",
    domain: "military", track: "stable", slot: "main",
    title: "徵召動員制", description: "戰時大量徵召農民,平時不養兵,省錢但戰力不穩。",
    cost: 8, turns: 5, requires: ["regime.royal_decree"], exclusiveGroup: "mil_doctrine_1",
    effects: [
      { kind: "modifier", stat: "armyUpkeep", value: -20 },
      { kind: "militarySatisfaction", value: -8 },
    ],
  },
  {
    id: "mil.mercenary_reliance",
    domain: "military", track: "stable", slot: "main",
    title: "倚重僱傭兵", description: "與軍事公司長期合作,以金錢換取戰力。",
    cost: 9, turns: 5, requires: ["regime.royal_decree"], exclusiveGroup: "mil_doctrine_1",
    effects: [
      { kind: "unlock", capability: "mercenary.discount" },
      { kind: "modifier", stat: "taxIncome", value: -8 },
    ],
    milestone: true,
  },
  // ── 黑線:軍國化(累積傾向值,代價是議會與穩定)────────────────
  {
    id: "mil.total_mobilization",
    domain: "military", track: "black", slot: "main",
    title: "總體戰動員", description: "一切資源納入戰爭機器,民間生活全面軍事化。",
    cost: 16, turns: 8, requires: [], requiresAny: ["mil.standing_army", "mil.levy_mobilization"],
    effects: [
      { kind: "lean", side: "black", value: 25 },
      { kind: "modifier", stat: "productionOutput", value: 12 },
      { kind: "parliamentSatisfaction", value: -15 },
      { kind: "grant", stat: "stability", value: -8 },
    ],
  },
  // ── 轉型國策:取代舊「政體變更接受度」────────────────────────
  {
    id: "regime.to_military_dictatorship",
    domain: "regime", track: "black", slot: "main",
    title: "軍政府成立", description: "軍方接管國家機器,宣布戒嚴並停止一切文官決策。",
    cost: 30, turns: 10, requires: ["mil.total_mobilization"],
    governments: ["absolute_monarchy", "parliamentary", "presidential_democracy"],
    conditions: [
      { kind: "leanAtLeast", side: "black", value: 50 },
      { kind: "militarySatisfactionAtLeast", value: 60 },
    ],
    milestone: true,
    effects: [
      { kind: "transition", toGovernment: "military_dictatorship" },
      { kind: "grant", stat: "politicalSupport", value: -25 },
    ],
  },
  {
    id: "regime.to_constitutional_monarchy",
    domain: "regime", track: "reform", slot: "main",
    title: "頒布憲章", description: "君主自願讓渡部分權力,以憲章換取社會穩定。",
    cost: 24, turns: 8, requires: ["regime.royal_decree"],
    governments: ["absolute_monarchy"],
    conditions: [{ kind: "politicalSupportAtLeast", value: 55 }],
    milestone: true,
    effects: [
      { kind: "transition", toGovernment: "constitutional_monarchy" },
      { kind: "grant", stat: "money", value: -800 },
    ],
  },
  // ── 紅線:從議會內閣走向社會主義委員會 ────────────────────────
  {
    id: "int.workers_councils",
    domain: "interior", track: "red", slot: "side",
    title: "工人委員會", description: "在工廠與城市設立工人代表委員會,分享決策權。",
    cost: 14, turns: 7, requires: [], governments: ["parliamentary", "parliamentary_republic", "council_system"],
    effects: [
      { kind: "lean", side: "red", value: 25 },
      { kind: "modifier", stat: "productionOutput", value: 8 },
      { kind: "modifier", stat: "taxIncome", value: -10 },
    ],
  },
  {
    id: "regime.to_socialist_council",
    domain: "regime", track: "red", slot: "main",
    title: "宣告社會主義共和", description: "生產資料收歸公有,權力移交各級代表委員會。",
    cost: 32, turns: 10, requires: ["int.workers_councils"],
    governments: ["parliamentary", "parliamentary_republic", "council_system"],
    conditions: [
      { kind: "leanAtLeast", side: "red", value: 50 },
      { kind: "stabilityAtMost", value: 60 },
    ],
    milestone: true,
    effects: [
      { kind: "transition", toGovernment: "socialist_council" },
      { kind: "grant", stat: "money", value: -1500 },
    ],
  },
];
