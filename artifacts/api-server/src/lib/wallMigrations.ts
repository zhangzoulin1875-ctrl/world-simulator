import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import type { WarCity, WarCityState, WallTier } from "@workspace/db";
import { logger } from "./logger";
import { WALL_MAX_DURABILITY } from "./wall";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #150 — 城牆系統的 idempotent 啟動遷移。必須在 runProductionMigrations
 * 之後（本表 FK 依賴 map_cities，且與生產科技的城牆解鎖相關）於遷移鏈末端執行。
 *
 * 兩件事：
 * 1. 建立 city_walls 表（每座城市的城牆階級；未建列 = 木牆預設）。
 * 2. 一次性轉換進行中戰役的 WarCityState jsonb 舊格式
 *    （{cities: string[], holdoutPct, garrisoned}）→ 新格式
 *    （{cities: WarCity[], garrisoned}）。只改寫 cities[0] 仍為字串的列，
 *    以城市名在該地區的 map_cities 對應 cityId；階級一律木牆、耐久由舊
 *    holdoutPct 換算（木牆上限 100 → 耐久 = holdoutPct）。永不寫入 null。
 *
 * 與其他啟動遷移一致：不包 try/catch，失敗必須讓 bootstrap 大聲失敗。
 */
export async function runWallMigrations(): Promise<void> {
  await withTestMigrationStamp("wall", runWallMigrationsInner);
}

async function runWallMigrationsInner(): Promise<void> {
  // ── 城市城牆表（以 city_id 為鍵；任何掌控該城地區者皆可升級） ──
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS city_walls (
      city_id integer PRIMARY KEY
        REFERENCES map_cities(id) ON DELETE CASCADE,
      tier text NOT NULL DEFAULT 'wood',
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  // ── 進行中戰役的 city_state jsonb 舊→新格式轉換（一次性、逐列） ──
  // 只挑 cities 陣列首元素為字串（舊格式）的進行中戰役。
  const legacy = await db.execute<{
    id: number;
    attacker_region_id: number;
    defender_region_id: number;
    attacker_city_state: unknown;
    defender_city_state: unknown;
  }>(sql`
    SELECT id, attacker_region_id, defender_region_id,
           attacker_city_state, defender_city_state
    FROM war_campaigns
    WHERE status = 'active'
      AND (
        jsonb_typeof(attacker_city_state -> 'cities' -> 0) = 'string'
        OR jsonb_typeof(defender_city_state -> 'cities' -> 0) = 'string'
      )
  `);

  const rows = legacy.rows ?? [];
  if (rows.length === 0) {
    logger.info("wall migrations completed (no legacy campaigns)");
    return;
  }

  // 一次撈齊涉及地區的城市名→id 對應（以地區分組）。
  const regionIds = new Set<number>();
  for (const r of rows) {
    regionIds.add(r.attacker_region_id);
    regionIds.add(r.defender_region_id);
  }
  const cityRows = await db.execute<{
    id: number;
    region_id: number;
    name: string;
  }>(sql`
    SELECT id, region_id, name FROM map_cities
    WHERE region_id = ANY(${sql.raw(`ARRAY[${[...regionIds].join(",")}]`)}::int[])
  `);
  const nameToId = new Map<string, number>();
  for (const c of cityRows.rows ?? []) {
    nameToId.set(`${c.region_id}:${c.name}`, c.id);
  }

  const woodMax = WALL_MAX_DURABILITY.wood;
  const wood: WallTier = "wood";

  // 把舊格式 city_state 轉為新格式；無法辨識則回傳 null（永不留下壞格式）。
  const convert = (raw: unknown, regionId: number): WarCityState | null => {
    if (!raw || typeof raw !== "object") return null;
    const old = raw as {
      cities?: unknown;
      holdoutPct?: unknown;
      garrisoned?: unknown;
    };
    if (!Array.isArray(old.cities)) return raw as WarCityState;
    // 已是新格式（物件）→ 原樣返回。
    if (old.cities.length > 0 && typeof old.cities[0] !== "string") {
      return raw as WarCityState;
    }
    const holdout = Math.max(
      0,
      Math.min(100, Math.round(Number(old.holdoutPct ?? 0)) || 0),
    );
    const durability = Math.round((woodMax * holdout) / 100);
    const cities: WarCity[] = [];
    for (const name of old.cities as unknown[]) {
      if (typeof name !== "string") continue;
      const cityId = nameToId.get(`${regionId}:${name}`);
      if (cityId === undefined) continue;
      cities.push({
        cityId,
        name,
        wallTier: wood,
        maxDurability: woodMax,
        durability,
      });
    }
    if (cities.length === 0) return null;
    return { cities, garrisoned: Boolean(old.garrisoned) };
  };

  let converted = 0;
  for (const r of rows) {
    const newAttacker = convert(r.attacker_city_state, r.attacker_region_id);
    const newDefender = convert(r.defender_city_state, r.defender_region_id);
    await db.execute(sql`
      UPDATE war_campaigns
      SET attacker_city_state = ${
        newAttacker ? sql`${JSON.stringify(newAttacker)}::jsonb` : sql`NULL`
      },
          defender_city_state = ${
            newDefender ? sql`${JSON.stringify(newDefender)}::jsonb` : sql`NULL`
          }
      WHERE id = ${r.id}
    `);
    converted += 1;
  }

  logger.info({ converted }, "wall migrations completed");
}
