import test from "node:test";
import assert from "node:assert/strict";
import { validateCatalog } from "./validate";
import { FOCUS_CATALOG } from "./catalog";
import {
  buildCommunistPathFocuses,
  COMMUNIST_PATH_ROOT_IDS,
  COMMUNIST_PATH_GROUP,
  PATH_MARXIST_LENINIST_ID,
  PATH_MAOIST_ID,
  PATH_TITOIST_ID,
} from "./communistPaths";
import { COMMUNIST_REVOLUTION_ID } from "./regimeFocuses";
import { sumWiredModifiers, isEffectWired } from "./effects";
import { advanceFocus } from "./core";
import type { FocusDef } from "./types";

const paths = buildCommunistPathFocuses();
const byId = new Map(paths.map((d) => [d.id, d]));

test("路線:整份目錄(政體國策 + 三條路線)通過驗證", () => {
  assert.deepEqual(validateCatalog(FOCUS_CATALOG), []);
});

test("路線:三個起點互斥、都要求共產革命、只在委員會制開放、是里程碑", () => {
  assert.equal(COMMUNIST_PATH_ROOT_IDS.length, 3);
  for (const id of COMMUNIST_PATH_ROOT_IDS) {
    const d = byId.get(id)!;
    assert.ok(d, id);
    assert.equal(d.exclusiveGroup, COMMUNIST_PATH_GROUP, `${id} 互斥群組`);
    assert.deepEqual(d.requires, [COMMUNIST_REVOLUTION_ID], `${id} 需革命`);
    assert.deepEqual(d.governments, ["council_system"], `${id} 只在委員會制`);
    assert.equal(d.milestone, true);
  }
  assert.equal(new Set(COMMUNIST_PATH_ROOT_IDS.map((id) => byId.get(id)!.exclusiveGroup)).size, 1);
});

test("路線:每條路線各有 3 個後續國策,依賴只指向自己這條路線,路線之間不通用", () => {
  const rootOf = (d: FocusDef): string => {
    if (COMMUNIST_PATH_ROOT_IDS.includes(d.id)) return d.id;
    const parent = d.requires[0]!;
    return rootOf(byId.get(parent)!);
  };
  for (const root of COMMUNIST_PATH_ROOT_IDS) {
    const followers = paths.filter((d) => !COMMUNIST_PATH_ROOT_IDS.includes(d.id) && rootOf(d) === root);
    assert.equal(followers.length, 3, `${root} 後續數`);
    for (const f of followers) {
      assert.equal(f.requires.length, 1, `${f.id} 單一前置`);
      assert.ok(byId.has(f.requires[0]!), `${f.id} 前置存在`);
      assert.deepEqual(f.governments, ["council_system"]);
    }
  }
  assert.equal(paths.length, 12);
});

test("路線:後續國策的前置鏈最終都通到自己的起點(第二層依賴第一層)", () => {
  assert.deepEqual(byId.get("path.ml.heavy_industry")!.requires, ["path.ml.five_year_plan"]);
  assert.deepEqual(byId.get("path.mao.land_reform")!.requires, ["path.mao.mass_line"]);
  assert.deepEqual(byId.get("path.tito.market_socialism")!.requires, ["path.tito.self_management"]);
});

test("路線:三條路線的常駐加成和取捨各不相同(不是換皮)", () => {
  const sig = (id: string) => JSON.stringify(byId.get(id)!.effects.filter((e) => e.kind !== "unlock"));
  assert.notEqual(sig(PATH_MARXIST_LENINIST_ID), sig(PATH_MAOIST_ID));
  assert.notEqual(sig(PATH_MAOIST_ID), sig(PATH_TITOIST_ID));
  assert.notEqual(sig(PATH_MARXIST_LENINIST_ID), sig(PATH_TITOIST_ID));
  // 馬列與鐵托給政治點數;毛給國策速度
  assert.equal(sumWiredModifiers([byId.get(PATH_MARXIST_LENINIST_ID)!.effects]).pointsPerTurn, 1);
  assert.equal(sumWiredModifiers([byId.get(PATH_TITOIST_ID)!.effects]).pointsPerTurn, 1);
  assert.equal(sumWiredModifiers([byId.get(PATH_MAOIST_ID)!.effects]).focusSpeedPct, 15);
  assert.equal(sumWiredModifiers([byId.get(PATH_MAOIST_ID)!.effects]).pointsPerTurn, 0);
});

test("路線:目錄裡所有 modifier 都是已接線的統計(不寫會落空的數字)", () => {
  for (const d of paths) {
    for (const e of d.effects) {
      if (e.kind === "modifier") assert.ok(isEffectWired(e), `${d.id} 的 ${e.stat} 尚未接線`);
    }
  }
});

test("加成加總:多個國策疊加;非 modifier 與未接線統計不計入", () => {
  const r = sumWiredModifiers([
    [{ kind: "modifier", stat: "pointsPerTurn", value: 1 }, { kind: "grant", stat: "money", value: 5 }],
    [{ kind: "modifier", stat: "focusSpeed", value: 15 }, { kind: "modifier", stat: "taxIncome", value: 10 }],
    [{ kind: "modifier", stat: "pointsPerTurn", value: 2 }],
  ]);
  assert.deepEqual(r, { pointsPerTurn: 3, focusSpeedPct: 15 });
  assert.deepEqual(sumWiredModifiers([]), { pointsPerTurn: 0, focusSpeedPct: 0 });
});

test("國策速度加成:加速進度;議會停滯(滿意度 0)時加成不能繞過停滯", () => {
  const base = advanceFocus(0, 10, 75);
  const fast = advanceFocus(0, 10, 75, 15);
  assert.ok(fast.progress > base.progress, "有加成比較快");
  assert.ok(Math.abs(fast.progress - base.progress * 1.15) < 0.001, "快 15%");
  const stalled = advanceFocus(2, 10, 0, 100);
  assert.equal(stalled.progress, 2, "停滯時進度不動");
  assert.equal(stalled.stalled, true);
  // 不給加成時行為與原本完全相同
  assert.deepEqual(advanceFocus(3, 8, 60), advanceFocus(3, 8, 60, 0));
  // 異常值不會讓進度倒退或爆掉
  assert.ok(advanceFocus(1, 8, 60, Number.NaN).progress >= 1);
  assert.ok(advanceFocus(1, 8, 60, -50).progress >= 1);
});
