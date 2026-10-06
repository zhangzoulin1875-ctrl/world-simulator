import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { ERAS, DEFAULT_ERA_SLUG } from "./mapRegionEras";
import { MAP_REGION_AREAS_KM2 } from "./mapRegionAreas.generated";
import { getSeedRows } from "./mapRegions";
import {
  REGION_ASSIGNMENTS,
  type RegionAssignmentSeed,
} from "./mapConstants.generated";

/**
 * 373 區 × 14 時代的模擬數據種子。
 *
 * 產生模型（估算精度，非精確史料）：
 *  - 每個地區指派一個「文明 profile」：14 時代的人口密度曲線（人/km²）
 *    與發展指數曲線（1.0 = 該時代世界平均）。
 *  - population   = 面積 × 密度[時代] × popMult，取 3 位有效數字。
 *  - productivity = 時代平均生產素質 × 發展指數[時代] × devMult。
 *  - techPoints   = 時代平均科技點數 × sqrt(發展指數 × devMult)
 *    （開根號壓縮 → 科技浮動幅度比生產素質小，符合使用者要求）。
 *  - soilFertility 為每區靜態值（新基準 0–120：東亞／南亞大平原最高 120、
 *    沙漠與凍原斷崖式 3–10、歐洲平均 60–80、混合型地區取平均；
 *    詳見 scripts/src/worldmap/regionMaster.ts 的 f 欄位）。
 *  - areaKm2 來自 mapRegionAreas.generated.ts（地圖幾何球面面積）。
 *
 * 種子為冪等 upsert：只改寫實際變動的列，重啟不重複、不漂移。
 */

interface CivProfile {
  /** 人口密度（人/km²），對應 ERAS 順序的 14 個值。 */
  density: readonly number[];
  /** 發展指數（1.0 = 世界平均），對應 ERAS 順序的 14 個值。 */
  dev: readonly number[];
}

/* eslint-disable prettier/prettier */
const PROFILES: Readonly<Record<string, CivProfile>> = {
  // ── 東亞 ──
  china_core: {
    density: [11, 16, 21, 27, 35, 37, 42, 80, 115, 118, 139, 219, 370, 320],
    // 古典/羅馬 1.5/1.6：秦漢與羅馬、安息同級（europe_med 1.5、persia 1.4），
    // 不再獨享全場最高；唐 1.9、宋 2.1 維持世界之巔（史實）。
    dev: [1.5, 1.6, 1.9, 2.1, 1.8, 1.3, 0.9, 0.7, 0.5, 0.45, 0.45, 0.6, 1.3, 1.5],
  },
  china_south: {
    density: [5, 8, 12, 18, 25, 30, 34, 60, 90, 100, 120, 200, 420, 380],
    dev: [1.5, 1.5, 1.7, 1.9, 1.7, 1.2, 0.9, 0.7, 0.5, 0.45, 0.45, 0.65, 1.35, 1.55],
  },
  china_frontier: {
    density: [1.2, 1.8, 2.0, 2.5, 3.2, 3.5, 4, 7.5, 11, 11, 13, 20, 35, 30],
    dev: [1.0, 1.0, 1.1, 1.2, 1.1, 0.8, 0.6, 0.5, 0.4, 0.35, 0.35, 0.5, 1.0, 1.2],
  },
  taiwan: {
    density: [0.5, 0.7, 1, 1.5, 2, 8, 12, 20, 40, 80, 110, 180, 650, 600],
    dev: [0.5, 0.5, 0.6, 0.7, 0.8, 1.0, 0.9, 0.8, 0.7, 0.8, 0.9, 1.3, 2.0, 2.0],
  },
  japan: {
    density: [0.8, 2.6, 13, 18, 40, 79, 79, 82, 85, 138, 190, 275, 330, 240],
    dev: [0.6, 0.7, 0.9, 1.0, 1.0, 0.9, 0.85, 0.85, 0.9, 1.3, 1.5, 2.1, 2.2, 2.0],
  },
  korea_south: {
    density: [2, 5, 9, 14, 18, 27, 32, 41, 50, 77, 105, 180, 350, 300],
    dev: [0.7, 0.8, 1.0, 1.1, 1.0, 0.9, 0.8, 0.75, 0.6, 0.5, 0.5, 0.9, 2.1, 2.0],
  },
  korea_north: {
    density: [2, 5, 9, 14, 18, 27, 32, 41, 50, 77, 105, 160, 200, 170],
    dev: [0.7, 0.8, 1.0, 1.1, 1.0, 0.9, 0.8, 0.75, 0.6, 0.5, 0.6, 0.9, 0.35, 0.4],
  },
  // ── 南亞 / 東南亞 / 大洋洲 ──
  india: {
    density: [10, 17, 17, 20, 25, 30, 36, 45, 52, 70, 90, 155, 400, 430],
    dev: [1.3, 1.3, 1.3, 1.3, 1.2, 1.0, 0.8, 0.7, 0.5, 0.45, 0.45, 0.5, 0.9, 1.2],
  },
  seasia: {
    density: [2, 3, 4, 5, 7, 8, 9, 11, 15, 22, 30, 60, 140, 150],
    dev: [0.7, 0.8, 0.9, 1.0, 1.0, 0.9, 0.8, 0.7, 0.6, 0.55, 0.55, 0.7, 1.1, 1.2],
  },
  seasia_islands: {
    density: [2, 3, 4, 5, 6, 7, 8, 10, 14, 22, 32, 65, 160, 170],
    dev: [0.6, 0.7, 0.8, 0.9, 0.9, 0.85, 0.75, 0.65, 0.55, 0.5, 0.5, 0.65, 1.0, 1.1],
  },
  entrepot: {
    density: [1, 2, 3, 5, 8, 15, 25, 40, 120, 600, 1500, 4500, 14000, 15000],
    dev: [0.7, 0.8, 0.9, 1.0, 1.0, 1.0, 1.0, 1.0, 1.2, 1.6, 1.8, 2.4, 3.0, 2.8],
  },
  oceania: {
    density: [0.03, 0.03, 0.04, 0.04, 0.05, 0.05, 0.06, 0.1, 0.3, 1.0, 1.3, 2.0, 4.0, 5.0],
    dev: [0.2, 0.2, 0.2, 0.2, 0.2, 0.7, 0.9, 1.1, 1.8, 2.2, 2.3, 2.4, 2.3, 2.1],
  },
  // ── 中亞 / 北亞 ──
  steppe: {
    density: [0.8, 1, 1.2, 1.5, 1.5, 1.5, 1.6, 1.8, 2.5, 4, 6, 12, 18, 22],
    dev: [0.8, 0.8, 1.0, 1.1, 0.9, 0.7, 0.6, 0.5, 0.45, 0.5, 0.7, 1.0, 0.9, 0.9],
  },
  siberia: {
    density: [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.15, 0.3, 0.6, 1, 2, 3, 2.8],
    dev: [0.2, 0.2, 0.25, 0.3, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.9, 1.1, 0.9, 0.9],
  },
  arctic: {
    density: [0.005, 0.006, 0.008, 0.01, 0.01, 0.012, 0.015, 0.02, 0.03, 0.06, 0.1, 0.15, 0.2, 0.25],
    dev: [0.15, 0.15, 0.2, 0.2, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.0, 1.0],
  },
  // ── 西亞 ──
  persia: {
    density: [4, 5, 5, 6, 6, 6, 7, 8, 10, 14, 20, 35, 58, 60],
    dev: [1.4, 1.4, 1.5, 1.4, 1.2, 1.0, 0.8, 0.7, 0.5, 0.5, 0.5, 0.8, 0.9, 1.0],
  },
  levant: {
    density: [8, 10, 9, 9, 8, 8, 9, 10, 12, 15, 22, 40, 80, 90],
    dev: [1.6, 1.5, 1.5, 1.3, 1.0, 0.8, 0.7, 0.6, 0.5, 0.5, 0.5, 0.7, 0.8, 0.9],
  },
  mesopotamia: {
    density: [10, 12, 11, 10, 7, 6, 6, 7, 9, 12, 18, 40, 95, 110],
    dev: [1.6, 1.5, 1.5, 1.3, 1.0, 0.8, 0.7, 0.6, 0.5, 0.5, 0.5, 0.7, 0.8, 0.9],
  },
  arabia: {
    density: [1, 1.2, 1.5, 1.5, 1.5, 1.5, 1.5, 1.6, 1.8, 2.2, 3, 8, 20, 25],
    dev: [0.8, 0.8, 1.1, 1.0, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.6, 1.5, 2.0, 1.8],
  },
  caucasus: {
    density: [5, 6, 6, 6, 6, 6, 7, 8, 10, 14, 25, 50, 90, 85],
    dev: [1.0, 1.0, 1.1, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.6, 0.8, 1.1, 0.9, 1.0],
  },
  // ── 非洲 ──
  nile: {
    density: [2, 2.5, 2, 2, 2, 2, 2.2, 2.5, 3.5, 5, 7, 15, 44, 55],
    dev: [1.5, 1.4, 1.3, 1.2, 1.0, 0.8, 0.7, 0.6, 0.5, 0.5, 0.5, 0.6, 0.7, 0.8],
  },
  africa_med: {
    density: [1.5, 2, 1.8, 1.8, 1.8, 1.8, 2, 2.2, 2.8, 4, 6, 14, 30, 38],
    dev: [1.2, 1.3, 1.2, 1.1, 0.9, 0.7, 0.6, 0.55, 0.5, 0.5, 0.5, 0.7, 0.8, 0.9],
  },
  africa_desert: {
    density: [0.05, 0.06, 0.08, 0.1, 0.1, 0.1, 0.1, 0.12, 0.15, 0.2, 0.3, 0.8, 2, 3],
    dev: [0.3, 0.3, 0.4, 0.5, 0.5, 0.4, 0.35, 0.3, 0.25, 0.25, 0.3, 0.5, 0.6, 0.7],
  },
  africa_sub: {
    density: [1, 1.2, 1.5, 2, 2.5, 2.8, 3, 3.2, 3.5, 4.5, 6, 14, 50, 90],
    dev: [0.5, 0.5, 0.6, 0.7, 0.7, 0.6, 0.5, 0.45, 0.35, 0.3, 0.3, 0.35, 0.45, 0.7],
  },
  // ── 歐洲 ──
  europe_west: {
    density: [4, 6, 6, 9, 12, 15, 17, 22, 40, 60, 65, 80, 150, 140],
    dev: [0.8, 1.0, 0.8, 0.9, 1.2, 1.5, 1.9, 2.1, 2.6, 2.6, 2.3, 2.0, 1.9, 1.8],
  },
  europe_med: {
    density: [8, 10, 8, 10, 13, 15, 16, 20, 30, 42, 50, 65, 105, 95],
    dev: [1.5, 1.7, 1.0, 1.1, 1.5, 1.3, 1.2, 1.1, 1.0, 1.1, 1.1, 1.3, 1.4, 1.3],
  },
  europe_central: {
    density: [3, 4, 5, 7, 10, 12, 14, 18, 32, 55, 65, 80, 110, 100],
    dev: [0.7, 0.8, 0.8, 0.9, 1.1, 1.2, 1.4, 1.6, 2.2, 2.4, 2.2, 1.6, 1.8, 1.7],
  },
  europe_east: {
    density: [1, 1.5, 2, 2.5, 3.5, 4.5, 5.5, 7, 12, 20, 25, 32, 40, 38],
    dev: [0.5, 0.6, 0.6, 0.7, 0.8, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.7, 1.2, 1.2],
  },
  scandinavia: {
    density: [0.3, 0.5, 0.8, 1, 1.5, 2, 2.5, 3, 5, 8, 10, 14, 18, 20],
    dev: [0.4, 0.5, 0.7, 0.8, 0.9, 1.0, 1.2, 1.3, 1.6, 1.9, 2.0, 2.2, 2.2, 2.0],
  },
  // ── 美洲 ──
  north_america: {
    density: [0.3, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 1, 4, 16, 22, 34, 55, 60],
    dev: [0.2, 0.2, 0.2, 0.25, 0.25, 0.9, 1.1, 1.3, 2.2, 2.9, 3.1, 3.2, 2.9, 2.6],
  },
  mesoamerica: {
    density: [4, 5, 6, 7, 9, 3.5, 4, 5, 7, 10, 13, 25, 70, 80],
    dev: [0.9, 1.0, 1.1, 1.1, 1.1, 0.7, 0.7, 0.7, 0.7, 0.7, 0.8, 0.9, 1.0, 1.1],
  },
  andes: {
    density: [2, 2.5, 3, 3.5, 5, 2, 2.2, 2.5, 3.5, 5, 7, 12, 25, 30],
    dev: [0.8, 0.9, 1.0, 1.0, 1.1, 0.7, 0.7, 0.65, 0.6, 0.6, 0.7, 0.8, 0.9, 1.0],
  },
  latam_temperate: {
    density: [0.15, 0.2, 0.25, 0.3, 0.35, 0.6, 0.8, 1.2, 3, 8, 12, 18, 28, 32],
    dev: [0.2, 0.2, 0.25, 0.3, 0.3, 0.7, 0.9, 1.0, 1.4, 1.8, 1.7, 1.4, 1.2, 1.2],
  },
  latam_tropical: {
    density: [0.8, 1, 1.2, 1.5, 1.8, 1.5, 1.8, 2.5, 5, 9, 14, 28, 60, 70],
    dev: [0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0, 1.0, 1.0, 1.0, 1.1],
  },
  amazon_frontier: {
    density: [0.1, 0.12, 0.15, 0.18, 0.2, 0.15, 0.18, 0.25, 0.5, 1, 2, 4, 8, 10],
    dev: [0.2, 0.2, 0.25, 0.3, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  },
  // ── 虛構陸地 ──
  // 姆大陸：太平洋中央的新開拓地（無歷史文明包袱，人少地多）。古典約占全球人口 1.2%，
  // 二戰時期升到約 3.9%，現代回落至約 2.6%（約一個巴基斯坦）；發展指數中性偏低，不是最佳開局。
  mu: {
    density: [0.3, 0.4, 0.5, 0.6, 0.8, 1.1, 1.6, 2.3, 4.2, 7, 10, 16, 24, 27],
    dev: [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1.0, 1.05, 1.1],
  },
};
/* eslint-enable prettier/prettier */

/**
 * 373 區 → profile / 肥沃度 / 倍率（由 mapConstants.generated.ts 產生）。
 * 名稱必須與 MAP_REGION_SEED 完全一致；profile 名稱須存在於 PROFILES
 * （由 validateEraStatSeed() 於啟動時檢查）。
 */
export { REGION_ASSIGNMENTS };
export type RegionAssignment = RegionAssignmentSeed;

/** 取 3 位有效數字（人口用，避免假精度）。 */
function roundSig3(n: number): number {
  if (n <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 2);
  return Math.round(n / mag) * mag;
}

export interface EraStatRow {
  name: string;
  era: string;
  population: number;
  productivity: number;
  techPoints: number;
}

export interface RegionStaticRow {
  name: string;
  soilFertility: number;
  areaKm2: number;
}

/** 驗證指派表：與地區種子完全一致、面積齊全、profile 曲線長度正確。 */
export function validateEraStatSeed(): void {
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (profile.density.length !== ERAS.length) {
      throw new Error(`era stats seed: profile ${name} density length mismatch`);
    }
    if (profile.dev.length !== ERAS.length) {
      throw new Error(`era stats seed: profile ${name} dev length mismatch`);
    }
  }
  const seedNames = new Set(getSeedRows().map((r) => r.name));
  const assignedNames = new Set(Object.keys(REGION_ASSIGNMENTS));
  for (const n of seedNames) {
    if (!assignedNames.has(n)) {
      throw new Error(`era stats seed: region ${n} missing assignment`);
    }
    if (!(n in MAP_REGION_AREAS_KM2)) {
      throw new Error(`era stats seed: region ${n} missing area`);
    }
  }
  for (const n of assignedNames) {
    if (!seedNames.has(n)) {
      throw new Error(`era stats seed: assignment for unknown region ${n}`);
    }
    const p = REGION_ASSIGNMENTS[n]!.p;
    if (!(p in PROFILES)) {
      throw new Error(`era stats seed: region ${n} 使用未知 profile ${p}`);
    }
  }
}

export function getRegionStaticRows(): RegionStaticRow[] {
  return Object.entries(REGION_ASSIGNMENTS).map(([name, a]) => ({
    name,
    soilFertility: a.f,
    areaKm2: MAP_REGION_AREAS_KM2[name]!,
  }));
}

export function generateEraStatRows(): EraStatRow[] {
  const rows: EraStatRow[] = [];
  for (const [name, a] of Object.entries(REGION_ASSIGNMENTS)) {
    const profile = PROFILES[a.p]!;
    const area = MAP_REGION_AREAS_KM2[name]!;
    const pm = a.pm ?? 1;
    const dm = a.dm ?? 1;
    ERAS.forEach((era, i) => {
      const population = Math.max(100, roundSig3(area * profile.density[i]! * pm));
      const devTotal = profile.dev[i]! * dm;
      const productivity = Math.max(1, Math.round(era.prodAvg * devTotal));
      const techPoints = Math.max(1, Math.round(era.techAvg * Math.sqrt(devTotal)));
      rows.push({ name, era: era.slug, population, productivity, techPoints });
    });
  }
  return rows;
}

/**
 * 冪等啟動同步：建表、補欄位、寫入靜態屬性與 2828 筆時代數據、
 * 初始化全域遊戲時代。必須在 runMapRegionSync() 之後執行。
 */
export async function runMapRegionEraStatsSync(): Promise<void> {
  validateEraStatSeed();

  await db.execute(sql`
    ALTER TABLE map_regions ADD COLUMN IF NOT EXISTS soil_fertility integer
  `);
  await db.execute(sql`
    ALTER TABLE map_regions ADD COLUMN IF NOT EXISTS area_km2 integer
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS map_region_era_stats (
      id serial PRIMARY KEY,
      region_id integer NOT NULL,
      era text NOT NULL,
      population integer NOT NULL,
      productivity integer NOT NULL,
      tech_points integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT map_region_era_stats_region_id_map_regions_id_fk
        FOREIGN KEY (region_id) REFERENCES map_regions(id) ON DELETE CASCADE
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS map_region_era_stats_region_era_uidx
      ON map_region_era_stats (region_id, era)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS world_game_state (
      id integer PRIMARY KEY DEFAULT 1,
      current_era text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    INSERT INTO world_game_state (id, current_era)
    VALUES (1, ${DEFAULT_ERA_SLUG})
    ON CONFLICT (id) DO NOTHING
  `);
  // Task #21: 全域遊戲日期（年/月/日），預設 1900-01-01。之後由管理員以 SQL
  // 修改；推進機制尚未實作。Add-only — 此欄位不可在後續遷移中 DROP。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS game_date date NOT NULL DEFAULT '1900-01-01'
  `);

  // 回合引擎（turnEngine.ts）：每日自動回合的時間設定、每回合年數、
  // 金錢收入比例，與「今日已執行」的持久化防重旗標。Add-only。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS turn_hour integer NOT NULL DEFAULT 18,
      ADD COLUMN IF NOT EXISTS turn_minute integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS years_per_turn integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS money_income_pct integer NOT NULL DEFAULT 10,
      ADD COLUMN IF NOT EXISTS last_turn_date text
  `);
  // 全局開銷旋鈕(線性 10–500、函數 0–200;預設 100 = 現狀)。
  // 必須放在這裡(建表處、啟動鏈最前面),不能只放後面的 runWorldSimMigrations:
  // drizzle 的 select() 會帶上 schema 裡「所有」欄位,啟動鏈中排在 runWorldSimMigrations
  // 之前的步驟(例如 recalcArmyProductionReservations)一讀這張表,欄位還沒加就整串失敗,
  // 而正式環境遷移失敗只記錄後繼續服務 → 後面的遷移永遠不跑 → 欄位永遠加不上,
  // 所有讀 world_game_state 的請求(首頁 /player/nation 等)全部 500。
  // 規則:凡是加進 worldGameStateTable 的新欄位,ALTER 一律放在此處。Add-only。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS cost_linear_pct integer NOT NULL DEFAULT 100
        CHECK (cost_linear_pct >= 10 AND cost_linear_pct <= 500)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS cost_curve_pct integer NOT NULL DEFAULT 100
        CHECK (cost_curve_pct >= 0 AND cost_curve_pct <= 200)
  `);
  // 「數據時代」stats_era：玩家數據計算所用時代（見 schema 註解）。Add-only。
  // 回填為 current_era（僅 NULL 時，冪等）。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS stats_era text
  `);
  await db.execute(sql`
    UPDATE world_game_state
    SET stats_era = current_era
    WHERE id = 1 AND stats_era IS NULL
  `);

  // Task #289 — 每日多時段回合排程：時刻清單（jsonb）＋最後實際執行時刻
  // （timestamptz，多時段防重依據）。Add-only（不可 DROP）。turn_times 先以
  // 可空欄位新增、由既有 turn_hour/turn_minute 一次性回填（僅 NULL 列），
  // 再設定預設值與 NOT NULL——此模式天然冪等，回填只發生一次、不覆寫管理員編輯。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS turn_times jsonb,
      ADD COLUMN IF NOT EXISTS last_turn_at timestamptz
  `);
  await db.execute(sql`
    UPDATE world_game_state
    SET turn_times = jsonb_build_array(
      jsonb_build_object('hour', turn_hour, 'minute', turn_minute)
    )
    WHERE turn_times IS NULL
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ALTER COLUMN turn_times SET DEFAULT '[{"hour":18,"minute":0}]'::jsonb
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ALTER COLUMN turn_times SET NOT NULL
  `);
  // 一次性自我修正：舊資料的 game_date 預設 1900-01-01 與 current_era
  // 'classical' 互相矛盾（回合引擎會依年份推導時代，1900 年會把世界從古典
  // 直接跳到一戰、數值暴增）。僅在「兩者皆為未動過的預設值」時把日期拉回
  // 古典時代起點；任一值被管理員改過就不碰。冪等：修正後條件不再成立。
  await db.execute(sql`
    UPDATE world_game_state
    SET game_date = '0001-01-01', updated_at = NOW()
    WHERE id = 1 AND current_era = 'classical' AND game_date = '1900-01-01'
  `);

  // ── Task #504 — 開局資源設定：自創建國時新國家獲得的初始科技點數／金錢。
  // 管理員於「發放資源」頁調整；接手無主國家與 NPC 生成不受影響。Add-only。
  // 上限與發放資源一致（科技點 int4、金錢 int8），避免溢位。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS starting_tech_points integer NOT NULL DEFAULT 200
        CHECK (starting_tech_points >= 0 AND starting_tech_points <= 2000000000),
      ADD COLUMN IF NOT EXISTS starting_money bigint NOT NULL DEFAULT 5000
        CHECK (starting_money >= 0 AND starting_money <= 1000000000000000)
  `);

  // 開局領土生產力上限：選 2–3 塊起始地區時的生產力（productivity × population / 1,000,000）
  // 加總上限；選 1 塊不受限。管理員於「發放資源」頁調整（預設 10,000）。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS founding_production_cap integer NOT NULL DEFAULT 10000
        CHECK (founding_production_cap >= 0 AND founding_production_cap <= 1000000000)
  `);

  // 靜態屬性（肥沃度/面積）：只更新有變動的列。
  const staticRows = getRegionStaticRows();
  await db.execute(sql`
    UPDATE map_regions r
    SET soil_fertility = (e->>'soilFertility')::int,
        area_km2 = (e->>'areaKm2')::int,
        updated_at = NOW()
    FROM jsonb_array_elements(${JSON.stringify(staticRows)}::jsonb) AS e
    WHERE r.name = e->>'name'
      AND (r.soil_fertility IS DISTINCT FROM (e->>'soilFertility')::int
        OR r.area_km2 IS DISTINCT FROM (e->>'areaKm2')::int)
  `);

  // 時代數據：一次 upsert，只改寫實際變動的列。
  const eraRows = generateEraStatRows();
  await db.execute(sql`
    INSERT INTO map_region_era_stats (region_id, era, population, productivity, tech_points)
    SELECT r.id, e->>'era', (e->>'population')::int,
           (e->>'productivity')::int, (e->>'techPoints')::int
    FROM jsonb_array_elements(${JSON.stringify(eraRows)}::jsonb) AS e
    JOIN map_regions r ON r.name = e->>'name'
    ON CONFLICT (region_id, era) DO UPDATE
      SET population = EXCLUDED.population,
          productivity = EXCLUDED.productivity,
          tech_points = EXCLUDED.tech_points,
          updated_at = NOW()
      WHERE (map_region_era_stats.population,
             map_region_era_stats.productivity,
             map_region_era_stats.tech_points)
        IS DISTINCT FROM
            (EXCLUDED.population, EXCLUDED.productivity, EXCLUDED.tech_points)
  `);

  // 移除不再存在的時代列（例如時代 slug 改名後的殘留）。
  const validSlugs = ERAS.map((e) => e.slug);
  const stale = await db.execute(sql`
    DELETE FROM map_region_era_stats
    WHERE era NOT IN (
      SELECT jsonb_array_elements_text(${JSON.stringify(validSlugs)}::jsonb)
    )
    RETURNING id
  `);
  if (stale.rows.length > 0) {
    logger.warn(
      { removed: stale.rows.length },
      "era stats sync: removed stale era rows",
    );
  }

  const summary = await db.execute<{ stats: number; regions_with_area: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM map_region_era_stats) AS stats,
      (SELECT count(*)::int FROM map_regions WHERE area_km2 IS NOT NULL) AS regions_with_area
  `);
  logger.info(
    summary.rows[0] as Record<string, number>,
    "map region era stats sync complete",
  );
}
