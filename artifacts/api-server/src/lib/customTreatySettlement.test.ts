import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planCustomTreatyTransfers,
  type CustomTreatyRow,
} from "./customTreatySettlement";

function row(overrides: Partial<CustomTreatyRow> = {}): CustomTreatyRow {
  return {
    id: 1,
    proposerNationId: "prop",
    targetNationId: "targ",
    perTurnMoney: 0,
    perTurnTech: 0,
    perTurnProduction: 0,
    perTurnWood: 0,
    perTurnOre: 0,
    requestPerTurnMoney: 0,
    requestPerTurnTech: 0,
    requestPerTurnProduction: 0,
    requestPerTurnWood: 0,
    requestPerTurnOre: 0,
    proposerIsPayer: true,
    ...overrides,
  };
}

test("proposerIsPayer=true → proposer pays, target benefits", () => {
  const plans = planCustomTreatyTransfers(
    row({ proposerIsPayer: true, perTurnMoney: 100 }),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.payerId, "prop");
  assert.equal(plans[0]!.beneficiaryId, "targ");
  assert.equal(plans[0]!.money, 100);
});

test("proposerIsPayer=false → target pays, proposer benefits", () => {
  const plans = planCustomTreatyTransfers(
    row({ proposerIsPayer: false, perTurnTech: 25 }),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.payerId, "targ");
  assert.equal(plans[0]!.beneficiaryId, "prop");
  assert.equal(plans[0]!.tech, 25);
});

test("carries all resource amounts", () => {
  const plans = planCustomTreatyTransfers(
    row({
      perTurnMoney: 10,
      perTurnTech: 20,
      perTurnProduction: 30,
      perTurnWood: 40,
      perTurnOre: 50,
    }),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.money, 10);
  assert.equal(plans[0]!.tech, 20);
  assert.equal(plans[0]!.production, 30);
  assert.equal(plans[0]!.wood, 40);
  assert.equal(plans[0]!.ore, 50);
});

test("negative amounts clamp to 0 → no plan emitted", () => {
  const plans = planCustomTreatyTransfers(
    row({
      perTurnMoney: -5,
      perTurnTech: -1,
      perTurnProduction: -100,
      perTurnWood: -7,
      perTurnOre: -3,
    }),
  );
  assert.equal(plans.length, 0);
});

test("fractional amounts truncate toward zero", () => {
  const plans = planCustomTreatyTransfers(
    row({
      perTurnMoney: 10.9,
      perTurnTech: 3.2,
      perTurnProduction: 7.7,
      perTurnWood: 2.6,
      perTurnOre: 9.1,
    }),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.money, 10);
  assert.equal(plans[0]!.tech, 3);
  assert.equal(plans[0]!.production, 7);
  assert.equal(plans[0]!.wood, 2);
  assert.equal(plans[0]!.ore, 9);
});

// Task #476 — 每回合木材／礦石的付款方向與其他資源一致。
test("proposerIsPayer=false carries wood/ore from target to proposer", () => {
  const plans = planCustomTreatyTransfers(
    row({ proposerIsPayer: false, perTurnWood: 12, perTurnOre: 34 }),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.payerId, "targ");
  assert.equal(plans[0]!.beneficiaryId, "prop");
  assert.equal(plans[0]!.wood, 12);
  assert.equal(plans[0]!.ore, 34);
});

test("treatyId is preserved on the plan", () => {
  const plans = planCustomTreatyTransfers(row({ id: 42, perTurnMoney: 1 }));
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.treatyId, 42);
});

// ── Task #527 — 反向每回合定期支付（requestPerTurn*） ──────────────

test("reverse-only row → single plan with opposite direction", () => {
  const plans = planCustomTreatyTransfers(
    row({ proposerIsPayer: true, requestPerTurnMoney: 60 }),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.payerId, "targ");
  assert.equal(plans[0]!.beneficiaryId, "prop");
  assert.equal(plans[0]!.money, 60);
});

test("reverse direction flips with proposerIsPayer=false", () => {
  const plans = planCustomTreatyTransfers(
    row({ proposerIsPayer: false, requestPerTurnTech: 9 }),
  );
  assert.equal(plans.length, 1);
  // forward payer = targ（proposerIsPayer=false）→ reverse payer = prop
  assert.equal(plans[0]!.payerId, "prop");
  assert.equal(plans[0]!.beneficiaryId, "targ");
  assert.equal(plans[0]!.tech, 9);
});

test("bidirectional row → two plans (forward + reverse)", () => {
  const plans = planCustomTreatyTransfers(
    row({
      perTurnMoney: 100,
      requestPerTurnOre: 5,
      requestPerTurnWood: 3,
    }),
  );
  assert.equal(plans.length, 2);
  const forward = plans.find((p) => p.payerId === "prop")!;
  const reverse = plans.find((p) => p.payerId === "targ")!;
  assert.equal(forward.beneficiaryId, "targ");
  assert.equal(forward.money, 100);
  assert.equal(reverse.beneficiaryId, "prop");
  assert.equal(reverse.ore, 5);
  assert.equal(reverse.wood, 3);
  assert.equal(reverse.money, 0);
});

test("reverse amounts clamp/truncate like forward", () => {
  const plans = planCustomTreatyTransfers(
    row({
      requestPerTurnMoney: -8,
      requestPerTurnTech: 4.9,
      requestPerTurnProduction: -1,
    }),
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.money, 0);
  assert.equal(plans[0]!.tech, 4);
  assert.equal(plans[0]!.production, 0);
});

test("all-zero row → no plans", () => {
  assert.equal(planCustomTreatyTransfers(row()).length, 0);
});
