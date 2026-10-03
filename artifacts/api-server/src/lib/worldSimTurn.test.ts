import { strict as assert } from "node:assert";
import test from "node:test";
import {
  intensityCaps,
  buildAutoSimInstruction,
  findAffectedPlayers,
} from "./worldSimTurn";

test("intensityCaps 隨強度遞增，未知值退回最低強度", () => {
  const low = intensityCaps(1);
  const mid = intensityCaps(2);
  const high = intensityCaps(3);
  assert.ok(low.maxOperations < mid.maxOperations);
  assert.ok(mid.maxOperations < high.maxOperations);
  assert.ok(low.maxCreates < mid.maxCreates);
  assert.ok(mid.maxCreates < high.maxCreates);
  // 每個上限都是正整數。
  for (const c of [low, mid, high]) {
    assert.ok(Number.isInteger(c.maxOperations) && c.maxOperations > 0);
    assert.ok(Number.isInteger(c.maxCreates) && c.maxCreates > 0);
  }
  // 未知強度（0 / 99）退回最低。
  assert.deepEqual(intensityCaps(0), low);
  assert.deepEqual(intensityCaps(99), low);
});

test("buildAutoSimInstruction 帶入年份、時代標籤與該強度的數量上限", () => {
  const caps = intensityCaps(2);
  const text = buildAutoSimInstruction({
    year: 1850,
    eraSlug: "industrial",
    eraLabel: "工業時代",
    intensity: 2,
  });
  assert.ok(text.includes("1850"), "應包含年份");
  assert.ok(text.includes("工業時代"), "應包含時代標籤");
  assert.ok(
    text.includes(String(caps.maxOperations)),
    "應包含最多操作數上限",
  );
  assert.ok(text.includes(String(caps.maxCreates)), "應包含最多新增數上限");
  // 一律提醒不可觸及玩家。
  assert.ok(text.includes("玩家"), "應提醒不可觸及玩家");
});

test("buildAutoSimInstruction 不同強度給出不同節奏描述", () => {
  const low = buildAutoSimInstruction({
    year: 1,
    eraSlug: "classical",
    eraLabel: "古典",
    intensity: 1,
  });
  const high = buildAutoSimInstruction({
    year: 1,
    eraSlug: "classical",
    eraLabel: "古典",
    intensity: 3,
  });
  assert.notEqual(low, high);
  assert.ok(high.includes("劇烈"));
  assert.ok(low.includes("和緩"));
});

test("findAffectedPlayers：影響區 = 觸及地區 ∪ 相鄰地區", () => {
  // 地區圖：1-2-3 鏈；4 孤立。
  const adjacency = [
    { regionId: 1, adjacentRegionId: 2 },
    { regionId: 2, adjacentRegionId: 3 },
  ];
  const playerControls = [
    { regionId: 2, discordUserId: "userA" }, // 直接觸及
    { regionId: 3, discordUserId: "userB" }, // 相鄰 (2-3)
    { regionId: 4, discordUserId: "userC" }, // 完全無關
  ];
  const affected = findAffectedPlayers({
    touchedRegionIds: [2],
    adjacency,
    playerControls,
  });
  assert.ok(affected.includes("userA"));
  assert.ok(affected.includes("userB"));
  assert.ok(!affected.includes("userC"));
});

test("findAffectedPlayers：對稱處理相鄰（單向鄰接列也涵蓋反向）", () => {
  const adjacency = [{ regionId: 1, adjacentRegionId: 2 }];
  // 觸及 2，玩家在 1（鄰接只列了 1→2）。
  const affected = findAffectedPlayers({
    touchedRegionIds: [2],
    adjacency,
    playerControls: [{ regionId: 1, discordUserId: "userA" }],
  });
  assert.deepEqual(affected, ["userA"]);
});

test("findAffectedPlayers：去重且無觸及時回空陣列", () => {
  const affected = findAffectedPlayers({
    touchedRegionIds: [],
    adjacency: [{ regionId: 1, adjacentRegionId: 2 }],
    playerControls: [{ regionId: 1, discordUserId: "userA" }],
  });
  assert.deepEqual(affected, []);

  // 同一玩家掌控多個受影響地區 → 只出現一次。
  const dedup = findAffectedPlayers({
    touchedRegionIds: [1, 2],
    adjacency: [],
    playerControls: [
      { regionId: 1, discordUserId: "userA" },
      { regionId: 2, discordUserId: "userA" },
    ],
  });
  assert.deepEqual(dedup, ["userA"]);
});
