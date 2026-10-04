import { strict as assert } from "node:assert";
import test, { before, after } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5433/postgres";
}
if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "https://stub.invalid/v1";
}
if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "x";
}

const { eq, sql } = await import("drizzle-orm");
const {
  db,
  playerNationsTable,
  generalsTable,
  generalDrawsTable,
  generalPoolTable,
} = await import("@workspace/db");
const { runGeneralsMigrations } = await import("./generalsMigrations");
const { getEraSlugs, computeAdjustedNationStats } = await import("./nationStats");
const { loadDominantCultureProfile, takeGeneralFromPool } = await import("./generalAi");
const { loadCurrentTurnRecruitSpend } = await import("./recruitSpend");
const { computeAvailableProduction } = await import("./economy");
const { drawCost } = await import("./generals");

const runId = randomBytes(4).toString("hex");
const userId = `drawtest-${runId}`;
let nationId: string;

const CURRENT_TURN_PREDICATE = sql`(
  (SELECT last_turn_at FROM world_game_state WHERE id = 1) IS NULL
  OR ${generalDrawsTable.createdAt} >
     (SELECT last_turn_at FROM world_game_state WHERE id = 1)
)`;

async function hasDrawnThisTurn(nid: string): Promise<boolean> {
  const [row] = await db
    .select({ id: generalDrawsTable.id })
    .from(generalDrawsTable)
    .where(
      sql`${eq(generalDrawsTable.ownerNationId, nid)} AND ${eq(
        generalDrawsTable.kind,
        "draw",
      )} AND ${CURRENT_TURN_PREDICATE}`,
    )
    .limit(1);
  return row !== undefined;
}

before(async () => {
  await runGeneralsMigrations();
  const [n] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: userId,
      name: `drawtest-${runId}`,
      leaderName: "Leader",
      government: "君主制",
      money: 100000,
    })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
});

after(async () => {
  if (nationId) {
    await db.delete(generalsTable).where(eq(generalsTable.ownerNationId, nationId));
    await db.delete(generalDrawsTable).where(eq(generalDrawsTable.ownerNationId, nationId));
    await db.delete(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  }
});

test("Step-by-step general draw process execution", async () => {
  console.log("=== Testing Step 1: hasDrawnThisTurn ===");
  const drawn = await hasDrawnThisTurn(nationId);
  console.log("drawn:", drawn);
  assert.equal(drawn, false);

  console.log("=== Testing Step 2: getEraSlugs ===");
  const { currentEra, statsEra } = await getEraSlugs();
  console.log("currentEra:", currentEra, "statsEra:", statsEra);

  console.log("=== Testing Step 3: loadDominantCultureProfile ===");
  const cultureProfile = await loadDominantCultureProfile(nationId);
  console.log("cultureProfile:", cultureProfile);

  console.log("=== Testing Step 4: costSnapshot ===");
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  const stats = await computeAdjustedNationStats(nation!, statsEra);
  const currentTurnSpend = await loadCurrentTurnRecruitSpend(nationId);
  const availableProd = computeAvailableProduction({
    production: stats.production,
    productionSpent: nation!.productionSpent,
    currentTurnSpend,
  });
  const cost = drawCost(nation!.money, availableProd);
  console.log("cost:", cost, "availableProd:", availableProd);

  console.log("=== Testing Step 5: Transaction ===");
  await db.transaction(async (t) => {
    const updated = await t
      .update(playerNationsTable)
      .set({ money: sql`${playerNationsTable.money} - ${cost.money}` })
      .where(
        sql`${eq(playerNationsTable.id, nationId)} AND ${playerNationsTable.money} >= ${cost.money}`,
      )
      .returning();
    assert.equal(updated.length, 1);

    const [dup] = await t
      .select({ id: generalDrawsTable.id })
      .from(generalDrawsTable)
      .where(
        sql`${eq(generalDrawsTable.ownerNationId, nationId)} AND ${eq(
          generalDrawsTable.kind,
          "draw",
        )} AND ${CURRENT_TURN_PREDICATE}`,
      )
      .limit(1);
    assert.equal(dup, undefined);

    await t.insert(generalDrawsTable).values({
      ownerNationId: nationId,
      kind: "draw",
      moneySpent: cost.money,
      productionSpent: cost.production,
    });

    const spent = await loadCurrentTurnRecruitSpend(nationId, t);
    const available = computeAvailableProduction({
      production: stats.production,
      productionSpent: nation!.productionSpent,
      currentTurnSpend: spent,
    });
    console.log("Transaction inner available production:", available);
  });
  console.log("Transaction succeeded!");

  console.log("=== Testing Step 6: takeGeneralFromPool ===");
  const card = await takeGeneralFromPool({ eraSlug: currentEra, cultureProfile });
  console.log("card from pool:", card);

  console.log("=== Testing Step 7: insert(generalsTable) ===");
  const category = card?.category ?? "infantry";
  const [created] = await db
    .insert(generalsTable)
    .values({
      ownerNationId: nationId,
      name: card?.name ?? "（生成中…）",
      title: card?.title ?? "",
      background: card?.background ?? "",
      category,
      grade: 1,
      status: card ? "candidate" : "generating",
      skills: card?.skills ?? [],
      eraSlug: currentEra,
    })
    .returning();
  console.log("created general:", created);
});
