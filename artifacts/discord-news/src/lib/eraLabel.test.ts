import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveCurrentEraLabel, type EraOption } from "./eraLabel.ts";

/**
 * 守住政治視圖國情面板的「科技水準」語意：一律以『目前世界時代』表示，
 * 不受地圖上方時代篩選（使用者可自由切換）影響。若有人把面板標籤接回篩選用
 * 的時代，這裡就會亮紅燈（Task #58 code review 明確要求）。
 */
const ERAS: EraOption[] = [
  { era: "classical", label: "古典" },
  { era: "industrial", label: "工業" },
  { era: "modern", label: "現代" },
  { era: "future", label: "未來" },
];

describe("resolveCurrentEraLabel", () => {
  it("回傳目前世界時代對應的標籤", () => {
    assert.equal(resolveCurrentEraLabel(ERAS, "industrial"), "工業");
    assert.equal(resolveCurrentEraLabel(ERAS, "future"), "未來");
  });

  it("標籤只取決於 currentEra——即使使用者選了不同時代篩選，標籤也不變", () => {
    // 模擬使用者把上方篩選切到各種時代；面板科技水準永遠跟著 currentEra=modern。
    const currentEra = "modern";
    for (const selected of ["classical", "industrial", "future", "modern"]) {
      // selected 只是使用者篩選，函式根本不接受它——確保無法誤傳影響結果。
      void selected;
      assert.equal(resolveCurrentEraLabel(ERAS, currentEra), "現代");
    }
  });

  it("currentEra 為 null／undefined 或查無對應時回 null", () => {
    assert.equal(resolveCurrentEraLabel(ERAS, null), null);
    assert.equal(resolveCurrentEraLabel(ERAS, undefined), null);
    assert.equal(resolveCurrentEraLabel(ERAS, "stone"), null);
  });
});
