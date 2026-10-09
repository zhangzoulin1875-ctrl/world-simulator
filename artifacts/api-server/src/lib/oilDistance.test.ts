import { strict as assert } from "node:assert";
import test from "node:test";
import {
  greatCircleKm, attackDistanceKm, distanceFactor, attackerRangeFactor,
  OIL_DISTANCE_MIN_FACTOR, OIL_DISTANCE_FALLOFF_KM, canContestRig, NAVAL_TECH_SLUG,
} from "./oilRigCore";
import { OIL_RIG_SEEDS } from "./oilRigSeeds";
import { MAP_REGION_CENTROIDS } from "./mapRegionCentroids.generated";
import { resolveOilBattle, type FleetLine } from "./oilCombat";

const close = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (±${tol})`);
// 單艦戰力 = (攻+防)/2 × √血 = 100 × √1 = 100,數字才直覺
const ship = (q: number): FleetLine => ({ templateId: 1, quantity: q, stats: { hp: 1, attack: 100, defense: 100 } });

test("大圓距離:同點 0;赤道上相隔 180° ≈ 半周長;對稱;已知城市距離", () => {
  assert.equal(greatCircleKm([5, 5], [5, 5]), 0);
  close(greatCircleKm([0, 0], [180, 0]), 20015, 5, "對蹠點");
  close(greatCircleKm([0, 0], [90, 0]), 10008, 5, "四分之一圈");
  assert.equal(greatCircleKm([10, 20], [30, 40]), greatCircleKm([30, 40], [10, 20]));
  close(greatCircleKm([-0.1276, 51.5072], [2.3522, 48.8566]), 344, 4, "倫敦-巴黎");
  close(greatCircleKm([-74.006, 40.7128], [139.6917, 35.6895]), 10838, 40, "紐約-東京");
});
test("大圓距離:跨日界線走短邊(不繞地球一圈)", () => {
  close(greatCircleKm([179, 0], [-179, 0]), 222, 2);
});
test("大圓距離:非有限輸入回 NaN,不丟例外", () => {
  assert.ok(Number.isNaN(greatCircleKm([NaN, 0], [0, 0])));
  assert.ok(Number.isNaN(greatCircleKm([0, 0], [Infinity, 0])));
});

test("距離係數:0 km=1、10000 km=0.5、12000 km 起=下限 0.4、不會低於下限", () => {
  assert.equal(distanceFactor(0), 1);
  assert.equal(distanceFactor(10000), 0.5);
  assert.equal(distanceFactor(12000), OIL_DISTANCE_MIN_FACTOR);
  assert.equal(distanceFactor(OIL_DISTANCE_FALLOFF_KM), OIL_DISTANCE_MIN_FACTOR);
  assert.equal(distanceFactor(40000), OIL_DISTANCE_MIN_FACTOR);
});
test("距離係數:單調不增", () => {
  let prev = Infinity;
  for (let km = 0; km <= 25000; km += 250) { const f = distanceFactor(km); assert.ok(f <= prev, `km=${km}`); assert.ok(f >= OIL_DISTANCE_MIN_FACTOR && f <= 1); prev = f; }
});
test("距離係數:null / NaN / 負數 / Infinity 一律保守取下限(不給滿戰力)", () => {
  for (const bad of [null, NaN, -1, -0.0001, Infinity, -Infinity]) assert.equal(distanceFactor(bad as number | null), OIL_DISTANCE_MIN_FACTOR, String(bad));
});

test("進攻距離:取離油井最近的自有地區;多塊地時近的優先", () => {
  const rig = OIL_RIG_SEEDS.find((r) => r.slug === "north_sea_1")!;
  const near = attackDistanceKm(["荷蘭"], rig)!, far = attackDistanceKm(["佛羅里達"], rig)!;
  assert.ok(near < far);
  assert.equal(attackDistanceKm(["佛羅里達", "荷蘭"], rig), near, "有荷蘭就用荷蘭");
  assert.equal(attackDistanceKm(["荷蘭", "佛羅里達"], rig), near, "順序無關");
});
test("進攻距離:沒有地區或全是未知名稱 → null(不能默默當 0 km)", () => {
  const rig = OIL_RIG_SEEDS[0]!;
  assert.equal(attackDistanceKm([], rig), null);
  assert.equal(attackDistanceKm(["不存在的地區", "另一個"], rig), null);
  assert.equal(attackDistanceKm(["不存在的地區", "荷蘭"], rig) !== null, true, "未知名稱略過,不影響已知的");
});
test("實測值:荷蘭→北海一號 ≈615km(0.969);佛羅里達→北海一號 ≈7064km(0.647);佛羅里達→墨西哥灣 ≈801km", () => {
  const nl = attackerRangeFactor(["荷蘭"], "north_sea_1");
  close(nl.km!, 615, 5); close(nl.factor, 0.9692, 0.001);
  const fl = attackerRangeFactor(["佛羅里達"], "north_sea_1");
  close(fl.km!, 7064, 10); close(fl.factor, 0.6468, 0.001);
  close(attackerRangeFactor(["佛羅里達"], "gulf_mexico").km!, 801, 5);
});
test("係數查詢:未知油井或無座標 → 下限 0.4 而非 1", () => {
  assert.deepEqual(attackerRangeFactor(["荷蘭"], "nope"), { km: null, factor: OIL_DISTANCE_MIN_FACTOR });
  assert.deepEqual(attackerRangeFactor([], "north_sea_1"), { km: null, factor: OIL_DISTANCE_MIN_FACTOR });
});

test("質心資料:397 區全在合法範圍,且每座油井的掛靠區都有質心", () => {
  const names = Object.keys(MAP_REGION_CENTROIDS);
  assert.equal(names.length, 397);
  for (const n of names) { const [lo, la] = MAP_REGION_CENTROIDS[n]!; assert.ok(lo >= -180 && lo <= 180 && la >= -90 && la <= 90, n); }
  for (const r of OIL_RIG_SEEDS) for (const a of r.anchorRegions) assert.ok(MAP_REGION_CENTROIDS[a], `${r.slug} 掛靠區 ${a} 缺質心`);
});
test("質心資料:每座油井的掛靠區離該井都在合理範圍(<4000 km),抓質心算錯", () => {
  for (const r of OIL_RIG_SEEDS) for (const a of r.anchorRegions) {
    const d = greatCircleKm(MAP_REGION_CENTROIDS[a]!, [r.lng, r.lat]);
    assert.ok(d < 4000, `${r.slug} ← ${a}: ${Math.round(d)} km`);
  }
});

test("戰鬥:攻方係數預設 1(既有行為不變);0.5 使攻方戰力減半並反映在回報值", () => {
  const base = resolveOilBattle([ship(100)], [ship(50)]);
  assert.equal(base.attackerPower, 10000);
  const half = resolveOilBattle([ship(100)], [ship(50)], 0.5);
  assert.equal(half.attackerPower, 5000);
  assert.equal(half.defenderPower, 5750, "守方不衰減,仍含地利 ×1.15");
});
test("戰鬥:距離衰減能把『近距離會贏』變成『遠距離會輸』", () => {
  // 100 艘對 80 艘守軍:守方 8000×1.15=9200 < 10000,近距離攻方勝
  assert.equal(resolveOilBattle([ship(100)], [ship(80)], 1).outcome, "attacker_wins");
  // 衰減到 0.647(佛羅里達→北海):6470 < 9200,攻方輸
  assert.equal(resolveOilBattle([ship(100)], [ship(80)], 0.647).outcome, "defender_wins");
  // 衰減下限 0.4:4000
  assert.equal(resolveOilBattle([ship(100)], [ship(80)], 0.4).outcome, "defender_wins");
});
test("戰鬥:衰減後勝負邊界精確 — 攻方須嚴格大於守方×1.15", () => {
  // 守方 100 艘 → 10000×1.15 = 11500。攻方 200 艘 × 0.575 = 11500 → 平手 → 守方勝
  assert.equal(resolveOilBattle([ship(200)], [ship(100)], 0.575).outcome, "defender_wins");
  assert.equal(resolveOilBattle([ship(200)], [ship(100)], 0.5751).outcome, "attacker_wins");
});
test("戰鬥:壞係數被夾住 — NaN 視為不衰減、>1 夾成 1、負數夾成 0", () => {
  assert.equal(resolveOilBattle([ship(10)], [ship(5)], NaN).attackerPower, 1000);
  assert.equal(resolveOilBattle([ship(10)], [ship(5)], 5).attackerPower, 1000, "不能靠係數>1放大戰力");
  assert.equal(resolveOilBattle([ship(10)], [ship(5)], -1).attackerPower, 0);
  assert.equal(resolveOilBattle([ship(10)], [ship(5)], -1).outcome, "defender_wins");
});
test("戰鬥:衰減不影響損失以外的守方空佔規則 — 守方 0 戰力仍攻方無損獲勝", () => {
  const r = resolveOilBattle([ship(10)], [], 0.4);
  assert.equal(r.outcome, "attacker_wins"); assert.equal(r.attackerLossRatio, 0);
});
test("資格仍檢查科技與沿海,距離不影響資格", () => {
  assert.deepEqual(canContestRig(["佛羅里達"], [NAVAL_TECH_SLUG], "north_sea_1"), { ok: true });
  assert.deepEqual(canContestRig(["佛羅里達"], [], "north_sea_1"), { ok: false, reason: "no_naval_tech" });
});
