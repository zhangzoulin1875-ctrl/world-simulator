import { ERAS, isEraSlug } from "./mapRegionEras";

/**
 * Task #30 — 12 種政體與各時代的推薦政體對照表（集中管理）。
 *
 * 政體在建國時三選一（見 FOUNDING_GOVERNMENT_SLUGS，Task #428），其餘政體
 * 只能在建國後透過政治系統改制取得；建國後不可經設定頁修改。
 * DB 存 zh-TW label，前端直接顯示。時代推薦表僅供 UI 排序提示。
 */

export interface GovernmentDef {
  slug: string;
  label: string;
  description: string;
  /**
   * Task #127 — 政府決策難度（0–100，越高越難通過）。集權／獨裁政體政令暢通、
   * 決策容易（低難度）；民主／議會／聯合政體需要協商共識，決策較難（高難度）。
   * 用於 politics.ts 的 decisionSuccessChance。
   */
  decisionDifficulty: number;
}

export const GOVERNMENTS: readonly GovernmentDef[] = [
  {
    slug: "absolute_monarchy",
    label: "君主專制",
    description: "君主獨攬大權，政令如一，動員迅速但繫於一人之明。",
    decisionDifficulty: 20,
  },
  {
    slug: "constitutional_monarchy",
    label: "君主立憲制",
    description: "君主為國家象徵，實權歸於憲法與議會，穩定而漸進。",
    decisionDifficulty: 45,
  },
  {
    slug: "elective_monarchy",
    label: "選舉君主制",
    description: "君主由貴族或選帝侯推舉產生，王位不世襲、講究合縱連橫。",
    decisionDifficulty: 50,
  },
  {
    slug: "dual_monarchy",
    label: "二元君主制",
    description: "兩頂王冠共戴一君，雙元政府並立，兼容多民族版圖。",
    decisionDifficulty: 45,
  },
  {
    slug: "aristocracy",
    label: "貴族制",
    description: "世家大族輪執國政，重門第與傳統，權力分散於貴族院。",
    decisionDifficulty: 50,
  },
  {
    slug: "theocracy",
    label: "神權制",
    description: "以信仰立國，教義即法律，祭司階層兼掌俗世權柄。",
    decisionDifficulty: 35,
  },
  {
    slug: "military_dictatorship",
    label: "軍事獨裁",
    description: "軍方掌握國家機器，紀律嚴明、窮兵黷武，以武力維繫秩序。",
    decisionDifficulty: 15,
  },
  {
    slug: "plutocracy",
    label: "財閥共和",
    description: "商賈與金融巨頭主導國政，重貿易與資本，唯利是圖。",
    decisionDifficulty: 45,
  },
  {
    slug: "presidential_democracy",
    label: "總統制民主",
    description: "全民直選的總統統領行政，三權分立、任期有度。",
    decisionDifficulty: 55,
  },
  {
    slug: "parliamentary",
    label: "議會內閣制",
    description: "內閣對議會負責，首相由多數黨推舉，政黨政治為核心。",
    decisionDifficulty: 60,
  },
  {
    slug: "council_system",
    label: "委員會制",
    description: "權力歸於各級委員會，集體領導、由下而上層層代表。",
    decisionDifficulty: 65,
  },
  {
    slug: "confederation",
    label: "邦聯制",
    description: "多個自治邦國鬆散聯合，共組外交與防務，內政各自為政。",
    decisionDifficulty: 70,
  },
  {
    slug: "parliamentary_republic",
    label: "議會共和制",
    description: "無世襲元首，國家權力繫於民選議會，總統多為虛位，共和而重議事。",
    decisionDifficulty: 60,
  },
  {
    slug: "socialist_council",
    label: "社會主義委員會制",
    description: "生產資料公有，由工農代表委員會集體決策，計畫經濟、階級動員。",
    decisionDifficulty: 55,
  },
];

/**
 * 建國頁給新手看的政體說明(只涵蓋建國三選一)。內容對照現行機制:
 *  - 議會三檔:專制=橡皮圖章、半專制=單次最多 -8、民主=單次最多 -25(parliament/core.ts)。
 *  - 議會滿意度歸零 → 革命,分走 40% 土地(半專制/民主;專制議會不會革命)。
 *  - 軍方:每 4 回合擲一次、18% 機率要求進攻,拒絕 -15;<50 強制開戰、<15 政變;民主國家永不被要求(militaryDemand/core.ts)。
 * 改機制時請同步更新這裡的文字(governments.test.ts 會檢查欄位齊全)。
 */
export interface FoundingGuide {
  /** 一句話定位。 */
  summary: string;
  pros: string[];
  cons: string[];
  /** 適合誰。 */
  tip: string;
}

export const FOUNDING_GUIDES: Readonly<Record<string, FoundingGuide>> = {
  absolute_monarchy: {
    summary: "獨裁路線:君主說了算,議會只是橡皮圖章,政令最暢通。",
    pros: [
      "議會不會刁難你:不提政策要求、不扣議會滿意度,也不會因議會不滿而革命",
      "決策最容易通過(難度 20),想做的事幾乎都推得動",
      "不必花心思安撫議會,可以專心經營內政與軍事",
    ],
    cons: [
      "軍方是你唯一要顧的人:每 4 回合有 18% 機率要求你出兵攻打某地,拒絕一次軍方滿意度 -15",
      "軍方滿意度低於 50 會直接替你開戰,低於 15 會發動政變或軍閥分裂",
      "權力集中在一人,軍方一旦失控就沒有議會可以緩衝",
    ],
    tip: "適合想專心擴張、敢打仗的玩家。要常常滿足軍方的出兵要求。",
  },
  aristocracy: {
    summary: "半獨裁路線:貴族議會會發聲,但影響力有限,介於獨裁與民主之間。",
    pros: [
      "議會雖然會提意見,但單次違背最多只扣 8 點,相對好控制",
      "決策難度中等(50),比民主好推動",
      "可以寫「國情報告」安撫議會,緩和不滿",
    ],
    cons: [
      "議會每 3 回合會提一次政策要求,長期不理會,議會滿意度歸零就會爆發革命,被奪走 40% 土地",
      "軍方和獨裁一樣會要求出兵,拒絕會扣軍方滿意度",
      "要同時顧議會與軍方兩邊,管理負擔最重",
    ],
    tip: "適合想要折衷、願意花時間經營兩邊關係的玩家。",
  },
  parliamentary_republic: {
    summary: "民主路線:權力在民選議會,軍方不干政,但議會可以重罰你。",
    pros: [
      "軍方永遠不會要求你出兵,也不會替你開戰,不必被逼著打仗",
      "決策要協商但較穩健,政權不靠單一領袖",
      "想走和平發展、專心建設經濟的玩家最輕鬆",
    ],
    cons: [
      "議會話語權最大:違背政策要求單次最多扣 25 點,議會滿意度掉得很快",
      "議會滿意度歸零會爆發革命,被奪走 40% 土地,風險最高",
      "決策難度高(60),想推動政策需要更多協商",
    ],
    tip: "適合偏好和平發展的玩家。要認真讀議會的政策要求,照著做。",
  },
};

/** 建國預設政體（Task #127：一律 君主專制；Task #428 起改為三選一，此值保留供舊路徑/回退使用）。 */
export const DEFAULT_GOVERNMENT_SLUG = "absolute_monarchy";

/**
 * Task #428 — 建國時可選的政體（三選一）。其餘政體僅能在建國後
 * 透過政治系統改制取得。
 */
export const FOUNDING_GOVERNMENT_SLUGS: readonly string[] = [
  "absolute_monarchy",
  "aristocracy",
  "parliamentary_republic",
];

/** 是否為建國可選政體 slug。 */
export function isFoundingGovernmentSlug(value: string): boolean {
  return FOUNDING_GOVERNMENT_SLUGS.includes(value);
}

/** 政變成功時偏好安裝的政體（依序，跳過與現行相同者）。 */
export const COUP_GOVERNMENT_SLUGS: readonly string[] = [
  "military_dictatorship",
  "absolute_monarchy",
];

const GOVERNMENT_BY_SLUG = new Map(GOVERNMENTS.map((g) => [g.slug, g]));
const GOVERNMENT_BY_LABEL = new Map(GOVERNMENTS.map((g) => [g.label, g]));

export function isGovernmentSlug(value: string): boolean {
  return GOVERNMENT_BY_SLUG.has(value);
}

export function governmentLabel(slug: string): string | null {
  return GOVERNMENT_BY_SLUG.get(slug)?.label ?? null;
}

/** zh-TW label → slug（player_nations.government 存的是 label）。 */
export function governmentSlugByLabel(label: string | null): string | null {
  if (!label) return null;
  return GOVERNMENT_BY_LABEL.get(label)?.slug ?? null;
}

/**
 * 政府決策難度（0–100）。輸入為政體 label 或 slug；未知政體回中位數 50。
 */
export function governmentDecisionDifficulty(
  governmentLabelOrSlug: string | null,
): number {
  if (!governmentLabelOrSlug) return 50;
  const def =
    GOVERNMENT_BY_LABEL.get(governmentLabelOrSlug) ??
    GOVERNMENT_BY_SLUG.get(governmentLabelOrSlug);
  return def?.decisionDifficulty ?? 50;
}

/**
 * 各時代推薦政體（era slug → government slugs，順序即推薦順位）。
 * 集中於此表；時代 slug 見 mapRegionEras.ts 的 14 個時代。
 */
export const ERA_RECOMMENDED_GOVERNMENTS: Readonly<
  Record<string, readonly string[]>
> = {
  classical: ["absolute_monarchy", "aristocracy", "military_dictatorship"],
  roman: ["absolute_monarchy", "aristocracy", "elective_monarchy"],
  early_medieval: ["absolute_monarchy", "theocracy", "elective_monarchy"],
  high_medieval: ["absolute_monarchy", "theocracy", "aristocracy"],
  renaissance: ["absolute_monarchy", "plutocracy", "aristocracy"],
  discovery: ["absolute_monarchy", "plutocracy", "dual_monarchy"],
  scientific: ["absolute_monarchy", "constitutional_monarchy", "plutocracy"],
  enlightenment: [
    "constitutional_monarchy",
    "elective_monarchy",
    "parliamentary",
  ],
  industrial: [
    "constitutional_monarchy",
    "parliamentary",
    "presidential_democracy",
  ],
  ww1: ["dual_monarchy", "constitutional_monarchy", "parliamentary"],
  ww2: ["military_dictatorship", "presidential_democracy", "parliamentary"],
  cold_war: ["presidential_democracy", "council_system", "parliamentary"],
  modern: ["presidential_democracy", "parliamentary", "confederation"],
  future: ["confederation", "council_system", "presidential_democracy"],
};

/** 指定時代的推薦政體 slug 清單（未知時代回空陣列）。 */
export function recommendedGovernmentsForEra(era: string): readonly string[] {
  if (!isEraSlug(era)) return [];
  return ERA_RECOMMENDED_GOVERNMENTS[era] ?? [];
}

/** 靜態一致性檢查用：每個時代都應有推薦、且 slug 均存在。 */
export function validateGovernmentTables(): string[] {
  const problems: string[] = [];
  for (const era of ERAS) {
    const recs = ERA_RECOMMENDED_GOVERNMENTS[era.slug];
    if (!recs || recs.length === 0) {
      problems.push(`era ${era.slug} has no recommended governments`);
      continue;
    }
    for (const slug of recs) {
      if (!GOVERNMENT_BY_SLUG.has(slug)) {
        problems.push(`era ${era.slug} references unknown government ${slug}`);
      }
    }
    if (new Set(recs).size !== recs.length) {
      problems.push(`era ${era.slug} has duplicate recommendations`);
    }
  }
  return problems;
}
