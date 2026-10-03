import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  isHelpSeen,
  markHelpSeen,
  isOnboardingDone,
  markOnboardingDone,
  ANON_SCOPE,
} from "./help-storage-core.ts";

/**
 * 這些測試守住「說明／新手教學只彈一次」的核心承諾：
 * 一旦有人改壞 help-storage 的 localStorage 邏輯，導致每次進站又跳教學／說明，
 * 這裡就會亮紅燈。
 *
 * help-storage-core 依賴 window.localStorage；Node 環境沒有 window，
 * 因此在每個測試前塞入一個以 Map 為底的 localStorage mock。
 */

class LocalStorageMock {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

beforeEach(() => {
  (globalThis as unknown as { window: { localStorage: LocalStorageMock } }).window = {
    localStorage: new LocalStorageMock(),
  };
});

/**
 * 重現 HelpButton 首次到訪的自動彈出判斷：
 * 沒看過 → 標記已看過並回傳 true（代表這次會自動開啟），否則回傳 false。
 */
function visitHelp(scope: string, key: string): boolean {
  if (!isHelpSeen(scope, key)) {
    markHelpSeen(scope, key);
    return true;
  }
  return false;
}

describe("說明首次到訪：每個 scope+key 只自動彈出一次", () => {
  it("同一頁第一次到訪會彈出，之後不再彈出", () => {
    const scope = "user-1";
    assert.equal(visitHelp(scope, "military"), true, "首次到訪應自動彈出");
    assert.equal(visitHelp(scope, "military"), false, "第二次到訪不應再彈出");
    assert.equal(visitHelp(scope, "military"), false, "第三次到訪仍不應彈出");
  });

  it("不同分頁（key）各自獨立觸發一次", () => {
    const scope = "user-1";
    assert.equal(visitHelp(scope, "military"), true);
    assert.equal(visitHelp(scope, "diplomacy"), true, "另一分頁首次到訪應各自彈出");
    assert.equal(visitHelp(scope, "military"), false);
    assert.equal(visitHelp(scope, "diplomacy"), false);
  });

  it("markHelpSeen 具冪等性，重複標記不會出錯或改變結果", () => {
    const scope = "user-1";
    assert.equal(isHelpSeen(scope, "economy"), false);
    markHelpSeen(scope, "economy");
    markHelpSeen(scope, "economy");
    assert.equal(isHelpSeen(scope, "economy"), true);
    assert.equal(visitHelp(scope, "economy"), false, "已標記後不應再彈出");
  });
});

describe("新手教學：只觸發一次，markOnboardingDone 後不再觸發", () => {
  it("首次為未完成，標記完成後回報已完成", () => {
    const scope = "user-1";
    assert.equal(isOnboardingDone(scope), false, "新玩家應尚未完成新手教學");
    markOnboardingDone(scope);
    assert.equal(isOnboardingDone(scope), true, "標記後應視為已完成");
  });

  it("重現 game-home 的觸發判斷：完成後不再自動觸發歡迎導覽", () => {
    const scope = "user-1";
    const shouldTriggerFirst = !isOnboardingDone(scope);
    assert.equal(shouldTriggerFirst, true, "首次進站應觸發新手教學");

    markOnboardingDone(scope);

    const shouldTriggerAgain = !isOnboardingDone(scope);
    assert.equal(shouldTriggerAgain, false, "回訪不應再觸發新手教學");
  });
});

describe("狀態以 scope 區隔：不同 Discord 帳號與匿名（anon）互不干擾", () => {
  it("A 帳號看過的說明不會影響 B 帳號", () => {
    markHelpSeen("user-A", "military");
    assert.equal(isHelpSeen("user-A", "military"), true);
    assert.equal(isHelpSeen("user-B", "military"), false, "另一帳號應仍為首次");
    assert.equal(visitHelp("user-B", "military"), true, "另一帳號首次仍應彈出");
  });

  it("登入帳號與匿名（anon）狀態彼此獨立", () => {
    markHelpSeen(ANON_SCOPE, "military");
    assert.equal(isHelpSeen(ANON_SCOPE, "military"), true);
    assert.equal(isHelpSeen("user-A", "military"), false, "登入後應與匿名狀態分離");
  });

  it("新手教學完成狀態也依 scope 區隔", () => {
    markOnboardingDone("user-A");
    assert.equal(isOnboardingDone("user-A"), true);
    assert.equal(isOnboardingDone("user-B"), false, "另一帳號應仍需跑新手教學");
    assert.equal(isOnboardingDone(ANON_SCOPE), false, "匿名狀態應與登入帳號分離");
  });
});
