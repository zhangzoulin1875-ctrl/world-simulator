import { test } from "node:test";
import assert from "node:assert/strict";
import type { CabinetStyle, MilitaryUnitTemplate } from "@workspace/db";
// Task #516 — 純函式一律直接自 militaryPolicy 匯入（不經 ./military，
// 避免 domain 模組 → ../index 的循環匯入陷阱：單跑本檔會 ReferenceError）。
import {
  militaryAgentAggression,
  militaryAutoBudget,
  recruitNeedsApproval,
  purchaseNeedsApproval,
  techSpendNeedsApproval,
  listDesignableCategories,
  resolveUsableTemplate,
} from "./militaryPolicy";

// Task #244 — 元帥領域門檻判定純函式單元測試（不觸 DB／IO）。

function style(overreach: number, timidity: number): CabinetStyle {
  return { overreach, timidity, description: "" };
}

test("militaryAgentAggression 由代理程度定基準", () => {
  const neutral = style(50, 50);
  assert.equal(militaryAgentAggression("conservative", neutral), 25);
  assert.equal(militaryAgentAggression("balanced", neutral), 50);
  assert.equal(militaryAgentAggression("aggressive", neutral), 75);
});

test("militaryAgentAggression 越權拉高、膽小壓低並夾在 0–100", () => {
  // 越權高、膽小低 → 明顯高於基準。
  assert.ok(
    militaryAgentAggression("balanced", style(100, 0)) >
      militaryAgentAggression("balanced", style(50, 50)),
  );
  // 越權低、膽小高 → 明顯低於基準。
  assert.ok(
    militaryAgentAggression("balanced", style(0, 100)) <
      militaryAgentAggression("balanced", style(50, 50)),
  );
  // 夾住上下界（積極 75 + 越權 20 + 低膽小 20 = 115 → 夾到 100；
  // 保守 25 − 20 − 20 = −15 → 夾到 0）。
  assert.equal(militaryAgentAggression("aggressive", style(100, 0)), 100);
  assert.equal(militaryAgentAggression("conservative", style(0, 100)), 0);
  assert.ok(militaryAgentAggression("conservative", style(0, 100)) >= 0);
  assert.ok(militaryAgentAggression("aggressive", style(100, 0)) <= 100);
});

test("militaryAutoBudget 積極度越高、可自動動用比例越大", () => {
  const timid = militaryAutoBudget("conservative", style(0, 100));
  const bold = militaryAutoBudget("aggressive", style(100, 0));
  assert.ok(bold.recruitProductionFraction > timid.recruitProductionFraction);
  assert.ok(bold.purchaseCapFraction > timid.purchaseCapFraction);
  assert.ok(bold.techAutoCostFraction > timid.techAutoCostFraction);
  assert.ok(bold.designAutoCostFraction > timid.designAutoCostFraction);
  // 比例落在 0–1。
  for (const v of Object.values(bold)) {
    assert.ok(v >= 0 && v <= 1);
  }
  for (const v of Object.values(timid)) {
    assert.ok(v >= 0 && v <= 1);
  }
});

test("recruitNeedsApproval 以可用生產力 × 比例為門檻", () => {
  // 預算 = floor(1000 * 0.5) = 500；成本 500 恰在門檻內。
  assert.equal(
    recruitNeedsApproval({
      productionCost: 500,
      availableProduction: 1000,
      fraction: 0.5,
    }),
    false,
  );
  assert.equal(
    recruitNeedsApproval({
      productionCost: 501,
      availableProduction: 1000,
      fraction: 0.5,
    }),
    true,
  );
  // 無可用生產力 → 任何正成本都需批准。
  assert.equal(
    recruitNeedsApproval({
      productionCost: 1,
      availableProduction: 0,
      fraction: 0.9,
    }),
    true,
  );
});

test("purchaseNeedsApproval 以今日剩餘配額 × 比例為門檻", () => {
  // 預算 = floor(100 * 0.6) = 60。
  assert.equal(
    purchaseNeedsApproval({ quantity: 60, remainingCap: 100, fraction: 0.6 }),
    false,
  );
  assert.equal(
    purchaseNeedsApproval({ quantity: 61, remainingCap: 100, fraction: 0.6 }),
    true,
  );
  assert.equal(
    purchaseNeedsApproval({ quantity: 1, remainingCap: 0, fraction: 1 }),
    true,
  );
});

// ── Task #516 — 內閣自動軍事不得使用預設兵種（Task #511 行為鎖定） ──

/** 建構最小可用的兵種模板（僅測試會讀到的欄位）。 */
function template(
  overrides: Partial<MilitaryUnitTemplate>,
): MilitaryUnitTemplate {
  return {
    id: 1,
    ownerDiscordUserId: "user-1",
    ownerNationId: null,
    category: "infantry",
    name: "測試兵種",
    description: null,
    isDefault: false,
    eraSlug: "classical",
    ...overrides,
  } as MilitaryUnitTemplate;
}

test("listDesignableCategories：無任何自創兵種／科技時仍有可設計類別", () => {
  // 玩家沒有自訂兵種、也沒研發任何關鍵科技 → 內閣仍可提「設計兵種」提案。
  const cats = listDesignableCategories([], "classical");
  assert.ok(cats.length > 0);
  const slugs = cats.map((c) => c.slug);
  // 不需科技的類別一開始就解鎖。
  assert.ok(slugs.includes("infantry"));
  assert.ok(slugs.includes("armor"));
  assert.ok(slugs.includes("siege"));
  // 需關鍵科技的類別未解鎖前不可設計。
  assert.ok(!slugs.includes("ranged"));
  assert.ok(!slugs.includes("artillery"));
  assert.ok(!slugs.includes("ship"));
  assert.ok(!slugs.includes("air"));
  // 標籤為時代對應的 zh-TW 顯示名稱（armor 於 ww1 前顯示「騎兵」）。
  assert.equal(cats.find((c) => c.slug === "armor")?.label, "騎兵");
});

test("listDesignableCategories：科技解鎖擴充類別、火槍兵反鎖射手", () => {
  const cats = listDesignableCategories(
    ["marksmanship", "gunpowder", "naval_warfare", "aviation"],
    "ww1",
  );
  const slugs = cats.map((c) => c.slug);
  assert.ok(slugs.includes("ranged"));
  assert.ok(slugs.includes("artillery"));
  assert.ok(slugs.includes("ship"));
  assert.ok(slugs.includes("air"));
  assert.equal(cats.find((c) => c.slug === "armor")?.label, "裝甲");
  // 研發「火槍兵」後，射手被反向鎖定，不可再設計。
  const after = listDesignableCategories(["marksmanship", "musketeer"], "ww1");
  assert.ok(!after.map((c) => c.slug).includes("ranged"));
});

const usableParams = {
  userId: "user-1",
  eraSlug: "classical",
  researchedKeySlugs: [] as readonly string[],
};

test("resolveUsableTemplate：查無模板 → zh-TW 錯誤", () => {
  assert.throws(
    () => resolveUsableTemplate(undefined, usableParams),
    /找不到這個兵種模板（請先設計自創兵種）/,
  );
});

test("resolveUsableTemplate：無主（無擁有者）模板 → 拒絕（zh-TW 錯誤）", () => {
  const orphan = template({ ownerDiscordUserId: null });
  assert.throws(
    () => resolveUsableTemplate(orphan, usableParams),
    /找不到這個兵種模板（請先設計自創兵種）/,
  );
});

test("resolveUsableTemplate：他人自創兵種 → 拒絕（zh-TW 錯誤）", () => {
  const others = template({ ownerDiscordUserId: "user-2" });
  assert.throws(
    () => resolveUsableTemplate(others, usableParams),
    /找不到這個兵種模板/,
  );
});

test("resolveUsableTemplate：自己的自創兵種但類別未解鎖 → zh-TW 鎖定原因", () => {
  const locked = template({ category: "artillery" });
  assert.throws(
    () => resolveUsableTemplate(locked, usableParams),
    /需先研發關鍵技術/,
  );
});

test("resolveUsableTemplate：自己的已解鎖自創兵種 → 回傳模板", () => {
  const own = template({});
  assert.equal(resolveUsableTemplate(own, usableParams), own);
  const unlockedArtillery = template({ category: "artillery" });
  assert.equal(
    resolveUsableTemplate(unlockedArtillery, {
      ...usableParams,
      researchedKeySlugs: ["gunpowder"],
    }),
    unlockedArtillery,
  );
});

test("techSpendNeedsApproval 以目前科技點數 × 比例為門檻", () => {
  // 預算 = floor(1000 * 0.3) = 300。
  assert.equal(
    techSpendNeedsApproval({
      costPoints: 300,
      techPoints: 1000,
      fraction: 0.3,
    }),
    false,
  );
  assert.equal(
    techSpendNeedsApproval({
      costPoints: 301,
      techPoints: 1000,
      fraction: 0.3,
    }),
    true,
  );
  assert.equal(
    techSpendNeedsApproval({ costPoints: 1, techPoints: 0, fraction: 0.9 }),
    true,
  );
});
