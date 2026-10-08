import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 暗底頁面標題顏色的防回歸測試(2026-10-08)。
 *
 * 事故:index.css 的 `h1~h6 { color: foreground }` 直接宣告在標題上,
 * 會蓋掉從 text-white 容器繼承來的白字,所以暗底卡片上沒自己指定顏色的標題
 * 全變成深藍黑字(倉庫、糧食、議會、外交…看不清楚)。
 *
 * 修法是 `.text-white :is(h1..h6) { color: inherit }`。這裡守住兩個容易再踩的點:
 *  1. 規則必須存在,而且涵蓋 text-white 與 text-slate-100(錯誤頁用)。
 *  2. 不可改回 :where(...) 零優先權寫法 —— 同在 base 層時標題規則 (0,0,1)
 *     會贏過零優先權,規則等於沒寫(實測踩過)。
 */
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.css"),
  "utf8",
);

/** 取出 @layer base { ... } 區塊內文(以大括號配對,不被內部規則的 } 騙到)。 */
function baseLayerBody(src: string): string {
  const start = src.indexOf("@layer base");
  assert.ok(start >= 0, "找不到 @layer base");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error("@layer base 括號沒有配對");
}

test("暗底容器內的標題改為繼承顏色,涵蓋 text-white 與 text-slate-100", () => {
  const base = baseLayerBody(css);
  const rule = /\.text-white\s+:is\(\s*h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\)\s*,\s*\.text-slate-100\s+:is\(\s*h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\)\s*\{\s*color:\s*inherit;?\s*\}/;
  assert.match(base, rule, "缺少暗底標題繼承規則,暗底卡片標題會變深字");
});

test("規則放在 @layer base 內(utilities 層級更高,標題自己的 text-* 才能維持優先)", () => {
  assert.ok(baseLayerBody(css).includes("color: inherit"));
});

test("不可使用 :where() 零優先權寫法(會輸給標題基礎規則而失效)", () => {
  const base = baseLayerBody(css);
  const bad = /:where\(\s*\.text-white[^)]*\)\s*:where\(\s*h1/;
  assert.doesNotMatch(base, bad, ":where() 把優先權壓到 0,會輸給 h1~h6 的 text-foreground");
});

test("全域標題規則仍存在(淺底後台與 Dialog 的深字不受影響)", () => {
  const base = baseLayerBody(css);
  assert.match(base, /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*text-foreground/);
});
