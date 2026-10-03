import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRemainderContestRegionIds,
  type RegionControlShare,
} from "./remainderContest.ts";

const ME = "nation-me";
const UNOWNED = "nation-unowned";
const NPC = "nation-npc";
const ENEMY = "nation-enemy";

function controlsMap(
  entries: [number, RegionControlShare[]][],
): Map<number, RegionControlShare[]> {
  const m = new Map<number, RegionControlShare[]>();
  for (const [id, list] of entries) {
    m.set(id, [...list].sort((a, b) => b.percent - a.percent));
  }
  return m;
}

describe("computeRemainderContestRegionIds（Task #502 無人剩餘同區爭奪）", () => {
  it("空白剩餘（我方 60%、無其他持有者）→ 可爭奪", () => {
    const ids = computeRemainderContestRegionIds({
      myNationId: ME,
      myRegionIds: [1],
      enemyRegionIds: new Set<number>(),
      controlsByRegion: controlsMap([[1, [{ nationId: ME, percent: 60 }]]]),
      unownedNationIds: new Set(),
    });
    assert.deepEqual([...ids], [1]);
  });

  it("剩餘持有者為無主國家（比例最高的其他持有者）→ 可爭奪", () => {
    const ids = computeRemainderContestRegionIds({
      myNationId: ME,
      myRegionIds: [2],
      enemyRegionIds: new Set<number>(),
      controlsByRegion: controlsMap([
        [
          2,
          [
            { nationId: ME, percent: 55 },
            { nationId: UNOWNED, percent: 45 },
          ],
        ],
      ]),
      unownedNationIds: new Set([UNOWNED]),
    });
    assert.deepEqual([...ids], [2]);
  });

  it("只剩無人剩餘目標（無交戰敵國、無外部無人領土）時集合非空 → 分頁不會顯示「沒有目標」", () => {
    // 迴歸保護：空狀態判斷必須把 remainderContestRegionIds 一併納入，
    // 否則玩家只有同區剩餘可打時整個分頁會被誤判為無目標而隱藏。
    const ids = computeRemainderContestRegionIds({
      myNationId: ME,
      myRegionIds: [7],
      enemyRegionIds: new Set<number>(), // 無任何交戰敵國
      controlsByRegion: controlsMap([[7, [{ nationId: ME, percent: 40 }]]]),
      unownedNationIds: new Set(),
    });
    assert.equal(ids.size, 1);
  });

  it("我方已 100% 掌控 → 不可爭奪", () => {
    const ids = computeRemainderContestRegionIds({
      myNationId: ME,
      myRegionIds: [3],
      enemyRegionIds: new Set<number>(),
      controlsByRegion: controlsMap([[3, [{ nationId: ME, percent: 100 }]]]),
      unownedNationIds: new Set(),
    });
    assert.equal(ids.size, 0);
  });

  it("有交戰敵國同在此地 → 走既有同區爭奪，不列入", () => {
    const ids = computeRemainderContestRegionIds({
      myNationId: ME,
      myRegionIds: [4],
      enemyRegionIds: new Set([4]),
      controlsByRegion: controlsMap([
        [
          4,
          [
            { nationId: ME, percent: 50 },
            { nationId: ENEMY, percent: 30 },
          ],
        ],
      ]),
      unownedNationIds: new Set(),
    });
    assert.equal(ids.size, 0);
  });

  it("比例最高的其他持有者是 NPC（非無主）→ 不可爭奪", () => {
    const ids = computeRemainderContestRegionIds({
      myNationId: ME,
      myRegionIds: [5],
      enemyRegionIds: new Set<number>(),
      controlsByRegion: controlsMap([
        [
          5,
          [
            { nationId: ME, percent: 50 },
            { nationId: NPC, percent: 30 },
            { nationId: UNOWNED, percent: 10 },
          ],
        ],
      ]),
      unownedNationIds: new Set([UNOWNED]),
    });
    assert.equal(ids.size, 0);
  });

  it("未建國（myNationId null）→ 空集合", () => {
    const ids = computeRemainderContestRegionIds({
      myNationId: null,
      myRegionIds: [6],
      enemyRegionIds: new Set<number>(),
      controlsByRegion: controlsMap([[6, [{ nationId: ME, percent: 10 }]]]),
      unownedNationIds: new Set(),
    });
    assert.equal(ids.size, 0);
  });
});
