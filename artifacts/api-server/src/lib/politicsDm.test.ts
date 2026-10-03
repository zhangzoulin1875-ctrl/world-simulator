import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPoliticsSettlementDm,
  emptyPoliticsDigest,
  politicsSiteUrl,
} from "./politicsDm";

test("politicsSiteUrl prefers SITE_URL and strips trailing slashes", () => {
  assert.equal(
    politicsSiteUrl({ SITE_URL: "https://example.com/" }),
    "https://example.com/game/politics",
  );
  assert.equal(
    politicsSiteUrl({
      SITE_URL: "https://example.com",
      REPLIT_DOMAINS: "other.repl.co",
    }),
    "https://example.com/game/politics",
  );
});

test("politicsSiteUrl falls back to first REPLIT_DOMAINS entry", () => {
  assert.equal(
    politicsSiteUrl({ REPLIT_DOMAINS: "a.repl.co,b.repl.co" }),
    "https://a.repl.co/game/politics",
  );
  assert.equal(politicsSiteUrl({}), null);
});

test("buildPoliticsSettlementDm returns null when nothing happened", () => {
  assert.equal(
    buildPoliticsSettlementDm(emptyPoliticsDigest("大越帝國"), null),
    null,
  );
});

test("buildPoliticsSettlementDm includes policies, event, coup and link", () => {
  const digest = emptyPoliticsDigest("大越帝國");
  digest.policies.push({ title: "全民義務教育", succeeded: true });
  digest.policies.push({ title: "鹽鐵專賣", succeeded: false });
  digest.event = { title: "豐收之年", good: true };
  digest.coup = { title: "禁衛軍嘩變" };
  const msg = buildPoliticsSettlementDm(digest, "https://x.example/game/politics");
  assert.ok(msg);
  assert.ok(msg.startsWith("🏛️ 「大越帝國」內政回合結算結果："));
  assert.ok(msg.includes("📜 政策「全民義務教育」推行成功"));
  assert.ok(msg.includes("📉 政策「鹽鐵專賣」推行失敗"));
  assert.ok(msg.includes("🎉 隨機事件：「豐收之年」"));
  assert.ok(msg.includes("🔥 政變爆發：「禁衛軍嘩變」"));
  assert.ok(msg.endsWith("👉 前往內政頁面：https://x.example/game/politics"));
});

test("buildPoliticsSettlementDm handles bad event, missing name and no url", () => {
  const digest = emptyPoliticsDigest(null);
  digest.event = { title: "瘟疫蔓延", good: false };
  const msg = buildPoliticsSettlementDm(digest, null);
  assert.ok(msg);
  assert.ok(msg.startsWith("🏛️ 「你的國家」內政回合結算結果："));
  assert.ok(msg.includes("🌩️ 隨機事件：「瘟疫蔓延」"));
  assert.ok(!msg.includes("👉"));
});
