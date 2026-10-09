import test from "node:test";
import assert from "node:assert/strict";
import {
  pointsPerHour, scoreGain, hoursBetween, canContestRig, isCoastalRegionName, pickWinner,
  validateSeasonRestart, ownedRegionNames, OWN_REGION_MIN_PERCENT, OIL_WIN_SCORE, OIL_MAX_CATCHUP_HOURS, NAVAL_TECH_SLUG,
} from "./oilRigCore";
import { OIL_RIG_SEEDS, COASTAL_REGION_NAMES } from "./oilRigSeeds";

test("每小時得分:佔越多加速越快", () => {
  assert.equal(pointsPerHour(0), 0);
  assert.equal(pointsPerHour(1), 1);
  assert.equal(pointsPerHour(2), 2.5);
  assert.equal(pointsPerHour(4), 7);
  assert.equal(pointsPerHour(8), 22);
  for (let n = 1; n < 16; n++) assert.ok(pointsPerHour(n + 1) / (n + 1) > pointsPerHour(n) / n, `第 ${n + 1} 座的平均得分應高於 ${n} 座`);
});

test("佔領數不是非負整數會丟錯,不吞掉壞資料", () => {
  for (const bad of [-1, 1.5, NaN, Infinity]) assert.throws(() => pointsPerHour(bad), RangeError);
});

test("得分只依經過時間:同樣 24 小時,不管跨幾個回合都一樣", () => {
  const once = scoreGain(5, 24);
  const split = Math.round((scoreGain(5, 6) * 4) * 100) / 100;
  assert.equal(once, split);
  assert.equal(once, pointsPerHour(5) * 24);
});

test("壞時間不會倒扣分:負數、NaN、Infinity 皆視為 0", () => {
  for (const h of [-5, NaN, -Infinity, 0]) assert.equal(scoreGain(4, h), 0);
  // +Infinity 代表時鐘壞掉:不給分(0),也不當成「超過上限」而給滿上限
  assert.equal(scoreGain(4, Infinity), 0);
  // 對照:有限的超大值才會被截斷到補算上限
  assert.equal(scoreGain(4, 1e9), scoreGain(4, OIL_MAX_CATCHUP_HOURS));
});

test("補算上限:停擺很久也不會一次灌爆分數造成瞬間勝利", () => {
  assert.equal(scoreGain(8, 10_000), scoreGain(8, OIL_MAX_CATCHUP_HOURS));
  assert.ok(scoreGain(8, 10_000) < OIL_WIN_SCORE / 10, "上限內單次結算遠低於勝利線");
});

test("hoursBetween:時鐘倒退回 0", () => {
  const a = new Date("2026-10-09T00:00:00Z"), b = new Date("2026-10-09T03:30:00Z");
  assert.equal(hoursBetween(a, b), 3.5);
  assert.equal(hoursBetween(b, a), 0);
  assert.equal(hoursBetween(new Date(NaN), b), 0);
});

test("賽季長度:領先者長期佔 5 座約 30~60 天(設計目標)", () => {
  const days = OIL_WIN_SCORE / pointsPerHour(5) / 24;
  assert.ok(days >= 30 && days <= 60, `實際 ${days.toFixed(1)} 天`);
});

test("種子資料:16 座、slug 與名稱不重複、經緯度合法、每座都有掛靠區", () => {
  assert.equal(OIL_RIG_SEEDS.length, 16);
  assert.equal(new Set(OIL_RIG_SEEDS.map((r) => r.slug)).size, 16);
  assert.equal(new Set(OIL_RIG_SEEDS.map((r) => r.name)).size, 16);
  for (const r of OIL_RIG_SEEDS) {
    assert.ok(r.lng >= -180 && r.lng <= 180 && r.lat >= -90 && r.lat <= 90, r.slug);
    assert.ok(r.anchorRegions.length >= 1, `${r.slug} 沒有掛靠區`);
    assert.equal(new Set(r.anchorRegions).size, r.anchorRegions.length, `${r.slug} 掛靠區重複`);
  }
});

test("沿海名單:內陸區不在其中、已知沿海區在其中", () => {
  for (const n of ["莫斯科", "馬德里", "巴伐利亞邦", "撒哈拉中", "布達佩斯", "基輔", "衛藏吐蕃"]) assert.equal(COASTAL_REGION_NAMES.has(n), false, n);
  for (const n of ["北海道", "雞籠", "大倫敦地區", "西西里", "冰島"]) assert.equal(COASTAL_REGION_NAMES.has(n), true, n);
  assert.equal(isCoastalRegionName("幾內亞灣"), true, "人工審定的掛靠區視為沿海");
});

test("資格:缺科技、無沿海、不在航程各有明確原因,且順序固定", () => {
  const withTech = [NAVAL_TECH_SLUG];
  assert.deepEqual(canContestRig(["北海道"], [], "japan_trench"), { ok: false, reason: "no_naval_tech" });
  assert.deepEqual(canContestRig(["莫斯科", "基輔"], withTech, "japan_trench"), { ok: false, reason: "no_coastal_region" });
  assert.deepEqual(canContestRig(["西西里"], withTech, "japan_trench"), { ok: false, reason: "rig_out_of_range" });
  assert.deepEqual(canContestRig(["北海道", "莫斯科"], withTech, "japan_trench"), { ok: true });
  assert.deepEqual(canContestRig(["北海道"], withTech, "不存在"), { ok: false, reason: "unknown_rig" });
  assert.deepEqual(canContestRig([], withTech, "japan_trench"), { ok: false, reason: "no_coastal_region" });
});

test("每座油井至少有一個掛靠區在沿海名單或人工審定中(沒有人打得到的死油井不存在)", () => {
  for (const r of OIL_RIG_SEEDS) assert.ok(r.anchorRegions.some(isCoastalRegionName), r.slug);
});

test("勝者:無人達標回 null;多人越線取最高分;同分取較早;完全相同取 id 決定論", () => {
  assert.equal(pickWinner([{ nationId: "a", score: 9999.99 }]), null);
  assert.equal(pickWinner([]), null);
  assert.equal(pickWinner([{ nationId: "a", score: 10010 }, { nationId: "b", score: 10200 }]), "b");
  assert.equal(pickWinner([
    { nationId: "a", score: 10000, reachedAt: new Date("2026-10-09T05:00:00Z") },
    { nationId: "b", score: 10000, reachedAt: new Date("2026-10-09T03:00:00Z") },
  ]), "b");
  assert.equal(pickWinner([{ nationId: "z", score: 10000 }, { nationId: "m", score: 10000 }]), "m");
  assert.equal(pickWinner([{ nationId: "n", score: NaN }]), null, "NaN 不可獲勝");
});

test("重開賽季:必須在冷卻中且指定有效年代", () => {
  const eras = ["ancient", "medieval", "modern"];
  assert.equal(validateSeasonRestart("active", "modern", eras).ok, false);
  assert.equal(validateSeasonRestart("cooldown", null, eras).ok, false);
  assert.equal(validateSeasonRestart("cooldown", "", eras).ok, false);
  assert.equal(validateSeasonRestart("cooldown", "stone", eras).ok, false);
  assert.deepEqual(validateSeasonRestart("cooldown", "modern", eras), { ok: true });
});

test("擁有地區:控制比例達門檻才算,只握少數股份的沿海區不能出海", () => {
  const owned = ownedRegionNames([
    { regionName: "北海道", percent: OWN_REGION_MIN_PERCENT },
    { regionName: "雞籠", percent: OWN_REGION_MIN_PERCENT - 1 },
    { regionName: "莫斯科", percent: 100 },
  ]);
  assert.deepEqual(owned, ["北海道", "莫斯科"]);
  // 只握 1% 沿海股份的內陸大國:不具資格
  const inlandPower = ownedRegionNames([{ regionName: "莫斯科", percent: 100 }, { regionName: "北海道", percent: 1 }]);
  assert.deepEqual(canContestRig(inlandPower, [NAVAL_TECH_SLUG], "japan_trench"), { ok: false, reason: "no_coastal_region" });
  assert.deepEqual(ownedRegionNames([]), []);
});
