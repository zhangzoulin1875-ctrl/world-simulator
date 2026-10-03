import { strict as assert } from "node:assert";
import test from "node:test";
import {
  aggregateSocialEffects,
  cityBuildingSlots,
  BUILDING_SLOTS_MAX,
  type AggregatedSocialEffects,
} from "./socialTech";

test("cityBuildingSlots：未解鎖部落革新時為 0", () => {
  const agg = aggregateSocialEffects([]);
  assert.equal(agg.buildingSlotsEnabled, false);
  assert.equal(cityBuildingSlots(agg), 0);
});

test("cityBuildingSlots：部落革新解鎖後起始 5 格", () => {
  const agg: AggregatedSocialEffects = {
    ...aggregateSocialEffects([]),
    buildingSlotsEnabled: true,
    buildingSlots: 5,
  };
  assert.equal(cityBuildingSlots(agg), 5);
});

test("cityBuildingSlots：夾在硬上限（30）內", () => {
  const agg: AggregatedSocialEffects = {
    ...aggregateSocialEffects([]),
    buildingSlotsEnabled: true,
    buildingSlots: 999,
  };
  assert.equal(cityBuildingSlots(agg), BUILDING_SLOTS_MAX);
});

test("cityBuildingSlots：負值夾為 0", () => {
  const agg: AggregatedSocialEffects = {
    ...aggregateSocialEffects([]),
    buildingSlotsEnabled: true,
    buildingSlots: -5,
  };
  assert.equal(cityBuildingSlots(agg), 0);
});
