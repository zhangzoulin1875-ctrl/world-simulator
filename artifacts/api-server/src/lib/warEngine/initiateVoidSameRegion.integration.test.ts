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

const { eq, inArray, and, notInArray } = await import("drizzle-orm");
const {
  db,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  warRegionCooldownsTable,
} = await import("@workspace/db");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { initiateCampaign } = await import("./initiate");

const runId = randomBytes(4).toString("hex");
let playerId: string;
const createdNpcIds: string[] = [];
const usedRegions: number[] = [];
const baseline = anthropic.messages.create;

const NPC_UNIT_SET_STUB_TEXT = JSON.stringify(
  (["infantry", "ranged", "armor", "artillery", "ship"] as const).map(
    (category) => ({
      category,
      name: `測試樁兵種-${category}`,
      description: "測試樁兵種：數值貼齊預設基準，僅供整合測試決定性使用。",
      hp: 100,
      attack: 100,
      defense: 10,
      speed: 1,
      accuracy: 80,
      range:
        category === "ranged" || category === "artillery" || category === "ship"
          ? "ranged"
          : "melee",
      antiCavalryPct: 0,
      antiRangedPct: 0,
      antiArtilleryPct: 0,
      siegePct: 0,
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 1,
      upkeepPerUnit: 0.1,
      prodUpkeepPerUnit: 0.1,
      woodCostPerUnit: 0,
      oreCostPerUnit: 0,
    }),
  ),
);

before(() => {
  anthropic.messages.create = (async (params: { system?: unknown }) => {
    const system = typeof params?.system === "string" ? params.system : "";
    if (system.includes("兵種設計 AI")) {
      return { content: [{ type: "text", text: NPC_UNIT_SET_STUB_TEXT }] };
    }
    return { content: [{ type: "text", text: "地形敘述測試".repeat(10) }] };
  }) as unknown as typeof anthropic.messages.create;
});

async function spareRegion(): Promise<number> {
  const taken = (await db.select({ id: regionControlsTable.regionId }).from(regionControlsTable)).map((r) => r.id);
  const cooled = (await db.select({ id: warRegionCooldownsTable.regionId }).from(warRegionCooldownsTable)).map((r) => r.id);
  const skip = [...new Set([...taken, ...cooled, ...usedRegions])];
  const [row] = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .where(skip.length ? notInArray(mapRegionsTable.id, skip) : undefined)
    .limit(1);
  assert.ok(row, "需要一塊無人控制的地區");
  usedRegions.push(row.id);
  return row.id;
}

before(async () => {
  const [p] = await db
    .insert(playerNationsTable)
    .values({ discordUserId: `iv-${runId}`, name: `iv-player-${runId}`, isNpc: false })
    .returning({ id: playerNationsTable.id });
  playerId = p!.id;
});

after(async () => {
  anthropic.messages.create = baseline;
  if (usedRegions.length) {
    await db.delete(warRegionCooldownsTable).where(inArray(warRegionCooldownsTable.regionId, usedRegions));
  }
  const ids = [playerId, ...createdNpcIds];
  await db.delete(playerNationsTable).where(inArray(playerNationsTable.id, ids));
});

for (const mode of ["undefined", "null"] as const) {
  test(`玩家只佔 48%、其餘 52% 無人持有：就地爭奪建立 NPC 並取得 52%（defenderNationId=${mode}）`, async () => {
    const region = await spareRegion();
    await db.insert(regionControlsTable).values({ regionId: region, nationId: playerId, percent: 48 });

    const campaign = await initiateCampaign({
      attackerNationId: playerId,
      attackerRegionId: region,
      defenderRegionId: region,
      ...(mode === "null" ? { defenderNationId: null } : {}),
    });
    createdNpcIds.push(campaign.defenderNationId);
    assert.equal(campaign.attackerRegionId, region);
    assert.equal(campaign.defenderRegionId, region);

    const controls = await db.select().from(regionControlsTable).where(eq(regionControlsTable.regionId, region));
    const npc = controls.find((c) => c.nationId === campaign.defenderNationId);
    assert.equal(npc?.percent, 52, "新 NPC 應持有剩餘 52%");
    assert.equal(controls.find((c) => c.nationId === playerId)?.percent, 48, "玩家 48% 不變");
    assert.equal(controls.reduce((s, c) => s + c.percent, 0), 100);
  });
}

test("就地爭奪若 NPC 兵種設計失敗(409)：不可留下孤兒 NPC 佔住剩餘空白", async () => {
  const region = await spareRegion();
  await db.insert(regionControlsTable).values({ regionId: region, nationId: playerId, percent: 48 });
  const prev = anthropic.messages.create;
  anthropic.messages.create = (async () => {
    throw new Error("AI down");
  }) as unknown as typeof anthropic.messages.create;
  try {
    await assert.rejects(() =>
      initiateCampaign({
        attackerNationId: playerId,
        attackerRegionId: region,
        defenderRegionId: region,
        defenderNationId: null,
      }),
    );
  } finally {
    anthropic.messages.create = prev;
  }
  const controls = await db.select().from(regionControlsTable).where(eq(regionControlsTable.regionId, region));
  const total = controls.reduce((s, c) => s + c.percent, 0);
  for (const c of controls) if (c.nationId !== playerId) createdNpcIds.push(c.nationId);
  assert.equal(total, 48, `失敗後空白必須還給玩家可再爭奪（目前合計 ${total}%）`);
});

const { cleanupOrphanWildNpcs } = await import("../npcExtinction");
const { diplomacyWarsTable } = await import("@workspace/db");

test("cleanupOrphanWildNpcs：清掉無戰爭的孤兒野生 NPC，不碰有戰爭的、自然 NPC、寬限期內者", async () => {
  const region = await spareRegion();
  await db.insert(regionControlsTable).values({ regionId: region, nationId: playerId, percent: 48 });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const mk = async (name: string, origin: string, createdAt: Date) => {
    const [n] = await db
      .insert(playerNationsTable)
      .values({ name: `${name}-${runId}`, isNpc: true, npcOrigin: origin, createdAt })
      .returning({ id: playerNationsTable.id });
    createdNpcIds.push(n!.id);
    return n!.id;
  };
  const orphan = await mk("orphan", "wild", old);
  const atWar = await mk("atwar", "wild", old);
  const natural = await mk("natural", "natural", old);
  const fresh = await mk("fresh", "wild", new Date());
  // diplomacy_wars 有 nation_a < nation_b 的排序約束，UUID 隨機，須排序後插入。
  await db.insert(diplomacyWarsTable).values({
    nationAId: playerId < atWar ? playerId : atWar,
    nationBId: playerId < atWar ? atWar : playerId,
    declaredByNationId: playerId,
  });
  await db.insert(regionControlsTable).values({ regionId: region, nationId: orphan, percent: 52 });

  const res = await cleanupOrphanWildNpcs();
  assert.ok(res.deletedIds.includes(orphan), "孤兒應被清除");
  for (const keep of [atWar, natural, fresh]) {
    assert.ok(!res.deletedIds.includes(keep), `${keep} 不應被清除`);
    const [row] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, keep));
    assert.ok(row, "應仍存在");
  }
  const left = await db.select().from(regionControlsTable).where(eq(regionControlsTable.regionId, region));
  assert.equal(left.reduce((s, c) => s + c.percent, 0), 48, "空白還給玩家");
});
