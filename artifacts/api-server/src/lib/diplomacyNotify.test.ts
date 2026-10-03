import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  claimMessageDmSlot,
  diplomacySiteUrl,
  withSiteLink,
  MESSAGE_DM_COOLDOWN_MS,
  optedOutFromRow,
  deliverDm,
  deliverPoliticsDm,
  notifyTreatyProposal,
  notifyWarDeclared,
  notifyDiplomacyMessage,
  notifyRelationAction,
  __setDmDepsForTest,
  __setPersistDepForTest,
  type DmDeps,
} from "./diplomacyNotify";
import type { NewPlayerNotification } from "./playerNotify";

test("diplomacySiteUrl prefers SITE_URL and strips trailing slashes", () => {
  assert.equal(
    diplomacySiteUrl({ SITE_URL: "https://example.com/" }),
    "https://example.com/game/diplomacy",
  );
  assert.equal(
    diplomacySiteUrl({
      SITE_URL: "https://example.com",
      REPLIT_DOMAINS: "other.repl.co",
    }),
    "https://example.com/game/diplomacy",
  );
});

test("diplomacySiteUrl falls back to first REPLIT_DOMAINS entry", () => {
  assert.equal(
    diplomacySiteUrl({ REPLIT_DOMAINS: "a.repl.co,b.repl.co" }),
    "https://a.repl.co/game/diplomacy",
  );
});

test("diplomacySiteUrl returns null when nothing configured", () => {
  assert.equal(diplomacySiteUrl({}), null);
  assert.equal(diplomacySiteUrl({ SITE_URL: "  " }), null);
});

test("withSiteLink appends link only when url exists", () => {
  assert.equal(withSiteLink("哈囉", null), "哈囉");
  assert.equal(
    withSiteLink("哈囉", "https://x/game/diplomacy"),
    "哈囉\n👉 前往外交頁面：https://x/game/diplomacy",
  );
});

test("claimMessageDmSlot enforces per-key cooldown", () => {
  const slots = new Map<string, number>();
  const t0 = 1_000_000;
  assert.equal(claimMessageDmSlot(slots, "u1:n1", t0), true);
  // Same key within cooldown → blocked.
  assert.equal(claimMessageDmSlot(slots, "u1:n1", t0 + 1000), false);
  // Different key is independent.
  assert.equal(claimMessageDmSlot(slots, "u1:n2", t0 + 1000), true);
  // After cooldown the same key can claim again.
  assert.equal(
    claimMessageDmSlot(slots, "u1:n1", t0 + MESSAGE_DM_COOLDOWN_MS),
    true,
  );
});

test("claimMessageDmSlot prunes expired entries when map grows large", () => {
  const slots = new Map<string, number>();
  const t0 = 0;
  for (let i = 0; i < 501; i++) {
    claimMessageDmSlot(slots, `k${i}`, t0);
  }
  // All original entries are expired at this point → prune happens on claim.
  claimMessageDmSlot(slots, "fresh", t0 + MESSAGE_DM_COOLDOWN_MS);
  assert.ok(slots.size <= 2);
});

// ── Task #61: 「關閉外交通知」擋信 gate ────────────────────────

test("optedOutFromRow: flag 關閉 → 擋、開啟 → 送、查無國家 → 預設送", () => {
  assert.equal(optedOutFromRow({ enabled: false }), true);
  assert.equal(optedOutFromRow({ enabled: true }), false);
  assert.equal(optedOutFromRow(undefined), false);
});

/** 建立記錄呼叫的假依賴。 */
function makeFakeDeps(optedOut: boolean): {
  deps: DmDeps;
  checked: string[];
  sent: Array<{ discordUserId: string; content: string }>;
} {
  const checked: string[] = [];
  const sent: Array<{ discordUserId: string; content: string }> = [];
  const deps: DmDeps = {
    isOptedOut: async (id) => {
      checked.push(id);
      return optedOut;
    },
    send: async (discordUserId, content) => {
      sent.push({ discordUserId, content });
    },
  };
  return { deps, checked, sent };
}

test("deliverDm: 玩家關閉通知 → 不送出", async () => {
  const { deps, checked, sent } = makeFakeDeps(true);
  await deliverDm("user-off", "測試訊息", deps);
  assert.deepEqual(checked, ["user-off"]);
  assert.equal(sent.length, 0);
});

test("deliverDm: 玩家未關閉 → 送出", async () => {
  const { deps, checked, sent } = makeFakeDeps(false);
  await deliverDm("user-on", "測試訊息", deps);
  assert.deepEqual(checked, ["user-on"]);
  assert.deepEqual(sent, [{ discordUserId: "user-on", content: "測試訊息" }]);
});

test("deliverPoliticsDm: 內政開關關閉 → 不送、開啟 → 送（與外交開關各自獨立）", async () => {
  {
    const { deps, checked, sent } = makeFakeDeps(true);
    await deliverPoliticsDm("user-off", "內政摘要", deps);
    assert.deepEqual(checked, ["user-off"]);
    assert.equal(sent.length, 0);
  }
  {
    const { deps, checked, sent } = makeFakeDeps(false);
    await deliverPoliticsDm("user-on", "內政摘要", deps);
    assert.deepEqual(checked, ["user-on"]);
    assert.deepEqual(sent, [{ discordUserId: "user-on", content: "內政摘要" }]);
  }
});

// ── notify* 都必須經過同一個 gate（行為 + 靜態雙保險） ────────

afterEach(() => {
  __setDmDepsForTest(null);
  __setPersistDepForTest(null);
});

/** 記錄站內通知寫入的假依賴。 */
function makeFakePersist(): {
  persist: (n: NewPlayerNotification) => void;
  persisted: NewPlayerNotification[];
} {
  const persisted: NewPlayerNotification[] = [];
  return { persist: (n) => persisted.push(n), persisted };
}

/** 等待 fire-and-forget 的私訊 Promise 落定。 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

test("notifyTreatyProposal / notifyWarDeclared / notifyDiplomacyMessage 經過 opt-out gate；站內通知不受影響", async () => {
  // 關閉 → 三種 DM 都不送，但站內通知照樣寫入（Task #79）。
  {
    const { deps, checked, sent } = makeFakeDeps(true);
    const { persist, persisted } = makeFakePersist();
    __setDmDepsForTest(deps);
    __setPersistDepForTest(persist);
    notifyTreatyProposal({
      targetDiscordUserId: "u-blocked",
      proposerNationName: "甲國",
      treatyType: "non_aggression",
    });
    notifyWarDeclared({
      targetDiscordUserId: "u-blocked",
      declarerNationName: "乙國",
    });
    notifyDiplomacyMessage({
      recipientDiscordUserId: "u-blocked",
      senderNationId: "gate-test-nation-1",
      senderNationName: "丙國",
    });
    await flushAsync();
    assert.equal(checked.length, 3);
    assert.equal(sent.length, 0);
    assert.equal(persisted.length, 3, "DM 關閉時站內通知仍必須寫入");
    for (const p of persisted) {
      assert.equal(p.discordUserId, "u-blocked");
      assert.equal(p.type, "diplomacy");
      assert.equal(p.linkPath, "/game/diplomacy");
      assert.ok(p.title.length > 0);
      assert.ok(p.body.length > 0);
    }
  }
  // 開啟 → 三種通知 DM 都送出，站內通知也寫入（訊息用不同 sender key 避開冷卻）。
  {
    const { deps, checked, sent } = makeFakeDeps(false);
    const { persist, persisted } = makeFakePersist();
    __setDmDepsForTest(deps);
    __setPersistDepForTest(persist);
    notifyTreatyProposal({
      targetDiscordUserId: "u-open",
      proposerNationName: "甲國",
      treatyType: "non_aggression",
    });
    notifyWarDeclared({
      targetDiscordUserId: "u-open",
      declarerNationName: "乙國",
    });
    notifyDiplomacyMessage({
      recipientDiscordUserId: "u-open",
      senderNationId: "gate-test-nation-2",
      senderNationName: "丙國",
    });
    await flushAsync();
    assert.equal(checked.length, 3);
    assert.equal(sent.length, 3);
    for (const s of sent) assert.equal(s.discordUserId, "u-open");
    assert.equal(persisted.length, 3);
  }
});

test("notifyDiplomacyMessage 冷卻同時擋 DM 與站內通知（共用同一冷卻）", async () => {
  const { deps, sent } = makeFakeDeps(false);
  const { persist, persisted } = makeFakePersist();
  __setDmDepsForTest(deps);
  __setPersistDepForTest(persist);
  const params = {
    recipientDiscordUserId: "u-cooldown",
    senderNationId: "gate-test-nation-cooldown",
    senderNationName: "丁國",
  };
  notifyDiplomacyMessage(params);
  notifyDiplomacyMessage(params); // 冷卻內第二次 → 兩個通道都不送
  await flushAsync();
  assert.equal(sent.length, 1);
  assert.equal(persisted.length, 1);
});

// ── Task #108: relation action 承受方通知 ──────────────────────

test("notifyRelationAction: 站內通知 linkPath 帶對方國家、正負語氣、opt-out gate", async () => {
  // 開啟 DM：站內通知＋DM 都送；linkPath 指向發動方國家。
  {
    const { deps, checked, sent } = makeFakeDeps(false);
    const { persist, persisted } = makeFakePersist();
    __setDmDepsForTest(deps);
    __setPersistDepForTest(persist);
    notifyRelationAction({
      targetDiscordUserId: "u-victim",
      actorNationId: "actor-123",
      actorNationName: "甲國",
      action: "insult",
    });
    await flushAsync();
    assert.equal(persisted.length, 1);
    const p = persisted[0]!;
    assert.equal(p.discordUserId, "u-victim");
    assert.equal(p.type, "diplomacy");
    assert.equal(p.linkPath, "/game/diplomacy?nation=actor-123");
    assert.ok(p.title.includes("侮辱"), "負面動作標題應點名被侮辱");
    assert.equal(checked.length, 1);
    assert.equal(sent.length, 1);
  }
  // 關閉 DM：DM 不送但站內通知照寫（正面動作亦有通知）。
  {
    const { deps, checked, sent } = makeFakeDeps(true);
    const { persist, persisted } = makeFakePersist();
    __setDmDepsForTest(deps);
    __setPersistDepForTest(persist);
    notifyRelationAction({
      targetDiscordUserId: "u-blocked",
      actorNationId: "actor-456",
      actorNationName: null,
      action: "gift",
    });
    await flushAsync();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.linkPath, "/game/diplomacy?nation=actor-456");
    assert.ok(persisted[0]!.body.includes("（未命名）"));
    assert.equal(checked.length, 1);
    assert.equal(sent.length, 0, "關閉 DM 時不得送出私訊");
  }
});

test("notifyRelationAction: 承受方無 Discord 帳號（NPC／無主）→ 不發任何通知", async () => {
  const { deps, checked, sent } = makeFakeDeps(false);
  const { persist, persisted } = makeFakePersist();
  __setDmDepsForTest(deps);
  __setPersistDepForTest(persist);
  notifyRelationAction({
    targetDiscordUserId: null,
    actorNationId: "actor-789",
    actorNationName: "乙國",
    action: "withdraw",
  });
  await flushAsync();
  assert.equal(persisted.length, 0);
  assert.equal(checked.length, 0);
  assert.equal(sent.length, 0);
});

test("靜態檢查：所有 notify* 都走 fireNotify，沒有函式繞過統一入口", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./diplomacyNotify.ts", import.meta.url)),
    "utf8",
  );

  // 找出所有匯出的 notify* 函式，逐一取出函式本體檢查。
  // 同時防範日後改用 `export const notifyX = ...` 形式繞過本檢查。
  const constNotify = [
    ...source.matchAll(/export const (notify\w+)/g),
  ].map((m) => m[1]!);
  assert.deepEqual(
    constNotify,
    [],
    "notify* 一律用 export function 宣告，否則靜態 gate 檢查無法覆蓋",
  );
  const notifyNames = [
    ...source.matchAll(/export function (notify\w+)/g),
  ].map((m) => m[1]!);
  assert.ok(
    notifyNames.length >= 5,
    `應至少有 5 個 notify* 函式，實際 ${notifyNames.length}`,
  );

  const declarations = [...source.matchAll(/export function \w+|async function \w+|function \w+/g)];
  const bodyOf = (name: string): string => {
    const idx = source.indexOf(`function ${name}`);
    assert.ok(idx >= 0, `找不到函式 ${name}`);
    const next = declarations
      .map((d) => d.index!)
      .filter((i) => i > idx)
      .sort((a, b) => a - b)[0];
    return source.slice(idx, next ?? source.length);
  };

  for (const name of notifyNames) {
    const body = bodyOf(name);
    assert.ok(
      body.includes("fireNotify("),
      `${name} 必須透過 fireNotify 通知（站內通知＋DM opt-out gate 統一入口）`,
    );
    assert.ok(
      !body.includes("fireDm(") &&
        !body.includes("sendDm(") &&
        !body.includes("deps.send(") &&
        !body.includes(".send({") &&
        !body.includes("deliverDm(") &&
        !body.includes("persistDep("),
      `${name} 不得繞過 fireNotify 直接送 DM 或寫站內通知`,
    );
  }

  // fireNotify 本體必須：先寫站內通知（不看 DM 開關）、再走 deliverDm gate。
  const fireNotifyBody = bodyOf("fireNotify");
  assert.ok(
    fireNotifyBody.includes("persistDep(") &&
      fireNotifyBody.includes("deliverDm("),
    "fireNotify 必須同時寫站內通知（persistDep）與走 deliverDm gate",
  );

  // sendDm（實際發送）只能出現在：自身定義、外交預設依賴 defaultDmDeps、
  // 內政預設依賴 defaultPoliticsDmDeps。
  const sendDmUses = [...source.matchAll(/\bsendDm\b/g)].length;
  assert.equal(
    sendDmUses,
    3,
    "sendDm 只能在定義處與 defaultDmDeps／defaultPoliticsDmDeps 出現；其他地方一律走 deliverDm/deliverPoliticsDm gate",
  );

  // Discord 原生送信（user.send）只能在 sendDm 內出現一次。
  const rawSends = [...source.matchAll(/\.send\(\{/g)].length;
  assert.equal(rawSends, 1, "user.send 只允許在 sendDm 內出現");
});
