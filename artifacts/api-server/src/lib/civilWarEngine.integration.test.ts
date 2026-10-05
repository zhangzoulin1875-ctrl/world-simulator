import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import {
  db, pool, playerNationsTable, regionControlsTable, mapRegionsTable,
  diplomacyWarsTable, parliamentLogTable,
} from "@workspace/db";
import { runGameMigrations, runRegionControlMigrations } from "./gameMigrations";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import { runWarMigrations } from "./warMigrations";
import { runParliamentMigrations } from "./parliamentMigrations";
import { startCivilWar, settleCivilWars } from "./civilWarEngine";
import { applyRevolution } from "./parliament/service";
import { runNpcExtinctionCheck } from "./npcExtinction";
import { governmentLabel } from "./governments";
import { civilWarBetween } from "./civilWar";
import { judgeCivilWar, splitRatioFor, rebelNationName } from "./civilWarCore";

const MARK = "CwEng";
const run = randomBytes(3).toString("hex");
let n = 0;
let regionIds: number[] = [];
type NationRow = typeof playerNationsTable.$inferSelect;

async function mkNation(gov: string, isNpc = false, extra: Record<string, unknown> = {}): Promise<NationRow> {
  const [row] = await db.insert(playerNationsTable).values({
    discordUserId: isNpc ? null : `cwe-${run}-${n}`, name: `${MARK}${run}${n++}`, leaderName: "t",
    government: governmentLabel(gov)!, isNpc, stability: 50, ...extra,
  } as never).returning();
  return row!;
}
const setLand = async (nationId: string, lands: Array<[number, number]>) => {
  await db.delete(regionControlsTable).where(eq(regionControlsTable.nationId, nationId));
  for (const [regionId, percent] of lands) await db.insert(regionControlsTable).values({ regionId, nationId, percent });
};
const landSum = async (nationId: string) =>
  (await db.select({ s: sql<number>`COALESCE(SUM(percent),0)::int` }).from(regionControlsTable).where(eq(regionControlsTable.nationId, nationId)))[0]!.s;
const reload = async (id: string) => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id)))[0];
const civilWarOf = async (incumbentId: string) =>
  (await db.select().from(diplomacyWarsTable).where(and(eq(diplomacyWarsTable.isCivilWar, true),
    sql`(${diplomacyWarsTable.nationAId} = ${incumbentId} OR ${diplomacyWarsTable.nationBId} = ${incumbentId})`)))[0];
const start = (nation: NationRow, ideology: "black" | "red" | "parliament") =>
  db.transaction((tx) => startCivilWar(tx, nation, ideology, 1, "測試"));

before(async () => {
  await runGameMigrations(); await runRegionControlMigrations(); await runDiplomacyMigrations();
  await runWarMigrations(); await runParliamentMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  // 借用「沒人控制」的地區,避開其他整合測試
  const rows = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable)
    .leftJoin(regionControlsTable, eq(regionControlsTable.regionId, mapRegionsTable.id))
    .where(isNull(regionControlsTable.id)).orderBy(mapRegionsTable.id).offset(260).limit(6);
  regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 4, "需要至少 4 個無人地區");
});
after(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

// ── 純邏輯 ─────────────────────────────────────────────
test("切地比例:共產革命打獨裁 35%,其餘 40%", () => {
  assert.equal(splitRatioFor("red", true), 0.35);
  assert.equal(splitRatioFor("red", false), 0.4);
  assert.equal(splitRatioFor("black", true), 0.4);
  assert.equal(splitRatioFor("parliament", false), 0.4);
});
test("勝負判定:一方沒地即被消滅;雙方皆無保守判原政權勝", () => {
  assert.deepEqual(judgeCivilWar(10, 10), { finished: false });
  assert.equal((judgeCivilWar(10, 0) as { winner: string }).winner, "incumbent");
  assert.equal((judgeCivilWar(0, 10) as { winner: string }).winner, "rebel");
  assert.equal((judgeCivilWar(0, 0) as { winner: string }).winner, "incumbent");
});
test("革命方命名:去標點空白、限 25 字", () => {
  assert.equal(rebelNationName("北 方,地", "red"), "北方地革命政權");
  assert.ok(rebelNationName("a".repeat(40), "black").length <= 25);
});

// ── 爆發 ───────────────────────────────────────────────
test("爆發(議會革命):切走 40%、建立 NPC 革命方、寫下不可停戰的內戰", async () => {
  const inc = await mkNation("parliamentary_republic");
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]); // 共 200
  const r = await start(inc, "parliament");
  assert.ok(r.started);
  if (!r.started) return;
  assert.equal(await landSum(r.rebelNationId), 80, "200 × 40%");
  assert.equal(await landSum(inc.id), 120);
  const rebel = (await reload(r.rebelNationId))!;
  assert.equal(rebel.isNpc, true);
  const w = (await civilWarOf(inc.id))!;
  assert.equal(w.isCivilWar, true); assert.equal(w.rebelNationId, rebel.id); assert.equal(w.rebelIdeology, "parliament");
  assert.equal(w.endedAt, null);
  assert.equal(await civilWarBetween(inc.id, rebel.id), true);
});

test("爆發(獨裁被共產革命):革命方只拿 35%", async () => {
  const inc = await mkNation("absolute_monarchy");
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(inc, "red");
  assert.ok(r.started);
  if (!r.started) return;
  assert.equal(await landSum(r.rebelNationId), 70, "200 × 35%");
  assert.equal((await civilWarOf(inc.id))!.rebelIdeology, "red");
});

test("爆發:沒有土地可切 → 不爆發,也不留下孤兒革命方或戰爭", async () => {
  const inc = await mkNation("absolute_monarchy");
  const before = (await db.select({ c: sql<number>`count(*)::int` }).from(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`)))[0]!.c;
  const r = await start(inc, "red");
  assert.deepEqual(r, { started: false, reason: "no_territory" });
  const after = (await db.select({ c: sql<number>`count(*)::int` }).from(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`)))[0]!.c;
  assert.equal(after, before);
  assert.equal(await civilWarOf(inc.id), undefined);
});

test("爆發:同一原政權同時只會有一場內戰(第二次不重複切地)", async () => {
  const inc = await mkNation("parliamentary_republic");
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  assert.ok((await start(inc, "parliament")).started);
  const landAfterFirst = await landSum(inc.id);
  assert.deepEqual(await start(inc, "red"), { started: false, reason: "already_civil_war" });
  assert.equal(await landSum(inc.id), landAfterFirst);
});

// ── 結算 ───────────────────────────────────────────────
test("進行中:雙方都有土地 → 不結算", async () => {
  const inc = await mkNation("parliamentary_republic");
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  await start(inc, "parliament");
  await settleCivilWars();
  assert.equal((await civilWarOf(inc.id))!.endedAt, null);
});

test("革命方勝(紅):NPC 原政權被推翻 → 革命方(NPC)改制為委員會制、保有土地、穩定 -10", async () => {
  const inc = await mkNation("absolute_monarchy", true, { stability: 50 });
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(inc, "red");
  assert.ok(r.started); if (!r.started) return;
  const rebelLand = await landSum(r.rebelNationId);
  await setLand(inc.id, []); // 原政權被打光
  const s = await settleCivilWars();
  assert.ok(s.rebelWon >= 1);
  const win = (await reload(r.rebelNationId))!;
  assert.equal(win.government, governmentLabel("council_system"), "勝方(革命方)改制");
  assert.equal(await landSum(r.rebelNationId), rebelLand, "勝方保有自己的土地");
  assert.notEqual((await civilWarOf(inc.id))!.endedAt, null);
  assert.equal((await civilWarOf(inc.id))!.loserNationId, inc.id, "記下敗方");
});

test("革命方勝(黑):革命方改制為軍事獨裁", async () => {
  const inc = await mkNation("parliamentary_republic", true);
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(inc, "black");
  assert.ok(r.started); if (!r.started) return;
  await setLand(inc.id, []);
  await settleCivilWars();
  assert.equal((await reload(r.rebelNationId))!.government, governmentLabel("military_dictatorship"));
});

test("原政權勝:政體不變、穩定 +10(上限100)、革命方被消滅", async () => {
  const inc = await mkNation("parliamentary_republic", false, { stability: 95 });
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(inc, "parliament");
  assert.ok(r.started); if (!r.started) return;
  await setLand(r.rebelNationId, []); // 革命軍被打光
  const s = await settleCivilWars();
  assert.ok(s.incumbentWon >= 1);
  const after = (await reload(inc.id))!;
  assert.equal(after.government, governmentLabel("parliamentary_republic"));
  assert.equal(after.stability, 100);
  assert.notEqual((await civilWarOf(inc.id))!.endedAt, null);
});

test("結算可重跑且不重複:已結束的內戰再跑一次,不會再次改制或扣穩定度", async () => {
  const inc = await mkNation("absolute_monarchy", true, { stability: 50 });
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(inc, "red");
  assert.ok(r.started); if (!r.started) return;
  await setLand(inc.id, []);
  await settleCivilWars();
  const once = (await reload(r.rebelNationId))!;
  await settleCivilWars(); await settleCivilWars();
  const thrice = (await reload(r.rebelNationId))!;
  assert.equal(thrice.stability, once.stability);
  assert.equal(thrice.government, once.government);
});

test("併發結算:兩個同時跑,只會結算一次(原子認領)", async () => {
  const inc = await mkNation("absolute_monarchy", true, { stability: 50 });
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(inc, "red");
  assert.ok(r.started); if (!r.started) return;
  const before = (await reload(r.rebelNationId))!.stability;
  await setLand(inc.id, []);
  await Promise.all([settleCivilWars(), settleCivilWars(), settleCivilWars()]);
  assert.equal((await reload(r.rebelNationId))!.stability, before - 10, "只扣一次 -10,不是 -30");
});

// ── 與 NPC 除名的順序(這是整個機制最容易出事的地方)──────────────
test("順序正確:先結算內戰、再除名 → 勝利被正確領取,敗方 NPC 之後乾淨消失", async () => {
  const inc = await mkNation("absolute_monarchy", true, { stability: 50 });
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(inc, "red");
  assert.ok(r.started); if (!r.started) return;
  await setLand(inc.id, []);
  await settleCivilWars();
  await runNpcExtinctionCheck();
  assert.equal((await reload(r.rebelNationId))!.government, governmentLabel("council_system"), "勝利已結算");
  assert.equal(await reload(inc.id), undefined, "敗方 NPC(原政權)已被除名");
  assert.ok((await landSum(r.rebelNationId)) > 0, "勝方保有土地");
});

test("反例(證明順序必要):若先除名,革命方被刪時戰爭列跟著消失", async () => {
  const inc = await mkNation("parliamentary_republic");
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(inc, "parliament");
  assert.ok(r.started); if (!r.started) return;
  await setLand(r.rebelNationId, []); // 革命方土地歸零 → 會被除名
  await runNpcExtinctionCheck();
  assert.equal(await reload(r.rebelNationId), undefined);
  assert.equal(await civilWarOf(inc.id), undefined, "戰爭列被 CASCADE 刪除,沒人能領取勝利結算");
});

// ── 與既有議會革命的銜接 ──────────────────────────────────
test("applyRevolution(議會革命)現在產生真正不可停戰的內戰", async () => {
  const inc = await mkNation("parliamentary_republic");
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  await applyRevolution(inc, 1, "parliament");
  const w = (await civilWarOf(inc.id))!;
  assert.equal(w.isCivilWar, true); assert.equal(w.rebelIdeology, "parliament");
});

test("applyRevolution(軍方叛變)= 黑線內戰", async () => {
  const inc = await mkNation("parliamentary_republic");
  await setLand(inc.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  await applyRevolution(inc, 1, "military");
  assert.equal((await civilWarOf(inc.id))!.rebelIdeology, "black");
});

test("applyRevolution:沒土地可切 → 後備處置仍是更替政體(維持原行為),且記日誌", async () => {
  const inc = await mkNation("parliamentary_republic");
  await applyRevolution(inc, 1, "parliament");
  assert.equal(await civilWarOf(inc.id), undefined);
  assert.equal((await reload(inc.id))!.government, governmentLabel("absolute_monarchy"));
  const logs = await db.select().from(parliamentLogTable).where(eq(parliamentLogTable.nationId, inc.id));
  assert.ok(logs.some((l) => l.kind === "revolution"));
});

// ── 玩家發動革命(玩家 = 革命方)──────────────────────────
const startAsRebel = (nation: NationRow, ideology: "black" | "red" | "parliament" = "red") =>
  db.transaction((tx) => startCivilWar(tx, nation, ideology, 1, "共產革命", "rebel"));
const exists = async (id: string) => (await reload(id)) !== undefined;

test("玩家革命爆發:玩家只留 35%,其餘 65% 歸新建的 NPC 舊政權,政體不變", async () => {
  const me = await mkNation("absolute_monarchy");
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]); // 200
  const r = await startAsRebel(me);
  assert.ok(r.started); if (!r.started) return;
  assert.equal(r.rebelNationId, me.id, "玩家本人是革命方");
  assert.equal(await landSum(me.id), 70, "200 × 35%");
  const w = (await civilWarOf(me.id))!;
  assert.equal(w.isCivilWar, true); assert.equal(w.rebelNationId, me.id); assert.equal(w.rebelIdeology, "red");
  const otherId = w.nationAId === me.id ? w.nationBId : w.nationAId;
  const old = (await reload(otherId))!;
  assert.equal(old.isNpc, true, "舊政權是新建的 NPC");
  assert.equal(old.government, me.government, "舊政權沿用玩家原本的政體");
  assert.equal(await landSum(otherId), 130, "200 × 65%");
  assert.equal((await reload(me.id))!.government, me.government, "打贏之前玩家政體不變");
});

test("玩家革命贏:玩家改制委員會制、保有身分、舊政權 NPC 被除名", async () => {
  const me = await mkNation("absolute_monarchy", false, { stability: 50 });
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await startAsRebel(me);
  assert.ok(r.started); if (!r.started) return;
  const w = (await civilWarOf(me.id))!;
  const oldId = w.nationAId === me.id ? w.nationBId : w.nationAId;
  await setLand(oldId, []); // 舊政權被打光
  const s = await settleCivilWars();
  assert.ok(s.rebelWon >= 1);
  const after = (await reload(me.id))!;
  assert.equal(after.government, governmentLabel("council_system"));
  assert.equal(after.stability, 40);
  assert.equal(after.discordUserId, me.discordUserId, "玩家身分延續");
  assert.equal(w.id, (await civilWarOf(me.id))!.id);
  await runNpcExtinctionCheck();
  assert.equal(await exists(oldId), false, "舊政權 NPC 已被除名");
  assert.equal(await exists(me.id), true);
});

test("玩家革命輸:視同被消滅,玩家國被刪(回建國畫面),勝方 NPC 不被改制", async () => {
  const me = await mkNation("absolute_monarchy");
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await startAsRebel(me);
  assert.ok(r.started); if (!r.started) return;
  const w = (await civilWarOf(me.id))!;
  const oldId = w.nationAId === me.id ? w.nationBId : w.nationAId;
  const oldGov = (await reload(oldId))!.government;
  await setLand(me.id, []); // 玩家被打光
  const s = await settleCivilWars();
  assert.ok(s.incumbentWon >= 1);
  assert.ok(s.playersEliminated >= 1);
  assert.equal(await exists(me.id), false, "玩家國已刪除,前端查不到國家 = 回建國畫面");
  const winner = (await reload(oldId))!;
  assert.equal(winner.government, oldGov, "勝方 NPC 政體不變");
  assert.equal(winner.stability, 60, "勝方穩定 +10");
});

test("玩家被消滅後,帳號可以重新建國(discord_user_id 已釋出)", async () => {
  const me = await mkNation("absolute_monarchy");
  const uid = me.discordUserId!;
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  await startAsRebel(me);
  await setLand(me.id, []);
  await settleCivilWars();
  assert.equal(await exists(me.id), false);
  const [again] = await db.insert(playerNationsTable).values({
    discordUserId: uid, name: `${MARK}${run}re${n++}`, leaderName: "t", government: governmentLabel("absolute_monarchy")!,
  } as never).returning();
  assert.ok(again, "同一個 Discord 帳號可再建國");
});

test("玩家是原政權而輸(NPC 革命方贏):同樣被消滅,NPC 革命方不被刪也不改制給玩家", async () => {
  const me = await mkNation("parliamentary_republic");
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(me, "parliament");
  assert.ok(r.started); if (!r.started) return;
  await setLand(me.id, []);
  await settleCivilWars();
  assert.equal(await exists(me.id), false, "玩家原政權被推翻 = 被消滅");
  const winner = (await reload(r.rebelNationId))!;
  assert.equal(winner.government, governmentLabel("parliamentary_republic"), "革命方(NPC)依意識形態改制");
});

test("注意:這與先前行為不同——玩家原政權被革命方推翻,現在是『被消滅』而非『改制後繼續玩』", async () => {
  // 先前(bcc2ff1)玩家原政權輸會被改制保留;定案後改為一律視同被消滅。此測試鎖住新規則。
  const me = await mkNation("absolute_monarchy");
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  assert.ok((await start(me, "red")).started);
  await setLand(me.id, []);
  await settleCivilWars();
  assert.equal(await exists(me.id), false);
});

// ── 自癒掃描 ────────────────────────────────────────────
test("自癒:內戰已標記結束但敗方玩家還在(程序中斷)→ 下次結算補做淘汰", async () => {
  const me = await mkNation("absolute_monarchy");
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  await startAsRebel(me);
  const w = (await civilWarOf(me.id))!;
  // 模擬:戰爭已結束並記下敗方 = me,但刪國沒做成
  await db.update(diplomacyWarsTable).set({ endedAt: new Date(), loserNationId: me.id }).where(eq(diplomacyWarsTable.id, w.id));
  assert.equal(await exists(me.id), true);
  await settleCivilWars();
  assert.equal(await exists(me.id), false, "被補做淘汰");
});

test("自癒不誤殺:內戰勝方玩家日後在別場戰爭失光土地,不會被當成內戰敗方刪掉", async () => {
  const me = await mkNation("absolute_monarchy");
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  await startAsRebel(me);
  const w = (await civilWarOf(me.id))!;
  const oldId = w.nationAId === me.id ? w.nationBId : w.nationAId;
  await setLand(oldId, []);
  await settleCivilWars(); // 玩家勝
  assert.equal(await exists(me.id), true);
  await setLand(me.id, []); // 之後他在別處失去所有土地
  await settleCivilWars(); await settleCivilWars();
  assert.equal(await exists(me.id), true, "他是勝方,不該被內戰自癒掃描淘汰");
});

test("自癒不誤殺:戰爭列記錄的敗方是 NPC 時,掃描不碰任何玩家", async () => {
  const me = await mkNation("parliamentary_republic");
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  const r = await start(me, "parliament");
  assert.ok(r.started); if (!r.started) return;
  await setLand(r.rebelNationId, []);
  await settleCivilWars();
  assert.equal((await civilWarOf(me.id))!.loserNationId, r.rebelNationId);
  await setLand(me.id, []);
  await settleCivilWars();
  assert.equal(await exists(me.id), true);
});

test("玩家革命:沒有土地可切 / 已在內戰中 → 不爆發", async () => {
  const me = await mkNation("absolute_monarchy");
  assert.deepEqual(await startAsRebel(me), { started: false, reason: "no_territory" });
  await setLand(me.id, [[regionIds[0]!, 100], [regionIds[1]!, 100]]);
  assert.ok((await startAsRebel(me)).started);
  assert.deepEqual(await startAsRebel(me), { started: false, reason: "already_civil_war" });
});

test("玩家革命:只有一塊地也能發動(留 35%、舊政權拿 65%)", async () => {
  const me = await mkNation("absolute_monarchy");
  await setLand(me.id, [[regionIds[0]!, 100]]);
  const r = await startAsRebel(me);
  assert.ok(r.started);
  assert.equal(await landSum(me.id), 35);
});
