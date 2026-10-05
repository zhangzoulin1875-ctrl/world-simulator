import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const { eq, like, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, parliamentStateTable, constitutionsTable } = await import("@workspace/db");
const { ensureParliamentTestSchema } = await import("../parliament/testSchema");
const { runParliamentMigrations } = await import("../parliamentMigrations");
const { settleNationParliament } = await import("../parliament/service");
const { saveDraft, loadConstitution, statusOf } = await import("./service");
const { NO_CONSTITUTION_SAT_FLOOR } = await import("./core");

const MARK = "ConT"; const run = randomBytes(3).toString("hex");
let n = 0;
async function mkNation(gov: string) {
  const [row] = await db.insert(playerNationsTable).values({
    discordUserId: `ct-${run}-${n}`, name: `${MARK}${run}${n++}`, leaderName: "t", government: gov,
  } as any).returning();
  return row!;
}
async function setStatus(id: string, status: string, extra: Record<string, unknown> = {}) {
  await db.update(constitutionsTable).set({ status, ...extra } as any).where(eq(constitutionsTable.nationId, id));
}
async function satOf(id: string) {
  const [s] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, id));
  return s!.satisfaction;
}

before(async () => {
  await ensureParliamentTestSchema();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
});
after(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("遷移可重複執行（冪等），不會因 trigger/函式已存在而失敗", async () => {
  await runParliamentMigrations();
  await runParliamentMigrations();
  const r = await db.execute(sql`select count(*)::int as c from pg_trigger where tgname = 'constitutions_lock_trg'`);
  assert.equal((r.rows[0] as any).c, 1, "trigger 只會有一個");
});

test("首次存草稿建立一列；重複存檔覆蓋同一列；超過 12000 字被擋", async () => {
  const nat = await mkNation("議會內閣制");
  assert.equal(statusOf(await loadConstitution(nat.id)), "none");
  const a = await saveDraft(nat.id, "第一條 主權在民");
  assert.ok(a.ok && a.row.status === "draft");
  const b = await saveDraft(nat.id, "第一條 主權在民\n第二條 三權分立");
  assert.ok(b.ok && b.row.draftText.includes("第二條"));
  const rows = await db.select().from(constitutionsTable).where(eq(constitutionsTable.nationId, nat.id));
  assert.equal(rows.length, 1);
  const tooLong = await saveDraft(nat.id, "字".repeat(12001));
  assert.ok(!tooLong.ok && tooLong.code === 400);
  assert.equal((await loadConstitution(nat.id))!.draftText.includes("第二條"), true, "被擋的存檔不覆蓋舊稿");
});

test("審議中不可改稿（409）", async () => {
  const nat = await mkNation("議會內閣制");
  await saveDraft(nat.id, "草稿內容");
  await setStatus(nat.id, "reviewing");
  const r = await saveDraft(nat.id, "趁審議偷改");
  assert.ok(!r.ok && r.code === 409);
  assert.equal((await loadConstitution(nat.id))!.draftText, "草稿內容");
});

test("通過後資料庫層鎖定：不能改文字、不能改狀態、不能把它改回草稿", async () => {
  const nat = await mkNation("議會內閣制");
  await saveDraft(nat.id, "原始草稿");
  await setStatus(nat.id, "ratified", { finalText: "定稿全文", ratifiedTick: 3 });

  const r = await saveDraft(nat.id, "通過後想改");
  assert.ok(!r.ok && r.code === 409 && r.error.includes("不可更改"));

  // 繞過服務層，直接對資料庫下手：每一條都要被 trigger 擋下。
  for (const patch of [
    sql`final_text = '偷改定稿'`,
    sql`draft_text = '偷改草稿'`,
    sql`status = 'draft'`,
    sql`ratified_tick = 99`,
  ]) {
    await assert.rejects(
      db.execute(sql`update constitutions set ${patch} where nation_id = ${nat.id}`),
      (err: any) => /cannot be modified/.test(String(err?.cause?.message ?? err?.message)),
    );
  }
  const row = (await loadConstitution(nat.id))!;
  assert.equal(row.finalText, "定稿全文");
  assert.equal(row.draftText, "原始草稿");
  assert.equal(row.status, "ratified");

  // 但後續階段需要寫入的欄位（漏洞清單、審查紀錄）仍可更新。
  await db.update(constitutionsTable).set({ flaws: ["漏洞一"] }).where(eq(constitutionsTable.nationId, nat.id));
  assert.deepEqual((await loadConstitution(nat.id))!.flaws, ["漏洞一"]);
});

test("並發存草稿不會產生兩列，也不會丟錯", async () => {
  const nat = await mkNation("議會內閣制");
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => saveDraft(nat.id, `並發稿 ${i}`)));
  assert.ok(rs.every((r) => r.ok));
  const rows = await db.select().from(constitutionsTable).where(eq(constitutionsTable.nationId, nat.id));
  assert.equal(rows.length, 1);
});

test("議會結算：民主國沒憲法 → 滿意度每回合 -1，並留下日誌", async () => {
  const nat = await mkNation("議會內閣制");
  await settleNationParliament(nat, null, 0); // 第一次結算會建議會狀態與政黨
  const s1 = await satOf(nat.id);
  await settleNationParliament(nat, null, 0);
  const s2 = await satOf(nat.id);
  assert.ok(s2 < s1 || s2 === NO_CONSTITUTION_SAT_FLOOR, `應下降：${s1} -> ${s2}`);
  const logs = await db.execute(sql`select summary from parliament_log where nation_id = ${nat.id} and summary like '%沒有憲法%'`);
  assert.ok(logs.rows.length >= 1);
});

test("議會結算：通過憲法後不再有「沒有憲法」扣分；專制橡皮圖章從來不扣", async () => {
  const ok = await mkNation("議會內閣制");
  await settleNationParliament(ok, null, 0);
  await db.insert(constitutionsTable).values({ nationId: ok.id, status: "ratified", draftText: "x", finalText: "x", ratifiedTick: 1 });
  // 結算前先清掉通過前累積的日誌，只看通過之後的。
  await db.execute(sql`delete from parliament_log where nation_id = ${ok.id}`);
  for (let i = 0; i < 3; i++) await settleNationParliament(ok, null, 0);
  const noLog = await db.execute(sql`select 1 from parliament_log where nation_id = ${ok.id} and summary like '%沒有憲法%'`);
  assert.equal(noLog.rows.length, 0, "通過後不應再出現憲法懲罰日誌（議會自己的政策要求判定另計）");

  const dict = await mkNation("軍事獨裁");
  await settleNationParliament(dict, null, 0);
  await settleNationParliament(dict, null, 0);
  assert.equal(await satOf(dict.id), 80, "橡皮圖章議會鎖 80，不受憲法懲罰");
  const dLog = await db.execute(sql`select 1 from parliament_log where nation_id = ${dict.id} and summary like '%沒有憲法%'`);
  assert.equal(dLog.rows.length, 0);
});

test("議會結算：滿意度已在下限時，憲法懲罰不再追加（不會單憑此事把人踩到歸零）", async () => {
  const nat = await mkNation("議會內閣制");
  await settleNationParliament(nat, null, 0);
  await db.update(parliamentStateTable).set({ satisfaction: NO_CONSTITUTION_SAT_FLOOR }).where(eq(parliamentStateTable.nationId, nat.id));
  await db.execute(sql`delete from parliament_log where nation_id = ${nat.id}`);
  await settleNationParliament(nat, null, 0);
  const pen = await db.execute(sql`select 1 from parliament_log where nation_id = ${nat.id} and summary like '%沒有憲法%'`);
  assert.equal(pen.rows.length, 0, "已在下限，憲法懲罰不該再出手");
});
