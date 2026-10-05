import { test } from "node:test";
import assert from "node:assert/strict";
import {
  npcCampaignTroops,
  NPC_TROOP_MIN,
  NPC_TROOP_MAX,
  NPC_UNCLAIMED_DEFENDER_TROOP_RATIO,
  NPC_DEFENDER_TROOP_RATIO,
} from "./shared";

// 空地 NPC(攻打無人領土就地建國的防守方)初始兵力過高是玩家回報的問題:
// 工業~二戰時代平均一區就有 2.7 萬~4.9 萬民兵。改用較低的動員比例。

test("空地 NPC 防守兵力明顯低於一般防守方", () => {
  const pop = 4_715_492; // 一戰時代平均一區
  const normal = npcCampaignTroops({ population: pop, isDefender: true });
  const unclaimed = npcCampaignTroops({ population: pop, isDefender: true, unclaimed: true });
  assert.equal(normal, Math.floor(pop * NPC_DEFENDER_TROOP_RATIO));
  assert.equal(unclaimed, Math.floor(pop * NPC_UNCLAIMED_DEFENDER_TROOP_RATIO));
  assert.ok(unclaimed * 3 < normal, `空地 ${unclaimed} 應不到一般防守 ${normal} 的 1/3`);
});

test("空地 NPC 各時代平均一區的兵力(工業 ~6.7千、二戰 ~1.2萬、現代 ~4.3萬)", () => {
  assert.equal(npcCampaignTroops({ population: 3_364_445, isDefender: true, unclaimed: true }), 6_728);
  assert.equal(npcCampaignTroops({ population: 6_094_964, isDefender: true, unclaimed: true }), 12_189);
  assert.equal(npcCampaignTroops({ population: 21_597_257, isDefender: true, unclaimed: true }), 43_194);
});

test("小地區仍有 NPC_TROOP_MIN 的保底守備", () => {
  assert.equal(npcCampaignTroops({ population: 100_000, isDefender: true, unclaimed: true }), NPC_TROOP_MIN);
});

test("兵力不超過 NPC_TROOP_MAX", () => {
  assert.equal(npcCampaignTroops({ population: 10_000_000_000, isDefender: true, unclaimed: true }), NPC_TROOP_MAX);
});

test("進攻方與一般防守方的比例不受影響", () => {
  const pop = 10_000_000;
  assert.equal(npcCampaignTroops({ population: pop, isDefender: false }), 40_000);
  assert.equal(npcCampaignTroops({ population: pop, isDefender: true }), 80_000);
  // unclaimed 旗標只對防守方生效
  assert.equal(npcCampaignTroops({ population: pop, isDefender: false, unclaimed: true }), 40_000);
});
