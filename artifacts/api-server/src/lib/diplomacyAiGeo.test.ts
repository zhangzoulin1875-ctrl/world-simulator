import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildNpcTreatyUserPrompt,
  buildNpcChatUserPrompt,
} from "./diplomacyAi";

// Task #372 — 鎖定「對方國家地理人文背景真的會流入外交 AI 提示詞」。
// 純函式測試（無 DB／無 AI）：counterpartGeoContext 非空時提示詞必含背景段，
// null／空白時省略。

const GEO = "【地理人文背景】\n掌控地區：蘇格蘭高地、蘇格蘭低地（西歐）";

// ── decideNpcTreatyResponse 的 user 提示詞 ────────────────────

const TREATY_BASE = {
  npcName: "德國",
  proposerName: "北國",
  treatyType: "nonaggression",
  durationDays: 30 as number | null,
  offerMoney: 0,
  offerTechPoints: 0,
  offerRegionNames: [] as string[],
  relationScore: 0,
  atWar: false,
};

test("buildNpcTreatyUserPrompt：geoContext 非空 → 附上提案國地理人文背景段", () => {
  const prompt = buildNpcTreatyUserPrompt({
    ...TREATY_BASE,
    counterpartGeoContext: GEO,
  });
  assert.match(prompt, /提案國：北國/);
  assert.match(prompt, /提案國所處地區的地理人文背景/);
  assert.match(prompt, /蘇格蘭高地/);
});

test("buildNpcTreatyUserPrompt：geoContext 空／空白／省略 → 不附背景段", () => {
  const empty = buildNpcTreatyUserPrompt({
    ...TREATY_BASE,
    counterpartGeoContext: "",
  });
  const blank = buildNpcTreatyUserPrompt({
    ...TREATY_BASE,
    counterpartGeoContext: "   ",
  });
  const nulled = buildNpcTreatyUserPrompt({
    ...TREATY_BASE,
    counterpartGeoContext: null,
  });
  const omitted = buildNpcTreatyUserPrompt(TREATY_BASE);
  for (const p of [empty, blank, nulled, omitted]) {
    assert.doesNotMatch(p, /提案國所處地區的地理人文背景/);
  }
});

// ── decideNpcChatReply 的 user 提示詞 ─────────────────────────

const CHAT_BASE = {
  npcName: "德國",
  playerName: "北國",
  playerMessage: "願與貴國永結盟好。",
  relationScore: 0,
  atWar: false,
};

test("buildNpcChatUserPrompt：geoContext 非空 → 附上對方地理人文背景段", () => {
  const prompt = buildNpcChatUserPrompt({
    ...CHAT_BASE,
    counterpartGeoContext: GEO,
  });
  assert.match(prompt, /對話對象（玩家國家）：北國/);
  assert.match(prompt, /對方所處地區的地理人文背景/);
  assert.match(prompt, /蘇格蘭高地/);
});

test("buildNpcChatUserPrompt：geoContext 空／空白／省略 → 不附背景段", () => {
  const empty = buildNpcChatUserPrompt({
    ...CHAT_BASE,
    counterpartGeoContext: "",
  });
  const blank = buildNpcChatUserPrompt({
    ...CHAT_BASE,
    counterpartGeoContext: "   ",
  });
  const nulled = buildNpcChatUserPrompt({
    ...CHAT_BASE,
    counterpartGeoContext: null,
  });
  const omitted = buildNpcChatUserPrompt(CHAT_BASE);
  for (const p of [empty, blank, nulled, omitted]) {
    assert.doesNotMatch(p, /對方所處地區的地理人文背景/);
  }
});
