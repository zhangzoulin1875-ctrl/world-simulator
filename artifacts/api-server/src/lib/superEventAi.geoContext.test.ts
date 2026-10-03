import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  generateSuperEvent,
  judgeSuperEventTurn,
  judgeSuperEventResponse,
} from "./superEventAi";

/**
 * Task #366 — 超事件 AI 敘事的「地理人文脈絡」導引單元測試（純函式，不連 DB）。
 *
 * 三個 AI 面（generateSuperEvent／judgeSuperEventTurn／judgeSuperEventResponse）
 * 都接受選填的 geoContext：
 *  - 有 geoContext（regional／targeted／政治決策等綁定實際地區的事件）→ user prompt
 *    需帶入該地區背景，並要求「勿預設中華／中國風格」貼合當地文化。
 *  - 無 geoContext（global 全球型事件）→ user prompt 需走「【文化中性】」導引，
 *    且不得出現地理綁定的「勿預設中華／中國風格」字樣。
 *
 * 策略：覆寫 anthropic.messages.create 攔截送出的 user prompt，並回傳一份對應各面
 * schema 的合法 JSON（讓函式順利解析回傳）。僅驗證 prompt 導引差異，不涉任何 DB。
 */

const GEO_CONTEXT =
  "【地理人文背景】此國主要位於中東／阿拉伯地區，代表城市：巴格達、開羅。";
const GEO_MARKER = "勿預設中華／中國風格";
const NEUTRAL_MARKER = "【文化中性】";

type MessagesCreate = typeof anthropic.messages.create;
const realCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

let capturedUser = "";

/** 覆寫 AI 呼叫：攔截 user prompt，回傳指定的合法 JSON 字串。 */
function stubReturning(json: string): void {
  capturedUser = "";
  anthropic.messages.create = (async (args: {
    messages: { content: string }[];
  }) => {
    capturedUser = args.messages[0]!.content;
    return { content: [{ type: "text", text: json }] };
  }) as unknown as MessagesCreate;
}

afterEach(() => {
  anthropic.messages.create = realCreate;
});

const GEN_JSON = JSON.stringify({
  title: "測試事件",
  summary: "一句話摘要",
  narrative: "事件起因敘事。",
  category: "天災",
  severity: 50,
  kind: "disaster",
});

const TURN_JSON = JSON.stringify({
  narrative: "本回合發展敘事。",
  effect: {},
  stage: "spreading",
  grantTech: null,
  npcHostility: "none",
  end: false,
});

const RESPONSE_JSON = JSON.stringify({
  title: "應對結果",
  description: "判定結果與後果。",
  fitScore: 60,
  effect: {},
});

test("generateSuperEvent：有 geoContext → prompt 帶地理導引；無 → 文化中性", async () => {
  stubReturning(GEN_JSON);
  await generateSuperEvent({ eraSlug: "classical", geoContext: GEO_CONTEXT });
  assert.ok(
    capturedUser.includes(GEO_CONTEXT),
    "有 geoContext 時 prompt 應含該地區背景文字",
  );
  assert.ok(
    capturedUser.includes(GEO_MARKER),
    "有 geoContext 時 prompt 應要求貼合當地文化（勿預設中華／中國風格）",
  );
  assert.ok(
    !capturedUser.includes(NEUTRAL_MARKER),
    "有 geoContext 時不應出現文化中性導引",
  );

  stubReturning(GEN_JSON);
  await generateSuperEvent({ eraSlug: "classical" });
  assert.ok(
    capturedUser.includes(NEUTRAL_MARKER),
    "無 geoContext 時 prompt 應走文化中性導引",
  );
  assert.ok(
    !capturedUser.includes(GEO_MARKER),
    "無 geoContext 時不應出現地理綁定的『勿預設中華』字樣",
  );
});

test("judgeSuperEventTurn：有 geoContext → prompt 帶地理導引；無 → 文化中性", async () => {
  const base = {
    eraSlug: "classical",
    title: "測試事件",
    category: "天災",
    severity: 50,
    turnsElapsed: 1,
    kind: "disaster" as const,
    currentStage: "spreading",
    narrative: "前情提要。",
  };

  stubReturning(TURN_JSON);
  await judgeSuperEventTurn({ ...base, geoContext: GEO_CONTEXT });
  assert.ok(capturedUser.includes(GEO_CONTEXT), "應含地區背景文字");
  assert.ok(capturedUser.includes(GEO_MARKER), "應要求貼合當地文化");
  assert.ok(!capturedUser.includes(NEUTRAL_MARKER), "不應出現文化中性導引");

  stubReturning(TURN_JSON);
  await judgeSuperEventTurn(base);
  assert.ok(capturedUser.includes(NEUTRAL_MARKER), "應走文化中性導引");
  assert.ok(!capturedUser.includes(GEO_MARKER), "不應出現地理綁定字樣");
});

test("judgeSuperEventResponse：有 geoContext → prompt 帶地理導引；無 → 文化中性", async () => {
  const base = {
    eraSlug: "classical",
    eventTitle: "測試事件",
    eventCategory: "天災",
    eventNarrative: "目前局勢。",
    government: "君主制",
    nationName: "測試國",
    responseText: "全力賑災。",
  };

  stubReturning(RESPONSE_JSON);
  await judgeSuperEventResponse({ ...base, geoContext: GEO_CONTEXT });
  assert.ok(capturedUser.includes(GEO_CONTEXT), "應含地區背景文字");
  assert.ok(capturedUser.includes(GEO_MARKER), "應要求貼合當地文化");
  assert.ok(!capturedUser.includes(NEUTRAL_MARKER), "不應出現文化中性導引");

  stubReturning(RESPONSE_JSON);
  await judgeSuperEventResponse(base);
  assert.ok(capturedUser.includes(NEUTRAL_MARKER), "應走文化中性導引");
  assert.ok(!capturedUser.includes(GEO_MARKER), "不應出現地理綁定字樣");
});

test("空字串 geoContext 視同無脈絡（走文化中性）", async () => {
  stubReturning(GEN_JSON);
  await generateSuperEvent({ eraSlug: "classical", geoContext: "   " });
  assert.ok(
    capturedUser.includes(NEUTRAL_MARKER),
    "空白 geoContext 應退回文化中性導引",
  );
  assert.ok(!capturedUser.includes(GEO_MARKER));
});
