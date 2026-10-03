import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRegionControls } from "./territoryHistory";

// Task #392 — diffRegionControls 純函式：full-replace 路徑共用的變更比對。

const BASE = { changeType: "admin_edit" as const, reason: "測試" };

test("無變更 → 空清單", () => {
  const controls = [{ nationId: "a", percent: 50 }];
  assert.deepEqual(diffRegionControls(1, controls, controls, BASE), []);
});

test("百分比變更 → before/after 正確", () => {
  const out = diffRegionControls(
    1,
    [{ nationId: "a", percent: 50 }],
    [{ nationId: "a", percent: 70 }],
    BASE,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.percentBefore, 50);
  assert.equal(out[0]!.percentAfter, 70);
  assert.equal(out[0]!.regionId, 1);
  assert.equal(out[0]!.changeType, "admin_edit");
});

test("移除的國家記為 after=0；新增的記為 before=0", () => {
  const out = diffRegionControls(
    2,
    [{ nationId: "a", percent: 40 }],
    [{ nationId: "b", percent: 60 }],
    BASE,
  );
  const a = out.find((e) => e.nationId === "a")!;
  const b = out.find((e) => e.nationId === "b")!;
  assert.deepEqual([a.percentBefore, a.percentAfter], [40, 0]);
  assert.deepEqual([b.percentBefore, b.percentAfter], [0, 60]);
});

test("混合：不變者略過、變更者入列", () => {
  const out = diffRegionControls(
    3,
    [
      { nationId: "a", percent: 30 },
      { nationId: "b", percent: 20 },
    ],
    [
      { nationId: "a", percent: 30 },
      { nationId: "b", percent: 25 },
    ],
    { ...BASE, changeType: "world_sim", warId: null, treatyId: null },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.nationId, "b");
  assert.equal(out[0]!.changeType, "world_sim");
});
