import { z } from "zod";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  gameBalanceSettingsTable,
  aiAbuseRecordsTable,
  militaryUnitTemplatesTable,
  playerNationsTable,
  userSessionsTable,
  type AiAbuseRecord,
  type InsertAiAbuseRecord,
} from "@workspace/db";
import { logger } from "./logger";
import { MILITARY_CATEGORIES, MIN_UPKEEP_PER_UNIT, type MilitaryCategory } from "./military";
import { FOOD_ERA_INDEX } from "./food";

/**
 * Task #451 — 遊戲平衡系統（AI 濫用防線）SSOT。
 *
 * 三道防線：
 *  1. 兵種設計：AI 產出的數值以「該類別全庫平均 × 管理員倍率上限」＋絕對
 *     上下限（含維護費下限）在入庫前確定性夾限；離譜／穿越時代的需求由 AI
 *     直接退件（400 zh-TW、退還點數）。
 *  2. 戰爭指令：AI 只回報被濫用的指令旗標（unreasonable/anachronistic/exploit），
 *     懲罰由伺服器在既有 clamp 範圍內確定性套用（絕不新增 AI 損失欄位）。
 *  3. 內政／財政政策：暴政合法不罰；離譜／穿越時代／prompt injection 由 AI
 *     標旗，伺服器歸零其正面效果並記錄。
 *
 * 另含「滿意度／支持度加減成來源註冊表」：管理員可停用個別來源或夾限其
 * 每回合增減範圍。夾限只在「套用點」執行（不動 compute helpers 的精度）。
 */

// ── 設定 schema（DB 只存部分覆寫；讀取時合併預設） ─────────────

/** 加減成來源註冊表的來源鍵（預算系統已於 Task #401 移除，不在列）。 */
export const MODIFIER_SOURCES = [
  "treasuryCrisis",
  "politicsEntries",
  "supportDrift",
  "fiscalPolicy",
] as const;
export type ModifierSource = (typeof MODIFIER_SOURCES)[number];

export const MODIFIER_SOURCE_LABELS: Record<ModifierSource, string> = {
  treasuryCrisis: "國庫危機懲罰（滿意度／穩定度／暴動度）",
  politicsEntries: "政治條目效果（政策／改革／傳統加減成）",
  supportDrift: "政治支持度漂移（朝滿意度平均靠攏）",
  fiscalPolicy: "財政政策 AI 判定（滿意度／穩定度偏移）",
};

const modifierSourceSchema = z.object({
  enabled: z.boolean().default(true),
  /** 單次套用的增減下限（百分點）。 */
  minDelta: z.number().int().min(-100).max(0).default(-100),
  /** 單次套用的增減上限（百分點）。 */
  maxDelta: z.number().int().min(0).max(100).default(100),
});

const multiplierCapSchema = z.number().min(1).max(100).default(5);

/** Task #523 — 建設成本倍率（0.0001–100，預設 1 = 現狀價格）。 */
const constructionCostMultiplierSchema = z
  .number()
  .min(0.0001)
  .max(100)
  .default(1);

/** 糧食時代指數欄位：非負、上限 10000，預設取 food.ts FOOD_ERA_INDEX。 */
const foodEraIndexValue = (slug: string) =>
  z.number().min(0).max(10_000).default(FOOD_ERA_INDEX[slug]!);

export const gameBalanceSettingsSchema = z.object({
  unitDesign: z
    .object({
      /** AI 退件（離譜／穿越時代需求直接 400 並退點）。 */
      aiRejectionEnabled: z.boolean().default(true),
      /**
       * AI 退件鬆緊度：strict=嚴格比照真實歷史；balanced=容許合理原型並不以
       * 地理位置退件（預設）；lenient=再放寬約一個時代。僅在 aiRejectionEnabled 開啟時生效。
       */
      aiRejectionStrictness: z
        .enum(["strict", "balanced", "lenient"])
        .default("balanced"),
      /** 各類別「相對全庫平均值」的倍率上限（戰鬥數值 hp/attack/defense/speed）。 */
      multiplierCaps: z
        .object({
          infantry: multiplierCapSchema,
          ranged: multiplierCapSchema,
          armor: multiplierCapSchema,
          artillery: multiplierCapSchema,
          ship: multiplierCapSchema,
          air: multiplierCapSchema,
          siege: multiplierCapSchema,
        })
        .default({}),
      /** 絕對上限（與 zod 入庫 schema 的硬上限取小）。 */
      hpMax: z.number().int().min(1).max(10_000_000).default(10_000_000),
      attackMax: z.number().int().min(0).max(10_000_000).default(10_000_000),
      defenseMax: z.number().int().min(0).max(10_000_000).default(10_000_000),
      speedMax: z.number().min(0).max(1000).default(1000),
      /** 絕對下限（成本類；防「超強又免費」）。 */
      moneyCostMin: z.number().min(0.0001).max(1_000_000_000).default(1),
      prodCostPer100Min: z.number().min(0.0001).max(1_000_000_000).default(1),
      popCostMin: z.number().min(0.0001).max(1_000_000).default(1),
      prodUpkeepPerUnitMin: z
        .number()
        .min(0.0001)
        .max(1_000_000)
        .default(MIN_UPKEEP_PER_UNIT),
      /** 每單位維護費下限（金錢與生產力兩軌皆適用；與系統底線取大）。 */
      upkeepMin: z.number().min(0).max(1_000_000).default(MIN_UPKEEP_PER_UNIT),
      /** Task #471 — 每單位木材成本上限（防 AI 灌出天價原料需求）。 */
      woodCostMax: z.number().int().min(0).max(1_000_000).default(1_000_000),
      /** Task #471 — 每單位礦石成本上限。 */
      oreCostMax: z.number().int().min(0).max(1_000_000).default(1_000_000),
    })
    .default({}),
  war: z
    .object({
      /** 戰爭指令 AI 審查（不合理／穿越時代／exploit 指令旗標＋伺服器懲罰）。 */
      reviewEnabled: z.boolean().default(true),
      /** 被標旗一方的軍團積極度乘數（%；exploit 再減半）。 */
      penaltyAggressionPct: z.number().int().min(0).max(100).default(50),
      /**
       * Task #547 — 反噬（backlash）：被標旗一方在該次結算額外承受的懲罰。
       * 全部預設 0（不啟用）；exploit 旗標一律加倍（仍受各自上限夾住）。
       */
      /** 額外傷亡（該方兵力的 %；仍受既有戰力硬上限與剩餘兵力封頂）。 */
      backlashExtraCasualtyPct: z.number().int().min(0).max(50).default(0),
      /** 領土反噬（百分點；往被標旗方不利方向推，夾在 AI schema ±15 內）。 */
      backlashTerritoryPct: z.number().int().min(0).max(15).default(0),
      /** 每次被標旗的穩定度下降（百分點，SQL clamp 0–100）。 */
      backlashStabilityDrop: z.number().int().min(0).max(30).default(0),
      /** 每次被標旗的暴動值上升（百分點，SQL clamp 0–100）。 */
      backlashUnrestRise: z.number().int().min(0).max(30).default(0),
      /** 每次被標旗的厭戰度上升（百分點，SQL clamp 0–100）。 */
      backlashWarWearinessRise: z.number().int().min(0).max(30).default(0),
      /**
       * 厭戰度每回合回復（衰減）：修正「停戰／戰爭結束後厭戰度永不下降」。
       * 回合引擎每回合對所有國家套用（SQL clamp ≥0）。無進行中戰爭（endedAt
       * IS NULL）→ peacetime；仍在進行中戰爭 → wartime（預設 0＝戰時不回復）。
       */
      warWearinessPeacetimeRecovery: z.number().int().min(0).max(30).default(3),
      warWearinessWartimeRecovery: z.number().int().min(0).max(30).default(0),
      /**
       * 厭戰度上升幅度倍率（%）：套用於每次戰役結算的 AI 厭戰度增量
       * （applyCycleResult 主增量；不影響反噬 backlashWarWearinessRise）。
       * 100＝原始幅度（預設，行為不變）；0＝完全不上升，500＝五倍。
       */
      warWearinessGainMultiplierPct: z
        .number()
        .int()
        .min(0)
        .max(500)
        .default(100),
      /**
       * 傷兵池線性復原速率（%/回合）：每回合復原初始傷兵數的此百分比。
       * 例：10（預設）→ 10% → 10 回合完全復原；20 → 5 回合；1 → 100 回合。
       * recoverySpeed 科技加成乘在此比率上（不影響 ceil(100/rate) 保證）。
       */
      woundedRecoveryPctPerTurn: z.number().int().min(1).max(100).default(10),
    })
    .default({}),
  interior: z
    .object({
      /** 內政／財政政策 AI 審查（暴政合法不罰；離譜／injection 歸零正面效果）。 */
      reviewEnabled: z.boolean().default(true),
    })
    .default({}),
  /**
   * Task #523 — 三類建設成本倍率。最終成本 = 原公式成本 × 倍率，向上取整、
   * 至少 1（見 scaleConstructionCost）。維護費不縮放。
   */
  constructionCosts: z
    .object({
      /** 地區生產力投資成本倍率。 */
      productivityInvestment: constructionCostMultiplierSchema,
      /** 地區資源建築（木材廠／礦場）建造與升級成本倍率。 */
      resourceBuilding: constructionCostMultiplierSchema,
      /** 一般城市建築建造成本倍率。 */
      cityBuilding: constructionCostMultiplierSchema,
    })
    .default({}),
  modifierSources: z
    .object({
      treasuryCrisis: modifierSourceSchema.default({}),
      politicsEntries: modifierSourceSchema.default({}),
      supportDrift: modifierSourceSchema.default({}),
      fiscalPolicy: modifierSourceSchema.default({}),
    })
    .default({}),
  food: z
    .object({
      /**
       * 糧食「時代指數」覆寫（產出公式：面積 × 肥沃度 × 時代指數 × 農民
       * 比例 × 校準常數）。key 與 mapRegionEras ERAS slug 一一對應；
       * 預設值 = food.ts FOOD_ERA_INDEX（單元測試鎖同步）。
       */
      eraIndex: z
        .object({
          classical: foodEraIndexValue("classical"),
          roman: foodEraIndexValue("roman"),
          early_medieval: foodEraIndexValue("early_medieval"),
          high_medieval: foodEraIndexValue("high_medieval"),
          renaissance: foodEraIndexValue("renaissance"),
          discovery: foodEraIndexValue("discovery"),
          scientific: foodEraIndexValue("scientific"),
          enlightenment: foodEraIndexValue("enlightenment"),
          industrial: foodEraIndexValue("industrial"),
          ww1: foodEraIndexValue("ww1"),
          ww2: foodEraIndexValue("ww2"),
          cold_war: foodEraIndexValue("cold_war"),
          modern: foodEraIndexValue("modern"),
          future: foodEraIndexValue("future"),
        })
        .default({}),
    })
    .default({}),
});

export type GameBalanceSettings = z.infer<typeof gameBalanceSettingsSchema>;

/**
 * Task #523 — 純函式：以管理員設定的建設成本倍率縮放最終成本。
 * 最終成本 = ceil(原成本 × 倍率)，下限 1。倍率不合法（NaN／≤0）時視為 1，
 * 絕不因設定異常讓成本歸零或變負。顯示端點與扣款端點必須共用此函式。
 */
export function scaleConstructionCost(
  cost: number,
  multiplier: number,
): number {
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  return Math.max(1, Math.ceil(cost * m));
}

export const DEFAULT_GAME_BALANCE_SETTINGS: GameBalanceSettings =
  gameBalanceSettingsSchema.parse({});

/** 讀取設定（單列 id=1；壞資料回退預設，絕不炸結算）。 */
export async function getGameBalanceSettings(): Promise<GameBalanceSettings> {
  try {
    const [row] = await db
      .select()
      .from(gameBalanceSettingsTable)
      .where(eq(gameBalanceSettingsTable.id, 1))
      .limit(1);
    if (!row) return DEFAULT_GAME_BALANCE_SETTINGS;
    const parsed = gameBalanceSettingsSchema.safeParse(row.params);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues },
        "stored game balance settings invalid — falling back to defaults",
      );
      return DEFAULT_GAME_BALANCE_SETTINGS;
    }
    return parsed.data;
  } catch (err) {
    logger.error({ err }, "failed to read game balance settings — defaults");
    return DEFAULT_GAME_BALANCE_SETTINGS;
  }
}

/** 全量寫入（管理端 PUT 已先 zod 驗證）。 */
export async function saveGameBalanceSettings(
  settings: GameBalanceSettings,
): Promise<void> {
  await db
    .insert(gameBalanceSettingsTable)
    .values({ id: 1, params: settings })
    .onConflictDoUpdate({
      target: gameBalanceSettingsTable.id,
      set: { params: settings, updatedAt: new Date() },
    });
}

// ── 濫用紀錄 ───────────────────────────────────────────────────

export const ABUSE_DOMAINS = [
  "unit_design",
  "war_order",
  "interior_policy",
  "fiscal_policy",
] as const;
export type AbuseDomain = (typeof ABUSE_DOMAINS)[number];

export const ABUSE_DOMAIN_LABELS: Record<AbuseDomain, string> = {
  unit_design: "兵種設計",
  war_order: "戰爭指令",
  interior_policy: "內政政策",
  fiscal_policy: "財政政策",
};

/**
 * 寫入一筆濫用紀錄。fire-and-safe：寫入失敗只記 log，絕不讓主流程
 * （設計路由／戰役結算／回合結算）因稽核失敗而中斷。
 */
export async function recordAiAbuse(
  record: Omit<InsertAiAbuseRecord, "id" | "createdAt">,
): Promise<void> {
  try {
    await db.insert(aiAbuseRecordsTable).values(record);
  } catch (err) {
    logger.error({ err, domain: record.domain }, "failed to record AI abuse");
  }
}

// ── Task #519 — 濫用紀錄行為人 enrich（讀取時補查，不做資料庫回填） ──

/** 濫用紀錄 + 讀取時補出的行為人資訊（admin 列表端點回傳形狀）。 */
export type EnrichedAbuseRecord = AiAbuseRecord & {
  /** 玩家顯示名稱（globalName 優先，退回 username；查不到為 null）。 */
  actorName: string | null;
};

/**
 * 批次補上每筆濫用紀錄的行為人資訊：
 *  - actorName：以 discordUserId 查 user_sessions 最新一筆的
 *    globalName ?? username（一次批次查詢，非逐筆 N+1）。
 *  - nationName：紀錄快照為 null 但有 discordUserId 時，補查該玩家
 *    「目前」國家名稱（僅供顯示；nationId 保持原樣，撤銷/補償仍以
 *    資料庫紀錄為準）。
 * 沒有任何關聯玩家/國家的紀錄原樣返回（actorName = null）。
 */
export async function enrichAbuseRecordActors(
  records: AiAbuseRecord[],
): Promise<EnrichedAbuseRecord[]> {
  const userIds = [
    ...new Set(
      records
        .map((r) => r.discordUserId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (userIds.length === 0) {
    return records.map((r) => ({ ...r, actorName: null }));
  }

  const [sessionRows, nationRows] = await Promise.all([
    db
      .selectDistinctOn([userSessionsTable.discordUserId], {
        discordUserId: userSessionsTable.discordUserId,
        username: userSessionsTable.username,
        globalName: userSessionsTable.globalName,
      })
      .from(userSessionsTable)
      .where(inArray(userSessionsTable.discordUserId, userIds))
      .orderBy(
        userSessionsTable.discordUserId,
        desc(userSessionsTable.createdAt),
      ),
    db
      .select({
        discordUserId: playerNationsTable.discordUserId,
        name: playerNationsTable.name,
      })
      .from(playerNationsTable)
      .where(inArray(playerNationsTable.discordUserId, userIds)),
  ]);

  const nameByUser = new Map<string, string>();
  for (const s of sessionRows) {
    const display = s.globalName?.trim() || s.username;
    if (display) nameByUser.set(s.discordUserId, display);
  }
  const nationNameByUser = new Map<string, string>();
  for (const n of nationRows) {
    if (n.discordUserId && n.name) nationNameByUser.set(n.discordUserId, n.name);
  }

  return records.map((r) => ({
    ...r,
    actorName: r.discordUserId
      ? (nameByUser.get(r.discordUserId) ?? null)
      : null,
    nationName:
      r.nationName ??
      (r.discordUserId
        ? (nationNameByUser.get(r.discordUserId) ?? null)
        : null),
  }));
}

// ── 兵種設計夾限 ───────────────────────────────────────────────

export interface UnitCategoryAverages {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  /** Task #471 — 全庫平均木材成本（每單位；平衡頁檢視用）。 */
  woodCost: number;
  /** Task #471 — 全庫平均礦石成本（每單位）。 */
  oreCost: number;
  /** Task #471 — 全庫平均金錢維護費（每單位／回合）。 */
  upkeep: number;
  /** Task #471 — 全庫平均生產力維護費（每單位／回合）。 */
  prodUpkeep: number;
  /** 平均樣本數（0 = 該類別尚無模板 → 不套倍率上限）。 */
  count: number;
}

/** 該類別全庫（預設＋自創＋NPC）模板的戰鬥數值平均。 */
export async function computeUnitCategoryAverages(
  category: MilitaryCategory,
): Promise<UnitCategoryAverages> {
  const [row] = await db
    .select({
      hp: sql<string>`COALESCE(AVG(${militaryUnitTemplatesTable.hp}), 0)`,
      attack: sql<string>`COALESCE(AVG(${militaryUnitTemplatesTable.attack}), 0)`,
      defense: sql<string>`COALESCE(AVG(${militaryUnitTemplatesTable.defense}), 0)`,
      speed: sql<string>`COALESCE(AVG(${militaryUnitTemplatesTable.speed}), 0)`,
      woodCost: sql<string>`COALESCE(AVG(${militaryUnitTemplatesTable.woodCostPerUnit}), 0)`,
      oreCost: sql<string>`COALESCE(AVG(${militaryUnitTemplatesTable.oreCostPerUnit}), 0)`,
      upkeep: sql<string>`COALESCE(AVG(${militaryUnitTemplatesTable.upkeepPerUnit}), 0)`,
      prodUpkeep: sql<string>`COALESCE(AVG(${militaryUnitTemplatesTable.prodUpkeepPerUnit}), 0)`,
      count: sql<string>`COUNT(*)`,
    })
    .from(militaryUnitTemplatesTable)
    .where(eq(militaryUnitTemplatesTable.category, category));
  return {
    hp: Number(row?.hp ?? 0),
    attack: Number(row?.attack ?? 0),
    defense: Number(row?.defense ?? 0),
    speed: Number(row?.speed ?? 0),
    woodCost: Number(row?.woodCost ?? 0),
    oreCost: Number(row?.oreCost ?? 0),
    upkeep: Number(row?.upkeep ?? 0),
    prodUpkeep: Number(row?.prodUpkeep ?? 0),
    count: Number(row?.count ?? 0),
  };
}

export interface UnitDesignStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  prodCostPer100: number;
  popCostPerUnit: number;
  moneyCostPerUnit: number;
  upkeepPerUnit: number;
  prodUpkeepPerUnit: number;
  /** Task #471 — 每單位木材成本（受管理員上限夾限）。 */
  woodCostPerUnit: number;
  /** Task #471 — 每單位礦石成本（受管理員上限夾限）。 */
  oreCostPerUnit: number;
}

export interface UnitClampResult<T extends UnitDesignStats> {
  design: T;
  /** 被夾限的欄位（zh-TW 描述），空陣列 = 無調整。 */
  clamps: string[];
}

/**
 * Task #572 — prodCostPer100 的戰力比例下限基準：預設步兵
 * HP100＋攻100＋防10 = 210 戰力 ⇔ prodCostPer100 = 1。
 */
export const PROD_COST_POWER_BASELINE = 210;

/**
 * 純函式：依戰力（HP＋攻＋防）計算 prodCostPer100 的確定性下限
 * ＝⌈戰力 ÷ 210⌉（至少 1）。這是保守下限——各類別的公平定價
 * （騎兵 10、艦船 100）都高於此線性值，因此永不擋掉合理設計，
 * 只擋「高戰力近乎免費」的漏價（Task #568 起 prodCostPer100
 * 直接閘住招募，AI 提示僅屬建議，必須有伺服器端夾限）。
 */
export function prodCostPowerFloor(
  hp: number,
  attack: number,
  defense: number,
): number {
  const power = Math.max(0, hp) + Math.max(0, attack) + Math.max(0, defense);
  return Math.max(1, Math.ceil(power / PROD_COST_POWER_BASELINE));
}

/**
 * 純函式：把 AI 兵種設計夾進「類別平均 × 倍率上限」＋絕對上下限。
 * 平均樣本為 0（新類別）時只套絕對上下限。成本類套下限、維護費套下限
 * （與系統底線 MIN_UPKEEP_PER_UNIT 取大）。回傳新物件與夾限說明。
 */
export function clampUnitDesign<T extends UnitDesignStats>(
  design: T,
  category: MilitaryCategory,
  averages: UnitCategoryAverages,
  settings: GameBalanceSettings,
): UnitClampResult<T> {
  const u = settings.unitDesign;
  const mult = u.multiplierCaps[category];
  const clamps: string[] = [];
  const out = { ...design };

  const capOf = (avg: number, absMax: number): number => {
    if (averages.count <= 0 || avg <= 0) return absMax;
    return Math.min(absMax, Math.ceil(avg * mult));
  };

  const capInt = (
    field: "hp" | "attack" | "defense",
    avg: number,
    absMax: number,
    label: string,
  ) => {
    const cap = capOf(avg, absMax);
    if (out[field] > cap) {
      clamps.push(`${label} ${out[field]} → ${cap}（上限：類別平均 × ${mult}）`);
      out[field] = cap;
    }
  };
  capInt("hp", averages.hp, u.hpMax, "HP");
  capInt("attack", averages.attack, u.attackMax, "攻擊");
  capInt("defense", averages.defense, u.defenseMax, "防禦");

  const speedCap = Math.min(
    u.speedMax,
    averages.count > 0 && averages.speed > 0
      ? averages.speed * mult
      : u.speedMax,
  );
  if (out.speed > speedCap) {
    clamps.push(`速度 ${out.speed} → ${speedCap}`);
    out.speed = speedCap;
  }

  if (out.moneyCostPerUnit < u.moneyCostMin) {
    clamps.push(`金錢成本 ${out.moneyCostPerUnit} → ${u.moneyCostMin}（下限）`);
    out.moneyCostPerUnit = u.moneyCostMin;
  }
  if (out.prodCostPer100 < u.prodCostPer100Min) {
    clamps.push(
      `生產力成本 ${out.prodCostPer100} → ${u.prodCostPer100Min}（下限）`,
    );
    out.prodCostPer100 = u.prodCostPer100Min;
  }
  // Task #572 — 戰力比例下限（以夾限後的 HP／攻／防計算），防止
  // 高戰力兵種以近乎免費的生產力成本入庫（招募一次性花費被繞過）。
  const powerFloor = prodCostPowerFloor(out.hp, out.attack, out.defense);
  if (out.prodCostPer100 < powerFloor) {
    clamps.push(
      `生產力成本 ${out.prodCostPer100} → ${powerFloor}（下限：戰力 ÷ ${PROD_COST_POWER_BASELINE}）`,
    );
    out.prodCostPer100 = powerFloor;
  }
  if (out.popCostPerUnit < u.popCostMin) {
    clamps.push(`人口成本 ${out.popCostPerUnit} → ${u.popCostMin}（下限）`);
    out.popCostPerUnit = u.popCostMin;
  }

  // Task #471 — 木材／礦石成本上限（防 AI 灌出天價原料需求，卡死招募）。
  if (out.woodCostPerUnit > u.woodCostMax) {
    clamps.push(`木材成本 ${out.woodCostPerUnit} → ${u.woodCostMax}（上限）`);
    out.woodCostPerUnit = u.woodCostMax;
  }
  if (out.oreCostPerUnit > u.oreCostMax) {
    clamps.push(`礦石成本 ${out.oreCostPerUnit} → ${u.oreCostMax}（上限）`);
    out.oreCostPerUnit = u.oreCostMax;
  }

  const upkeepFloor = Math.max(MIN_UPKEEP_PER_UNIT, u.upkeepMin);
  if (out.upkeepPerUnit < upkeepFloor) {
    clamps.push(`金錢維護費 ${out.upkeepPerUnit} → ${upkeepFloor}（下限）`);
    out.upkeepPerUnit = upkeepFloor;
  }
  const prodUpkeepFloor = Math.max(
    MIN_UPKEEP_PER_UNIT,
    u.prodUpkeepPerUnitMin ?? MIN_UPKEEP_PER_UNIT,
  );
  if (out.prodUpkeepPerUnit < prodUpkeepFloor) {
    clamps.push(
      `生產力佔用 ${out.prodUpkeepPerUnit} → ${prodUpkeepFloor}（下限）`,
    );
    out.prodUpkeepPerUnit = prodUpkeepFloor;
  }

  return { design: out, clamps };
}

// ── 戰爭指令懲罰（伺服器確定性套用；絕不新增 AI 損失欄位） ──────

export const WAR_ORDER_FLAG_KINDS = [
  "unreasonable",
  "anachronistic",
  "exploit",
] as const;
export type WarOrderFlagKind = (typeof WAR_ORDER_FLAG_KINDS)[number];

export const WAR_ORDER_FLAG_LABELS: Record<WarOrderFlagKind, string> = {
  unreasonable: "不合理指令",
  anachronistic: "穿越時代指令",
  exploit: "誘導／注入式指令",
};

export interface WarOrderFlag {
  side: "attacker" | "defender";
  orderType: string;
  kind: WarOrderFlagKind;
  reason: string;
}

interface WarPenaltyLegion {
  aggressionPct: number;
}
interface WarPenaltySide {
  legions: WarPenaltyLegion[];
}
export interface WarPenaltyTarget {
  attacker: WarPenaltySide;
  defender: WarPenaltySide;
}

/** Task #547 — 被標旗一方在該次結算額外承受的反噬（伺服器確定性計算）。 */
export interface WarOrderBacklash {
  /** 額外傷亡（該方兵力的 %；套用點仍受戰力硬上限與剩餘兵力封頂）。 */
  extraCasualtyPct: number;
  /** 穩定度下降（百分點）。 */
  stabilityDrop: number;
  /** 暴動值上升（百分點）。 */
  unrestRise: number;
  /** 厭戰度上升（百分點）。 */
  warWearinessRise: number;
  /** 該方是否含 exploit 旗標（exploit 反噬加倍後的旗標，供稽核/通知）。 */
  exploit: boolean;
}

/**
 * 純函式：依旗標把被標旗一方的軍團積極度打折（exploit 再減半），並在
 * exploit 時把對其有利的領土移轉夾回 0（正值＝攻擊方增加）。所有調整
 * 都在既有 schema 界內（0–100／±15），mutate 傳入物件並回傳懲罰摘要。
 *
 * Task #547 — 另外計算反噬：
 *  - 領土反噬 backlashTerritoryPct：往被標旗方不利方向推移（攻方被標旗 →
 *    兩地區移轉值下修；守方被標旗 → 上修），結果夾在 ±15（AI schema 界）。
 *  - 額外傷亡／穩定−／暴動＋／厭戰＋ 以 backlash 物件回傳（由結算端在
 *    交易內套用；本函式不碰資料庫）。exploit 旗標一律加倍（傷亡 % 夾 100、
 *    國家數值百分點夾 100，SQL 端再 clamp 0–100）。
 */
export function applyWarOrderPenalties(
  result: WarPenaltyTarget,
  flags: readonly WarOrderFlag[],
  settings: GameBalanceSettings,
): {
  penalizedSides: ("attacker" | "defender")[];
  backlash: Partial<Record<"attacker" | "defender", WarOrderBacklash>>;
} {
  if (!settings.war.reviewEnabled || flags.length === 0) {
    return { penalizedSides: [], backlash: {} };
  }
  const penalized: ("attacker" | "defender")[] = [];
  const backlash: Partial<
    Record<"attacker" | "defender", WarOrderBacklash>
  > = {};
  for (const side of ["attacker", "defender"] as const) {
    const sideFlags = flags.filter((f) => f.side === side);
    if (sideFlags.length === 0) continue;
    penalized.push(side);
    const hasExploit = sideFlags.some((f) => f.kind === "exploit");
    const basePct = settings.war.penaltyAggressionPct;
    const factor = Math.max(0, Math.min(100, hasExploit ? basePct / 2 : basePct)) / 100;
    for (const legion of result[side].legions) {
      legion.aggressionPct = Math.max(
        0,
        Math.min(100, Math.round(legion.aggressionPct * factor)),
      );
    }
    // Task #625 — territoryShiftPct 已移除（領土由確定性純函式決定）；
    // exploit 的積極度打折已在上面套用，間接影響確定性推進量。
    // Task #547 — 反噬（exploit 一律加倍；各自上限夾住）。
    const mult = hasExploit ? 2 : 1;
    const w = settings.war;
    backlash[side] = {
      extraCasualtyPct: Math.max(
        0,
        Math.min(100, w.backlashExtraCasualtyPct * mult),
      ),
      stabilityDrop: Math.max(0, Math.min(100, w.backlashStabilityDrop * mult)),
      unrestRise: Math.max(0, Math.min(100, w.backlashUnrestRise * mult)),
      warWearinessRise: Math.max(
        0,
        Math.min(100, w.backlashWarWearinessRise * mult),
      ),
      exploit: hasExploit,
    };
  }
  return { penalizedSides: penalized, backlash };
}

/**
 * Task #547 — 純函式：反噬額外傷亡的伺服器決定量。
 * = min(floor(該方兵力 × pct / 100), 既有戰力硬上限, 該方兵力)，永不為負。
 * 上限（cap）沿用 computeCycleCasualties 回傳的對應 casualtyCap，確保
 * 反噬不會讓弱方承受超出戰力邏輯的損失。
 */
export function computeBacklashExtraCasualties(
  troops: number,
  casualtyCap: number,
  extraCasualtyPct: number,
): number {
  if (troops <= 0 || extraCasualtyPct <= 0) return 0;
  const raw = Math.floor((troops * Math.min(100, extraCasualtyPct)) / 100);
  return Math.max(0, Math.min(raw, Math.max(0, casualtyCap), troops));
}

// ── 加減成來源註冊表（套用點夾限） ──────────────────────────────

/**
 * 純函式：套用來源設定到單次增減值。來源停用 → 0；否則夾在
 * [minDelta, maxDelta]。只在「套用點」呼叫（不動 compute helpers）。
 */
export function applyModifierSource(
  source: ModifierSource,
  delta: number,
  settings: GameBalanceSettings,
): number {
  const cfg = settings.modifierSources[source];
  if (!cfg.enabled) return 0;
  return Math.max(cfg.minDelta, Math.min(cfg.maxDelta, delta));
}

/** MILITARY_CATEGORIES re-export（前端顯示用鍵序）。 */
export const UNIT_CATEGORIES = MILITARY_CATEGORIES;
