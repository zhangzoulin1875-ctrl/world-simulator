import test from "node:test";
import assert from "node:assert/strict";

type Handler = () => void;
function makeEnv() {
  const win = new Map<string, Handler[]>();
  const doc = new Map<string, Handler[]>();
  const add = (m: Map<string, Handler[]>) => (e: string, h: Handler) => {
    m.set(e, [...(m.get(e) ?? []), h]);
  };
  const fire = (m: Map<string, Handler[]>, e: string) => (m.get(e) ?? []).forEach((h) => h());
  const document = {
    visibilityState: "visible" as string,
    addEventListener: add(doc),
    removeEventListener() {},
  };
  const window = { addEventListener: add(win), removeEventListener() {} };
  return { window, document, fireWin: (e: string) => fire(win, e), fireDoc: (e: string) => fire(doc, e) };
}

test("閒置 2 分鐘 → 失焦；操作 → 恢復；隱藏分頁 → 失焦", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const env = makeEnv();
  (globalThis as any).window = env.window;
  (globalThis as any).document = env.document;

  const { focusManager } = await import("@tanstack/react-query");
  const { installIdleFocus, IDLE_MS } = await import("./idle-focus");
  installIdleFocus();

  assert.equal(focusManager.isFocused(), true, "剛載入時應為聚焦");

  t.mock.timers.tick(IDLE_MS + 1);
  assert.equal(focusManager.isFocused(), false, "閒置超時應視為失焦（輪詢暫停）");

  env.fireWin("mousedown");
  assert.equal(focusManager.isFocused(), true, "一有操作應恢復聚焦");

  env.document.visibilityState = "hidden";
  env.fireDoc("visibilitychange");
  assert.equal(focusManager.isFocused(), false, "分頁隱藏應為失焦");

  env.document.visibilityState = "visible";
  env.fireDoc("visibilitychange");
  assert.equal(focusManager.isFocused(), true, "分頁回到前景應恢復聚焦");
});
