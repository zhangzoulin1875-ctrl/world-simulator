import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { like } from "drizzle-orm";
import { db, pool, playerNotificationsTable } from "@workspace/db";
import { runGameMigrations } from "./gameMigrations";
import {
  createPlayerNotification,
  listPlayerNotifications,
  markPlayerNotificationsRead,
  NOTIFICATION_RETENTION,
} from "./playerNotify";

/**
 * Task #79 — 站內通知 helper 的整合測試（真實資料庫）。
 * - 寫入＋清單（新到舊）＋未讀數
 * - 保留上限（每玩家最新 NOTIFICATION_RETENTION 則）
 * - 標為已讀：全部／指定 ids／不可標到別人的通知
 */

const TEST_TAG = "__notifytest__";
const USER_A = `${TEST_TAG}-user-a`;
const USER_B = `${TEST_TAG}-user-b`;

async function cleanup() {
  await db
    .delete(playerNotificationsTable)
    .where(like(playerNotificationsTable.discordUserId, `${TEST_TAG}%`));
}

before(async () => {
  await runGameMigrations();
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("寫入＋清單：新到舊排序、未讀數正確", async () => {
  for (let i = 1; i <= 3; i++) {
    await createPlayerNotification({
      discordUserId: USER_A,
      type: "diplomacy",
      title: `標題 ${i}`,
      body: `內容 ${i}`,
      linkPath: "/game/diplomacy",
    });
  }
  const { notifications, unreadCount } = await listPlayerNotifications(
    USER_A,
    10,
  );
  assert.equal(notifications.length, 3);
  assert.equal(unreadCount, 3);
  assert.equal(notifications[0]!.title, "標題 3");
  assert.equal(notifications[2]!.title, "標題 1");
  assert.equal(notifications[0]!.readAt, null);
  assert.equal(notifications[0]!.linkPath, "/game/diplomacy");
});

test("標為已讀：指定 ids 只標指定通知", async () => {
  const { notifications } = await listPlayerNotifications(USER_A, 10);
  const firstId = notifications[0]!.id;
  const { unreadCount } = await markPlayerNotificationsRead(USER_A, [firstId]);
  assert.equal(unreadCount, 2);
  const afterList = await listPlayerNotifications(USER_A, 10);
  const marked = afterList.notifications.find((n) => n.id === firstId);
  assert.ok(marked?.readAt instanceof Date);
});

test("標為已讀：省略 ids = 全部標為已讀；不影響其他玩家", async () => {
  await createPlayerNotification({
    discordUserId: USER_B,
    type: "diplomacy",
    title: "B 的通知",
    body: "B 的內容",
  });
  const { unreadCount } = await markPlayerNotificationsRead(USER_A);
  assert.equal(unreadCount, 0);
  const bList = await listPlayerNotifications(USER_B, 10);
  assert.equal(bList.unreadCount, 1, "標已讀不得影響其他玩家");
});

test("不可用別人的 user id 標到自己的通知（ids 交集為空 → 無事發生）", async () => {
  const bList = await listPlayerNotifications(USER_B, 10);
  const bId = bList.notifications[0]!.id;
  // USER_A 嘗試標 USER_B 的通知 → 條件含 discordUserId，不會生效。
  await markPlayerNotificationsRead(USER_A, [bId]);
  const bAfter = await listPlayerNotifications(USER_B, 10);
  assert.equal(bAfter.unreadCount, 1);
});

test("保留上限：超過 NOTIFICATION_RETENTION 則自動清最舊", async () => {
  const userId = `${TEST_TAG}-retention`;
  for (let i = 1; i <= NOTIFICATION_RETENTION + 5; i++) {
    await createPlayerNotification({
      discordUserId: userId,
      type: "diplomacy",
      title: `第 ${i} 則`,
      body: `內容 ${i}`,
    });
  }
  const { notifications, unreadCount } = await listPlayerNotifications(
    userId,
    NOTIFICATION_RETENTION + 10,
  );
  assert.equal(notifications.length, NOTIFICATION_RETENTION);
  assert.equal(unreadCount, NOTIFICATION_RETENTION);
  // 最新一則在最前面；最舊的 5 則已被清掉。
  assert.equal(notifications[0]!.title, `第 ${NOTIFICATION_RETENTION + 5} 則`);
  assert.equal(
    notifications[notifications.length - 1]!.title,
    "第 6 則",
  );
});
