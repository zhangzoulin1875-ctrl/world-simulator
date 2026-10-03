import { strict as assert } from "node:assert";
import test from "node:test";
import {
  parseGiftRequest,
  parseGiftTarget,
  parseGiftNote,
  giftTargetLabel,
  giftSatisfactionDirections,
  buildGiftNotification,
  parseStartingResourcesUpdate,
  GIFT_RESOURCE_SPECS,
  GIFT_DURATION_MAX,
  STARTING_TECH_POINTS_MAX,
  STARTING_MONEY_MAX,
  FOUNDING_PRODUCTION_CAP_MAX,
} from "./gifts";

// ── Task #504 — 開局資源設定驗證 ──

test("parseStartingResourcesUpdate: 合法值（含 0 與上限）", () => {
  const r = parseStartingResourcesUpdate({
    startingTechPoints: 200,
    startingMoney: 5000,
    foundingProductionCap: 10000,
  });
  assert.ok("update" in r);
  assert.deepEqual(r.update, { startingTechPoints: 200, startingMoney: 5000, foundingProductionCap: 10000 });

  const zero = parseStartingResourcesUpdate({
    startingTechPoints: 0,
    startingMoney: 0,
    foundingProductionCap: 0,
  });
  assert.ok("update" in zero);

  const max = parseStartingResourcesUpdate({
    startingTechPoints: STARTING_TECH_POINTS_MAX,
    startingMoney: STARTING_MONEY_MAX,
    foundingProductionCap: FOUNDING_PRODUCTION_CAP_MAX,
  });
  assert.ok("update" in max);
});

test("parseStartingResourcesUpdate: 非法科技點數 → zh-TW 錯誤", () => {
  for (const bad of [
    -1,
    1.5,
    Number.NaN,
    "200" as unknown,
    undefined,
    STARTING_TECH_POINTS_MAX + 1,
  ]) {
    const r = parseStartingResourcesUpdate({
      startingTechPoints: bad,
      startingMoney: 5000,
      foundingProductionCap: 10000,
    });
    assert.ok("error" in r, `startingTechPoints=${String(bad)} 應被拒絕`);
    assert.match(r.error, /開局科技點數/);
  }
});

test("parseStartingResourcesUpdate: 非法金錢 → zh-TW 錯誤", () => {
  for (const bad of [
    -1,
    2.5,
    Number.NaN,
    "5000" as unknown,
    undefined,
    STARTING_MONEY_MAX + 1000,
  ]) {
    const r = parseStartingResourcesUpdate({
      startingTechPoints: 200,
      startingMoney: bad,
      foundingProductionCap: 10000,
    });
    assert.ok("error" in r, `startingMoney=${String(bad)} 應被拒絕`);
    assert.match(r.error, /開局金錢/);
  }
});

test("parseStartingResourcesUpdate: 非法生產力上限 → zh-TW 錯誤", () => {
  for (const bad of [
    -1,
    1.5,
    Number.NaN,
    "10000" as unknown,
    undefined,
    FOUNDING_PRODUCTION_CAP_MAX + 1,
  ]) {
    const r = parseStartingResourcesUpdate({
      startingTechPoints: 200,
      startingMoney: 5000,
      foundingProductionCap: bad,
    });
    assert.ok("error" in r, `foundingProductionCap=${String(bad)} 應被拒絕`);
    assert.match(r.error, /開局生產力上限/);
  }
});

test("parseGiftRequest: 合法的科技點數發放（指定國家）", () => {
  const r = parseGiftRequest({
    resource: "techPoints",
    amount: 1000,
    target: { type: "nation", nationId: "abc-123" },
    note: " 活動獎勵 ",
  });
  assert.ok("request" in r);
  assert.deepEqual(r.request, {
    resource: "techPoints",
    amount: 1000,
    target: { type: "nation", nationId: "abc-123" },
    note: "活動獎勵",
    durationTurns: null,
    direction: null,
  });
});

test("parseGiftRequest: 合法的金錢普發（全體）", () => {
  const r = parseGiftRequest({
    resource: "money",
    amount: 5000,
    target: { type: "all" },
  });
  assert.ok("request" in r);
  assert.equal(r.request.resource, "money");
  assert.equal(r.request.target.type, "all");
  assert.equal(r.request.note, null);
});

test("parseGiftRequest: 未知資源 → 錯誤", () => {
  const r = parseGiftRequest({ resource: "gold", amount: 1, target: { type: "all" } });
  assert.ok("error" in r);
});

test("parseGiftRequest: amount 必須是 ≥1 的整數", () => {
  for (const amount of [0, -5, 1.5, Number.NaN, "10" as unknown]) {
    const r = parseGiftRequest({ resource: "money", amount, target: { type: "all" } });
    assert.ok("error" in r, `amount=${String(amount)} 應被拒絕`);
  }
});

test("parseGiftRequest: amount 超過資源上限 → 錯誤", () => {
  const overTech = parseGiftRequest({
    resource: "techPoints",
    amount: GIFT_RESOURCE_SPECS.techPoints.max + 1,
    target: { type: "all" },
  });
  assert.ok("error" in overTech);
  const atMax = parseGiftRequest({
    resource: "money",
    amount: GIFT_RESOURCE_SPECS.money.max,
    target: { type: "allNpcs" },
  });
  assert.ok("request" in atMax);
});

test("parseGiftRequest: 指定國家但缺 nationId → 錯誤", () => {
  const r = parseGiftRequest({
    resource: "money",
    amount: 100,
    target: { type: "nation", nationId: "  " },
  });
  assert.ok("error" in r);
});

test("parseGiftRequest: target 格式不正確 → 錯誤", () => {
  for (const target of [null, undefined, {}, { type: "everyone" }, "all" as unknown]) {
    const r = parseGiftRequest({ resource: "money", amount: 1, target });
    assert.ok("error" in r, `target=${JSON.stringify(target)} 應被拒絕`);
  }
});

test("parseGiftTarget: 三種普發型別與指定國家", () => {
  assert.deepEqual(parseGiftTarget({ type: "all" }), { target: { type: "all" } });
  assert.deepEqual(parseGiftTarget({ type: "allPlayers" }), {
    target: { type: "allPlayers" },
  });
  assert.deepEqual(parseGiftTarget({ type: "allNpcs" }), {
    target: { type: "allNpcs" },
  });
  const nation = parseGiftTarget({ type: "nation", nationId: " x " });
  assert.deepEqual(nation, { target: { type: "nation", nationId: "x" } });
});

test("parseGiftNote: 空字串/非字串→null，過長截斷", () => {
  assert.equal(parseGiftNote("   "), null);
  assert.equal(parseGiftNote(123), null);
  assert.equal(parseGiftNote(null), null);
  assert.equal(parseGiftNote("嗨"), "嗨");
  const long = "字".repeat(500);
  assert.equal(parseGiftNote(long)?.length, 200);
});

test("giftTargetLabel: 中文標籤", () => {
  assert.equal(giftTargetLabel({ type: "all" }), "全體國家");
  assert.equal(giftTargetLabel({ type: "allPlayers" }), "全體玩家");
  assert.equal(giftTargetLabel({ type: "allNpcs" }), "全體 NPC");
  assert.equal(giftTargetLabel({ type: "nation", nationId: "x" }), "指定國家");
});

test("buildGiftNotification: 含資源名稱、千分位與附註", () => {
  const withNote = buildGiftNotification("money", 1234567, "補償");
  assert.match(withNote.body, /金錢/);
  assert.match(withNote.body, /1,234,567/);
  assert.match(withNote.body, /附註：補償/);

  const noNote = buildGiftNotification("techPoints", 50, null);
  assert.match(noNote.body, /科技點數/);
  assert.doesNotMatch(noNote.body, /附註/);
});

test("parseGiftRequest: 合法的滿意度暫時 buff（單一方向）", () => {
  const r = parseGiftRequest({
    resource: "satisfaction",
    amount: 10,
    durationTurns: 5,
    direction: "law",
    target: { type: "allPlayers" },
  });
  assert.ok("request" in r);
  assert.equal(r.request.resource, "satisfaction");
  assert.equal(r.request.amount, 10);
  assert.equal(r.request.durationTurns, 5);
  assert.equal(r.request.direction, "law");
});

test("parseGiftRequest: 滿意度可指定全部方向", () => {
  const r = parseGiftRequest({
    resource: "satisfaction",
    amount: 8,
    durationTurns: 3,
    direction: "all",
    target: { type: "all" },
  });
  assert.ok("request" in r);
  assert.equal(r.request.direction, "all");
});

test("parseGiftRequest: 滿意度缺方向 → 錯誤", () => {
  const r = parseGiftRequest({
    resource: "satisfaction",
    amount: 8,
    durationTurns: 3,
    target: { type: "all" },
  });
  assert.ok("error" in r);
});

test("parseGiftRequest: 滿意度方向不合法 → 錯誤", () => {
  const r = parseGiftRequest({
    resource: "satisfaction",
    amount: 8,
    durationTurns: 3,
    direction: "economy",
    target: { type: "all" },
  });
  assert.ok("error" in r);
});

test("parseGiftRequest: 合法的人口增長率暫時 buff（無方向）", () => {
  const r = parseGiftRequest({
    resource: "populationGrowth",
    amount: 20,
    durationTurns: 10,
    target: { type: "allPlayers" },
  });
  assert.ok("request" in r);
  assert.equal(r.request.resource, "populationGrowth");
  assert.equal(r.request.durationTurns, 10);
  assert.equal(r.request.direction, null);
});

test("parseGiftRequest: 暫時 buff 缺持續回合數 → 錯誤", () => {
  const r = parseGiftRequest({
    resource: "populationGrowth",
    amount: 20,
    direction: null,
    target: { type: "all" },
  });
  assert.ok("error" in r);
});

test("parseGiftRequest: 暫時 buff 持續回合數必須是 1..上限 的整數", () => {
  for (const durationTurns of [
    0,
    -1,
    1.5,
    GIFT_DURATION_MAX + 1,
    "5" as unknown,
  ]) {
    const r = parseGiftRequest({
      resource: "satisfaction",
      amount: 5,
      durationTurns,
      direction: "all",
      target: { type: "all" },
    });
    assert.ok("error" in r, `durationTurns=${String(durationTurns)} 應被拒絕`);
  }
});

test("parseGiftRequest: 暫時 buff amount 上限為 100", () => {
  const over = parseGiftRequest({
    resource: "satisfaction",
    amount: 101,
    durationTurns: 3,
    direction: "all",
    target: { type: "all" },
  });
  assert.ok("error" in over);
  const atMax = parseGiftRequest({
    resource: "populationGrowth",
    amount: 100,
    durationTurns: 3,
    target: { type: "all" },
  });
  assert.ok("request" in atMax);
});

test("parseGiftRequest: 永久資源忽略 durationTurns/direction", () => {
  const r = parseGiftRequest({
    resource: "money",
    amount: 100,
    durationTurns: 5,
    direction: "law",
    target: { type: "all" },
  });
  assert.ok("request" in r);
  assert.equal(r.request.durationTurns, null);
  assert.equal(r.request.direction, null);
});

test("giftSatisfactionDirections: 單一方向 vs 全部", () => {
  assert.deepEqual(giftSatisfactionDirections("law"), ["law"]);
  assert.deepEqual(giftSatisfactionDirections("all").sort(), [
    "culture",
    "law",
    "military",
    "religion",
    "rights",
  ]);
});

test("buildGiftNotification: 暫時 buff 含持續回合與方向", () => {
  const sat = buildGiftNotification("satisfaction", 10, "活動", {
    durationTurns: 5,
    direction: "law",
  });
  assert.match(sat.body, /滿意度/);
  assert.match(sat.body, /法律/);
  assert.match(sat.body, /5 回合/);
  assert.match(sat.body, /附註：活動/);

  const pop = buildGiftNotification("populationGrowth", 20, null, {
    durationTurns: 8,
  });
  assert.match(pop.body, /人口增長率/);
  assert.match(pop.body, /8 回合/);
});
