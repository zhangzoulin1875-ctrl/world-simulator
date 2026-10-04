import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const { eq, like, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, generalDrawsTable } = await import("@workspace/db");
const { runGeneralsMigrations } = await import("./generalsMigrations");

const MARK = "__drawbig__";
const runId = randomBytes(3).toString("hex");
let nationId: string;

before(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await runGeneralsMigrations();
  const [n] = await db.insert(playerNationsTable)
    .values({ discordUserId: `db-${runId}`, name: `${MARK}${runId}`, leaderName: "t", government: "君主制" })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
});
after(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("富國抽取費用（兆級）可寫入 general_draws，不再 integer 溢位", async () => {
  // 線上實際失敗的數值：3,383,838,238,854 金錢 / 22,555,329 生產力。
  await db.insert(generalDrawsTable).values({
    ownerNationId: nationId, kind: "draw", moneySpent: 3_383_838_238_854, productionSpent: 22_555_329,
  });
  const [row] = await db.select().from(generalDrawsTable).where(eq(generalDrawsTable.ownerNationId, nationId));
  assert.equal(row!.moneySpent, 3_383_838_238_854);
  assert.equal(row!.productionSpent, 22_555_329);
});

test("遷移把舊 integer 欄位就地升級為 bigint，且可重跑", async () => {
  await db.execute(sql`ALTER TABLE general_draws ALTER COLUMN money_spent TYPE integer USING 0, ALTER COLUMN production_spent TYPE integer USING 0`);
  await runGeneralsMigrations();
  await runGeneralsMigrations(); // 冪等
  const r = await db.execute(sql`SELECT data_type FROM information_schema.columns WHERE table_name='general_draws' AND column_name IN ('money_spent','production_spent')`);
  assert.deepEqual((r.rows as Array<{ data_type: string }>).map((x) => x.data_type), ["bigint", "bigint"]);
});
