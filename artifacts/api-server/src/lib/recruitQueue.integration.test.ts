/**
 * 招募訓練佇列資料層整合測試（真實 DB）：
 *  1. 入列：同兵種可追加；滿 3 種不同兵種拒絕第 4 種；被拒不留殘列。
 *  2. 推進：依產能 FIFO 完成，併入 player_armies，佔用量守恆轉移。
 *  3. 守恆：推進一部分再取消 → 軍隊預留 + 退還 = 下單總額（一分不差）。
 *  4. 取消：100% 退還國家 spent／木礦／金錢，訂單刪除；不能取消別國訂單。
 *  5. 功能開關：預設關閉，可開可關。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the recruit queue tests");
}

const { eq, like, notExists, sql } = await import("drizzle-orm");
const {
  db,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  recruitQueueTable,
} = await import("@workspace/db");
const {
  enqueueInTx,
  advanceNationQueue,
  cancelQueueOrder,
  listNationQueue,
  isRecruitQueueEnabled,
  setRecruitQueueEnabled,
  RecruitQueueFullError,
} = await import("./recruitQueue");

const MARK = "__rqtest__";
const runId = randomBytes(4).toString("hex");
const userId = `rqtest-${runId}-${process.pid}`;
const otherUserId = `rqtest-o-${runId}-${process.pid}`;
let nationId: string;
let otherNationId: string;
const tplIds: number[] = [];

async function cleanup() {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
}

async function nation(id = nationId) {
  const [r] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id));
  return r!;
}

async function mkTemplate(name: string, owner = userId) {
  const [t] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ownerDiscordUserId: owner, isDefault: false, category: "infantry",
      name: `${MARK}${name}-${runId}`, eraSlug: "x", hp: 100, attack: 100, defense: 10,
      speed: 1, accuracy: 80, range: "melee", prodCostPer100: 1, popCostPerUnit: 1,
      moneyCostPerUnit: 10, prodUpkeepPerUnit: 0.1,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  return t!.id;
}

async function resetQueue() {
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, nationId));
  await db.delete(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  await db
    .update(playerNationsTable)
    .set({ productionSpent: 0, populationSpent: 0, wood: 1000, ore: 1000, money: 100000 })
    .where(eq(playerNationsTable.id, nationId));
}

before(async () => {
  await cleanup();
  const [n] = await db.insert(playerNationsTable)
    .values({ discordUserId: userId, name: `${MARK}a-${runId}`, leaderName: "t", government: "君主制" })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
  const [o] = await db.insert(playerNationsTable)
    .values({ discordUserId: otherUserId, name: `${MARK}b-${runId}`, leaderName: "t", government: "君主制" })
    .returning({ id: playerNationsTable.id });
  otherNationId = o!.id;
  for (const nm of ["A", "B", "C", "D"]) tplIds.push(await mkTemplate(nm));
});

after(async () => {
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, nationId));
  await cleanup();
  await setRecruitQueueEnabled(false);
});

const enq = (templateId: number, quantity: number, extra: Record<string, number> = {}, nid = () => nationId) =>
  db.transaction((tx) =>
    enqueueInTx(tx, { nationId: nid(), templateId, quantity, tpPerUnit: 2, ...extra }),
  );

test("功能開關：預設關閉，可開可關", async () => {
  await setRecruitQueueEnabled(false);
  assert.equal(await isRecruitQueueEnabled(), false);
  await setRecruitQueueEnabled(true);
  assert.equal(await isRecruitQueueEnabled(), true);
  await setRecruitQueueEnabled(false);
  assert.equal(await isRecruitQueueEnabled(), false);
});

test("入列：同兵種可追加；滿 3 種時第 4 種被拒且不留殘列", async () => {
  await resetQueue();
  const [A, B, C, D] = tplIds as [number, number, number, number];
  await enq(A, 10);
  await enq(B, 10);
  await enq(C, 10);
  await enq(A, 5); // 同兵種追加 OK（即使滿 3 種）
  await assert.rejects(() => enq(D, 1), RecruitQueueFullError);
  const q = await listNationQueue(nationId);
  assert.equal(q.length, 4, "3 種 + 1 筆追加；D 不得殘留");
  assert.ok(!q.some((r) => r.templateId === D));
});

test("推進：FIFO 依產能完成，併入軍隊，佔用守恆轉移", async () => {
  await resetQueue();
  const [A, B] = tplIds as [number, number];
  await enq(A, 100, { productionReserved: 10, populationReserved: 100 });
  await enq(B, 100, { productionReserved: 20, populationReserved: 100 });
  // 產能 300、tp=2 → 可完成 150 單位：A 全 100，B 50。
  const done = await advanceNationQueue(nationId, 300, false);
  assert.deepEqual(
    done.sort((x, y) => x.templateId - y.templateId),
    [{ templateId: A, units: 100 }, { templateId: B, units: 50 }].sort((x, y) => x.templateId - y.templateId),
  );
  const armies = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  const a = armies.find((r) => r.templateId === A)!;
  const b = armies.find((r) => r.templateId === B)!;
  assert.equal(a.quantity, 100);
  assert.equal(a.productionReserved, 10, "A 全部完成，佔用全數轉入軍隊");
  assert.equal(b.quantity, 50);
  assert.equal(b.productionReserved, 10, "B 完成一半，佔用按比例轉 20×50/100");
  assert.equal(b.populationReserved, 50);
  const q = await listNationQueue(nationId);
  assert.equal(q.length, 1, "A 已完成並自佇列移除");
  assert.equal(q[0]!.remaining, 50);
  assert.equal(q[0]!.productionReserved, 10, "訂單上剩下的佔用 = 未完成部分");
});

test("守恆：推進一部分再取消，軍隊預留 + 退還 = 下單總額", async () => {
  await resetQueue();
  const [A] = tplIds as [number];
  await db.update(playerNationsTable)
    .set({ productionSpent: 33, populationSpent: 100, wood: 900, ore: 950, money: 99000 })
    .where(eq(playerNationsTable.id, nationId));
  // 下單 100：佔用 33、人口 100、木 100、礦 50、錢 1000（總額）
  const order = await enq(A, 100, {
    productionReserved: 33, populationReserved: 100, woodPaid: 100, orePaid: 50, moneyPaid: 1000,
  });
  await advanceNationQueue(nationId, 60, false); // tp=2 → 完成 30 單位
  const [army] = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  assert.equal(army!.quantity, 30);

  const refund = await cancelQueueOrder(nationId, order.id);
  assert.ok(refund);
  assert.equal(refund!.refundedUnits, 70);
  assert.equal(army!.productionReserved + refund!.production, 33, "佔用守恆");
  assert.equal(army!.populationReserved + refund!.population, 100, "人口守恆");
  // 木礦金錢：下單總額按 remaining/total 退（70%）
  assert.equal(refund!.wood, 70);
  assert.equal(refund!.ore, 35);
  assert.equal(refund!.money, 700);

  const n = await nation();
  assert.equal(n.productionSpent, 33 - refund!.production, "國家 spent 扣回退還量");
  assert.equal(n.populationSpent, 100 - refund!.population);
  assert.equal(n.wood, 900 + 70);
  assert.equal(n.money, 99000 + 700);
  assert.equal((await listNationQueue(nationId)).length, 0);
});

test("取消：未推進時 100% 全額退還", async () => {
  await resetQueue();
  const [A] = tplIds as [number];
  await db.update(playerNationsTable)
    .set({ productionSpent: 40, populationSpent: 200, wood: 800, ore: 900, money: 98000 })
    .where(eq(playerNationsTable.id, nationId));
  const o = await enq(A, 200, {
    productionReserved: 40, populationReserved: 200, woodPaid: 200, orePaid: 100, moneyPaid: 2000,
  });
  const r = await cancelQueueOrder(nationId, o.id);
  assert.deepEqual(
    [r!.production, r!.population, r!.wood, r!.ore, r!.money],
    [40, 200, 200, 100, 2000],
  );
  const n = await nation();
  assert.deepEqual(
    [n.productionSpent, n.populationSpent, n.wood, n.ore, n.money],
    [0, 0, 1000, 1000, 100000],
  );
});

test("不能取消別國的訂單", async () => {
  await resetQueue();
  const [A] = tplIds as [number];
  const o = await enq(A, 10);
  const r = await cancelQueueOrder(otherNationId, o.id);
  assert.equal(r, null);
  assert.equal((await listNationQueue(nationId)).length, 1, "原訂單不受影響");
});

test("保底：單位 TP 大於產能時每回合仍完成 1 單位（不會永久卡死）", async () => {
  await resetQueue();
  const [A] = tplIds as [number];
  await db.transaction((tx) => enqueueInTx(tx, { nationId, templateId: A, quantity: 3, tpPerUnit: 51 }));
  const done = await advanceNationQueue(nationId, 20, false);
  assert.deepEqual(done, [{ templateId: A, units: 1 }]);
});

test("併發：兩個推進同時執行不會重複完成", async () => {
  await resetQueue();
  const [A] = tplIds as [number];
  await enq(A, 100);
  await Promise.all([
    advanceNationQueue(nationId, 100, false), // 完成 50
    advanceNationQueue(nationId, 100, false), // 完成 50
  ]);
  const [army] = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  assert.equal(army!.quantity, 100, "兩次合計恰好 100，不多不少");
  assert.equal((await listNationQueue(nationId)).length, 0);
});

test("防超發：訂單只有 60 單位，兩個各有 50 單位產能的並發推進，總和不得超過 60", async () => {
  await resetQueue();
  const [A] = tplIds as [number];
  await enq(A, 60);
  await Promise.all([
    advanceNationQueue(nationId, 100, false),
    advanceNationQueue(nationId, 100, false),
  ]);
  const [army] = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  assert.equal(army!.quantity, 60, "兵力不得超過下單量");
  assert.equal((await listNationQueue(nationId)).length, 0);
});
