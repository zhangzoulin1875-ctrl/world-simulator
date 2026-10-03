import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildTerrainBriefUserPrompt,
  buildWarCycleUserPrompt,
  type TerrainBriefRegion,
  type WarCycleAiInput,
  type WarCycleSideInput,
} from "./warAi";

// Task #372 — 鎖定「國家地理人文背景真的會流入戰爭敘事 AI 提示詞」。
// 純函式測試（無 DB／無 AI）：geoContext 非空時提示詞必含背景段，null／空白時省略。

const GEO = "【地理人文背景】\n掌控地區：蘇格蘭高地、蘇格蘭低地（西歐）";

const ATTACKER_REGION: TerrainBriefRegion = {
  name: "蘇格蘭高地",
  macroRegion: "西歐",
  cities: ["因弗內斯"],
};
const DEFENDER_REGION: TerrainBriefRegion = {
  name: "蘇格蘭低地",
  macroRegion: "西歐",
  cities: [],
};

function side(nationName: string): WarCycleSideInput {
  return {
    nationName,
    isNpc: false,
    warWeariness: 0,
    attackModifierPct: 0,
    seaLandingReductionPct: null,
    cityState: null,
    legions: [],
    orders: [],
  };
}

const CYCLE_BASE: WarCycleAiInput = {
  eraLabel: "古典",
  cycleNumber: 0,
  cycleHours: 24,
  terrainBrief: null,
  attackerRegion: {
    regionName: "蘇格蘭高地",
    attackerPct: 100,
    defenderPct: 0,
  },
  defenderRegion: {
    regionName: "蘇格蘭低地",
    attackerPct: 0,
    defenderPct: 100,
  },
  attacker: side("北國"),
  defender: side("南國"),
};

// ── generateTerrainBrief 的 user 提示詞 ────────────────────────

test("buildTerrainBriefUserPrompt：geoContext 非空 → 附上戰場地理人文背景段", () => {
  const prompt = buildTerrainBriefUserPrompt({
    eraLabel: "古典",
    attackerRegion: ATTACKER_REGION,
    defenderRegion: DEFENDER_REGION,
    geoContext: GEO,
  });
  assert.match(prompt, /當前時代：古典/);
  assert.match(prompt, /戰場地區的地理人文背景/);
  assert.match(prompt, /蘇格蘭高地/);
});

test("buildTerrainBriefUserPrompt：geoContext 空／空白／省略 → 不附背景段", () => {
  const base = {
    eraLabel: "古典",
    attackerRegion: ATTACKER_REGION,
    defenderRegion: DEFENDER_REGION,
  };
  const empty = buildTerrainBriefUserPrompt({ ...base, geoContext: "" });
  const blank = buildTerrainBriefUserPrompt({ ...base, geoContext: "   " });
  const nulled = buildTerrainBriefUserPrompt({ ...base, geoContext: null });
  const omitted = buildTerrainBriefUserPrompt(base);
  for (const p of [empty, blank, nulled, omitted]) {
    assert.doesNotMatch(p, /戰場地區的地理人文背景/);
  }
});

// ── resolveWarCycleAi 的 user 提示詞 ──────────────────────────

test("buildWarCycleUserPrompt：geoContext 非空 → 附上戰場地理人文背景段", () => {
  const prompt = buildWarCycleUserPrompt({ ...CYCLE_BASE, geoContext: GEO });
  assert.match(prompt, /戰場地區的地理人文背景（戰報敘事請貼合）/);
  assert.match(prompt, /蘇格蘭高地/);
});

test("buildWarCycleUserPrompt：geoContext 空／空白／省略 → 不附背景段", () => {
  const empty = buildWarCycleUserPrompt({ ...CYCLE_BASE, geoContext: "" });
  const blank = buildWarCycleUserPrompt({ ...CYCLE_BASE, geoContext: "   " });
  const nulled = buildWarCycleUserPrompt({ ...CYCLE_BASE, geoContext: null });
  const omitted = buildWarCycleUserPrompt(CYCLE_BASE);
  for (const p of [empty, blank, nulled, omitted]) {
    assert.doesNotMatch(p, /戰場地區的地理人文背景/);
  }
});
