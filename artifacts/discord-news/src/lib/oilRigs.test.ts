import { strict as assert } from "node:assert";
import test from "node:test";
import { formatCountdown, myRoleFor, actionFor, buildFleetPayload, type OilRigView, type OilCampaignView, type ShipView } from "./oilRigs";

const NOW = new Date("2026-10-09T12:00:00Z");
const rig = (holder: string | null): OilRigView => ({ slug: "r", name: "r", sea: "s", lng: 0, lat: 0, holder: holder ? { nationId: holder, name: "h", color: null } : null, heldSince: null, anchorRegions: [] });
const camp = (over: Partial<OilCampaignView> = {}): OilCampaignView => ({ id: 1, rigSlug: "r", status: "active", startedAt: "", settleAt: "", outcome: null, attackerNationId: "A", defenderNationId: "D", attackerShips: 0, defenderShips: 0, attackerPower: 0, defenderPower: 0, forecast: "defender_wins", ...over });
const ship = (id: number, avail: number, name = "艦"): ShipView => ({ templateId: id, name, owned: avail, committed: 0, woundedPool: 0, available: avail });

test("倒數:小時分鐘、整點、不足一小時、已到期、無效值", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  assert.equal(formatCountdown(at(5 * 3_600_000 + 30 * 60_000), NOW), "5 小時 30 分");
  assert.equal(formatCountdown(at(2 * 3_600_000), NOW), "2 小時");
  assert.equal(formatCountdown(at(45 * 60_000), NOW), "45 分鐘");
  assert.equal(formatCountdown(at(1), NOW), "1 分鐘", "不足一分鐘進位,不顯示 0 分鐘");
  assert.equal(formatCountdown(at(0), NOW), "結算中");
  assert.equal(formatCountdown(at(-5000), NOW), "結算中");
  assert.equal(formatCountdown("garbage", NOW), "—");
});

test("角色:未登入/持有者/攻方/守方/無關", () => {
  assert.equal(myRoleFor(rig("D"), camp(), null), "none");
  assert.equal(myRoleFor(rig("D"), camp(), "A"), "attacker");
  assert.equal(myRoleFor(rig("D"), camp(), "D"), "defender");
  assert.equal(myRoleFor(rig("D"), undefined, "D"), "holder");
  assert.equal(myRoleFor(rig("D"), undefined, "X"), "none");
  assert.equal(myRoleFor(rig("D"), camp(), "X"), "none", "第三國不能介入");
  assert.equal(myRoleFor(rig("D"), camp({ status: "settled" }), "A"), "none", "已結算的戰役不算");
});

test("動作:凍結一律只讀;攻守可追加;別人在打不能介入;持有者無戰役時不能自攻", () => {
  assert.equal(actionFor("none", undefined, true), "none");
  assert.equal(actionFor("attacker", camp(), true), "none");
  assert.equal(actionFor("attacker", camp(), false), "reinforce");
  assert.equal(actionFor("defender", camp(), false), "reinforce");
  assert.equal(actionFor("none", camp(), false), "none");
  assert.equal(actionFor("none", undefined, false), "attack");
  assert.equal(actionFor("holder", undefined, false), "none");
});

test("投入:空白視為 0 並略過、合計正確", () => {
  const r = buildFleetPayload({ 1: "5", 2: "", 3: "  " }, [ship(1, 10), ship(2, 4), ship(3, 4)]);
  assert.deepEqual(r, { ok: true, fleet: [{ templateId: 1, quantity: 5 }], total: 5 });
});
test("投入:全空 / 全 0 → 要求至少 1 艘", () => {
  assert.deepEqual(buildFleetPayload({}, [ship(1, 5)]), { ok: false, error: "請至少投入 1 艘艦" });
  assert.deepEqual(buildFleetPayload({ 1: "0" }, [ship(1, 5)]), { ok: false, error: "請至少投入 1 艘艦" });
});
test("投入:非整數、負數、小數、科學記號、超大數 → 拒絕", () => {
  for (const bad of ["-1", "1.5", "1e3", "abc", "０５", "5 艘", "+3"]) {
    const r = buildFleetPayload({ 1: bad }, [ship(1, 99)]);
    assert.equal(r.ok, false, bad);
  }
  assert.deepEqual(buildFleetPayload({ 1: "99999999999999999999" }, [ship(1, 5)]), { ok: false, error: "數量過大" });
});
test("投入:超過可派量指名艦種;可派量 0 的艦不能投", () => {
  assert.deepEqual(buildFleetPayload({ 1: "11" }, [ship(1, 10, "驅逐艦")]), { ok: false, error: "驅逐艦 最多可派 10 艘" });
  assert.equal(buildFleetPayload({ 1: "1" }, [ship(1, 0)]).ok, false);
});
test("投入:不在艦隊清單的艦種(竄改/過期)被拒", () => {
  assert.deepEqual(buildFleetPayload({ 999: "1" }, [ship(1, 5)]), { ok: false, error: "包含無法派遣的艦種" });
});
test("投入:前導零視為合法整數(007 = 7)", () => {
  assert.deepEqual(buildFleetPayload({ 1: "007" }, [ship(1, 10)]), { ok: true, fleet: [{ templateId: 1, quantity: 7 }], total: 7 });
});
