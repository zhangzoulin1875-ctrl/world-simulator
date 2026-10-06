import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getSupportChannelId, setSupportChannelId, resetSupportCache } from "./supportBot";

let original: string | null = null;
before(async () => {
  const [row] = await db.select({ id: botSettingsTable.supportChannelId }).from(botSettingsTable).where(eq(botSettingsTable.id, 1)).limit(1);
  original = row?.id ?? null;
});
after(async () => { await setSupportChannelId(original); });

test("遷移後 bot_settings 有 support_channel_id 欄位，且可重複執行", async () => {
  const r: any = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='bot_settings' AND column_name='support_channel_id'`);
  assert.equal((r.rows ?? r).length, 1);
});

test("設定 → 讀回；取消 → null；重設快取後仍從資料庫讀到同值", async () => {
  await setSupportChannelId("123456789012345678");
  resetSupportCache();
  assert.equal(await getSupportChannelId(), "123456789012345678");
  await setSupportChannelId(null);
  resetSupportCache();
  assert.equal(await getSupportChannelId(), null);
});

test("設定客服頻道不會洗掉同一列的其他設定（token／線路池）", async () => {
  await db.update(botSettingsTable).set({ aiRoutePool: '[{"keep":"me"}]' }).where(eq(botSettingsTable.id, 1));
  await setSupportChannelId("999");
  const [row] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, 1)).limit(1);
  assert.equal(row!.aiRoutePool, '[{"keep":"me"}]');
  assert.equal(row!.supportChannelId, "999");
  await db.update(botSettingsTable).set({ aiRoutePool: null }).where(eq(botSettingsTable.id, 1));
});
