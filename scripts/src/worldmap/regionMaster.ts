/**
 * 地圖二代 — 373 區世界地圖「唯一真實來源」（single source of truth）。
 *
 * 每一區包含：名稱、所屬大地區（macro）、代表座標（seed）、涵蓋的國家代碼
 * （adm0_a3）、文明 profile、土壤肥沃度 f、人口倍率 pm、發展倍率 dm。
 *
 * 建置流程（buildWorldDistricts.ts）：
 *  - 一般區：以「最近 seed」將各國 admin-1 單元指派給同國候選區（乾淨海岸線、
 *    自動分割一國內多區、自動全覆蓋）。距離門檻與排除框剔除海外屬地／亞洲俄羅斯。
 *  - 中國 42 區：admin-1 只有 32 省 < 42 區，故以 bbox 裁切（Sutherland–Hodgman）
 *    近似切割省份（使用者已同意「較不精緻」）。興安漠北改以 seed 覆蓋蒙古(MNG)。
 *
 * 產生器（generateMapConstants.ts）在建置後讀取 topo + 本表，輸出：
 *  MAP_REGION_SEED、REGION_ASSIGNMENTS、面積、鄰接、孤立集合、城市重指派。
 *
 * 名稱一致性鏈：本表名稱 = topo district = 面積 = 種子 = era 指派 = 城市引用。
 */

export interface SeedRegion {
  name: string;
  macro: string;
  /** 代表點經度。 */
  lon: number;
  /** 代表點緯度。 */
  lat: number;
  /** 涵蓋的國家 adm0_a3 代碼（該國單元指派給最近的候選區）。虛構陸地（姆大陸）為空陣列。 */
  countries: readonly string[];
  /** 文明 profile（對應 mapRegionEraStats.PROFILES）。 */
  profile: string;
  /** 土壤肥沃度（靜態）。 */
  f: number;
  /** 人口密度倍率（預設 1）。 */
  pm?: number;
  /** 發展指數倍率（預設 1）。 */
  dm?: number;
  /**
   * 若提供，改以「指定 admin-1 單元 + bbox 裁切」取得幾何（取代最近-seed），
   * 且此區不參與最近-seed 候選。用於切割單一大單元（如加州拆南／北）。
   */
  clipUnits?: readonly ClipUnitRef[];
}

/** 裁切單元參照：指定某國某 admin-1 單元，可選 bbox 裁切。 */
export interface ClipUnitRef {
  /** admin-1 所屬國家 adm0_a3。 */
  country: string;
  /** Natural Earth admin-1 name。 */
  name: string;
  /** 裁切 bbox [minLon,minLat,maxLon,maxLat]（省略則取整個單元）。 */
  clip?: readonly [number, number, number, number];
}

export interface ChinaProvinceRef {
  /** CHN admin-1 name（Natural Earth）。 */
  name: string;
  /** 若提供，將該省幾何裁切到此 bbox [minLon,minLat,maxLon,maxLat]。 */
  clip?: readonly [number, number, number, number];
}

export interface ChinaRegion {
  name: string;
  provinces: readonly ChinaProvinceRef[];
  profile: string;
  f: number;
  pm?: number;
  dm?: number;
}

/** 排除框：落在框內（centroid）的該國單元不畫（灰底）。用於亞洲俄羅斯。 */
export interface ExcludeBox {
  country: string;
  /** [minLon,minLat,maxLon,maxLat]；centroid 落入即排除。 */
  box: readonly [number, number, number, number];
}

/** 最近 seed 指派的距離門檻（公里）；超過則不指派（灰底），用於剔除海外屬地。 */
export const MAX_ASSIGN_KM = 1400;

export const EXCLUDE_BOXES: readonly ExcludeBox[] = [];

/* eslint-disable prettier/prettier */
export const SEED_REGIONS: readonly SeedRegion[] = [
  // ══════════════ 非洲 (32) ══════════════
  { name: "埃及尼羅", macro: "非洲", lon: 31, lat: 27, countries: ["EGY"], profile: "nile", f: 65, pm: 1.1 },
  { name: "利比亞岸", macro: "非洲", lon: 18, lat: 31, countries: ["LBY"], profile: "africa_med", f: 15, pm: 0.9 },
  { name: "阿特拉斯", macro: "非洲", lon: 3, lat: 35, countries: ["MAR", "DZA", "TUN"], profile: "africa_med", f: 55, pm: 1.2 },
  { name: "撒哈拉西", macro: "非洲", lon: -8, lat: 24, countries: ["MAR", "MRT", "DZA"], profile: "africa_desert", f: 5, pm: 0.7 },
  { name: "撒哈拉中", macro: "非洲", lon: 3, lat: 21, countries: ["DZA", "MLI", "NER"], profile: "africa_desert", f: 4 },
  { name: "撒哈拉東", macro: "非洲", lon: 20, lat: 22, countries: ["LBY", "TCD", "EGY", "SDN"], profile: "africa_desert", f: 4 },
  { name: "薩赫爾西", macro: "非洲", lon: -4, lat: 15, countries: ["MLI", "BFA", "SEN", "MRT"], profile: "africa_sub", f: 25 },
  { name: "薩赫爾東", macro: "非洲", lon: 15, lat: 14, countries: ["NER", "TCD", "SDN"], profile: "africa_sub", f: 20 },
  { name: "幾內亞灣", macro: "非洲", lon: 1, lat: 7, countries: ["GHA", "CIV", "TGO", "BEN"], profile: "africa_sub", f: 85, pm: 1.3 },
  { name: "奈及利亞", macro: "非洲", lon: 8, lat: 9, countries: ["NGA"], profile: "africa_sub", f: 80, pm: 1.6 },
  { name: "富塔賈隆", macro: "非洲", lon: -11, lat: 10, countries: ["GIN", "SLE", "LBR", "GNB"], profile: "africa_sub", f: 60 },
  { name: "塞內甘比", macro: "非洲", lon: -15, lat: 15, countries: ["SEN", "GMB"], profile: "africa_sub", f: 45 },
  { name: "剛果河口", macro: "非洲", lon: 14, lat: -5, countries: ["COG", "GAB", "AGO"], profile: "africa_sub", f: 65 },
  { name: "剛果盆地", macro: "非洲", lon: 23, lat: 0, countries: ["COD", "CAF"], profile: "africa_sub", f: 70 },
  { name: "加丹加高", macro: "非洲", lon: 27, lat: -10, countries: ["COD", "ZMB"], profile: "africa_sub", f: 45 },
  { name: "中非高原", macro: "非洲", lon: 20, lat: 6, countries: ["CAF", "CMR"], profile: "africa_sub", f: 50 },
  { name: "安哥拉北", macro: "非洲", lon: 17, lat: -10, countries: ["AGO"], profile: "africa_sub", f: 50 },
  { name: "非洲之角", macro: "非洲", lon: 46, lat: 6, countries: ["SOM", "DJI", "SOL"], profile: "africa_sub", f: 12 },
  { name: "厄利垂亞", macro: "非洲", lon: 39, lat: 15.5, countries: ["ERI"], profile: "africa_sub", f: 15 },
  { name: "衣索比亞", macro: "非洲", lon: 39, lat: 9, countries: ["ETH"], profile: "africa_sub", f: 75, pm: 1.4 },
  { name: "大湖區北", macro: "非洲", lon: 33, lat: 0, countries: ["UGA", "KEN", "RWA", "BDI"], profile: "africa_sub", f: 90, pm: 1.4 },
  { name: "大湖區南", macro: "非洲", lon: 34, lat: -6, countries: ["TZA"], profile: "africa_sub", f: 65 },
  { name: "馬拉威河", macro: "非洲", lon: 34, lat: -13, countries: ["MWI"], profile: "africa_sub", f: 60 },
  { name: "蘇丹草原", macro: "非洲", lon: 30, lat: 13, countries: ["SDN"], profile: "africa_sub", f: 40 },
  { name: "南蘇丹", macro: "非洲", lon: 30.5, lat: 7, countries: ["SDS"], profile: "africa_sub", f: 55, pm: 1.1 },
  { name: "尚比西河", macro: "非洲", lon: 28, lat: -16, countries: ["ZMB", "ZWE"], profile: "africa_sub", f: 45 },
  { name: "喀拉哈里", macro: "非洲", lon: 23, lat: -22, countries: ["BWA"], profile: "africa_desert", f: 8 },
  { name: "西南非洲", macro: "非洲", lon: 16, lat: -22, countries: ["NAM"], profile: "africa_desert", f: 6 },
  { name: "莫三比克", macro: "非洲", lon: 36, lat: -18, countries: ["MOZ"], profile: "africa_sub", f: 50 },
  { name: "南非德蘭", macro: "非洲", lon: 28, lat: -26, countries: ["ZAF", "SWZ", "LSO"], profile: "africa_sub", f: 55, pm: 1.2 },
  { name: "南非開普", macro: "非洲", lon: 22, lat: -32, countries: ["ZAF"], profile: "africa_med", f: 45 },
  { name: "馬達加斯", macro: "非洲", lon: 47, lat: -19, countries: ["MDG"], profile: "africa_sub", f: 50 },

  // ══════════════ 西歐 (44) ══════════════
  // 英國 (12)
  { name: "蘇格蘭高地", macro: "西歐", lon: -4.5, lat: 57.3, countries: ["GBR"], profile: "europe_west", f: 30 },
  { name: "蘇格蘭低地", macro: "西歐", lon: -3.8, lat: 55.9, countries: ["GBR"], profile: "europe_west", f: 65 },
  { name: "北愛爾蘭區", macro: "西歐", lon: -6.5, lat: 54.6, countries: ["GBR"], profile: "europe_west", f: 60 },
  { name: "北威爾斯", macro: "西歐", lon: -3.8, lat: 53.1, countries: ["GBR"], profile: "europe_west", f: 45 },
  { name: "南威爾斯", macro: "西歐", lon: -3.4, lat: 51.7, countries: ["GBR"], profile: "europe_west", f: 55 },
  { name: "大倫敦地區", macro: "西歐", lon: -0.1, lat: 51.5, countries: ["GBR"], profile: "europe_west", f: 80, pm: 2.2 },
  { name: "東英格蘭", macro: "西歐", lon: 0.6, lat: 52.4, countries: ["GBR"], profile: "europe_west", f: 90 },
  { name: "西南英格蘭", macro: "西歐", lon: -3.5, lat: 50.8, countries: ["GBR"], profile: "europe_west", f: 70 },
  { name: "西密德蘭", macro: "西歐", lon: -2.0, lat: 52.5, countries: ["GBR"], profile: "europe_west", f: 75, pm: 1.3 },
  { name: "約克郡亨伯", macro: "西歐", lon: -1.3, lat: 53.8, countries: ["GBR"], profile: "europe_west", f: 75, pm: 1.2 },
  { name: "西北英格蘭", macro: "西歐", lon: -2.7, lat: 53.6, countries: ["GBR"], profile: "europe_west", f: 65, pm: 1.4 },
  { name: "東北英格蘭", macro: "西歐", lon: -1.7, lat: 54.9, countries: ["GBR"], profile: "europe_west", f: 60 },
  // 法國 (16)
  { name: "法蘭西島", macro: "西歐", lon: 2.4, lat: 48.8, countries: ["FRA"], profile: "europe_west", f: 90, pm: 2.4 },
  { name: "上法蘭西", macro: "西歐", lon: 2.9, lat: 50.2, countries: ["FRA"], profile: "europe_west", f: 90, pm: 1.3 },
  { name: "諾曼第大區", macro: "西歐", lon: 0.2, lat: 49.1, countries: ["FRA"], profile: "europe_west", f: 80 },
  { name: "布列塔尼", macro: "西歐", lon: -3.0, lat: 48.2, countries: ["FRA"], profile: "europe_west", f: 70 },
  { name: "羅亞爾河", macro: "西歐", lon: -1.2, lat: 47.4, countries: ["FRA"], profile: "europe_west", f: 80 },
  { name: "盧瓦爾河谷", macro: "西歐", lon: 0.9, lat: 47.3, countries: ["FRA"], profile: "europe_west", f: 85 },
  { name: "中央羅亞爾河", macro: "西歐", lon: 2.0, lat: 47.9, countries: ["FRA"], profile: "europe_west", f: 85 },
  { name: "新阿基坦", macro: "西歐", lon: -0.5, lat: 45.0, countries: ["FRA"], profile: "europe_west", f: 75 },
  { name: "奧克西塔尼", macro: "西歐", lon: 2.0, lat: 43.8, countries: ["FRA"], profile: "europe_med", f: 60 },
  { name: "普羅旺斯阿爾", macro: "西歐", lon: 6.0, lat: 43.9, countries: ["FRA"], profile: "europe_med", f: 50 },
  { name: "奧弗涅隆阿爾", macro: "西歐", lon: 3.2, lat: 45.5, countries: ["FRA"], profile: "europe_west", f: 55 },
  { name: "羅訥隆河谷", macro: "西歐", lon: 4.9, lat: 45.4, countries: ["FRA"], profile: "europe_west", f: 70, pm: 1.3 },
  { name: "勃艮第法蘭琪", macro: "西歐", lon: 5.2, lat: 47.2, countries: ["FRA"], profile: "europe_west", f: 70 },
  { name: "大東部大區", macro: "西歐", lon: 7.2, lat: 48.6, countries: ["FRA"], profile: "europe_west", f: 75 },
  { name: "中北部香檳", macro: "西歐", lon: 4.3, lat: 48.8, countries: ["FRA"], profile: "europe_west", f: 80 },
  { name: "科西嘉島", macro: "西歐", lon: 9.1, lat: 42.2, countries: ["FRA"], profile: "europe_med", f: 30 },
  // 德奧瑞 (13)
  { name: "巴伐利亞邦", macro: "西歐", lon: 11.5, lat: 48.9, countries: ["DEU"], profile: "europe_central", f: 70, pm: 1.3 },
  { name: "巴登符騰堡", macro: "西歐", lon: 9.0, lat: 48.6, countries: ["DEU"], profile: "europe_central", f: 70, pm: 1.4 },
  { name: "北萊茵西發", macro: "西歐", lon: 7.2, lat: 51.4, countries: ["DEU"], profile: "europe_central", f: 75, pm: 2.0 },
  { name: "下薩克森邦", macro: "西歐", lon: 9.5, lat: 52.7, countries: ["DEU"], profile: "europe_central", f: 80 },
  { name: "黑森萊茵", macro: "西歐", lon: 8.3, lat: 50.1, countries: ["DEU"], profile: "europe_central", f: 70, pm: 1.4 },
  { name: "布蘭登堡", macro: "西歐", lon: 13.4, lat: 52.4, countries: ["DEU"], profile: "europe_central", f: 55, pm: 1.3 },
  { name: "北德沿海", macro: "西歐", lon: 10.0, lat: 54.0, countries: ["DEU"], profile: "europe_central", f: 65, pm: 1.2 },
  { name: "薩克森圖林", macro: "西歐", lon: 12.2, lat: 51.1, countries: ["DEU"], profile: "europe_central", f: 75 },
  { name: "西瑞士", macro: "西歐", lon: 6.6, lat: 46.5, countries: ["CHE"], profile: "europe_central", f: 50 },
  { name: "東瑞士", macro: "西歐", lon: 8.7, lat: 47.3, countries: ["CHE"], profile: "europe_central", f: 45, pm: 1.3 },
  { name: "下奧地利", macro: "西歐", lon: 15.9, lat: 48.3, countries: ["AUT"], profile: "europe_central", f: 65, pm: 1.3 },
  { name: "薩爾斯堡", macro: "西歐", lon: 13.0, lat: 47.6, countries: ["AUT"], profile: "europe_central", f: 30 },
  { name: "奧地利南部", macro: "西歐", lon: 14.8, lat: 46.9, countries: ["AUT"], profile: "europe_central", f: 40 },
  // 低地國與愛爾蘭 (3)
  { name: "荷蘭", macro: "西歐", lon: 5.3, lat: 52.2, countries: ["NLD"], profile: "europe_west", f: 85, pm: 1.8 },
  { name: "比利時", macro: "西歐", lon: 4.5, lat: 50.6, countries: ["BEL", "LUX"], profile: "europe_west", f: 80, pm: 1.6 },
  { name: "愛爾蘭", macro: "西歐", lon: -8.0, lat: 53.2, countries: ["IRL"], profile: "europe_west", f: 60 },

  // ══════════════ 北歐 (10) ══════════════
  { name: "斯德哥爾摩", macro: "北歐", lon: 18.0, lat: 59.3, countries: ["SWE"], profile: "scandinavia", f: 45, pm: 1.6 },
  { name: "哥德堡", macro: "北歐", lon: 12.5, lat: 57.7, countries: ["SWE"], profile: "scandinavia", f: 50 },
  { name: "瑞典北部諾爾蘭", macro: "北歐", lon: 17.5, lat: 64.5, countries: ["SWE"], profile: "scandinavia", f: 10 },
  { name: "奧斯陸", macro: "北歐", lon: 10.7, lat: 59.9, countries: ["NOR"], profile: "scandinavia", f: 40, pm: 1.4 },
  { name: "卑爾根沿海", macro: "北歐", lon: 6.5, lat: 60.6, countries: ["NOR"], profile: "scandinavia", f: 20 },
  { name: "挪威北部", macro: "北歐", lon: 18.0, lat: 68.5, countries: ["NOR"], profile: "scandinavia", f: 8 },
  { name: "赫爾辛基", macro: "北歐", lon: 25.0, lat: 60.5, countries: ["FIN"], profile: "scandinavia", f: 40, pm: 1.3 },
  { name: "芬蘭拉普蘭", macro: "北歐", lon: 26.0, lat: 66.0, countries: ["FIN"], profile: "scandinavia", f: 8 },
  { name: "哥本哈根", macro: "北歐", lon: 12.0, lat: 55.7, countries: ["DNK"], profile: "scandinavia", f: 75, pm: 1.6 },
  { name: "冰島", macro: "北歐", lon: -19.0, lat: 64.9, countries: ["ISL"], profile: "scandinavia", f: 10 },

  // ══════════════ 東歐 (35) ══════════════
  { name: "基輔", macro: "東歐", lon: 30.5, lat: 50.4, countries: ["UKR"], profile: "europe_east", f: 100, pm: 1.4 },
  { name: "西烏克蘭", macro: "東歐", lon: 24.5, lat: 49.5, countries: ["UKR"], profile: "europe_east", f: 90 },
  { name: "東烏克蘭", macro: "東歐", lon: 37.5, lat: 48.5, countries: ["UKR"], profile: "europe_east", f: 95, pm: 1.2 },
  { name: "南烏克蘭", macro: "東歐", lon: 32.5, lat: 46.8, countries: ["UKR"], profile: "europe_east", f: 95 },
  { name: "克里米亞", macro: "東歐", lon: 34.2, lat: 45.2, countries: ["UKR", "RUS"], profile: "europe_east", f: 60 },
  { name: "明斯克", macro: "東歐", lon: 27.5, lat: 53.9, countries: ["BLR"], profile: "europe_east", f: 55, pm: 1.2 },
  { name: "白俄羅斯東", macro: "東歐", lon: 30.3, lat: 53.3, countries: ["BLR"], profile: "europe_east", f: 50 },
  { name: "摩爾多瓦", macro: "東歐", lon: 28.6, lat: 47.2, countries: ["MDA"], profile: "europe_east", f: 90 },
  { name: "愛沙尼亞", macro: "東歐", lon: 25.5, lat: 58.7, countries: ["EST"], profile: "europe_east", f: 40 },
  { name: "拉脫維亞", macro: "東歐", lon: 24.9, lat: 56.9, countries: ["LVA"], profile: "europe_east", f: 40 },
  { name: "立陶宛", macro: "東歐", lon: 24.0, lat: 55.3, countries: ["LTU"], profile: "europe_east", f: 50 },
  { name: "馬佐夫舍", macro: "東歐", lon: 21.0, lat: 52.2, countries: ["POL"], profile: "europe_central", f: 65, pm: 1.3 },
  { name: "大波蘭", macro: "東歐", lon: 17.0, lat: 52.4, countries: ["POL"], profile: "europe_central", f: 70 },
  { name: "西里西亞", macro: "東歐", lon: 19.0, lat: 50.3, countries: ["POL"], profile: "europe_central", f: 70, pm: 1.4 },
  { name: "波美拉尼亞", macro: "東歐", lon: 17.5, lat: 54.0, countries: ["POL"], profile: "europe_central", f: 55 },
  { name: "莫斯科", macro: "東歐", lon: 37.6, lat: 55.7, countries: ["RUS"], profile: "europe_east", f: 50, pm: 2.0 },
  { name: "聖彼得堡", macro: "東歐", lon: 30.3, lat: 59.9, countries: ["RUS"], profile: "europe_east", f: 30, pm: 1.6 },
  { name: "列寧格勒", macro: "東歐", lon: 33.5, lat: 59.0, countries: ["RUS"], profile: "europe_east", f: 25 },
  { name: "加里寧格勒", macro: "東歐", lon: 20.5, lat: 54.7, countries: ["RUS"], profile: "europe_east", f: 50 },
  { name: "下諾夫哥羅", macro: "東歐", lon: 44.0, lat: 56.3, countries: ["RUS"], profile: "europe_east", f: 45 },
  { name: "韃靼斯坦", macro: "東歐", lon: 49.5, lat: 55.6, countries: ["RUS"], profile: "europe_east", f: 60 },
  { name: "薩馬拉", macro: "東歐", lon: 50.1, lat: 53.2, countries: ["RUS"], profile: "europe_east", f: 65 },
  { name: "羅斯托夫", macro: "東歐", lon: 40.0, lat: 47.5, countries: ["RUS"], profile: "europe_east", f: 85 },
  { name: "高加索俄", macro: "東歐", lon: 43.0, lat: 44.2, countries: ["RUS"], profile: "caucasus", f: 80 },
  { name: "烏拉爾邊區", macro: "東歐", lon: 59.5, lat: 57.5, countries: ["RUS"], profile: "europe_east", f: 30 },
  { name: "波希米亞", macro: "東歐", lon: 14.4, lat: 50.0, countries: ["CZE"], profile: "europe_central", f: 65, pm: 1.3 },
  { name: "摩拉維亞", macro: "東歐", lon: 17.0, lat: 49.3, countries: ["CZE"], profile: "europe_central", f: 70 },
  { name: "捷克西里西", macro: "東歐", lon: 18.1, lat: 49.8, countries: ["CZE"], profile: "europe_central", f: 60 },
  { name: "斯洛伐克西", macro: "東歐", lon: 17.7, lat: 48.5, countries: ["SVK"], profile: "europe_central", f: 65 },
  { name: "斯洛伐克東", macro: "東歐", lon: 21.5, lat: 48.9, countries: ["SVK"], profile: "europe_central", f: 50 },
  { name: "布達佩斯", macro: "東歐", lon: 19.1, lat: 47.5, countries: ["HUN"], profile: "europe_central", f: 75, pm: 1.4 },
  { name: "匈牙利平原", macro: "東歐", lon: 20.8, lat: 47.2, countries: ["HUN"], profile: "europe_central", f: 90 },
  // 羅馬尼亞 (3)
  { name: "外西凡尼亞", macro: "東歐", lon: 23.6, lat: 46.5, countries: ["ROU"], profile: "europe_east", f: 55 },
  { name: "瓦拉幾亞", macro: "東歐", lon: 25.0, lat: 44.6, countries: ["ROU"], profile: "europe_east", f: 85, pm: 1.3 },
  { name: "多瑙河下游", macro: "東歐", lon: 27.3, lat: 46.5, countries: ["ROU"], profile: "europe_east", f: 75 },

  // ══════════════ 南歐 (44) ══════════════
  // 西班牙 (12)
  { name: "馬德里", macro: "南歐", lon: -3.7, lat: 40.4, countries: ["ESP"], profile: "europe_med", f: 45, pm: 1.9 },
  { name: "加泰隆尼亞", macro: "南歐", lon: 1.8, lat: 41.7, countries: ["ESP"], profile: "europe_med", f: 55, pm: 1.6 },
  { name: "安達魯西亞", macro: "南歐", lon: -4.5, lat: 37.4, countries: ["ESP"], profile: "europe_med", f: 60 },
  { name: "瓦倫西亞", macro: "南歐", lon: -0.4, lat: 39.5, countries: ["ESP"], profile: "europe_med", f: 65 },
  { name: "加利西亞", macro: "南歐", lon: -8.0, lat: 42.8, countries: ["ESP"], profile: "europe_med", f: 50 },
  { name: "巴斯克", macro: "南歐", lon: -2.6, lat: 43.0, countries: ["ESP"], profile: "europe_med", f: 45, pm: 1.3 },
  { name: "阿拉貢", macro: "南歐", lon: -0.9, lat: 41.6, countries: ["ESP"], profile: "europe_med", f: 40 },
  { name: "卡斯提亞雷昂", macro: "南歐", lon: -5.0, lat: 41.7, countries: ["ESP"], profile: "europe_med", f: 45 },
  { name: "卡斯提亞曼查", macro: "南歐", lon: -3.0, lat: 39.3, countries: ["ESP"], profile: "europe_med", f: 35 },
  { name: "莫夕亞", macro: "南歐", lon: -1.3, lat: 38.0, countries: ["ESP"], profile: "europe_med", f: 40 },
  { name: "埃斯特雷馬杜", macro: "南歐", lon: -6.0, lat: 39.0, countries: ["ESP"], profile: "europe_med", f: 35 },
  { name: "巴利阿里群島", macro: "南歐", lon: 2.9, lat: 39.6, countries: ["ESP"], profile: "europe_med", f: 30, pm: 2.7 },
  // 葡萄牙 (2)
  { name: "北葡萄牙", macro: "南歐", lon: -8.4, lat: 41.3, countries: ["PRT"], profile: "europe_med", f: 55, pm: 1.3 },
  { name: "南葡萄牙", macro: "南歐", lon: -8.5, lat: 38.7, countries: ["PRT"], profile: "europe_med", f: 40, pm: 1.4 },
  // 義大利 (10)
  { name: "倫巴底", macro: "南歐", lon: 9.7, lat: 45.6, countries: ["ITA"], profile: "europe_med", f: 90, pm: 1.7 },
  { name: "皮埃蒙特", macro: "南歐", lon: 7.9, lat: 45.0, countries: ["ITA"], profile: "europe_med", f: 75, pm: 1.2 },
  { name: "威尼托", macro: "南歐", lon: 12.0, lat: 45.7, countries: ["ITA"], profile: "europe_med", f: 85, pm: 1.3 },
  { name: "艾米利亞", macro: "南歐", lon: 11.0, lat: 44.6, countries: ["ITA"], profile: "europe_med", f: 90 },
  { name: "托斯卡尼", macro: "南歐", lon: 11.2, lat: 43.4, countries: ["ITA"], profile: "europe_med", f: 60 },
  { name: "拉齊奧", macro: "南歐", lon: 12.7, lat: 41.9, countries: ["ITA"], profile: "europe_med", f: 60, pm: 1.5 },
  { name: "坎帕尼亞", macro: "南歐", lon: 14.9, lat: 40.8, countries: ["ITA"], profile: "europe_med", f: 75, pm: 1.5 },
  { name: "普利亞", macro: "南歐", lon: 16.5, lat: 40.8, countries: ["ITA"], profile: "europe_med", f: 50 },
  { name: "西西里", macro: "南歐", lon: 14.0, lat: 37.5, countries: ["ITA"], profile: "europe_med", f: 55 },
  { name: "薩丁尼亞", macro: "南歐", lon: 9.0, lat: 40.0, countries: ["ITA"], profile: "europe_med", f: 35 },
  // 巴爾幹 (20)
  { name: "斯洛維尼亞", macro: "南歐", lon: 14.8, lat: 46.1, countries: ["SVN"], profile: "europe_med", f: 50 },
  { name: "克羅埃西亞北", macro: "南歐", lon: 16.0, lat: 45.8, countries: ["HRV"], profile: "europe_med", f: 60 },
  { name: "達爾馬提亞", macro: "南歐", lon: 16.5, lat: 43.5, countries: ["HRV"], profile: "europe_med", f: 30 },
  { name: "斯拉沃尼亞", macro: "南歐", lon: 18.5, lat: 45.4, countries: ["HRV"], profile: "europe_med", f: 75 },
  { name: "波士尼亞", macro: "南歐", lon: 17.8, lat: 44.4, countries: ["BIH"], profile: "europe_med", f: 40 },
  { name: "赫塞哥維納", macro: "南歐", lon: 17.9, lat: 43.3, countries: ["BIH"], profile: "europe_med", f: 25 },
  { name: "塞族共和國", macro: "南歐", lon: 18.7, lat: 44.9, countries: ["BIH"], profile: "europe_med", f: 50 },
  { name: "蒙特內哥羅", macro: "南歐", lon: 19.3, lat: 42.8, countries: ["MNE"], profile: "europe_med", f: 25 },
  { name: "貝爾格勒", macro: "南歐", lon: 20.5, lat: 44.8, countries: ["SRB"], profile: "europe_med", f: 70, pm: 1.3 },
  { name: "伏伊伏丁那", macro: "南歐", lon: 19.9, lat: 45.5, countries: ["SRB"], profile: "europe_med", f: 90 },
  { name: "塞爾維亞南", macro: "南歐", lon: 21.5, lat: 43.3, countries: ["SRB"], profile: "europe_med", f: 45 },
  { name: "科索沃", macro: "南歐", lon: 20.9, lat: 42.6, countries: ["KOS"], profile: "europe_med", f: 45 },
  { name: "阿爾巴尼亞", macro: "南歐", lon: 20.0, lat: 41.0, countries: ["ALB"], profile: "europe_med", f: 40 },
  { name: "北馬其頓", macro: "南歐", lon: 21.7, lat: 41.6, countries: ["MKD"], profile: "europe_med", f: 40 },
  { name: "索菲亞", macro: "南歐", lon: 23.3, lat: 42.7, countries: ["BGR"], profile: "europe_med", f: 50, pm: 1.2 },
  { name: "保加利亞北", macro: "南歐", lon: 25.0, lat: 43.4, countries: ["BGR"], profile: "europe_med", f: 70 },
  { name: "色雷斯", macro: "南歐", lon: 26.2, lat: 42.0, countries: ["BGR"], profile: "europe_med", f: 60 },
  { name: "雅典阿提卡", macro: "南歐", lon: 23.7, lat: 38.0, countries: ["GRC"], profile: "europe_med", f: 25, pm: 1.7 },
  { name: "馬其頓希臘", macro: "南歐", lon: 22.5, lat: 40.6, countries: ["GRC"], profile: "europe_med", f: 55 },
  { name: "伯羅奔尼撒", macro: "南歐", lon: 22.0, lat: 37.5, countries: ["GRC"], profile: "europe_med", f: 35 },

  // ══════════════ 西亞 (25) ══════════════
  { name: "伊斯坦堡", macro: "西亞", lon: 29.0, lat: 41.0, countries: ["TUR"], profile: "levant", f: 55, pm: 1.9 },
  { name: "安卡拉", macro: "西亞", lon: 34.0, lat: 39.4, countries: ["TUR"], profile: "levant", f: 35 },
  { name: "愛琴海沿岸", macro: "西亞", lon: 28.0, lat: 38.5, countries: ["TUR"], profile: "levant", f: 55 },
  { name: "格魯吉亞", macro: "西亞", lon: 43.5, lat: 42.0, countries: ["GEO"], profile: "caucasus", f: 55 },
  { name: "亞美尼亞", macro: "西亞", lon: 45.0, lat: 40.2, countries: ["ARM"], profile: "caucasus", f: 30 },
  { name: "亞塞拜然", macro: "西亞", lon: 48.0, lat: 40.4, countries: ["AZE"], profile: "caucasus", f: 45 },
  { name: "敘利亞", macro: "西亞", lon: 38.0, lat: 35.0, countries: ["SYR"], profile: "levant", f: 35 },
  { name: "黎巴嫩", macro: "西亞", lon: 35.9, lat: 33.9, countries: ["LBN"], profile: "levant", f: 40, pm: 7 },
  { name: "約旦", macro: "西亞", lon: 36.5, lat: 31.5, countries: ["JOR"], profile: "levant", f: 15 },
  { name: "以色列", macro: "西亞", lon: 35.0, lat: 31.4, countries: ["ISR"], profile: "levant", f: 40, pm: 1.6 },
  { name: "巴勒斯坦", macro: "西亞", lon: 35.2, lat: 32.0, countries: ["PSX"], profile: "levant", f: 35, pm: 11 },
  { name: "巴格達", macro: "西亞", lon: 44.2, lat: 33.5, countries: ["IRQ"], profile: "mesopotamia", f: 70, pm: 1.4 },
  { name: "伊拉克南", macro: "西亞", lon: 46.5, lat: 31.0, countries: ["IRQ"], profile: "mesopotamia", f: 65 },
  { name: "德黑蘭", macro: "西亞", lon: 51.4, lat: 35.7, countries: ["IRN"], profile: "persia", f: 25, pm: 1.7 },
  { name: "伊斯法罕", macro: "西亞", lon: 52.5, lat: 32.5, countries: ["IRN"], profile: "persia", f: 15 },
  { name: "胡齊斯坦", macro: "西亞", lon: 49.0, lat: 31.3, countries: ["IRN"], profile: "persia", f: 50 },
  { name: "呼羅珊", macro: "西亞", lon: 59.0, lat: 36.0, countries: ["IRN"], profile: "persia", f: 20 },
  { name: "利雅德", macro: "西亞", lon: 46.7, lat: 24.7, countries: ["SAU"], profile: "arabia", f: 5, pm: 1.4 },
  { name: "漢志麥加", macro: "西亞", lon: 40.0, lat: 22.0, countries: ["SAU"], profile: "arabia", f: 6 },
  { name: "東部省阿拉伯", macro: "西亞", lon: 49.5, lat: 26.5, countries: ["SAU"], profile: "arabia", f: 5 },
  { name: "阿曼", macro: "西亞", lon: 57.0, lat: 21.5, countries: ["OMN"], profile: "arabia", f: 8 },
  { name: "葉門", macro: "西亞", lon: 45.0, lat: 15.5, countries: ["YEM"], profile: "arabia", f: 20 },
  { name: "阿聯酋", macro: "西亞", lon: 54.5, lat: 24.0, countries: ["ARE"], profile: "arabia", f: 4, pm: 1.5 },
  { name: "卡達", macro: "西亞", lon: 51.2, lat: 25.3, countries: ["QAT"], profile: "arabia", f: 3, pm: 12 },
  { name: "科威特巴林", macro: "西亞", lon: 47.9, lat: 29.3, countries: ["KWT", "BHR"], profile: "arabia", f: 4, pm: 17 },

  // ══════════════ 中亞 (18) ══════════════
  { name: "阿斯塔納", macro: "中亞", lon: 71.4, lat: 51.1, countries: ["KAZ"], profile: "steppe", f: 30 },
  { name: "阿拉木圖", macro: "中亞", lon: 77.0, lat: 43.5, countries: ["KAZ"], profile: "steppe", f: 35, pm: 1.3 },
  { name: "西哈薩克", macro: "中亞", lon: 52.0, lat: 49.5, countries: ["KAZ"], profile: "steppe", f: 15 },
  { name: "東哈薩克", macro: "中亞", lon: 82.0, lat: 49.0, countries: ["KAZ"], profile: "steppe", f: 25 },
  { name: "卡拉干達", macro: "中亞", lon: 73.0, lat: 48.0, countries: ["KAZ"], profile: "steppe", f: 12 },
  { name: "塔什干", macro: "中亞", lon: 69.3, lat: 41.3, countries: ["UZB"], profile: "steppe", f: 50, pm: 11 },
  { name: "撒馬爾罕", macro: "中亞", lon: 66.9, lat: 39.7, countries: ["UZB"], profile: "steppe", f: 45 },
  { name: "費爾干納盆地", macro: "中亞", lon: 71.2, lat: 40.6, countries: ["UZB"], profile: "steppe", f: 65 },
  { name: "卡拉卡爾帕克", macro: "中亞", lon: 59.5, lat: 43.0, countries: ["UZB"], profile: "steppe", f: 8 },
  { name: "阿什哈巴德", macro: "中亞", lon: 58.4, lat: 38.0, countries: ["TKM"], profile: "steppe", f: 10 },
  { name: "達沙古茲", macro: "中亞", lon: 59.9, lat: 41.8, countries: ["TKM"], profile: "steppe", f: 15 },
  { name: "馬雷馬爾吉亞納", macro: "中亞", lon: 62.0, lat: 37.6, countries: ["TKM"], profile: "steppe", f: 15 },
  { name: "比什凱克", macro: "中亞", lon: 74.6, lat: 42.9, countries: ["KGZ"], profile: "steppe", f: 35 },
  { name: "奧什", macro: "中亞", lon: 72.8, lat: 40.5, countries: ["KGZ"], profile: "steppe", f: 40 },
  { name: "塔吉克", macro: "中亞", lon: 71.0, lat: 38.8, countries: ["TJK"], profile: "steppe", f: 25 },
  // 阿富汗 (3)
  { name: "喀布爾", macro: "中亞", lon: 69.2, lat: 34.5, countries: ["AFG"], profile: "steppe", f: 20, pm: 1.2 },
  { name: "赫拉特", macro: "中亞", lon: 62.2, lat: 34.3, countries: ["AFG"], profile: "persia", f: 20 },
  { name: "坎大哈", macro: "中亞", lon: 65.7, lat: 31.6, countries: ["AFG"], profile: "persia", f: 12 },

  // ══════════════ 北亞（西伯利亞）(8) ══════════════
  { name: "西西伯利亞", macro: "北亞", lon: 74.0, lat: 57.0, countries: ["RUS"], profile: "siberia", f: 25, pm: 0.8 },
  { name: "亞馬爾", macro: "北亞", lon: 72.0, lat: 64.0, countries: ["RUS"], profile: "arctic", f: 3, pm: 0.3 },
  { name: "阿爾泰薩彥", macro: "北亞", lon: 87.0, lat: 53.0, countries: ["RUS"], profile: "steppe", f: 25, pm: 0.7 },
  { name: "克拉斯諾亞爾斯克", macro: "北亞", lon: 92.0, lat: 62.0, countries: ["RUS"], profile: "siberia", f: 8, pm: 0.3 },
  { name: "貝加爾湖區", macro: "北亞", lon: 108.0, lat: 54.0, countries: ["RUS"], profile: "siberia", f: 15, pm: 0.6 },
  { name: "薩哈雅庫特", macro: "北亞", lon: 130.0, lat: 65.0, countries: ["RUS"], profile: "arctic", f: 3, pm: 0.2 },
  { name: "遠東濱海", macro: "北亞", lon: 132.0, lat: 50.0, countries: ["RUS"], profile: "siberia", f: 35, pm: 0.9 },
  { name: "堪察加楚科奇", macro: "北亞", lon: 160.0, lat: 62.0, countries: ["RUS"], profile: "arctic", f: 3, pm: 0.2 },

  // ══════════════ 中國 (1 seed；其餘 41 見 CHINA_REGIONS) ══════════════
  { name: "興安漠北", macro: "中國", lon: 104.0, lat: 47.0, countries: ["MNG"], profile: "steppe", f: 6, pm: 0.4 },

  // ══════════════ 東亞 (23) ══════════════
  // 日本 (10)
  { name: "北海道", macro: "東亞", lon: 142.5, lat: 43.3, countries: ["JPN"], profile: "japan", f: 65, pm: 0.35 },
  { name: "東北地方", macro: "東亞", lon: 140.7, lat: 39.5, countries: ["JPN"], profile: "japan", f: 60, pm: 0.7 },
  { name: "江戶平原", macro: "東亞", lon: 139.7, lat: 35.9, countries: ["JPN"], profile: "japan", f: 95, pm: 2.6 },
  { name: "北陸信越", macro: "東亞", lon: 138.2, lat: 37.0, countries: ["JPN"], profile: "japan", f: 55, pm: 0.9 },
  { name: "東海中京圈", macro: "東亞", lon: 137.2, lat: 35.2, countries: ["JPN"], profile: "japan", f: 70, pm: 1.6 },
  { name: "近畿", macro: "東亞", lon: 135.5, lat: 34.7, countries: ["JPN"], profile: "japan", f: 70, pm: 2.0 },
  { name: "山陰山陽", macro: "東亞", lon: 132.8, lat: 34.7, countries: ["JPN"], profile: "japan", f: 50, pm: 0.9 },
  { name: "四國地方", macro: "東亞", lon: 133.5, lat: 33.8, countries: ["JPN"], profile: "japan", f: 45, pm: 0.6 },
  { name: "九州島", macro: "東亞", lon: 130.7, lat: 32.8, countries: ["JPN"], profile: "japan", f: 65, pm: 1.2 },
  { name: "沖繩琉球", macro: "東亞", lon: 127.8, lat: 26.3, countries: ["JPN"], profile: "japan", f: 40, pm: 6.2 },
  // 南韓 (7)
  { name: "首爾首都圈", macro: "東亞", lon: 127.0, lat: 37.5, countries: ["KOR"], profile: "korea_south", f: 80, pm: 2.4 },
  { name: "江原道", macro: "東亞", lon: 128.3, lat: 37.8, countries: ["KOR"], profile: "korea_south", f: 35, pm: 0.5 },
  { name: "忠清地方", macro: "東亞", lon: 127.5, lat: 36.6, countries: ["KOR"], profile: "korea_south", f: 70, pm: 1.1 },
  { name: "大邱慶北", macro: "東亞", lon: 128.7, lat: 36.2, countries: ["KOR"], profile: "korea_south", f: 55, pm: 1.1 },
  { name: "釜山廣域圈", macro: "東亞", lon: 129.0, lat: 35.3, countries: ["KOR"], profile: "korea_south", f: 50, pm: 1.8 },
  { name: "全羅地方", macro: "東亞", lon: 127.0, lat: 35.3, countries: ["KOR"], profile: "korea_south", f: 80, pm: 0.9 },
  { name: "濟州島", macro: "東亞", lon: 126.5, lat: 33.4, countries: ["KOR"], profile: "korea_south", f: 45, pm: 1.1 },
  // 台灣 (2)
  { name: "打狗", macro: "東亞", lon: 120.4, lat: 22.9, countries: ["TWN"], profile: "taiwan", f: 80, pm: 1.5 },
  { name: "雞籠", macro: "東亞", lon: 121.5, lat: 25.0, countries: ["TWN"], profile: "taiwan", f: 60, pm: 1.8 },
  // 北韓 (4)
  { name: "平壤", macro: "東亞", lon: 125.7, lat: 39.0, countries: ["PRK"], profile: "korea_north", f: 70, pm: 1.4 },
  { name: "黃海西岸", macro: "東亞", lon: 125.3, lat: 38.2, countries: ["PRK"], profile: "korea_north", f: 75, pm: 0.9 },
  { name: "咸鏡", macro: "東亞", lon: 129.5, lat: 41.2, countries: ["PRK"], profile: "korea_north", f: 25, pm: 0.6 },
  { name: "江原", macro: "東亞", lon: 127.4, lat: 38.8, countries: ["PRK"], profile: "korea_north", f: 35, pm: 0.5 },

  // ══════════════ 東南亞與大洋洲 (25) ══════════════
  { name: "伊洛瓦底平原", macro: "東南亞與大洋洲", lon: 95.5, lat: 18.0, countries: ["MMR"], profile: "seasia", f: 105, pm: 1.3 },
  { name: "撣邦高原", macro: "東南亞與大洋洲", lon: 98.0, lat: 21.5, countries: ["MMR"], profile: "seasia", f: 35 },
  { name: "若開山脈沿海", macro: "東南亞與大洋洲", lon: 93.5, lat: 20.5, countries: ["MMR"], profile: "seasia", f: 45 },
  { name: "丹那沙林山地", macro: "東南亞與大洋洲", lon: 98.0, lat: 13.0, countries: ["MMR"], profile: "seasia", f: 35 },
  { name: "湄南河平原", macro: "東南亞與大洋洲", lon: 100.5, lat: 14.8, countries: ["THA"], profile: "seasia", f: 105, pm: 1.6 },
  { name: "呵叻高原", macro: "東南亞與大洋洲", lon: 102.8, lat: 15.5, countries: ["THA"], profile: "seasia", f: 50 },
  { name: "泰北山地", macro: "東南亞與大洋洲", lon: 99.0, lat: 18.8, countries: ["THA"], profile: "seasia", f: 40 },
  { name: "紅河三角洲", macro: "東南亞與大洋洲", lon: 105.8, lat: 21.0, countries: ["VNM"], profile: "seasia", f: 107, pm: 1.6 },
  { name: "長山山脈", macro: "東南亞與大洋洲", lon: 107.0, lat: 16.0, countries: ["VNM"], profile: "seasia", f: 30 },
  { name: "安南海岸", macro: "東南亞與大洋洲", lon: 109.0, lat: 12.8, countries: ["VNM"], profile: "seasia", f: 55 },
  { name: "湄公河三角洲", macro: "東南亞與大洋洲", lon: 105.8, lat: 10.0, countries: ["VNM"], profile: "seasia", f: 110, pm: 1.5 },
  { name: "洞里薩湖盆地", macro: "東南亞與大洋洲", lon: 104.5, lat: 12.8, countries: ["KHM"], profile: "seasia", f: 85 },
  { name: "萬象寮國谷地", macro: "東南亞與大洋洲", lon: 103.5, lat: 18.5, countries: ["LAO"], profile: "seasia", f: 45 },
  { name: "蒂迪旺沙山脈", macro: "東南亞與大洋洲", lon: 101.5, lat: 4.5, countries: ["MYS"], profile: "seasia", f: 40 },
  { name: "半島東西海岸", macro: "東南亞與大洋洲", lon: 103.2, lat: 3.0, countries: ["MYS"], profile: "seasia", f: 60, pm: 1.3 },
  { name: "呂宋民答那峨", macro: "東南亞與大洋洲", lon: 122.0, lat: 13.5, countries: ["PHL"], profile: "seasia_islands", f: 75, pm: 1.6 },
  { name: "米沙鄢群島", macro: "東南亞與大洋洲", lon: 123.5, lat: 11.0, countries: ["PHL"], profile: "seasia_islands", f: 65, pm: 1.2 },
  { name: "蘇門答臘島", macro: "東南亞與大洋洲", lon: 101.5, lat: -0.5, countries: ["IDN"], profile: "seasia_islands", f: 70 },
  { name: "爪哇島", macro: "東南亞與大洋洲", lon: 110.0, lat: -7.3, countries: ["IDN"], profile: "seasia_islands", f: 107, pm: 4.0 },
  { name: "婆羅洲東馬", macro: "東南亞與大洋洲", lon: 114.0, lat: 0.5, countries: ["IDN", "MYS", "BRN"], profile: "seasia_islands", f: 40, pm: 0.17 },
  { name: "蘇拉威西摩鹿加", macro: "東南亞與大洋洲", lon: 121.0, lat: -2.0, countries: ["IDN"], profile: "seasia_islands", f: 55 },
  { name: "新幾內亞島", macro: "東南亞與大洋洲", lon: 140.0, lat: -5.0, countries: ["IDN", "PNG"], profile: "seasia_islands", f: 40, pm: 0.1 },
  { name: "澳洲東部沿海", macro: "東南亞與大洋洲", lon: 149.0, lat: -33.0, countries: ["AUS"], profile: "oceania", f: 55, pm: 1.6 },
  { name: "澳洲中西部內陸", macro: "東南亞與大洋洲", lon: 126.0, lat: -25.0, countries: ["AUS"], profile: "oceania", f: 5, pm: 0.4 },
  { name: "紐西蘭南北島", macro: "東南亞與大洋洲", lon: 172.0, lat: -42.0, countries: ["NZL"], profile: "oceania", f: 65 },

  // ══════════════ 美洲 (27) ══════════════
  // 加拿大 (4)
  { name: "魁北克", macro: "美洲", lon: -72.0, lat: 52.0, countries: ["CAN"], profile: "north_america", f: 30, pm: 0.08 },
  { name: "安大略", macro: "美洲", lon: -83.0, lat: 49.0, countries: ["CAN"], profile: "north_america", f: 35, pm: 0.27 },
  { name: "加西草原", macro: "美洲", lon: -106.0, lat: 52.0, countries: ["CAN"], profile: "north_america", f: 40, pm: 0.098 },
  { name: "卑詩", macro: "美洲", lon: -124.0, lat: 53.0, countries: ["CAN"], profile: "north_america", f: 15, pm: 0.032 },
  // 美國 (16)
  { name: "新英格蘭", macro: "美洲", lon: -71.5, lat: 43.5, countries: ["USA"], profile: "north_america", f: 40, pm: 1.5 },
  { name: "紐約平原", macro: "美洲", lon: -75.0, lat: 42.5, countries: ["USA"], profile: "north_america", f: 60, pm: 1.9 },
  { name: "賓州大西洋中", macro: "美洲", lon: -77.5, lat: 40.0, countries: ["USA"], profile: "north_america", f: 65, pm: 1.6 },
  { name: "五大湖芝加哥", macro: "美洲", lon: -86.5, lat: 42.0, countries: ["USA"], profile: "north_america", f: 85, pm: 1.5 },
  { name: "中西部北平原", macro: "美洲", lon: -96.5, lat: 44.0, countries: ["USA"], profile: "north_america", f: 100, pm: 0.19 },
  { name: "上南方阿帕拉契", macro: "美洲", lon: -83.5, lat: 37.0, countries: ["USA"], profile: "north_america", f: 50 },
  { name: "佛羅里達", macro: "美洲", lon: -81.5, lat: 28.0, countries: ["USA"], profile: "north_america", f: 45, pm: 1.4 },
  { name: "深南迪克西", macro: "美洲", lon: -87.5, lat: 32.5, countries: ["USA"], profile: "north_america", f: 60 },
  { name: "大德州", macro: "美洲", lon: -98.5, lat: 31.5, countries: ["USA"], profile: "north_america", f: 45, pm: 1.4 },
  { name: "南加州", macro: "美洲", lon: -117.5, lat: 34.0, countries: ["USA"], profile: "north_america", f: 30, pm: 1.9, clipUnits: [{ country: "USA", name: "California", clip: [-125, 32, -114, 37.0] }] },
  { name: "北加州灣區", macro: "美洲", lon: -121.5, lat: 38.0, countries: ["USA"], profile: "north_america", f: 65, pm: 1.6, clipUnits: [{ country: "USA", name: "California", clip: [-125, 37.0, -114, 42.1] }] },
  { name: "西北太平洋", macro: "美洲", lon: -121.5, lat: 46.5, countries: ["USA"], profile: "north_america", f: 55, pm: 1.2 },
  { name: "落磯山脈北", macro: "美洲", lon: -110.5, lat: 44.0, countries: ["USA"], profile: "north_america", f: 15, pm: 0.085 },
  { name: "西南四角地帶", macro: "美洲", lon: -110.0, lat: 34.5, countries: ["USA"], profile: "north_america", f: 8, pm: 0.2 },
  { name: "阿拉斯加", macro: "美洲", lon: -150.0, lat: 63.0, countries: ["USA"], profile: "north_america", f: 4, pm: 0.0098 },
  { name: "夏威夷", macro: "美洲", lon: -156.5, lat: 20.5, countries: ["USA"], profile: "north_america", f: 50, pm: 1.7 },
  // 墨西哥 (5)
  { name: "中央高原", macro: "美洲", lon: -101.0, lat: 21.0, countries: ["MEX"], profile: "mesoamerica", f: 50, pm: 1.6 },
  { name: "東西馬德雷山脈", macro: "美洲", lon: -104.0, lat: 26.0, countries: ["MEX"], profile: "mesoamerica", f: 15 },
  { name: "太平洋沿岸", macro: "美洲", lon: -100.0, lat: 17.5, countries: ["MEX"], profile: "mesoamerica", f: 45 },
  { name: "下加利福尼亞半島", macro: "美洲", lon: -113.0, lat: 27.0, countries: ["MEX"], profile: "mesoamerica", f: 5, pm: 0.18 },
  { name: "猶加敦半島", macro: "美洲", lon: -89.0, lat: 19.0, countries: ["MEX"], profile: "mesoamerica", f: 30 },
  // 中美 + 加勒比 (2)
  { name: "中美地峽", macro: "美洲", lon: -85.0, lat: 13.0, countries: ["GTM", "BLZ", "HND", "SLV", "NIC", "CRI", "PAN"], profile: "mesoamerica", f: 60, pm: 1.3 },
  { name: "西印度群島", macro: "美洲", lon: -76.0, lat: 20.0, countries: ["CUB", "DOM", "HTI", "JAM", "BHS", "TTO", "PRI"], profile: "latam_tropical", f: 55, pm: 1.3 },

  // ══════════════ 南亞 (22) ══════════════
  { name: "旁遮普", macro: "南亞", lon: 75.8, lat: 30.3, countries: ["IND"], profile: "india", f: 107, pm: 1.4 },
  { name: "喜馬偕爾", macro: "南亞", lon: 77.5, lat: 31.8, countries: ["IND"], profile: "india", f: 30 },
  { name: "拉賈斯坦", macro: "南亞", lon: 74.0, lat: 26.5, countries: ["IND"], profile: "india", f: 20 },
  { name: "北方邦", macro: "南亞", lon: 80.5, lat: 27.0, countries: ["IND"], profile: "india", f: 110, pm: 1.6 },
  { name: "比哈爾", macro: "南亞", lon: 85.5, lat: 25.0, countries: ["IND"], profile: "india", f: 107, pm: 1.6 },
  { name: "古吉拉特", macro: "南亞", lon: 71.5, lat: 22.5, countries: ["IND"], profile: "india", f: 50, pm: 1.2 },
  { name: "中央邦", macro: "南亞", lon: 80.0, lat: 22.5, countries: ["IND"], profile: "india", f: 55 },
  { name: "馬哈拉施特拉", macro: "南亞", lon: 75.5, lat: 19.0, countries: ["IND"], profile: "india", f: 50, pm: 1.5 },
  { name: "果阿", macro: "南亞", lon: 74.5, lat: 15.3, countries: ["IND"], profile: "india", f: 60 },
  { name: "西孟加拉", macro: "南亞", lon: 89.0, lat: 23.5, countries: ["IND", "BGD"], profile: "india", f: 107, pm: 2.0 },
  { name: "奧里薩", macro: "南亞", lon: 84.5, lat: 20.5, countries: ["IND"], profile: "india", f: 65 },
  { name: "阿薩姆", macro: "南亞", lon: 93.0, lat: 26.0, countries: ["IND"], profile: "india", f: 80 },
  { name: "喜馬", macro: "南亞", lon: 88.5, lat: 27.5, countries: ["IND"], profile: "india", f: 35 },
  { name: "安得拉與特倫甘納", macro: "南亞", lon: 79.0, lat: 16.5, countries: ["IND"], profile: "india", f: 60, pm: 1.2 },
  { name: "坦米爾納杜", macro: "南亞", lon: 78.5, lat: 11.0, countries: ["IND"], profile: "india", f: 60, pm: 1.3 },
  { name: "喀拉拉", macro: "南亞", lon: 76.3, lat: 10.5, countries: ["IND"], profile: "india", f: 70, pm: 1.4 },
  // 巴基斯坦 (3)
  { name: "印度河上游", macro: "南亞", lon: 72.5, lat: 32.5, countries: ["PAK"], profile: "india", f: 90, pm: 1.4 },
  { name: "信德平原", macro: "南亞", lon: 68.5, lat: 26.5, countries: ["PAK"], profile: "india", f: 70, pm: 1.3 },
  { name: "俾路支", macro: "南亞", lon: 65.5, lat: 28.5, countries: ["PAK"], profile: "persia", f: 8 },
  // 尼泊爾、不丹、斯里蘭卡 (3)
  { name: "尼泊爾", macro: "南亞", lon: 84.1, lat: 28.2, countries: ["NPL"], profile: "india", f: 45 },
  { name: "不丹", macro: "南亞", lon: 90.4, lat: 27.4, countries: ["BTN"], profile: "india", f: 20 },
  { name: "斯里蘭卡", macro: "南亞", lon: 80.7, lat: 7.9, countries: ["LKA"], profile: "india", f: 70, pm: 1.3 },

  // ══════════════ 南美 (18) ══════════════
  { name: "亞馬遜盆地", macro: "南美", lon: -63.0, lat: -4.0, countries: ["BRA"], profile: "amazon_frontier", f: 30 },
  { name: "里約聖保羅", macro: "南美", lon: -45.5, lat: -22.5, countries: ["BRA"], profile: "latam_tropical", f: 65, pm: 1.9 },
  { name: "巴西高地", macro: "南美", lon: -47.0, lat: -12.0, countries: ["BRA"], profile: "latam_tropical", f: 45, pm: 0.35 },
  { name: "委內瑞拉", macro: "南美", lon: -66.0, lat: 8.0, countries: ["VEN"], profile: "latam_tropical", f: 45 },
  // 圭亞那地區 (3)
  { name: "蓋亞那", macro: "南美", lon: -58.9, lat: 6.0, countries: ["GUY"], profile: "latam_tropical", f: 35 },
  { name: "蘇利南", macro: "南美", lon: -55.9, lat: 4.5, countries: ["SUR"], profile: "latam_tropical", f: 35 },
  { name: "法屬圭亞那", macro: "南美", lon: -53.0, lat: 4.0, countries: ["FRA"], profile: "amazon_frontier", f: 25, clipUnits: [{ country: "FRA", name: "Guyane française" }] },
  { name: "哥倫比亞", macro: "南美", lon: -74.0, lat: 4.5, countries: ["COL"], profile: "andes", f: 55, pm: 1.3 },
  { name: "厄瓜多", macro: "南美", lon: -78.5, lat: -1.5, countries: ["ECU"], profile: "andes", f: 55 },
  { name: "利馬祕魯", macro: "南美", lon: -76.5, lat: -10.0, countries: ["PER"], profile: "andes", f: 25, pm: 1.3 },
  { name: "安地斯高地", macro: "南美", lon: -71.5, lat: -14.5, countries: ["PER"], profile: "andes", f: 20 },
  { name: "玻利維亞", macro: "南美", lon: -65.0, lat: -17.0, countries: ["BOL"], profile: "andes", f: 30 },
  { name: "巴拉圭", macro: "南美", lon: -58.0, lat: -23.5, countries: ["PRY"], profile: "latam_temperate", f: 55 },
  { name: "布宜諾斯", macro: "南美", lon: -59.5, lat: -35.0, countries: ["ARG"], profile: "latam_temperate", f: 100, pm: 1.6 },
  { name: "潘帕斯平原", macro: "南美", lon: -64.0, lat: -32.0, countries: ["ARG"], profile: "latam_temperate", f: 95 },
  { name: "巴塔哥尼亞", macro: "南美", lon: -69.0, lat: -45.0, countries: ["ARG"], profile: "latam_temperate", f: 8 },
  { name: "智利", macro: "南美", lon: -71.0, lat: -35.0, countries: ["CHL"], profile: "latam_temperate", f: 50, pm: 1.3 },
  { name: "烏拉圭", macro: "南美", lon: -56.0, lat: -33.0, countries: ["URY"], profile: "latam_temperate", f: 80 },  // ══════════════ 姆大陸 (24) ══════════════
  // 虛構陸地（太平洋中央，夏威夷以南；輪廓依參考手繪圖重新描摹，面積約 935 萬 km²）。
  // 分區為有機形狀（加權種子＋座標扭曲），大小懸殊、邊界彎曲，不走格狀。
  // 幾何固化於 data/mu-continent.geojson，由 buildWorldDistricts 併入；不走 Natural Earth，
  // 故 countries 為空。可建國、無特殊限制。肥沃度：河谷／沿海高、山地／台地／長尾低。
  { name: "姆西岬", macro: "姆大陸", lon: -175.1, lat: 6.1, countries: [], profile: "mu", f: 8, pm: 0.8 },
  { name: "波納佩灣", macro: "姆大陸", lon: -172.0, lat: 4.0, countries: [], profile: "mu", f: 19, pm: 1.2 },
  { name: "落日灣", macro: "姆大陸", lon: -167.9, lat: 0.1, countries: [], profile: "mu", f: 21, pm: 1.3 },
  { name: "晨星岬", macro: "姆大陸", lon: -167.5, lat: 6.0, countries: [], profile: "mu", f: 15 },
  { name: "翡翠半島", macro: "姆大陸", lon: -164.5, lat: -4.3, countries: [], profile: "mu", f: 16 },
  { name: "姆西原", macro: "姆大陸", lon: -164.4, lat: 1.1, countries: [], profile: "mu", f: 13, pm: 0.9 },
  { name: "斐濟南灘", macro: "姆大陸", lon: -158.5, lat: -7.9, countries: [], profile: "mu", f: 20, pm: 1.2 },
  { name: "姆中央谷地", macro: "姆大陸", lon: -157.1, lat: 2.3, countries: [], profile: "mu", f: 24, pm: 1.4 },
  { name: "夏威夷南麓", macro: "姆大陸", lon: -155.9, lat: 8.7, countries: [], profile: "mu", f: 11, pm: 0.9 },
  { name: "聖樹平原", macro: "姆大陸", lon: -153.3, lat: -5.3, countries: [], profile: "mu", f: 25, pm: 1.4 },
  { name: "日昇高原", macro: "姆大陸", lon: -150.3, lat: 3.8, countries: [], profile: "mu", f: 8, pm: 0.7 },
  { name: "內海渡口", macro: "姆大陸", lon: -149.2, lat: -1.1, countries: [], profile: "mu", f: 18, pm: 1.2 },
  { name: "北海岸", macro: "姆大陸", lon: -148.1, lat: 8.5, countries: [], profile: "mu", f: 18, pm: 1.1 },
  { name: "紅岩台地", macro: "姆大陸", lon: -146.8, lat: -8.4, countries: [], profile: "mu", f: 6, pm: 0.6 },
  { name: "珊瑚灣", macro: "姆大陸", lon: -144.0, lat: -11.4, countries: [], profile: "mu", f: 17 },
  { name: "王都盆地", macro: "姆大陸", lon: -142.7, lat: 2.5, countries: [], profile: "mu", f: 23, pm: 1.4 },
  { name: "馬克薩斯灣", macro: "姆大陸", lon: -140.3, lat: 7.4, countries: [], profile: "mu", f: 18, pm: 1.1 },
  { name: "月神湖區", macro: "姆大陸", lon: -138.7, lat: -5.2, countries: [], profile: "mu", f: 14 },
  { name: "東原", macro: "姆大陸", lon: -135.8, lat: 1.6, countries: [], profile: "mu", f: 12, pm: 0.8 },
  { name: "長尾北岸", macro: "姆大陸", lon: -132.9, lat: -3.3, countries: [], profile: "mu", f: 11, pm: 0.8 },
  { name: "長尾半島", macro: "姆大陸", lon: -132.8, lat: -8.4, countries: [], profile: "mu", f: 7, pm: 0.6 },
  { name: "南十字岬", macro: "姆大陸", lon: -129.4, lat: -8.3, countries: [], profile: "mu", f: 5, pm: 0.5 },
  { name: "遺跡高地", macro: "姆大陸", lon: -126.4, lat: -10.3, countries: [], profile: "mu", f: 4, pm: 0.5 },
  { name: "復活節尖端", macro: "姆大陸", lon: -123.5, lat: -11.6, countries: [], profile: "mu", f: 3, pm: 0.4 },
];

/**
 * 中國 41 區（第 42 區「興安漠北」以 seed 覆蓋蒙古，見 SEED_REGIONS）。
 * admin-1 只有 32 省 < 42 區，故對需要細分的省以 bbox 裁切近似（單一經／緯度切線，
 * 兩框在切線相接並各自延伸超出省界以確保聯集覆蓋全省）。
 */
export const CHINA_REGIONS: readonly ChinaRegion[] = [
  { name: "幽州", provinces: [{ name: "Beijing" }], profile: "china_core", f: 90, pm: 1.4 },
  { name: "津沽", provinces: [{ name: "Tianjin" }], profile: "china_core", f: 85, pm: 1.3 },
  { name: "冀南", provinces: [{ name: "Hebei", clip: [110, 34, 121, 39] }], profile: "china_core", f: 107, pm: 1.3 },
  { name: "河朔", provinces: [{ name: "Hebei", clip: [110, 39, 121, 43] }], profile: "china_core", f: 55, pm: 0.8 },
  { name: "河東", provinces: [{ name: "Shanxi" }], profile: "china_core", f: 50, pm: 0.9 },
  { name: "漠南", provinces: [{ name: "Inner Mongol", clip: [108, 37, 116, 54] }], profile: "china_frontier", f: 20, pm: 0.9 },
  { name: "呼倫貝爾錫林郭勒", provinces: [{ name: "Inner Mongol", clip: [116, 37, 128, 54] }], profile: "china_frontier", f: 15, pm: 0.4 },
  { name: "陰山河套鄂爾多斯", provinces: [{ name: "Inner Mongol", clip: [95, 37, 108, 54] }, { name: "Ningxia" }], profile: "china_frontier", f: 35, pm: 0.7 },
  { name: "遼東", provinces: [{ name: "Liaoning", clip: [122, 37, 127, 44] }], profile: "china_frontier", f: 85, pm: 1.6 },
  { name: "遼西走廊", provinces: [{ name: "Liaoning", clip: [117, 37, 122, 44] }], profile: "china_frontier", f: 70, pm: 1.2 },
  { name: "松江吉林", provinces: [{ name: "Jilin" }], profile: "china_frontier", f: 100, pm: 1.1 },
  { name: "黑龍江東", provinces: [{ name: "Heilongjiang" }], profile: "china_frontier", f: 105, pm: 1.0 },
  { name: "膠東", provinces: [{ name: "Shandong", clip: [119, 33, 124, 39] }], profile: "china_core", f: 80, pm: 1.4 },
  { name: "魯西", provinces: [{ name: "Shandong", clip: [113, 33, 119, 39] }], profile: "china_core", f: 107, pm: 1.5 },
  { name: "河洛中原", provinces: [{ name: "Henan", clip: [109, 33.5, 117, 38] }], profile: "china_core", f: 110, pm: 1.4 },
  { name: "豫南", provinces: [{ name: "Henan", clip: [109, 30, 117, 33.5] }], profile: "china_core", f: 105, pm: 1.2 },
  { name: "淮北", provinces: [{ name: "Anhui", clip: [113, 31.5, 121, 36] }], profile: "china_core", f: 105, pm: 1.1 },
  { name: "江寧江淮", provinces: [{ name: "Jiangsu", clip: [115, 31.7, 123, 36] }], profile: "china_core", f: 105, pm: 1.4 },
  { name: "滬上", provinces: [{ name: "Shanghai" }], profile: "china_core", f: 107, pm: 1.6 },
  { name: "太湖", provinces: [{ name: "Jiangsu", clip: [115, 29, 123, 31.7] }, { name: "Anhui", clip: [113, 28, 121, 31.5] }], profile: "china_core", f: 110, pm: 1.5 },
  { name: "會稽浙東", provinces: [{ name: "Zhejiang", clip: [117, 29, 123, 31.5] }], profile: "china_core", f: 95, pm: 1.3 },
  { name: "甌越", provinces: [{ name: "Zhejiang", clip: [117, 26.5, 123, 29] }], profile: "china_south", f: 60, pm: 1.1 },
  { name: "江漢荊楚", provinces: [{ name: "Hubei" }], profile: "china_core", f: 107, pm: 1.2 },
  { name: "峽江", provinces: [{ name: "Chongqing" }], profile: "china_core", f: 55, pm: 1.2 },
  { name: "洞庭湘江", provinces: [{ name: "Hunan", clip: [111.3, 24, 115, 31] }], profile: "china_core", f: 105, pm: 1.2 },
  { name: "武陵湘西", provinces: [{ name: "Hunan", clip: [108, 24, 111.3, 31] }], profile: "china_frontier", f: 40, pm: 0.8 },
  { name: "鄱陽贛江", provinces: [{ name: "Jiangxi" }], profile: "china_south", f: 100, pm: 1.0 },
  { name: "閩中沿海", provinces: [{ name: "Fujian", clip: [118, 22.5, 121.5, 28.5] }], profile: "china_south", f: 55, pm: 1.3 },
  { name: "武夷閩西", provinces: [{ name: "Fujian", clip: [115, 22.5, 118, 28.5] }], profile: "china_south", f: 35, pm: 0.7 },
  { name: "珠江嶺南", provinces: [{ name: "Guangdong" }, { name: "Guangxi" }], profile: "china_south", f: 80, pm: 1.6 },
  { name: "巴郡", provinces: [{ name: "Sichuan", clip: [105, 25, 110, 35] }], profile: "china_core", f: 70, pm: 1.1 },
  { name: "蜀郡天府", provinces: [{ name: "Sichuan", clip: [102, 25, 105, 35] }], profile: "china_core", f: 105, pm: 1.4 },
  { name: "康巴川西", provinces: [{ name: "Sichuan", clip: [96, 25, 102, 35] }], profile: "china_frontier", f: 12, pm: 0.4 },
  { name: "牂牁黔中", provinces: [{ name: "Guizhou" }], profile: "china_frontier", f: 30, pm: 0.9 },
  { name: "南詔滇東", provinces: [{ name: "Yunnan" }], profile: "china_frontier", f: 10, pm: 1.0 },
  { name: "關中", provinces: [{ name: "Shaanxi" }], profile: "china_core", f: 70, pm: 1.0 },
  { name: "河西隴右", provinces: [{ name: "Gansu" }], profile: "china_frontier", f: 25, pm: 0.7 },
  { name: "青唐西海", provinces: [{ name: "Qinghai" }], profile: "china_frontier", f: 8, pm: 0.3 },
  { name: "安西西域", provinces: [{ name: "Xinjiang" }], profile: "china_frontier", f: 10, pm: 0.5 },
  { name: "衛藏吐蕃", provinces: [{ name: "Xizang" }], profile: "china_frontier", f: 6, pm: 0.3 },
  { name: "瓊州南海", provinces: [{ name: "Hainan" }, { name: "Paracel Islands" }], profile: "china_south", f: 70, pm: 0.9 },
];
/* eslint-enable prettier/prettier */

/** 大地區顯示順序（14）。 */
export const MACRO_ORDER: readonly string[] = [
  "非洲",
  "西歐",
  "北歐",
  "東歐",
  "南歐",
  "西亞",
  "中亞",
  "北亞",
  "中國",
  "東亞",
  "東南亞與大洋洲",
  "美洲",
  "南亞",
  "南美",
  "姆大陸",
];

/** 全部 373 區名稱（順序：SEED_REGIONS 依大地區、CHINA_REGIONS 併入中國）。 */
export function allRegionNames(): string[] {
  return [
    ...SEED_REGIONS.map((r) => r.name),
    ...CHINA_REGIONS.map((r) => r.name),
  ];
}
