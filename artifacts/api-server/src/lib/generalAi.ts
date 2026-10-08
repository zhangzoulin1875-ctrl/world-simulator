import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  generalPoolTable,
  mapRegionsTable,
  regionControlsTable,
  type GeneralSkill,
} from "@workspace/db";
import { callGameAi } from "./gameAi";
import { logger } from "./logger";
import { ERAS, getEraIndex } from "./mapRegionEras";
import {
  eraAvailableCategories,
  isCategoryUnlocked,
  isMilitaryCategory,
  type MilitaryCategory,
} from "./military";
import { REGION_ASSIGNMENTS } from "./mapConstants.generated";
import { PROFILE_CULTURE } from "./nationGeoCulture";
import { GENERAL_SKILL_SPECS } from "./generals";

/**
 * 武將系統 — AI 生成模組（weaponAi 的姊妹流程）。
 *
 * 分類（步兵將領/騎兵將領…）與技能數值由伺服器指定/夾限，AI 只生成：
 *  - 姓名／稱號／背景故事：依「時代 × 文化圈」優先選真實歷史知名將領，
 *    完全沒有對應人物時就地虛構（貼合文化、不得超自然）。
 *  - 三條技能的名稱與描述（數值規格由 GENERAL_SKILL_SPECS 固定）。
 *
 * 預產池（general_pool）按「時代 × 文化圈」分桶；玩家抽取優先發同文化圈
 * 的池列（零延遲），池空時同步呼叫 AI 生成一次（玩家優先權佇列）。
 */

function parseAiJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

export class GeneralAiError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** AI 生成的原始敘事（不含數值規格）。 */
interface GeneralNarrative {
  name: string;
  title: string;
  background: string;
  /** 依指定分類微調的技能名稱與描述（三條）。 */
  skillNames: string[];
  skillDescriptions: string[];
  /** 是否真實歷史人物（供前端顯示「史實名將」標記；AI 自評）。 */
  historical: boolean;
}

const generalNarrativeSchema = z.object({
  name: z.string().trim().min(1).max(24),
  title: z.string().trim().min(1).max(40),
  background: z.string().trim().min(1).max(600),
  skills: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        description: z.string().trim().min(1).max(300),
      }),
    )
    .length(3),
  historical: z.boolean(),
});

/** 把 AI 敘事 + 伺服器技能規格組成 GeneralSkill[]。 */
export function assembleSkills(narrative: GeneralNarrative): GeneralSkill[] {
  return GENERAL_SKILL_SPECS.map((spec, i) => ({
    name: narrative.skillNames[i] ?? `戰法 ${i + 1}`,
    description: narrative.skillDescriptions[i] ?? "",
    effect: spec.effect,
    bonusPct: spec.bonusPct,
    unlockGrade: spec.unlockGrade,
  }));
}

/**
 * 從「可用類別」隨機抽一個。可用清單為空（理論上不會：步兵恆可用）時回退步兵。
 * 武將預產、池空 fallback 共用，確保不會產出該時代/該玩家不可用的兵種專精。
 */
export function pickGeneralCategory(
  available: readonly MilitaryCategory[],
): MilitaryCategory {
  if (available.length === 0) return "infantry";
  return available[Math.floor(Math.random() * available.length)]!;
}

const CATEGORY_LABEL: Readonly<Record<MilitaryCategory, string>> = {
  infantry: "步兵",
  ranged: "遠程／弓弩",
  armor: "裝甲／騎兵",
  artillery: "火炮",
  ship: "艦船",
  air: "空軍",
  siege: "攻城器械",
};

/** 文化圈標籤（查無 profile 時的兜底）。 */
export function cultureLabel(profile: string): string {
  return PROFILE_CULTURE[profile] ?? profile;
}

/** 生成一段武將敘事（供池預產與同步 fallback 共用）。 */
export async function generateGeneralNarrative(params: {
  eraSlug: string;
  category: MilitaryCategory;
  cultureProfile: string;
}): Promise<GeneralNarrative> {
  const era = ERAS[getEraIndex(params.eraSlug)]!;
  const culture = cultureLabel(params.cultureProfile);
  const catLabel = CATEGORY_LABEL[params.category];

  const systemPrompt = [
    "你是一款架空歷史戰略遊戲的武將生成 AI。本遊戲世界觀完全基於真實歷史，不含任何魔法、超自然、奇幻或科幻元素。請僅回覆 JSON 物件（不要 code fence、不要任何前後文字）。",
    "JSON 欄位：",
    '{"name": "姓名（繁體中文，≤24字）", "title": "稱號（繁體中文，≤40字，如「亞歷山大大帝」的征服者風格）", "background": "背景故事（繁體中文，≤600字，含生平、戰役、帶兵風格）", "skills": [{"name": "技能名（≤40字）", "description": "技能描述（≤300字，說明戰術原理）"}×3], "historical": true或false}',
    "規則：",
    `1. 依「時代（${era.label}）× 文化圈（${culture}）」優先選出真實歷史上的知名將領；名稱用繁體中文通用譯名。若該時代與文化圈完全沒有對應的歷史名將，就虛構一名符合該文化、該時代背景的原創將領（historical: false）。`,
    `2. 專精分類固定為「${catLabel}」（英文代碼 ${params.category}）：背景故事、稱號與技能都要扣合此兵種的指揮風格。`,
    "3. 三條技能分別對應：第1條進攻戰法、第2條防守戰法、第3條攻守兼備的成名絕技；技能名要具體有畫面、不得與其他武將雷同。",
    "4. 不得出現任何超自然能力；一切戰術以真實歷史可行為準。",
  ].join("\n");

  const userPrompt = `時代：${era.label}\n文化圈：${culture}\n專精分類：${catLabel}（${params.category}）\n\n僅回覆 JSON 物件。`;

  const message = await callGameAi("general.gacha", "quality", {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const block = message.content[0];
  const raw = block && block.type === "text" ? block.text : "";

  let parsed: z.infer<typeof generalNarrativeSchema>;
  try {
    const obj = parseAiJson(raw) as Record<string, unknown> & {
      skills?: unknown[];
    };
    // skills 攤平為兩個字串陣列後以敘事 schema 驗證。
    const skills = Array.isArray(obj.skills) ? obj.skills : [];
    const flat = {
      name: obj.name,
      title: obj.title,
      background: obj.background,
      skills: skills.slice(0, 3).map((s) => {
        const sk = (s ?? {}) as Record<string, unknown>;
        return { name: sk.name, description: sk.description };
      }),
      historical: obj.historical === true,
    };
    parsed = generalNarrativeSchema.parse({
      ...flat,
      skills:
        flat.skills.length === 3
          ? flat.skills
          : [0, 1, 2].map((i) => flat.skills[i] ?? { name: "戰法", description: "沉穩指揮部隊作戰。" }),
    });
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 400) }, "AI general parse failed");
    throw new GeneralAiError("AI 武將生成結果格式不正確，請再試一次");
  }

  return {
    name: parsed.name,
    title: parsed.title,
    background: parsed.background,
    skillNames: parsed.skills.map((s) => s.name),
    skillDescriptions: parsed.skills.map((s) => s.description),
    historical: parsed.historical,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 帶重試的敘事生成：AI 偶發回傳格式不正確時自動重試（指數退避），
 * 避免單次偶發錯誤就讓玩家看到「生成失敗」。全部嘗試仍失敗才向上拋出。
 */
export async function generateGeneralNarrativeWithRetry(
  params: { eraSlug: string; category: MilitaryCategory; cultureProfile: string },
  attempts = 3,
): Promise<GeneralNarrative> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await generateGeneralNarrative(params);
    } catch (err) {
      lastErr = err;
      logger.warn(
        { err, attempt: i + 1, attempts },
        "generateGeneralNarrative 重試",
      );
      if (i < attempts - 1) await sleep(400 * (i + 1));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new GeneralAiError("AI 武將生成結果格式不正確，請再試一次");
}

/**
 * 生成一張完整武將卡（敘事 + 組裝技能）；分類由呼叫端固定傳入
 * （抽取時已擲骰決定分類，背景重試不應讓分類跳動）。
 */
export async function generateGeneralCard(params: {
  eraSlug: string;
  category: MilitaryCategory;
  cultureProfile: string;
  attempts?: number;
}): Promise<{
  name: string;
  title: string;
  background: string;
  category: string;
  skills: GeneralSkill[];
  historical: boolean;
}> {
  const narrative = await generateGeneralNarrativeWithRetry(
    params,
    params.attempts ?? 3,
  );
  return {
    name: narrative.name,
    title: narrative.title,
    background: narrative.background,
    category: params.category,
    skills: assembleSkills(narrative),
    historical: narrative.historical,
  };
}

/**
 * 保底卡（非 AI）：背景生成多次重試仍全部失敗時的最後防線，確保玩家
 * 已付出的抽取成本一定能換到一張可用的候選武將，不會卡在「生成中」。
 */
export function buildFallbackGeneralCard(params: {
  eraSlug: string;
  category: MilitaryCategory;
  cultureProfile: string;
}): {
  name: string;
  title: string;
  background: string;
  category: string;
  skills: GeneralSkill[];
  historical: boolean;
} {
  const era = ERAS[getEraIndex(params.eraSlug)]!;
  const culture = cultureLabel(params.cultureProfile);
  const catLabel = CATEGORY_LABEL[params.category];
  const narrative: GeneralNarrative = {
    name: `${culture}${catLabel}宿將`,
    title: `${era.label}軍中老將`,
    background: `出身${culture}，於${era.label}從軍多年，擅長統率${catLabel}作戰，用兵穩健、臨陣不亂。`,
    skillNames: ["持重佈陣", "堅守陣線", "臨陣應變"],
    skillDescriptions: [
      "開戰前仔細佈置陣型，提升部隊進攻時的協同效率。",
      "面對敵軍衝鋒時穩住防線，減少己方損失。",
      "戰局不利時迅速調整部署，攻守皆能發揮水準。",
    ],
    historical: false,
  };
  return {
    name: narrative.name,
    title: narrative.title,
    background: narrative.background,
    category: params.category,
    skills: assembleSkills(narrative),
    historical: false,
  };
}

/**
 * 某國的「主文化圈」civ profile slug：掌控地區中最常見的 profile；
 * 無掌控地區回 "general"。
 */
export async function loadDominantCultureProfile(
  nationId: string,
): Promise<string> {
  const rows = await db
    .select({ regionName: mapRegionsTable.name })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, regionControlsTable.regionId),
    )
    .where(
      and(
        eq(regionControlsTable.nationId, nationId),
        sql`${regionControlsTable.percent} > 50`,
      ),
    );
  const count = new Map<string, number>();
  for (const r of rows) {
    const slug = REGION_ASSIGNMENTS[r.regionName]?.p;
    if (!slug) continue;
    count.set(slug, (count.get(slug) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [slug, n] of count) {
    if (n > bestN) {
      best = slug;
      bestN = n;
    }
  }
  return best ?? "general";
}

/**
 * 從預產池發一張牌（時代 × 文化圈優先，桶空時退而求其次同時代任意、
 * 再空回 null 走同步生成）。回傳組裝完成的將領資料（含技能規格）。
 */
export async function takeGeneralFromPool(params: {
  eraSlug: string;
  cultureProfile: string;
  /**
   * 玩家已研發的關鍵技術。給定時，池中屬於「該玩家已鎖定類別」的牌（例如研發火槍兵
   * 後的射手）一律跳過、不被取走，留給其他玩家。未給定時不過濾（舊行為）。
   */
  researchedKeySlugs?: readonly string[];
}): Promise<{
  name: string;
  title: string;
  background: string;
  category: string;
  skills: GeneralSkill[];
  historical: boolean;
} | null> {
  const pick = async (profile: string | null) => {
    const where = profile
      ? and(
          eq(generalPoolTable.eraSlug, params.eraSlug),
          eq(generalPoolTable.cultureProfile, profile),
        )
      : eq(generalPoolTable.eraSlug, params.eraSlug);
    const rows = await db
      .select()
      .from(generalPoolTable)
      .where(where)
      .orderBy(sql`created_at asc`)
      .limit(24);
    const usable = params.researchedKeySlugs
      ? rows.filter(
          (r) =>
            isMilitaryCategory(r.category) &&
            isCategoryUnlocked(r.category, params.researchedKeySlugs!),
        )
      : rows;
    if (usable.length === 0) return null;
    // 隨機挑一列（同桶內新舊均勻），原子刪除搶列：刪到 = 得牌。
    const shuffled = [...usable].sort(() => Math.random() - 0.5);
    for (const row of shuffled) {
      const deleted = await db
        .delete(generalPoolTable)
        .where(eq(generalPoolTable.id, row.id))
        .returning();
      if (deleted.length > 0) return row;
    }
    return null;
  };

  const row =
    (await pick(params.cultureProfile)) ?? (await pick(null));
  if (!row) return null;
  return {
    name: row.name,
    title: row.title,
    background: row.background,
    category: row.category,
    skills: row.skills ?? [],
    historical: row.skills?.length === 3, // 池列一律視為可展示卡面
  };
}

/**
 * 同步生成一名武將（池空 fallback；走玩家優先權佇列）。
 */
export async function generateGeneralSync(params: {
  eraSlug: string;
  cultureProfile: string;
  /** 玩家目前可用的類別（缺省 = 該時代預設可用）。 */
  availableCategories?: readonly MilitaryCategory[];
}): Promise<{
  name: string;
  title: string;
  background: string;
  category: string;
  skills: GeneralSkill[];
  historical: boolean;
}> {
  const category = pickGeneralCategory(
    params.availableCategories ?? eraAvailableCategories(params.eraSlug),
  );
  return generateGeneralCard({
    eraSlug: params.eraSlug,
    category,
    cultureProfile: params.cultureProfile,
  });
}

/**
 * 預產池補位（背景 worker 閒時呼叫）：目標桶每桶補到 targetPerBucket 張。
 * 回傳是否真的生成了一張（供 worker 節流：一個 tick 最多一張）。
 */
export async function topUpGeneralPool(params: {
  eraSlug: string;
  cultureProfile: string;
  targetPerBucket: number;
}): Promise<boolean> {
  const [{ n }] = await db
    .select({ n: sql<string>`COUNT(*)` })
    .from(generalPoolTable)
    .where(
      and(
        eq(generalPoolTable.eraSlug, params.eraSlug),
        eq(generalPoolTable.cultureProfile, params.cultureProfile),
      ),
    );
  if (Number(n) >= params.targetPerBucket) return false;

  // 預產時不知道會發給誰：只產該時代預設可用的類別（火槍時代起不再產射手、
  // 古代不產空軍/艦船）。玩家個人鎖定另在發牌時過濾（takeGeneralFromPool）。
  const category = pickGeneralCategory(eraAvailableCategories(params.eraSlug));
  const narrative = await generateGeneralNarrativeWithRetry(
    { eraSlug: params.eraSlug, category, cultureProfile: params.cultureProfile },
    2,
  );
  await db.insert(generalPoolTable).values({
    name: narrative.name,
    title: narrative.title,
    background: narrative.background,
    category,
    skills: assembleSkills(narrative),
    eraSlug: params.eraSlug,
    cultureProfile: params.cultureProfile,
  });
  return true;
}
