import test from "node:test";
import assert from "node:assert/strict";
import {
  parliamentTier, allocateSeats, rubberStampParliament, rulingParty, effectiveParliamentTier,
  judgeCompliance, complianceDelta, demandPeriodDelta, naturalDrift,
  reportBonus, canSubmitReport, parliamentAlert, shouldRevolt,
  planRevolutionSplit, fallbackMessage, isDemandDue, GOVERNMENT_TIER,
  MAX_PENALTY, type ComplianceSnapshot,
} from "./core";

const snap = (o: Partial<ComplianceSnapshot> = {}): ComplianceSnapshot => ({
  atWar: false, militarySpendChange: 0, taxChange: 0,
  religionLean: 0, commerceUp: false, ...o,
});

test("政體分三檔，13 種政體都有歸類、未知政體當半專制", () => {
  assert.equal(Object.keys(GOVERNMENT_TIER).length, 14);
  assert.equal(parliamentTier("military_dictatorship"), "autocracy");
  assert.equal(parliamentTier("constitutional_monarchy"), "semi");
  assert.equal(parliamentTier("parliamentary"), "democracy");
  assert.equal(parliamentTier("???"), "semi");
  assert.equal(parliamentTier(null), "semi");
});

test("席次恆為 100、每黨至少 1 席、按權重排序", () => {
  for (const ws of [[1, 1, 1], [50, 30, 20], [97, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1]]) {
    const r = allocateSeats(ws.map((w, i) => ({ id: `p${i}`, name: `黨${i}`, stance: "welfare" as const, weight: w })));
    assert.equal(r.reduce((s, p) => s + p.seats, 0), 100, JSON.stringify(ws));
    assert.ok(r.every((p) => p.seats >= 1));
  }
  const r = allocateSeats([{ id: "a", name: "A", stance: "militarist", weight: 70 }, { id: "b", name: "B", stance: "pacifist", weight: 30 }]);
  assert.deepEqual(r.map((p) => p.seats), [70, 30]);
});

test("席次：空輸入 / 權重全 0 / 非法權重 → 空陣列，不崩", () => {
  assert.deepEqual(allocateSeats([]), []);
  assert.deepEqual(allocateSeats([{ id: "a", name: "A", stance: "welfare", weight: 0 }]), []);
  assert.deepEqual(allocateSeats([{ id: "a", name: "A", stance: "welfare", weight: NaN }]), []);
});

test("專制橡皮圖章：單一政黨 100 席，執政黨即該黨", () => {
  const p = rubberStampParliament({ id: "x", name: "愛國黨" });
  assert.equal(p.length, 1); assert.equal(p[0]!.seats, 100);
  assert.equal(rulingParty(p)!.id, "x");
  assert.equal(rulingParty([]), null);
});

test("執政黨平手取 id 字典序小者（確定性）", () => {
  const r = rulingParty([
    { id: "b", name: "B", stance: "welfare", weight: 1, seats: 50 },
    { id: "a", name: "A", stance: "welfare", weight: 1, seats: 50 },
  ]);
  assert.equal(r!.id, "a");
});

test("什麼都沒做(沒有任何變化)→ 只依實際狀態判定,不會因為「沒頒布政策」被扣", () => {
  // 和平黨:沒打仗、軍費沒漲 → 遵守
  assert.equal(judgeCompliance("pacifist", snap({})), "complied");
  // 節流減稅:稅率沒漲 → 遵守
  assert.equal(judgeCompliance("fiscal_hawk", snap({})), "complied");
  // 民生福利:稅沒降、軍費沒漲 → 遵守
  assert.equal(judgeCompliance("welfare", snap({})), "complied");
  // 忠誠:永遠遵守
  assert.equal(judgeCompliance("loyalist", snap({})), "complied");
  // 擴軍/宗教/世俗/商貿:要求的是「主動作為」,沒變化 = 輕度違背(這是狀態判定,不是「沒頒布」)
  for (const st of ["militarist", "religious", "secular", "mercantile"] as const) {
    assert.equal(judgeCompliance(st, snap({})), "minor", st);
  }
});

test("各立場遵守 / 違背判定", () => {
  assert.equal(judgeCompliance("militarist", snap({ militarySpendChange: 0.1 })), "complied");
  assert.equal(judgeCompliance("militarist", snap({ militarySpendChange: -0.2 })), "severe");
  assert.equal(judgeCompliance("pacifist", snap({ atWar: true, militarySpendChange: 0.3 })), "severe");
  assert.equal(judgeCompliance("pacifist", snap({ atWar: false })), "complied");
  assert.equal(judgeCompliance("fiscal_hawk", snap({ taxChange: 6 })), "severe");
  assert.equal(judgeCompliance("fiscal_hawk", snap({ taxChange: 0 })), "complied");
  assert.equal(judgeCompliance("religious", snap({ religionLean: -1 })), "severe");
  assert.equal(judgeCompliance("secular", snap({ religionLean: -1 })), "complied");
  assert.equal(judgeCompliance("mercantile", snap({ commerceUp: true })), "complied");
});

test("半專制單次扣分最多 -8；民主可到 -25；專制不扣", () => {
  assert.equal(MAX_PENALTY.semi, 8);
  assert.equal(complianceDelta("severe", "semi"), -6);
  // 三回合全嚴重違背：半專制封頂 -8，民主封頂 -25
  const three = ["severe", "severe", "severe"] as const;
  assert.equal(demandPeriodDelta(three, "semi"), -8);
  assert.equal(demandPeriodDelta(three, "democracy"), -25);
  assert.equal(demandPeriodDelta(three, "autocracy"), 0);
  assert.equal(complianceDelta("severe", "autocracy"), 0);
});

test("遵守 → 加分；三回合全遵守 = +6", () => {
  assert.equal(complianceDelta("complied", "democracy"), 2);
  assert.equal(demandPeriodDelta(["complied", "complied", "complied"], "democracy"), 6);
});

test("議會滿意度自然漂移向 50、恆在 0–100", () => {
  assert.equal(naturalDrift(80), 79); assert.equal(naturalDrift(20), 21);
  assert.equal(naturalDrift(50), 50); assert.equal(naturalDrift(NaN), 59); // NaN 先回到起始值 60，再漂移一格
  assert.equal(naturalDrift(500), 99); assert.equal(naturalDrift(-9), 1);
});

test("國情報告：好報告加分、爛報告扣分、低於 10 加倍；專制不開放", () => {
  assert.ok(reportBonus(90, 50) > 0); assert.ok(reportBonus(0, 50) < 0);
  assert.equal(reportBonus(100, 5), reportBonus(100, 50) * 2);
  assert.ok(reportBonus(NaN, 50) <= 0);
  assert.equal(canSubmitReport("autocracy"), false);
  assert.equal(canSubmitReport("semi"), true);
  assert.equal(canSubmitReport("democracy"), true);
});

test("警示與革命條件：專制不因議會革命", () => {
  assert.equal(parliamentAlert(60), "ok"); assert.equal(parliamentAlert(24), "warn");
  assert.equal(parliamentAlert(9), "critical"); assert.equal(parliamentAlert(0), "revolt");
  assert.equal(shouldRevolt(0, "democracy"), true);
  assert.equal(shouldRevolt(0, "semi"), true);
  assert.equal(shouldRevolt(0, "autocracy"), false);
  assert.equal(shouldRevolt(1, "democracy"), false);
});

test("革命分裂：單地 40%、多地挑反對最強、無地改政體", () => {
  const one = planRevolutionSplit([{ regionId: 7, percent: 100 }]);
  assert.equal(one.mode, "split"); assert.deepEqual(one.transfers, [{ regionId: 7, percent: 40 }]);
  const multi = planRevolutionSplit([
    { regionId: 1, percent: 100, oppositionStrength: 10 },
    { regionId: 2, percent: 100, oppositionStrength: 90 },
    { regionId: 3, percent: 100, oppositionStrength: 50 },
  ]);
  assert.equal(multi.transfers.reduce((s, t) => s + t.percent, 0), 120); // 300 * 40%
  assert.equal(multi.transfers[0]!.regionId, 2);
  assert.equal(planRevolutionSplit([]).mode, "regime_change");
  assert.equal(planRevolutionSplit([{ regionId: 1, percent: 0 }]).mode, "regime_change");
});

test("議會訊息：抗議 + 政策要求兩種；專制沒有要求", () => {
  const m = fallbackMessage("militarist", "鷹派黨", "democracy");
  assert.ok(m.protest.length > 0); assert.ok(m.demand && m.demand.text.length > 0);
  assert.equal(m.demand!.stance, "militarist");
  assert.equal(fallbackMessage("loyalist", "x", "autocracy").demand, null);
});

test("要求三回合一次", () => {
  assert.equal(isDemandDue(10, null), true);
  assert.equal(isDemandDue(12, 10), false);
  assert.equal(isDemandDue(13, 10), true);
});

test("有效層級:專制 + 單一忠誠黨 = 橡皮圖章", () => {
  assert.equal(effectiveParliamentTier("autocracy", [{ stance: "loyalist", seats: 100 }]), "autocracy");
});
test("有效層級:專制 + 社會黨過半 = 升為半專制(議會開始問政)", () => {
  assert.equal(effectiveParliamentTier("autocracy", [{ stance: "welfare", seats: 55 }, { stance: "loyalist", seats: 45 }]), "semi");
});
test("有效層級:專制 + 非忠誠黨未過半(50 席整)= 仍是橡皮圖章", () => {
  assert.equal(effectiveParliamentTier("autocracy", [{ stance: "welfare", seats: 50 }, { stance: "loyalist", seats: 50 }]), "autocracy");
});
test("有效層級:忠誠黨過半不算,社會黨被逐出後恢復", () => {
  assert.equal(effectiveParliamentTier("autocracy", [{ stance: "loyalist", seats: 60 }, { stance: "welfare", seats: 40 }]), "autocracy");
});
test("有效層級:半專制/民主不受影響", () => {
  assert.equal(effectiveParliamentTier("semi", [{ stance: "loyalist", seats: 100 }]), "semi");
  assert.equal(effectiveParliamentTier("democracy", [{ stance: "welfare", seats: 10 }]), "democracy");
});
