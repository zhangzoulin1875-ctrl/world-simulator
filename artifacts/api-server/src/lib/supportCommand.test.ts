import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleCommand, __resetOwnerCacheForTest, SUPPORT_COMMAND_NAME } from "./supportBot";

/** 假的 interaction：記錄 defer／reply／editReply 的時間點，模擬 Discord 的 3 秒期限。 */
function fakeInteraction(opts: { userId: string; sub: string }) {
  const t0 = Date.now();
  const log: Array<{ what: string; at: number; content?: string }> = [];
  const i = {
    commandName: SUPPORT_COMMAND_NAME,
    user: { id: opts.userId },
    channel: { id: "chan1", type: 0 },
    options: { getSubcommand: () => opts.sub },
    deferReply: async () => { log.push({ what: "defer", at: Date.now() - t0 }); },
    editReply: async (o: { content: string }) => { log.push({ what: "edit", at: Date.now() - t0, content: o.content }); },
    reply: async (o: { content: string }) => { log.push({ what: "reply", at: Date.now() - t0, content: o.content }); },
  };
  return { i: i as never, log };
}

const slowOwnerClient = (ownerId: string, delayMs: number) =>
  ({ application: { fetch: async () => { await new Promise((r) => setTimeout(r, delayMs)); return { owner: { id: ownerId } }; } } }) as never;

beforeEach(() => __resetOwnerCacheForTest());

test("核心：即使查擁有者很慢（超過 3 秒），也在 3 秒內先 defer，之後才 editReply（不會顯示『該申請未受回應』）", async () => {
  const { i, log } = fakeInteraction({ userId: "owner1", sub: "狀態" });
  await handleCommand(slowOwnerClient("owner1", 3500), i);
  const defer = log.find((l) => l.what === "defer")!;
  assert.ok(defer && defer.at < 1000, `defer 應在 3 秒內（實際 ${defer?.at}ms）`);
  assert.equal(log[0]!.what, "defer", "第一個動作就是 defer");
  const edit = log.find((l) => l.what === "edit")!;
  assert.ok(edit.at >= 3400, "慢操作做完才編輯回覆");
  assert.ok(!log.some((l) => l.what === "reply"), "defer 之後不能再用 reply（會丟 already acknowledged）");
  assert.match(edit.content!, /客服頻道/);
});

test("非擁有者：被拒絕，且仍先 defer", async () => {
  const { i, log } = fakeInteraction({ userId: "stranger", sub: "設定" });
  await handleCommand(slowOwnerClient("owner1", 10), i);
  assert.equal(log[0]!.what, "defer");
  assert.match(log.find((l) => l.what === "edit")!.content!, /只有機器人擁有者/);
});

test("查不到擁有者（API 失敗）→ 一律拒絕，不會讓人亂設", async () => {
  const { i, log } = fakeInteraction({ userId: "owner1", sub: "設定" });
  const failing = { application: { fetch: async () => { throw new Error("discord down"); } } } as never;
  await handleCommand(failing, i);
  assert.match(log.find((l) => l.what === "edit")!.content!, /只有機器人擁有者/);
});

test("defer 本身失敗（互動已過期）→ 退而求其次用 reply，不會拋出未捕捉錯誤", async () => {
  const { i, log } = fakeInteraction({ userId: "owner1", sub: "狀態" });
  (i as unknown as { deferReply: () => Promise<void> }).deferReply = async () => { throw new Error("Unknown interaction"); };
  await assert.doesNotReject(handleCommand(slowOwnerClient("owner1", 5), i));
  assert.ok(log.some((l) => l.what === "reply"), "改用 reply");
});

test("別人的指令名稱不處理", async () => {
  const { i, log } = fakeInteraction({ userId: "owner1", sub: "狀態" });
  (i as unknown as { commandName: string }).commandName = "other";
  await handleCommand(slowOwnerClient("owner1", 5), i);
  assert.equal(log.length, 0);
});
