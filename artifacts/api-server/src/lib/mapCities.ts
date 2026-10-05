import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { MAP_REGION_SEED } from "./mapRegions";

/**
 * Task #23 — 世界地圖歷史重要城市（地圖二代 373 區重切後沿用）.
 *
 * 288 historically important cities, each assigned to exactly one of the 373
 * map regions. Quotas by group: 歐洲 90, 中國 20, 亞洲其他 106, 美洲 50,
 * 非洲 22（Task #311 於原 172 座上補增 116 座，依宏觀地區配額：非洲 +20、
 * 北亞 +5、東亞 +30、南亞 +8、歐洲 +30、北美 +10、南美 +10、澳洲 +3）.
 *
 * Region assignments were re-verified with point-in-polygon checks against the
 * regenerated 373-region world-districts TopoJSON, plus an ISO country
 * cross-check, so every city's coordinates fall inside its assigned district
 * AND that district's country matches the city's country.
 *
 * 二代重切調整（373 區的宏觀計數已固定，部分國家不再上圖）：
 *  - 13 座位於已移除國家的城市改以同重要性、同宏觀分組的替補城市取代（如
 *    都柏林→約克、里斯本→薩拉戈薩、喀布爾→巴庫 等），維持各分組配額不變。
 *  - 17 座與新區同名的城市統一加「城」字消歧義（如 莫斯科→莫斯科城）。
 *  - 例外：新加坡城保留，最近多邊形距 14km（半島東西海岸，MYS），該點落在
 *    繪製陸地上、標籤僅為地理分區，作為書面記錄的例外沿用。
 *
 * The sync is idempotent: create table if missing, upsert by city name,
 * remove stale rows. Safe to re-run on every boot.
 */

export interface MapCitySeed {
  /** zh-TW 城市名。 */
  name: string;
  /** 所屬地區（必須存在於 MAP_REGION_SEED 的 373 區之一）。 */
  region: string;
  lat: number;
  lng: number;
}

export type CityQuotaGroup = "europe" | "china" | "otherAsia" | "americas" | "africa" | "mu";

export const EXPECTED_CITY_QUOTAS: Readonly<Record<CityQuotaGroup, number>> = {
  europe: 90,
  china: 20,
  otherAsia: 106,
  americas: 50,
  africa: 22,
  // 姆大陸（虛構）：隨機虛構 12 座，不計入歷史城市 288 座配額。
  mu: 12,
};

export const MAP_CITY_SEED: Readonly<
  Record<CityQuotaGroup, readonly MapCitySeed[]>
> = {
  // ── 歐洲（60）───────────────────────────────────────────
  europe: [
    { name: "倫敦", region: "大倫敦地區", lat: 51.507, lng: -0.128 },
    { name: "曼徹斯特", region: "西北英格蘭", lat: 53.483, lng: -2.244 },
    { name: "利物浦", region: "西北英格蘭", lat: 53.419, lng: -2.975 },
    { name: "愛丁堡", region: "蘇格蘭低地", lat: 55.953, lng: -3.188 },
    { name: "巴黎", region: "法蘭西島", lat: 48.857, lng: 2.352 },
    { name: "魯昂", region: "諾曼第大區", lat: 49.443, lng: 1.099 },
    { name: "里昂", region: "羅訥隆河谷", lat: 45.764, lng: 4.836 },
    { name: "馬賽", region: "普羅旺斯阿爾", lat: 43.297, lng: 5.37 },
    { name: "波爾多", region: "新阿基坦", lat: 44.838, lng: -0.579 },
    { name: "史特拉斯堡", region: "大東部大區", lat: 48.573, lng: 7.752 },
    { name: "馬德里城", region: "馬德里", lat: 40.417, lng: -3.704 },
    { name: "托雷多", region: "馬德里", lat: 39.863, lng: -4.028 },
    { name: "巴塞隆納", region: "加泰隆尼亞", lat: 41.387, lng: 2.17 },
    { name: "塞維亞", region: "安達魯西亞", lat: 37.389, lng: -5.984 },
    { name: "科爾多瓦", region: "安達魯西亞", lat: 37.888, lng: -4.779 },
    { name: "格拉納達", region: "安達魯西亞", lat: 37.177, lng: -3.599 },
    { name: "瓦倫西亞城", region: "瓦倫西亞", lat: 39.47, lng: -0.377 },
    { name: "斯德哥爾摩城", region: "斯德哥爾摩", lat: 59.329, lng: 18.069 },
    { name: "哥本哈根城", region: "哥本哈根", lat: 55.696, lng: 12.568 },
    { name: "奧斯陸城", region: "奧斯陸", lat: 59.913, lng: 10.752 },
    { name: "卑爾根", region: "卑爾根沿海", lat: 60.393, lng: 5.324 },
    { name: "柏林", region: "布蘭登堡", lat: 52.52, lng: 13.405 },
    { name: "漢堡市", region: "北德沿海", lat: 53.551, lng: 9.994 },
    { name: "慕尼黑", region: "巴伐利亞邦", lat: 48.137, lng: 11.575 },
    { name: "紐倫堡", region: "巴伐利亞邦", lat: 49.454, lng: 11.077 },
    { name: "科隆", region: "北萊茵西發", lat: 50.938, lng: 6.96 },
    { name: "法蘭克福", region: "黑森萊茵", lat: 50.11, lng: 8.682 },
    { name: "萊比錫", region: "薩克森圖林", lat: 51.34, lng: 12.375 },
    { name: "德勒斯登", region: "薩克森圖林", lat: 51.051, lng: 13.738 },
    { name: "維也納", region: "下奧地利", lat: 48.208, lng: 16.373 },
    { name: "蘇黎世", region: "東瑞士", lat: 47.377, lng: 8.541 },
    { name: "日內瓦", region: "西瑞士", lat: 46.264, lng: 6.143 },
    { name: "布拉格", region: "波希米亞", lat: 50.088, lng: 14.421 },
    { name: "布達佩斯城", region: "布達佩斯", lat: 47.498, lng: 19.04 },
    { name: "克拉科夫", region: "西里西亞", lat: 50.065, lng: 19.945 },
    { name: "華沙", region: "馬佐夫舍", lat: 52.23, lng: 21.011 },
    { name: "格但斯克", region: "波美拉尼亞", lat: 54.352, lng: 18.646 },
    { name: "羅馬城", region: "拉齊奧", lat: 41.903, lng: 12.496 },
    { name: "米蘭", region: "倫巴底", lat: 45.464, lng: 9.19 },
    { name: "威尼斯", region: "威尼托", lat: 45.466, lng: 12.355 },
    { name: "佛羅倫斯", region: "托斯卡尼", lat: 43.77, lng: 11.258 },
    { name: "那不勒斯城", region: "坎帕尼亞", lat: 40.852, lng: 14.268 },
    { name: "巴勒摩", region: "西西里", lat: 38.116, lng: 13.362 },
    { name: "雅典", region: "雅典阿提卡", lat: 37.984, lng: 23.728 },
    { name: "貝爾格勒城", region: "貝爾格勒", lat: 44.787, lng: 20.457 },
    { name: "索菲亞城", region: "索菲亞", lat: 42.698, lng: 23.319 },
    { name: "莫斯科城", region: "莫斯科", lat: 55.756, lng: 37.617 },
    { name: "聖彼得堡城", region: "聖彼得堡", lat: 59.934, lng: 30.335 },
    { name: "諾夫哥羅德", region: "列寧格勒", lat: 58.521, lng: 31.276 },
    { name: "基輔城", region: "基輔", lat: 50.45, lng: 30.523 },
    { name: "里加", region: "拉脫維亞", lat: 56.949, lng: 24.105 },
    { name: "維爾紐斯", region: "立陶宛", lat: 54.687, lng: 25.28 },
    { name: "波隆那", region: "艾米利亞", lat: 44.494, lng: 11.343 },
    { name: "薩拉戈薩", region: "阿拉貢", lat: 41.649, lng: -0.887 },
    { name: "土魯斯", region: "奧克西塔尼", lat: 43.604, lng: 1.444 },
    { name: "約克", region: "約克郡亨伯", lat: 53.96, lng: -1.081 },
    { name: "敖德薩", region: "南烏克蘭", lat: 46.482, lng: 30.723 },
    { name: "喀山", region: "韃靼斯坦", lat: 55.796, lng: 49.106 },
    { name: "塞薩洛尼基", region: "馬其頓希臘", lat: 40.64, lng: 22.944 },
    { name: "布爾諾", region: "摩拉維亞", lat: 49.195, lng: 16.608 },
    // Task #311 補增（+30；西歐10／北歐4／東歐8／南歐8）
    { name: "阿姆斯特丹", region: "荷蘭", lat: 52.37, lng: 4.9 },
    { name: "鹿特丹", region: "荷蘭", lat: 51.924, lng: 4.478 },
    { name: "布魯塞爾", region: "比利時", lat: 50.851, lng: 4.352 },
    { name: "安特衛普", region: "比利時", lat: 51.221, lng: 4.4 },
    { name: "都柏林", region: "愛爾蘭", lat: 53.35, lng: -6.26 },
    { name: "伯明罕", region: "西密德蘭", lat: 52.48, lng: -1.903 },
    { name: "格拉斯哥", region: "蘇格蘭低地", lat: 55.861, lng: -4.25 },
    { name: "卡地夫", region: "南威爾斯", lat: 51.481, lng: -3.179 },
    { name: "布里斯托", region: "南威爾斯", lat: 51.454, lng: -2.588 },
    { name: "里爾", region: "上法蘭西", lat: 50.629, lng: 3.057 },
    { name: "圖爾庫", region: "赫爾辛基", lat: 60.451, lng: 22.267 },
    { name: "坦佩雷", region: "赫爾辛基", lat: 61.498, lng: 23.761 },
    { name: "馬爾默", region: "哥德堡", lat: 55.605, lng: 13.003 },
    { name: "于默奧", region: "瑞典北部諾爾蘭", lat: 63.826, lng: 20.263 },
    { name: "塔林", region: "愛沙尼亞", lat: 59.437, lng: 24.754 },
    { name: "考納斯", region: "立陶宛", lat: 54.898, lng: 23.904 },
    { name: "哈爾科夫", region: "東烏克蘭", lat: 49.994, lng: 36.231 },
    { name: "利沃夫", region: "西烏克蘭", lat: 49.84, lng: 24.03 },
    { name: "布拉提斯拉瓦", region: "斯洛伐克西", lat: 48.148, lng: 17.108 },
    { name: "科希策", region: "斯洛伐克東", lat: 48.716, lng: 21.261 },
    { name: "布加勒斯特", region: "瓦拉幾亞", lat: 44.427, lng: 26.103 },
    { name: "弗羅茨瓦夫", region: "大波蘭", lat: 51.108, lng: 17.038 },
    { name: "里斯本", region: "南葡萄牙", lat: 38.722, lng: -9.139 },
    { name: "波爾圖", region: "北葡萄牙", lat: 41.15, lng: -8.611 },
    { name: "杜林", region: "皮埃蒙特", lat: 45.07, lng: 7.687 },
    { name: "巴里", region: "普利亞", lat: 41.117, lng: 16.872 },
    { name: "卡塔尼亞", region: "西西里", lat: 37.502, lng: 15.087 },
    { name: "瓦拉多利德", region: "卡斯提亞雷昂", lat: 41.652, lng: -4.724 },
    { name: "畢爾包", region: "巴斯克", lat: 43.263, lng: -2.935 },
    { name: "維戈", region: "加利西亞", lat: 42.231, lng: -8.713 },
  ],
  // ── 中國（20）───────────────────────────────────────────
  china: [
    { name: "北京", region: "幽州", lat: 39.904, lng: 116.407 },
    { name: "天津", region: "津沽", lat: 39.084, lng: 117.201 },
    { name: "開封", region: "河洛中原", lat: 34.797, lng: 114.307 },
    { name: "洛陽", region: "河洛中原", lat: 34.62, lng: 112.454 },
    { name: "西安", region: "關中", lat: 34.342, lng: 108.94 },
    { name: "南京", region: "江寧江淮", lat: 32.061, lng: 118.798 },
    { name: "蘇州", region: "太湖", lat: 31.299, lng: 120.585 },
    { name: "上海", region: "滬上", lat: 31.23, lng: 121.474 },
    { name: "杭州", region: "會稽浙東", lat: 30.274, lng: 120.155 },
    { name: "廣州", region: "珠江嶺南", lat: 23.129, lng: 113.264 },
    { name: "泉州", region: "閩中沿海", lat: 24.874, lng: 118.676 },
    { name: "福州", region: "閩中沿海", lat: 26.074, lng: 119.297 },
    { name: "成都", region: "蜀郡天府", lat: 30.573, lng: 104.067 },
    { name: "重慶", region: "峽江", lat: 29.563, lng: 106.551 },
    { name: "武漢", region: "江漢荊楚", lat: 30.593, lng: 114.306 },
    { name: "瀋陽", region: "遼東", lat: 41.806, lng: 123.432 },
    { name: "蘭州", region: "河西隴右", lat: 36.061, lng: 103.834 },
    { name: "昆明", region: "南詔滇東", lat: 25.039, lng: 102.718 },
    { name: "拉薩", region: "衛藏吐蕃", lat: 29.652, lng: 91.141 },
    { name: "香港", region: "珠江嶺南", lat: 22.319, lng: 114.169 },
  ],
  // ── 亞洲其他地區（60）──────────────────────────────────
  otherAsia: [
    { name: "東京", region: "江戶平原", lat: 35.69, lng: 139.692 },
    { name: "京都", region: "近畿", lat: 35.011, lng: 135.768 },
    { name: "大阪", region: "近畿", lat: 34.694, lng: 135.502 },
    { name: "名古屋", region: "東海中京圈", lat: 35.181, lng: 136.906 },
    { name: "金澤", region: "北陸信越", lat: 36.561, lng: 136.656 },
    { name: "廣島", region: "山陰山陽", lat: 34.385, lng: 132.455 },
    { name: "長崎", region: "九州島", lat: 32.75, lng: 129.878 },
    { name: "札幌", region: "北海道", lat: 43.062, lng: 141.354 },
    { name: "首爾", region: "首爾首都圈", lat: 37.566, lng: 126.978 },
    { name: "平壤城", region: "平壤", lat: 39.02, lng: 125.738 },
    { name: "釜山", region: "釜山廣域圈", lat: 35.18, lng: 129.075 },
    { name: "台北", region: "雞籠", lat: 25.033, lng: 121.565 },
    { name: "台南", region: "打狗", lat: 22.999, lng: 120.227 },
    { name: "烏蘭巴托", region: "興安漠北", lat: 47.886, lng: 106.906 },
    { name: "河內", region: "紅河三角洲", lat: 21.028, lng: 105.854 },
    { name: "順化", region: "長山山脈", lat: 16.464, lng: 107.586 },
    { name: "西貢", region: "湄公河三角洲", lat: 10.776, lng: 106.701 },
    { name: "曼谷", region: "湄南河平原", lat: 13.756, lng: 100.502 },
    { name: "大城", region: "湄南河平原", lat: 14.353, lng: 100.569 },
    { name: "仰光", region: "伊洛瓦底平原", lat: 16.866, lng: 96.195 },
    { name: "曼德勒", region: "撣邦高原", lat: 21.975, lng: 96.084 },
    { name: "金邊", region: "洞里薩湖盆地", lat: 11.556, lng: 104.928 },
    { name: "暹粒", region: "洞里薩湖盆地", lat: 13.362, lng: 103.86 },
    { name: "永珍", region: "萬象寮國谷地", lat: 17.975, lng: 102.633 },
    { name: "馬六甲", region: "半島東西海岸", lat: 2.19, lng: 102.269 },
    { name: "新加坡城", region: "半島東西海岸", lat: 1.352, lng: 103.82 },
    { name: "雅加達", region: "爪哇島", lat: -6.208, lng: 106.846 },
    { name: "泗水", region: "爪哇島", lat: -7.257, lng: 112.732 },
    { name: "馬尼拉", region: "呂宋民答那峨", lat: 14.599, lng: 120.984 },
    { name: "德里", region: "旁遮普", lat: 28.614, lng: 77.209 },
    { name: "阿格拉", region: "北方邦", lat: 27.177, lng: 78.008 },
    { name: "孟買", region: "馬哈拉施特拉", lat: 19.076, lng: 72.878 },
    { name: "果阿城", region: "果阿", lat: 15.496, lng: 73.828 },
    { name: "班加羅爾", region: "果阿", lat: 12.972, lng: 77.594 },
    { name: "清奈", region: "坦米爾納杜", lat: 13.083, lng: 80.27 },
    { name: "海得拉巴", region: "安得拉與特倫甘納", lat: 17.385, lng: 78.487 },
    { name: "加爾各答", region: "西孟加拉", lat: 22.573, lng: 88.364 },
    { name: "達卡", region: "西孟加拉", lat: 23.81, lng: 90.412 },
    { name: "撒馬爾罕城", region: "撒馬爾罕", lat: 39.655, lng: 66.976 },
    { name: "布哈拉", region: "撒馬爾罕", lat: 39.768, lng: 64.421 },
    { name: "塔什干城", region: "塔什干", lat: 41.299, lng: 69.24 },
    { name: "阿拉木圖城", region: "阿拉木圖", lat: 43.238, lng: 76.889 },
    { name: "梅爾夫", region: "馬雷馬爾吉亞納", lat: 37.663, lng: 62.19 },
    { name: "伊斯坦堡城", region: "伊斯坦堡", lat: 41.008, lng: 28.978 },
    { name: "巴格達城", region: "巴格達", lat: 33.315, lng: 44.366 },
    { name: "巴斯拉", region: "伊拉克南", lat: 30.508, lng: 47.783 },
    { name: "大馬士革", region: "敘利亞", lat: 33.513, lng: 36.292 },
    { name: "阿勒坡", region: "敘利亞", lat: 36.202, lng: 37.161 },
    { name: "貝魯特", region: "黎巴嫩", lat: 33.869, lng: 35.491 },
    { name: "耶路撒冷", region: "巴勒斯坦", lat: 31.771, lng: 35.217 },
    { name: "麥加", region: "漢志麥加", lat: 21.389, lng: 39.857 },
    { name: "德黑蘭城", region: "德黑蘭", lat: 35.689, lng: 51.389 },
    { name: "大不里士", region: "德黑蘭", lat: 38.081, lng: 46.291 },
    { name: "伊斯法罕城", region: "伊斯法罕", lat: 32.654, lng: 51.668 },
    { name: "提比里斯", region: "格魯吉亞", lat: 41.716, lng: 44.783 },
    { name: "巴庫", region: "亞塞拜然", lat: 40.409, lng: 49.867 },
    { name: "葉里溫", region: "亞美尼亞", lat: 40.179, lng: 44.499 },
    { name: "麥地那", region: "漢志麥加", lat: 24.524, lng: 39.597 },
    { name: "科尼亞", region: "安卡拉", lat: 37.874, lng: 32.492 },
    { name: "設拉子", region: "伊斯法罕", lat: 29.591, lng: 52.584 },
    // Task #311 補增（+46；北亞5／東亞30／南亞8／澳洲3）
    { name: "新西伯利亞", region: "西西伯利亞", lat: 55.04, lng: 82.93 },
    { name: "伊爾庫茨克", region: "貝加爾湖區", lat: 52.29, lng: 104.3 },
    { name: "雅庫茨克", region: "薩哈雅庫特", lat: 62.03, lng: 129.73 },
    { name: "巴爾瑙爾", region: "阿爾泰薩彥", lat: 53.35, lng: 83.78 },
    { name: "鄂木斯克", region: "西西伯利亞", lat: 54.99, lng: 73.37 },
    { name: "橫濱", region: "江戶平原", lat: 35.444, lng: 139.638 },
    { name: "千葉", region: "江戶平原", lat: 35.607, lng: 140.106 },
    { name: "埼玉", region: "江戶平原", lat: 35.861, lng: 139.646 },
    { name: "仙台", region: "東北地方", lat: 38.268, lng: 140.872 },
    { name: "盛岡", region: "東北地方", lat: 39.702, lng: 141.153 },
    { name: "新潟", region: "北陸信越", lat: 37.902, lng: 139.023 },
    { name: "長野", region: "北陸信越", lat: 36.651, lng: 138.181 },
    { name: "靜岡", region: "東海中京圈", lat: 34.976, lng: 138.383 },
    { name: "岐阜", region: "東海中京圈", lat: 35.423, lng: 136.76 },
    { name: "神戶", region: "近畿", lat: 34.69, lng: 135.196 },
    { name: "奈良", region: "近畿", lat: 34.685, lng: 135.805 },
    { name: "岡山", region: "山陰山陽", lat: 34.655, lng: 133.919 },
    { name: "鳥取", region: "山陰山陽", lat: 35.501, lng: 134.238 },
    { name: "高松", region: "四國地方", lat: 34.34, lng: 134.043 },
    { name: "松山", region: "四國地方", lat: 33.839, lng: 132.766 },
    { name: "福岡", region: "九州島", lat: 33.59, lng: 130.402 },
    { name: "熊本", region: "九州島", lat: 32.803, lng: 130.708 },
    { name: "鹿兒島", region: "九州島", lat: 31.596, lng: 130.557 },
    { name: "仁川", region: "首爾首都圈", lat: 37.456, lng: 126.705 },
    { name: "水原", region: "首爾首都圈", lat: 37.263, lng: 127.029 },
    { name: "大田", region: "忠清地方", lat: 36.35, lng: 127.385 },
    { name: "清州", region: "忠清地方", lat: 36.642, lng: 127.489 },
    { name: "大邱", region: "大邱慶北", lat: 35.872, lng: 128.601 },
    { name: "慶州", region: "大邱慶北", lat: 35.856, lng: 129.225 },
    { name: "光州", region: "全羅地方", lat: 35.16, lng: 126.851 },
    { name: "全州", region: "全羅地方", lat: 35.824, lng: 127.148 },
    { name: "濟州", region: "濟州島", lat: 33.499, lng: 126.531 },
    { name: "春川", region: "江原道", lat: 37.881, lng: 127.73 },
    { name: "江陵", region: "江原道", lat: 37.752, lng: 128.876 },
    { name: "咸興", region: "江原", lat: 39.918, lng: 127.536 },
    { name: "拉合爾", region: "印度河上游", lat: 31.549, lng: 74.343 },
    { name: "喀拉蚩", region: "信德平原", lat: 24.861, lng: 67.01 },
    { name: "加德滿都", region: "尼泊爾", lat: 27.712, lng: 85.324 },
    { name: "可倫坡", region: "斯里蘭卡", lat: 6.927, lng: 79.861 },
    { name: "齋浦爾", region: "拉賈斯坦", lat: 26.912, lng: 75.787 },
    { name: "阿默達巴德", region: "古吉拉特", lat: 23.022, lng: 72.571 },
    { name: "浦那", region: "馬哈拉施特拉", lat: 18.52, lng: 73.857 },
    { name: "勒克瑙", region: "北方邦", lat: 26.847, lng: 80.947 },
    { name: "雪梨", region: "澳洲東部沿海", lat: -33.868, lng: 151.209 },
    { name: "墨爾本", region: "澳洲東部沿海", lat: -37.813, lng: 144.963 },
    { name: "伯斯", region: "澳洲中西部內陸", lat: -31.953, lng: 115.857 },
  ],
  // ── 美洲（30）───────────────────────────────────────────
  americas: [
    { name: "紐約", region: "賓州大西洋中", lat: 40.75, lng: -74.021 },
    { name: "波士頓", region: "新英格蘭", lat: 42.36, lng: -71.059 },
    { name: "費城", region: "賓州大西洋中", lat: 39.953, lng: -75.164 },
    { name: "華盛頓", region: "賓州大西洋中", lat: 38.907, lng: -77.037 },
    { name: "芝加哥", region: "五大湖芝加哥", lat: 41.878, lng: -87.63 },
    { name: "底特律", region: "五大湖芝加哥", lat: 42.331, lng: -83.046 },
    { name: "聖路易", region: "五大湖芝加哥", lat: 38.627, lng: -90.199 },
    { name: "紐奧良", region: "深南迪克西", lat: 29.951, lng: -90.072 },
    { name: "舊金山", region: "北加州灣區", lat: 37.804, lng: -122.271 },
    { name: "洛杉磯", region: "南加州", lat: 34.052, lng: -118.244 },
    { name: "多倫多", region: "安大略", lat: 43.653, lng: -79.383 },
    { name: "蒙特婁", region: "魁北克", lat: 45.502, lng: -73.507 },
    { name: "哈利法克斯", region: "魁北克", lat: 44.649, lng: -63.576 },
    { name: "墨西哥城", region: "太平洋沿岸", lat: 19.433, lng: -99.133 },
    { name: "維拉克魯斯", region: "太平洋沿岸", lat: 19.174, lng: -96.135 },
    { name: "瓜地馬拉城", region: "中美地峽", lat: 14.634, lng: -90.507 },
    { name: "巴拿馬城", region: "中美地峽", lat: 8.983, lng: -79.519 },
    { name: "波哥大", region: "哥倫比亞", lat: 4.711, lng: -74.072 },
    { name: "加拉加斯", region: "委內瑞拉", lat: 10.48, lng: -66.904 },
    { name: "基多", region: "厄瓜多", lat: -0.18, lng: -78.468 },
    { name: "利馬", region: "利馬祕魯", lat: -12.046, lng: -77.043 },
    { name: "庫斯科", region: "安地斯高地", lat: -13.532, lng: -71.967 },
    { name: "波托西", region: "玻利維亞", lat: -19.584, lng: -65.753 },
    { name: "里約熱內盧", region: "里約聖保羅", lat: -22.876, lng: -43.247 },
    { name: "聖保羅市", region: "里約聖保羅", lat: -23.551, lng: -46.633 },
    { name: "薩爾瓦多城", region: "巴西高地", lat: -12.972, lng: -38.501 },
    { name: "亞松森", region: "巴拉圭", lat: -25.264, lng: -57.576 },
    { name: "蒙特維多", region: "烏拉圭", lat: -34.895, lng: -56.168 },
    { name: "布宜諾斯艾利斯", region: "布宜諾斯", lat: -34.604, lng: -58.382 },
    { name: "聖地牙哥", region: "智利", lat: -33.449, lng: -70.669 },
    // Task #311 補增（+20；北美10／南美10）
    { name: "休士頓", region: "大德州", lat: 29.76, lng: -95.37 },
    { name: "達拉斯", region: "大德州", lat: 32.777, lng: -96.797 },
    { name: "亞特蘭大", region: "深南迪克西", lat: 33.749, lng: -84.388 },
    { name: "西雅圖", region: "西北太平洋", lat: 47.606, lng: -122.332 },
    { name: "丹佛", region: "西南四角地帶", lat: 39.739, lng: -104.99 },
    { name: "鳳凰城", region: "西南四角地帶", lat: 33.448, lng: -112.074 },
    { name: "溫哥華", region: "卑詩", lat: 49.283, lng: -123.121 },
    { name: "卡加利", region: "卑詩", lat: 51.049, lng: -114.07 },
    { name: "溫尼伯", region: "加西草原", lat: 49.9, lng: -97.139 },
    { name: "瓜達拉哈拉", region: "中央高原", lat: 20.667, lng: -103.35 },
    { name: "麥德林", region: "哥倫比亞", lat: 6.244, lng: -75.581 },
    { name: "卡利", region: "哥倫比亞", lat: 3.452, lng: -76.532 },
    { name: "瓜亞基爾", region: "厄瓜多", lat: -2.17, lng: -79.922 },
    { name: "巴西利亞", region: "巴西高地", lat: -15.794, lng: -47.882 },
    { name: "貝洛奧里藏特", region: "里約聖保羅", lat: -19.917, lng: -43.934 },
    { name: "累西腓", region: "巴西高地", lat: -8.047, lng: -34.877 },
    { name: "馬瑙斯", region: "亞馬遜盆地", lat: -3.119, lng: -60.021 },
    { name: "羅薩里奧", region: "潘帕斯平原", lat: -32.951, lng: -60.64 },
    { name: "拉巴斯", region: "玻利維亞", lat: -16.5, lng: -68.15 },
    { name: "阿雷基帕", region: "安地斯高地", lat: -16.409, lng: -71.537 },
  ],
  // ── 非洲（22）───────────────────────────────────────────
  africa: [
    { name: "開羅", region: "埃及尼羅", lat: 30.044, lng: 31.236 },
    { name: "廷巴克圖", region: "薩赫爾西", lat: 16.766, lng: -3.003 },
    // Task #311 補增（+20）
    { name: "突尼斯", region: "阿特拉斯", lat: 36.806, lng: 10.181 },
    { name: "阿爾及爾", region: "阿特拉斯", lat: 36.753, lng: 3.058 },
    { name: "卡薩布蘭卡", region: "阿特拉斯", lat: 33.573, lng: -7.59 },
    { name: "馬拉喀什", region: "撒哈拉西", lat: 31.63, lng: -7.99 },
    { name: "拉哥斯", region: "奈及利亞", lat: 6.455, lng: 3.394 },
    { name: "卡諾", region: "奈及利亞", lat: 12, lng: 8.516 },
    { name: "阿克拉", region: "幾內亞灣", lat: 5.603, lng: -0.187 },
    { name: "阿必尚", region: "幾內亞灣", lat: 5.36, lng: -4.008 },
    { name: "阿迪斯阿貝巴", region: "衣索比亞", lat: 9.03, lng: 38.74 },
    { name: "摩加迪休", region: "非洲之角", lat: 2.046, lng: 45.318 },
    { name: "蒙巴薩", region: "大湖區北", lat: -4.043, lng: 39.668 },
    { name: "三蘭港", region: "大湖區南", lat: -6.792, lng: 39.208 },
    { name: "金夏沙", region: "剛果盆地", lat: -4.325, lng: 15.322 },
    { name: "羅安達", region: "安哥拉北", lat: -8.839, lng: 13.289 },
    { name: "路沙卡", region: "尚比西河", lat: -15.387, lng: 28.323 },
    { name: "哈拉雷", region: "尚比西河", lat: -17.829, lng: 31.053 },
    { name: "溫得和克", region: "西南非洲", lat: -22.56, lng: 17.084 },
    { name: "約翰尼斯堡", region: "南非德蘭", lat: -26.204, lng: 28.047 },
    { name: "喀土穆", region: "蘇丹草原", lat: 15.5, lng: 32.56 },
    { name: "塔那那利佛", region: "馬達加斯", lat: -18.879, lng: 47.508 },
  ],
  // ── 姆大陸（12，虛構）────────────────────────────────────
  mu: [
    { name: "姆都．伊爾曼", region: "王都盆地", lat: 1.496, lng: -143.975 },
    { name: "太陽神殿城", region: "姆中央谷地", lat: 2.635, lng: -156.816 },
    { name: "白珊瑚港", region: "珊瑚灣", lat: -11.175, lng: -143.711 },
    { name: "月湖城", region: "月神湖區", lat: -4.204, lng: -139.775 },
    { name: "聖樹鎮", region: "聖樹平原", lat: -4.876, lng: -153.482 },
    { name: "落日港", region: "落日灣", lat: 1.415, lng: -168.235 },
    { name: "翡翠津", region: "翡翠半島", lat: -3.625, lng: -163.222 },
    { name: "紅岩堡", region: "紅岩台地", lat: -7.16, lng: -146.2 },
    { name: "晨星關", region: "晨星岬", lat: 6.412, lng: -167.57 },
    { name: "波納佩灣港", region: "波納佩灣", lat: 4.188, lng: -171.213 },
    { name: "長尾渡", region: "長尾北岸", lat: -3.275, lng: -132.935 },
    { name: "遺跡守望", region: "遺跡高地", lat: -11.555, lng: -126.856 },
  ],
};

export const CITY_QUOTA_GROUPS = Object.keys(MAP_CITY_SEED) as CityQuotaGroup[];

/** 全部城市（依配額組順序攤平）。 */
export function getAllCitySeeds(): MapCitySeed[] {
  return CITY_QUOTA_GROUPS.flatMap((g) => [...MAP_CITY_SEED[g]]);
}

/** 種子完整性驗證：配額、名稱唯一、經緯度範圍、地區存在。 */
export function validateMapCitySeed(): void {
  const regionNames = new Set(Object.values(MAP_REGION_SEED).flat());
  const seen = new Set<string>();
  for (const group of CITY_QUOTA_GROUPS) {
    const cities = MAP_CITY_SEED[group];
    if (cities.length !== EXPECTED_CITY_QUOTAS[group]) {
      throw new Error(
        `map city seed: group ${group} has ${cities.length} cities, expected ${EXPECTED_CITY_QUOTAS[group]}`,
      );
    }
    for (const c of cities) {
      if (seen.has(c.name)) {
        throw new Error(`map city seed: duplicate city name ${c.name}`);
      }
      seen.add(c.name);
      if (!regionNames.has(c.region)) {
        throw new Error(`map city seed: city ${c.name} has unknown region ${c.region}`);
      }
      if (!Number.isFinite(c.lat) || c.lat < -90 || c.lat > 90) {
        throw new Error(`map city seed: city ${c.name} has invalid lat ${c.lat}`);
      }
      if (!Number.isFinite(c.lng) || c.lng < -180 || c.lng > 180) {
        throw new Error(`map city seed: city ${c.name} has invalid lng ${c.lng}`);
      }
    }
  }
}

/**
 * Idempotent startup sync: create the map_cities table if missing, upsert
 * all cities by name (region/lat/lng follow the seed), and remove stale
 * rows. Must run after runMapRegionSync (needs map_regions rows).
 */
export async function runMapCitySync(): Promise<void> {
  validateMapCitySeed();

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS map_cities (
      id serial PRIMARY KEY,
      name text NOT NULL,
      region_id integer NOT NULL,
      lat double precision NOT NULL,
      lng double precision NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT map_cities_region_id_map_regions_id_fk
        FOREIGN KEY (region_id) REFERENCES map_regions(id) ON DELETE CASCADE
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS map_cities_name_uidx ON map_cities (name)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS map_cities_region_idx ON map_cities (region_id)
  `);
  // Task #311 — 玩家自訂城市名（全域單值）。守衛式冪等 ADD COLUMN；種子同步
  // 只 upsert region_id/lat/lng，永遠不覆寫 custom_name。
  await db.execute(sql`
    ALTER TABLE map_cities ADD COLUMN IF NOT EXISTS custom_name text
  `);
  await db.execute(sql`
    ALTER TABLE map_cities ADD COLUMN IF NOT EXISTS custom_name_nation_id uuid
  `);
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'map_cities_custom_name_nation_id_fk'
      ) THEN
        ALTER TABLE map_cities
          ADD CONSTRAINT map_cities_custom_name_nation_id_fk
          FOREIGN KEY (custom_name_nation_id)
          REFERENCES player_nations(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);

  const idRows = await db.execute<{ id: number; name: string }>(sql`
    SELECT id, name FROM map_regions
  `);
  const idByName = new Map<string, number>();
  for (const row of idRows.rows as Array<{ id: number; name: string }>) {
    idByName.set(row.name, row.id);
  }

  const cities = getAllCitySeeds();
  const rows = cities.map((c) => {
    const regionId = idByName.get(c.region);
    if (regionId === undefined) {
      throw new Error(`map city sync: missing region id for ${c.name} (${c.region})`);
    }
    return { name: c.name, regionId, lat: c.lat, lng: c.lng };
  });

  await db.execute(sql`
    INSERT INTO map_cities (name, region_id, lat, lng)
    SELECT e->>'name', (e->>'regionId')::int,
           (e->>'lat')::double precision, (e->>'lng')::double precision
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) AS e
    ON CONFLICT (name) DO UPDATE
      SET region_id = EXCLUDED.region_id,
          lat = EXCLUDED.lat,
          lng = EXCLUDED.lng,
          updated_at = NOW()
      WHERE (map_cities.region_id, map_cities.lat, map_cities.lng)
        IS DISTINCT FROM (EXCLUDED.region_id, EXCLUDED.lat, EXCLUDED.lng)
  `);

  const stale = await db.execute(sql`
    DELETE FROM map_cities
    WHERE name NOT IN (
      SELECT jsonb_array_elements_text(${JSON.stringify(rows.map((r) => r.name))}::jsonb)
    )
    RETURNING name
  `);
  if (stale.rows.length > 0) {
    logger.warn(
      { removed: stale.rows.map((r) => (r as { name: string }).name) },
      "map city sync: removed cities no longer in seed",
    );
  }

  const summary = await db.execute<{ cities: number }>(sql`
    SELECT count(*)::int AS cities FROM map_cities
  `);
  logger.info(summary.rows[0] as Record<string, number>, "map city sync complete");
}
