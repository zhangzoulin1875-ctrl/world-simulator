import test from "node:test";
import assert from "node:assert/strict";
import { REGION_SPECIALTIES, specialtyOf } from "./regionSpecialties";
import { GOOD_SLUGS } from "./goods";
import { getSeedRows } from "../mapRegions";

const seed = getSeedRows();
const macroOf = new Map(seed.map((r) => [r.name, r.macro]));
const entries = Object.entries(REGION_SPECIALTIES);

/** 地區名打錯字會讓該區特產靜默失效:每個鍵都必須對得上地圖種子。 */
test("每個特產地區名稱都存在於地圖種子(防打錯字)", () => {
  const unknown = entries.map(([n]) => n).filter((n) => !macroOf.has(n));
  assert.deepEqual(unknown, [], `地圖種子找不到:${unknown.join("、")}`);
});

test("貨物 slug 合法、不含糧食、強度只有 1 或 3、每區至少一項", () => {
  const valid = new Set<string>(GOOD_SLUGS.filter((g) => g !== "food"));
  for (const [name, spec] of entries) {
    const goods = Object.keys(spec);
    assert.ok(goods.length >= 1 && goods.length <= 3, `${name} 應有 1~3 種特產,實際 ${goods.length}`);
    for (const g of goods) {
      assert.ok(valid.has(g), `${name}: 非法貨物 ${g}(糧食不在此表)`);
      const s = (spec as Record<string, number>)[g];
      assert.ok(s === 1 || s === 3, `${name}.${g} 強度只能是 1 或 3,實際 ${s}`);
    }
  }
});

test("守恆:共 180 區有特產(約 45%),不低於 40% 也不高於 50%", () => {
  assert.equal(entries.length, 180);
  const ratio = entries.length / seed.length;
  assert.ok(ratio >= 0.4 && ratio <= 0.5, `比例 ${ratio.toFixed(3)} 超出 40~50%`);
});

test("每個大區都有特產,且比例落在 30%~65%(沒有被遺忘或灌水的大區)", () => {
  const total = new Map<string, number>();
  const has = new Map<string, number>();
  for (const r of seed) total.set(r.macro, (total.get(r.macro) ?? 0) + 1);
  for (const [name] of entries) {
    const m = macroOf.get(name)!;
    has.set(m, (has.get(m) ?? 0) + 1);
  }
  for (const [m, n] of total) {
    const ratio = (has.get(m) ?? 0) / n;
    assert.ok(ratio >= 0.3 && ratio <= 0.65, `${m} 特產比例 ${(ratio * 100).toFixed(0)}% 超出 30~65%`);
  }
});

test("石油是戰略資源:主產恰 18 區,且分布在至少 6 個大區", () => {
  const oil = entries.filter(([, s]) => (s as Record<string, number>).oil === 3);
  assert.equal(oil.length, 18);
  const macros = new Set(oil.map(([n]) => macroOf.get(n)));
  assert.ok(macros.size >= 6, `石油主產只在 ${macros.size} 個大區,易被壟斷`);
});

test("每種貨物至少 5 個大區有主產(避免單一大區壟斷)", () => {
  for (const g of GOOD_SLUGS.filter((x) => x !== "food")) {
    const macros = new Set(
      entries.filter(([, s]) => (s as Record<string, number>)[g] === 3).map(([n]) => macroOf.get(n)),
    );
    assert.ok(macros.size >= 5, `${g} 主產只分布在 ${macros.size} 個大區`);
  }
});

test("歷史代表區:關鍵產地都在(魯爾、巴庫、波斯灣、大慶、德州、瑞典鐵礦、香料群島)", () => {
  const must: Array<[string, string]> = [
    ["北萊茵西發", "ironcoal"], ["西里西亞", "ironcoal"], ["亞塞拜然", "oil"],
    ["東部省阿拉伯", "oil"], ["科威特巴林", "oil"], ["黑龍江東", "oil"], ["大德州", "oil"],
    ["瑞典北部諾爾蘭", "ore"], ["蘇拉威西摩鹿加", "spice"], ["喀拉拉", "spice"],
    ["太湖", "cloth"], ["加丹加高", "rare"], ["南非德蘭", "rare"],
  ];
  for (const [name, good] of must) {
    assert.equal((specialtyOf(name) as Record<string, number>)[good], 3, `${name} 應為 ${good} 主產`);
  }
});

test("糧食大區不是特產:高肥沃度與特產互不依賴(特產不含 food)", () => {
  for (const [, spec] of entries) assert.ok(!("food" in spec));
});

test("specialtyOf:查無地區回傳空物件,不是 undefined", () => {
  assert.deepEqual(specialtyOf("不存在的地方"), {});
  assert.deepEqual(specialtyOf("荷蘭"), { spice: 3 });
});
