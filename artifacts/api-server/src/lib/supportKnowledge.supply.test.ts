/**
 * 客服對「補給 / 彈藥 / 軍工廠」的回答基礎（不打 AI、不連索引）。
 *  - 知識底稿必須有專章，且數字與 supply.ts 的實際常數一致（改常數時這裡會紅燈，提醒同步更新客服）。
 *  - 客服回答以低溫呼叫；其他功能不傳 temperature（行為不變）。
 *  - 提示詞要求單層條列（Discord 會重編巢狀清單）。
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { answerQuestion, SUPPORT_TEMPERATURE } from "./supportBot";
import { SUPPORT_KNOWLEDGE, SUPPORT_SYSTEM_PROMPT } from "./supportKnowledge";
import { getSeedRows } from "./mapRegions";
import {
  SUPPLY_COLLAPSE_BELOW, AMMO_STOCK_CAP_PER_PLANT_LEVEL, AMMO_ERA_FACTOR,
} from "./supply";

type Create = typeof anthropic.messages.create;
const real: Create = anthropic.messages.create.bind(anthropic.messages);
afterEach(() => { anthropic.messages.create = real; });

test("知識底稿：有補給與軍工廠專章", () => {
  for (const k of ["【軍隊補給", "【軍工廠", "口糧", "彈藥", "崩潰", "戰爭室"]) {
    assert.ok(SUPPORT_KNOWLEDGE.includes(k), `缺少：${k}`);
  }
});

test("知識底稿的數字與 supply.ts 實際常數一致（改常數必須同步改客服）", () => {
  assert.ok(SUPPORT_KNOWLEDGE.includes(`跌破 ${SUPPLY_COLLAPSE_BELOW} 就是「崩潰」`), "崩潰門檻");
  assert.ok(SUPPORT_KNOWLEDGE.includes(`× ${AMMO_STOCK_CAP_PER_PLANT_LEVEL}`), "倉容係數");
  // 冷兵器時代不需彈藥（知識底稿這樣說）
  assert.equal(AMMO_ERA_FACTOR["classical"], 0);
  assert.equal(AMMO_ERA_FACTOR["roman"], 0);
});

test("知識底稿的地區數＝地圖種子實際地區數與大地區數", () => {
  const rows = getSeedRows();
  const macro = new Set(rows.map((r) => r.macro)).size;
  assert.ok(
    SUPPORT_KNOWLEDGE.includes(`共 ${rows.length} 個地區（分屬 ${macro} 個大地區）`),
    `知識底稿地區數與種子不符（種子 ${rows.length} 區／${macro} 大地區）`,
  );
});

test("提示詞：單層條列、先講結論、口糧與彈藥分開", () => {
  assert.ok(SUPPORT_SYSTEM_PROMPT.includes("單層"));
  assert.ok(SUPPORT_SYSTEM_PROMPT.includes("先講結論"));
  assert.ok(SUPPORT_SYSTEM_PROMPT.includes("口糧與彈藥是兩種不同"));
});

test("客服回答以低溫呼叫；system 內含補給專章", async () => {
  assert.ok(SUPPORT_TEMPERATURE > 0 && SUPPORT_TEMPERATURE <= 0.3);
  let seen: any = null;
  anthropic.messages.create = (async (p: any) => {
    seen = p;
    return { content: [{ type: "text", text: "好" }], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as unknown as Create;
  await answerQuestion("彈藥消耗是怎麼算");
  assert.equal(seen.temperature, SUPPORT_TEMPERATURE);
  assert.ok(String(seen.system).includes("【軍隊補給"));
});
