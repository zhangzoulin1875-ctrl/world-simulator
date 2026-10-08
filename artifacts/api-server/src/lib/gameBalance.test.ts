import { after, test } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  DEFAULT_GAME_BALANCE_SETTINGS,
  applyModifierSource,
  applyWarOrderPenalties,
  clampUnitDesign,
  computeBacklashExtraCasualties,
  prodCostPowerFloor,
  enrichAbuseRecordActors,
  getGameBalanceSettings,
  saveGameBalanceSettings,
  scaleConstructionCost,
  type GameBalanceSettings,
  type UnitCategoryAverages,
  type UnitDesignStats,
  type WarOrderFlag,
  type WarPenaltyTarget,
} from "./gameBalance";
import {
  UnitDesignRejectedError,
  designCustomUnit,
  designNpcUnitSet,
} from "./militaryAi";
import { gameBalanceSettingsSchema } from "./gameBalance";
import { FOOD_ERA_INDEX } from "./food";
import { ERAS } from "./mapRegionEras";
import {
  aiAbuseRecordsTable,
  db,
  gameBalanceSettingsTable,
  militaryUnitTemplatesTable,
  playerNationsTable,
  pool,
  userSessionsTable,
} from "@workspace/db";
import { and, eq, like, lt, sql } from "drizzle-orm";

function settingsWith(
  patch: (s: GameBalanceSettings) => void,
): GameBalanceSettings {
  const s = structuredClone(DEFAULT_GAME_BALANCE_SETTINGS);
  patch(s);
  return s;
}

const AVERAGES: UnitCategoryAverages = {
  hp: 100,
  attack: 100,
  defense: 10,
  speed: 1,
  woodCost: 1,
  oreCost: 1,
  upkeep: 0.5,
  prodUpkeep: 0.5,
  count: 10,
};

function baseDesign(overrides?: Partial<UnitDesignStats>): UnitDesignStats {
  return {
    hp: 120,
    attack: 130,
    defense: 12,
    speed: 1,
    prodCostPer100: 5,
    popCostPerUnit: 1,
    moneyCostPerUnit: 10,
    upkeepPerUnit: 0.5,
    prodUpkeepPerUnit: 0.5,
    woodCostPerUnit: 1,
    oreCostPerUnit: 2,
    ...overrides,
  };
}

// ── clampUnitDesign ─────────────────────────────────────────────

test("clampUnitDesign: within limits → untouched, no clamps", () => {
  const settings = DEFAULT_GAME_BALANCE_SETTINGS;
  const design = baseDesign();
  const { design: out, clamps } = clampUnitDesign(
    design,
    "infantry",
    AVERAGES,
    settings,
  );
  assert.deepEqual(out, design);
  assert.equal(clamps.length, 0);
});

test("clampUnitDesign: caps combat stats at category average × multiplier", () => {
  const settings = settingsWith((s) => {
    s.unitDesign.multiplierCaps.infantry = 3;
  });
  const design = baseDesign({ hp: 999_999, attack: 999_999, speed: 500 });
  const { design: out, clamps } = clampUnitDesign(
    design,
    "infantry",
    AVERAGES,
    settings,
  );
  assert.equal(out.hp, 300);
  assert.equal(out.attack, 300);
  assert.equal(out.speed, 3);
  assert.ok(clamps.length >= 3);
});

test("clampUnitDesign: zero samples → only absolute caps apply", () => {
  const settings = settingsWith((s) => {
    s.unitDesign.multiplierCaps.air = 2;
    s.unitDesign.hpMax = 1000;
  });
  const empty: UnitCategoryAverages = {
    woodCost: 0,
    oreCost: 0,
    upkeep: 0,
    prodUpkeep: 0,
    hp: 0,
    attack: 0,
    defense: 0,
    speed: 0,
    count: 0,
  };
  const design = baseDesign({ hp: 5000 });
  const { design: out } = clampUnitDesign(design, "air", empty, settings);
  assert.equal(out.hp, 1000);
});

test("clampUnitDesign: cost floors prevent free super-units", () => {
  const settings = settingsWith((s) => {
    s.unitDesign.moneyCostMin = 50;
    s.unitDesign.popCostMin = 2;
    s.unitDesign.upkeepMin = 1;
  });
  const design = baseDesign({
    moneyCostPerUnit: 1,
    popCostPerUnit: 0,
    upkeepPerUnit: 0,
    prodUpkeepPerUnit: 0,
  });
  const { design: out, clamps } = clampUnitDesign(
    design,
    "infantry",
    AVERAGES,
    settings,
  );
  assert.equal(out.moneyCostPerUnit, 50);
  assert.equal(out.popCostPerUnit, 2);
  assert.equal(out.upkeepPerUnit, 1);
  assert.equal(out.prodUpkeepPerUnit, 1);
  assert.ok(clamps.length >= 4);
});

// Task #471 — 木材／礦石成本上限。
test("clampUnitDesign: caps wood/ore cost at admin max with zh-TW clamp notes", () => {
  const settings = settingsWith((s) => {
    s.unitDesign.woodCostMax = 100;
    s.unitDesign.oreCostMax = 50;
  });
  const design = baseDesign({ woodCostPerUnit: 9999, oreCostPerUnit: 8888 });
  const { design: out, clamps } = clampUnitDesign(
    design,
    "infantry",
    AVERAGES,
    settings,
  );
  assert.equal(out.woodCostPerUnit, 100);
  assert.equal(out.oreCostPerUnit, 50);
  assert.ok(clamps.some((c) => c.includes("木材成本 9999 → 100")));
  assert.ok(clamps.some((c) => c.includes("礦石成本 8888 → 50")));
});

test("clampUnitDesign: wood/ore within caps → untouched", () => {
  const settings = settingsWith((s) => {
    s.unitDesign.woodCostMax = 100;
    s.unitDesign.oreCostMax = 50;
  });
  const design = baseDesign({ woodCostPerUnit: 100, oreCostPerUnit: 0 });
  const { design: out, clamps } = clampUnitDesign(
    design,
    "infantry",
    AVERAGES,
    settings,
  );
  assert.equal(out.woodCostPerUnit, 100);
  assert.equal(out.oreCostPerUnit, 0);
  assert.equal(
    clamps.filter((c) => c.includes("木材") || c.includes("礦石")).length,
    0,
  );
});

test("clampUnitDesign: woodCostMax 0 → 可完全禁用木材成本", () => {
  const settings = settingsWith((s) => {
    s.unitDesign.woodCostMax = 0;
  });
  const design = baseDesign({ woodCostPerUnit: 3 });
  const { design: out, clamps } = clampUnitDesign(
    design,
    "infantry",
    AVERAGES,
    settings,
  );
  assert.equal(out.woodCostPerUnit, 0);
  assert.ok(clamps.some((c) => c.includes("木材成本 3 → 0")));
});

// Task #572 — prodCostPer100 戰力比例下限。
test("prodCostPowerFloor: 基準步兵=1、艦船級≈29、零值保底 1", () => {
  assert.equal(prodCostPowerFloor(100, 100, 10), 1); // 210 / 210
  assert.equal(prodCostPowerFloor(150, 200, 5), 2); // 騎兵基準 355 → 2（< 公平價 10）
  assert.equal(prodCostPowerFloor(5000, 1000, 20), 29); // 艦船基準 6020 → 29（< 公平價 100）
  assert.equal(prodCostPowerFloor(0, 0, 0), 1);
  assert.equal(prodCostPowerFloor(-5, -5, -5), 1);
});

test("clampUnitDesign: 高戰力兵種標近乎免費 → 調升到戰力下限（zh-TW 說明）", () => {
  const settings = settingsWith((s) => {
    s.unitDesign.hpMax = 10_000;
    s.unitDesign.attackMax = 10_000;
  });
  const empty: UnitCategoryAverages = {
    hp: 0,
    attack: 0,
    defense: 0,
    speed: 0,
    woodCost: 0,
    oreCost: 0,
    upkeep: 0,
    prodUpkeep: 0,
    count: 0,
  };
  const design = baseDesign({
    hp: 4800,
    attack: 950,
    defense: 20,
    prodCostPer100: 1,
  });
  const { design: out, clamps } = clampUnitDesign(
    design,
    "ship",
    empty,
    settings,
  );
  assert.equal(out.prodCostPer100, prodCostPowerFloor(4800, 950, 20));
  assert.ok(clamps.some((c) => c.includes("生產力成本 1 →")));
});

test("clampUnitDesign: prodCostPer100 高於戰力下限 → 原樣保留", () => {
  const design = baseDesign({ prodCostPer100: 5 }); // 262 戰力 → 下限 2
  const { design: out, clamps } = clampUnitDesign(
    design,
    "infantry",
    AVERAGES,
    DEFAULT_GAME_BALANCE_SETTINGS,
  );
  assert.equal(out.prodCostPer100, 5);
  assert.equal(clamps.filter((c) => c.includes("生產力成本")).length, 0);
});

// ── applyWarOrderPenalties ──────────────────────────────────────

function penaltyTarget(): WarPenaltyTarget {
  return {
    attacker: { legions: [{ aggressionPct: 80 }, { aggressionPct: 60 }] },
    defender: { legions: [{ aggressionPct: 40 }] },
  };
}

test("applyWarOrderPenalties: no flags → no changes", () => {
  const result = penaltyTarget();
  const out = applyWarOrderPenalties(result, [], DEFAULT_GAME_BALANCE_SETTINGS);
  assert.deepEqual(out.penalizedSides, []);
  assert.equal(result.attacker.legions[0]!.aggressionPct, 80);
});

test("applyWarOrderPenalties: review disabled → no penalty even with flags", () => {
  const settings = settingsWith((s) => {
    s.war.reviewEnabled = false;
  });
  const result = penaltyTarget();
  const flags: WarOrderFlag[] = [
    { side: "attacker", orderType: "assault", kind: "exploit", reason: "x" },
  ];
  const out = applyWarOrderPenalties(result, flags, settings);
  assert.deepEqual(out.penalizedSides, []);
  assert.equal(result.attacker.legions[0]!.aggressionPct, 80);
});

test("applyWarOrderPenalties: flagged side aggression halved by penalty pct", () => {
  const settings = settingsWith((s) => {
    s.war.penaltyAggressionPct = 50;
  });
  const result = penaltyTarget();
  const flags: WarOrderFlag[] = [
    {
      side: "attacker",
      orderType: "assault",
      kind: "unreasonable",
      reason: "x",
    },
  ];
  const out = applyWarOrderPenalties(result, flags, settings);
  assert.deepEqual(out.penalizedSides, ["attacker"]);
  assert.equal(result.attacker.legions[0]!.aggressionPct, 40);
  assert.equal(result.attacker.legions[1]!.aggressionPct, 30);
  // Defender untouched.
  assert.equal(result.defender.legions[0]!.aggressionPct, 40);
});

test("applyWarOrderPenalties: attacker exploit → quarter aggression (Task #625 — territory shift is now deterministic)", () => {
  const settings = settingsWith((s) => {
    s.war.penaltyAggressionPct = 50;
  });
  const result = penaltyTarget();
  const flags: WarOrderFlag[] = [
    { side: "attacker", orderType: "assault", kind: "exploit", reason: "x" },
  ];
  applyWarOrderPenalties(result, flags, settings);
  // 50% halved again for exploit → 25%.
  assert.equal(result.attacker.legions[0]!.aggressionPct, 20);
  assert.equal(result.attacker.legions[1]!.aggressionPct, 15);
  // Defender untouched.
  assert.equal(result.defender.legions[0]!.aggressionPct, 40);
});

// ── Task #547 — 反噬（backlash） ────────────────────────────────

test("backlash: 預設全 0 → 被標旗仍回傳 backlash 物件但數值皆 0", () => {
  const result = penaltyTarget();
  const flags: WarOrderFlag[] = [
    {
      side: "attacker",
      orderType: "assault",
      kind: "unreasonable",
      reason: "x",
    },
  ];
  const out = applyWarOrderPenalties(
    result,
    flags,
    DEFAULT_GAME_BALANCE_SETTINGS,
  );
  const bl = out.backlash.attacker;
  assert.ok(bl);
  assert.equal(bl.extraCasualtyPct, 0);
  assert.equal(bl.stabilityDrop, 0);
  assert.equal(bl.unrestRise, 0);
  assert.equal(bl.warWearinessRise, 0);
  assert.equal(bl.exploit, false);
  assert.equal(out.backlash.defender, undefined);
  // 領土反噬改為確定性計算（Task #625）→ 不再由此函式處理。
});

test("backlash: 攻方被標旗 → 積極度依罰則調降（Task #625 — 領土反噬已移至確定性計算）", () => {
  const settings = settingsWith((s) => {
    s.war.backlashTerritoryPct = 10;
    s.war.penaltyAggressionPct = 50;
  });
  const result = penaltyTarget();
  const flags: WarOrderFlag[] = [
    {
      side: "attacker",
      orderType: "assault",
      kind: "unreasonable",
      reason: "x",
    },
  ];
  applyWarOrderPenalties(result, flags, settings);
  // 積極度按罰則調降（50% × 80 = 40）。
  assert.equal(result.attacker.legions[0]!.aggressionPct, 40);
  // 守方不受影響。
  assert.equal(result.defender.legions[0]!.aggressionPct, 40);
});

test("backlash: 守方被標旗 → 積極度依罰則調降", () => {
  const settings = settingsWith((s) => {
    s.war.backlashTerritoryPct = 12;
    s.war.penaltyAggressionPct = 50;
  });
  const result = penaltyTarget();
  const flags: WarOrderFlag[] = [
    { side: "defender", orderType: "hold", kind: "unreasonable", reason: "x" },
  ];
  applyWarOrderPenalties(result, flags, settings);
  // 守方積極度按罰則調降（50% × 40 = 20）。
  assert.equal(result.defender.legions[0]!.aggressionPct, 20);
  // 攻方不受影響。
  assert.equal(result.attacker.legions[0]!.aggressionPct, 80);
});

test("backlash: exploit 一律加倍（傷亡/數值），領土先歸零再反推", () => {
  const settings = settingsWith((s) => {
    s.war.backlashExtraCasualtyPct = 8;
    s.war.backlashTerritoryPct = 6;
    s.war.backlashStabilityDrop = 5;
    s.war.backlashUnrestRise = 4;
    s.war.backlashWarWearinessRise = 3;
  });
  const result = penaltyTarget();
  const flags: WarOrderFlag[] = [
    { side: "attacker", orderType: "assault", kind: "exploit", reason: "x" },
  ];
  const out = applyWarOrderPenalties(result, flags, settings);
  const bl = out.backlash.attacker;
  assert.ok(bl);
  assert.equal(bl.extraCasualtyPct, 16);
  assert.equal(bl.stabilityDrop, 10);
  assert.equal(bl.unrestRise, 8);
  assert.equal(bl.warWearinessRise, 6);
  assert.equal(bl.exploit, true);
  // Task #625 — 領土反噬改為確定性計算，不再由此函式修改移轉值。
  // 積極度已在 exploit 時打折（50÷2=25%），間接影響確定性領土推進。
  assert.equal(result.attacker.legions[0]!.aggressionPct, 20); // 80 × 0.25
});

test("computeBacklashExtraCasualties: floor、cap、兵力三重封頂、永不為負", () => {
  // floor(1000 × 7 / 100) = 70
  assert.equal(computeBacklashExtraCasualties(1000, 500, 7), 70);
  // cap 封頂
  assert.equal(computeBacklashExtraCasualties(1000, 50, 7), 50);
  // 兵力封頂（pct 100）
  assert.equal(computeBacklashExtraCasualties(30, 500, 100), 30);
  // pct 超過 100 → 視為 100
  assert.equal(computeBacklashExtraCasualties(30, 500, 250), 30);
  // 0 或負輸入 → 0
  assert.equal(computeBacklashExtraCasualties(0, 500, 10), 0);
  assert.equal(computeBacklashExtraCasualties(1000, 500, 0), 0);
  assert.equal(computeBacklashExtraCasualties(1000, -5, 10), 0);
});

test("war schema：反噬欄位超界被拒、缺欄位回填預設 0", () => {
  const over = gameBalanceSettingsSchema.safeParse({
    war: { backlashExtraCasualtyPct: 51 },
  });
  assert.equal(over.success, false);
  const over2 = gameBalanceSettingsSchema.safeParse({
    war: { backlashTerritoryPct: 16 },
  });
  assert.equal(over2.success, false);
  const over3 = gameBalanceSettingsSchema.safeParse({
    war: { backlashStabilityDrop: 31 },
  });
  assert.equal(over3.success, false);
  const ok = gameBalanceSettingsSchema.safeParse({ war: {} });
  assert.ok(ok.success);
  assert.equal(ok.data.war.backlashExtraCasualtyPct, 0);
  assert.equal(ok.data.war.backlashTerritoryPct, 0);
  assert.equal(ok.data.war.backlashStabilityDrop, 0);
  assert.equal(ok.data.war.backlashUnrestRise, 0);
  assert.equal(ok.data.war.backlashWarWearinessRise, 0);
  // 厭戰度變化幅度(2026-10-08 再平衡,緩解「只升不降」的惡性循環):
  // 和平每回合回復 5(原 3)、戰時 2(原 0)、上升倍率 65%(原 100)。
  assert.equal(ok.data.war.warWearinessPeacetimeRecovery, 5);
  assert.equal(ok.data.war.warWearinessWartimeRecovery, 2);
  assert.equal(ok.data.war.warWearinessGainMultiplierPct, 65);
  // 界限：回復 0–30、倍率 0–500。
  assert.equal(
    gameBalanceSettingsSchema.safeParse({
      war: { warWearinessPeacetimeRecovery: 31 },
    }).success,
    false,
  );
  assert.equal(
    gameBalanceSettingsSchema.safeParse({
      war: { warWearinessGainMultiplierPct: 501 },
    }).success,
    false,
  );
});

// ── applyModifierSource ─────────────────────────────────────────

test("applyModifierSource: enabled default passes delta through", () => {
  assert.equal(
    applyModifierSource("treasuryCrisis", -10, DEFAULT_GAME_BALANCE_SETTINGS),
    -10,
  );
  assert.equal(
    applyModifierSource("supportDrift", 7, DEFAULT_GAME_BALANCE_SETTINGS),
    7,
  );
});

test("applyModifierSource: disabled source → 0", () => {
  const settings = settingsWith((s) => {
    s.modifierSources.treasuryCrisis.enabled = false;
  });
  assert.equal(applyModifierSource("treasuryCrisis", -10, settings), 0);
});

test("applyModifierSource: clamps to [minDelta, maxDelta]", () => {
  const settings = settingsWith((s) => {
    s.modifierSources.fiscalPolicy.minDelta = -3;
    s.modifierSources.fiscalPolicy.maxDelta = 2;
  });
  assert.equal(applyModifierSource("fiscalPolicy", -10, settings), -3);
  assert.equal(applyModifierSource("fiscalPolicy", 10, settings), 2);
  assert.equal(applyModifierSource("fiscalPolicy", 1, settings), 1);
});

// ── designCustomUnit AI rejection（stubbed anthropic） ──────────

test("designCustomUnit: AI rejection → UnitDesignRejectedError, nothing inserted", async (t) => {
  const original = anthropic.messages.create;
  anthropic.messages.create = (async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ rejected: true, reason: "數值離譜" }),
      },
    ],
  })) as unknown as typeof anthropic.messages.create;
  t.after(() => {
    anthropic.messages.create = original;
  });

  await assert.rejects(
    designCustomUnit({
      ownerDiscordUserId: "gb-test-nonexistent-user",
      category: "infantry",
      requirement: "一擊必殺、免費、零維護的無敵兵",
      eraSlug: "classical",
    }),
    (err: unknown) => {
      assert.ok(err instanceof UnitDesignRejectedError);
      assert.ok(err.message.includes("數值離譜"));
      return true;
    },
  );
});

// ── Task #519 — AI 退件濫用紀錄帶行為人國家快照（stubbed anthropic） ──

const ACTOR_TAG = `gb-actor-test-${process.pid}-`;

test("designCustomUnit: AI 退件時濫用紀錄帶上 nationId/nationName 快照", async (t) => {
  const userId = `${ACTOR_TAG}user`;
  const nationId = crypto.randomUUID();
  const nationName = `${ACTOR_TAG}王國`;
  t.after(async () => {
    await db
      .delete(aiAbuseRecordsTable)
      .where(eq(aiAbuseRecordsTable.discordUserId, userId));
  });

  const original = anthropic.messages.create;
  anthropic.messages.create = (async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ rejected: true, reason: "數值離譜" }),
      },
    ],
  })) as unknown as typeof anthropic.messages.create;
  t.after(() => {
    anthropic.messages.create = original;
  });

  await assert.rejects(
    designCustomUnit({
      ownerDiscordUserId: userId,
      category: "infantry",
      requirement: "免費無敵兵",
      eraSlug: "classical",
      nation: { id: nationId, name: nationName },
    }),
    UnitDesignRejectedError,
  );

  const [record] = await db
    .select()
    .from(aiAbuseRecordsTable)
    .where(eq(aiAbuseRecordsTable.discordUserId, userId))
    .limit(1);
  assert.ok(record, "abuse record not written");
  assert.equal(record.nationId, nationId);
  assert.equal(record.nationName, nationName);
});

// ── Task #519 — enrichAbuseRecordActors（真 DB 批次補查） ──────────

test("enrichAbuseRecordActors: 補出玩家名稱與目前國家；無關聯者維持 null", async (t) => {
  const userA = `${ACTOR_TAG}enrich-a`; // 有 session（globalName）＋現有國家
  const userB = `${ACTOR_TAG}enrich-b`; // 有 session（無 globalName → username）
  const userC = `${ACTOR_TAG}enrich-c`; // 查無 session/國家

  await db.insert(userSessionsTable).values([
    {
      token: `${ACTOR_TAG}tok-a-old`,
      discordUserId: userA,
      username: "old-username-a",
      globalName: "舊名A",
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    {
      token: `${ACTOR_TAG}tok-a-new`,
      discordUserId: userA,
      username: "username-a",
      globalName: "玩家A",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    {
      token: `${ACTOR_TAG}tok-b`,
      discordUserId: userB,
      username: "username-b",
      globalName: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  ]);
  const [nationA] = await db
    .insert(playerNationsTable)
    .values({
      name: `${ACTOR_TAG}A國`,
      leaderName: "玩家A",
      discordUserId: userA,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nationA);
  t.after(async () => {
    await db
      .delete(playerNationsTable)
      .where(eq(playerNationsTable.id, nationA.id));
    await db
      .delete(userSessionsTable)
      .where(like(userSessionsTable.token, `${ACTOR_TAG}%`));
  });

  const base = {
    domain: "unit_design",
    verdict: "rejected",
    inputText: "x",
    reason: "y",
    context: {},
    compensation: {},
    revertedAt: null,
    revertNote: null,
    punishedAt: null,
    punishNote: null,
    punishment: {},
    createdAt: new Date(),
  };
  const enriched = await enrichAbuseRecordActors([
    // 舊紀錄：nation null → 讀取時補出目前國家＋最新 session 名稱。
    { ...base, id: 1, discordUserId: userA, nationId: null, nationName: null },
    // 無 globalName → 退回 username；無國家 → nationName 維持 null。
    { ...base, id: 2, discordUserId: userB, nationId: null, nationName: null },
    // 查無 session/國家 → actorName null（前端退回顯示 discordUserId）。
    { ...base, id: 3, discordUserId: userC, nationId: null, nationName: null },
    // 已有快照 → 快照優先，不被目前國家覆蓋。
    {
      ...base,
      id: 4,
      discordUserId: userA,
      nationId: crypto.randomUUID(),
      nationName: "快照國",
    },
    // 完全無關聯 → 原樣返回。
    { ...base, id: 5, discordUserId: null, nationId: null, nationName: null },
  ]);

  assert.equal(enriched[0]!.actorName, "玩家A");
  assert.equal(enriched[0]!.nationName, `${ACTOR_TAG}A國`);
  assert.equal(enriched[0]!.nationId, null); // 只補顯示，不動 nationId
  assert.equal(enriched[1]!.actorName, "username-b");
  assert.equal(enriched[1]!.nationName, null);
  assert.equal(enriched[2]!.actorName, null);
  assert.equal(enriched[2]!.nationName, null);
  assert.equal(enriched[3]!.actorName, "玩家A");
  assert.equal(enriched[3]!.nationName, "快照國");
  assert.equal(enriched[4]!.actorName, null);
  assert.equal(enriched[4]!.nationName, null);
});

// ── designNpcUnitSet 夾限整條流程（Task #475；stubbed anthropic） ──

const NPC_CLAMP_PREFIX = "gb-npc-clamp-test-";
const NPC_CLAMP_TAG = `${NPC_CLAMP_PREFIX}${process.pid}-`;

/** stub AI 回傳的單一兵種 JSON：木材／礦石遠超管理員上限（但在 zod 硬上限內）。 */
function npcAiUnit(category: string, name: string) {
  return {
    category,
    name,
    description: "測試用：AI 灌出天價原料需求的兵種",
    hp: 100,
    attack: 100,
    defense: 10,
    speed: 1,
    accuracy: 80,
    range: "melee",
    antiCavalryPct: 0,
    antiRangedPct: 0,
    antiArtilleryPct: 0,
    siegePct: 0,
    prodCostPer100: 5,
    popCostPerUnit: 1,
    moneyCostPerUnit: 10,
    upkeepPerUnit: 0.5,
    prodUpkeepPerUnit: 0.5,
    woodCostPerUnit: 1_000_000,
    oreCostPerUnit: 999_999,
  };
}

test("designNpcUnitSet: 超標木材／礦石成本在入庫前被夾到管理員上限", async (t) => {
  // 陳舊殘留清理：只清超過 30 分鐘的同前綴國家，不動並行程序的活資料。
  await db.delete(playerNationsTable).where(
    and(
      like(playerNationsTable.name, `${NPC_CLAMP_PREFIX}%`),
      lt(playerNationsTable.createdAt, sql`NOW() - INTERVAL '30 minutes'`),
    ),
  );

  // 暫時調低管理員木材／礦石上限（其餘設定保留現值），測後還原原始列。
  const [originalRow] = await db
    .select()
    .from(gameBalanceSettingsTable)
    .where(eq(gameBalanceSettingsTable.id, 1))
    .limit(1);
  const lowered = structuredClone(await getGameBalanceSettings());
  lowered.unitDesign.woodCostMax = 3;
  lowered.unitDesign.oreCostMax = 2;
  await saveGameBalanceSettings(lowered);
  t.after(async () => {
    if (originalRow) {
      await db
        .update(gameBalanceSettingsTable)
        .set({ params: originalRow.params })
        .where(eq(gameBalanceSettingsTable.id, 1));
    } else {
      await db
        .delete(gameBalanceSettingsTable)
        .where(eq(gameBalanceSettingsTable.id, 1));
    }
  });

  // 測試 NPC 國家（刪除時 cascade 一併清掉入庫的 NPC 兵種模板）。
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NPC_CLAMP_TAG}nation`,
      leaderName: NPC_CLAMP_TAG,
      isNpc: true,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "test nation insert failed");
  t.after(async () => {
    await db
      .delete(playerNationsTable)
      .where(eq(playerNationsTable.id, nation.id));
  });

  // stub anthropic.messages.create：回傳固定超標 JSON 陣列。
  const original = anthropic.messages.create;
  anthropic.messages.create = (async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify([
          npcAiUnit("infantry", `${NPC_CLAMP_TAG}步兵`),
          npcAiUnit("ranged", `${NPC_CLAMP_TAG}射手`),
        ]),
      },
    ],
  })) as unknown as typeof anthropic.messages.create;
  t.after(() => {
    anthropic.messages.create = original;
  });

  const rows = await designNpcUnitSet({
    nationId: nation.id,
    nationName: `${NPC_CLAMP_TAG}nation`,
    eraSlug: "classical",
    categories: ["infantry", "ranged"],
  });

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.ownerNationId, nation.id);
    assert.equal(row.ownerDiscordUserId, null);
    assert.equal(row.woodCostPerUnit, 3);
    assert.equal(row.oreCostPerUnit, 2);
  }

  // 從 DB 讀回，確認「入庫值」也已被夾限（不只是回傳值）。
  const stored = await db
    .select({
      woodCostPerUnit: militaryUnitTemplatesTable.woodCostPerUnit,
      oreCostPerUnit: militaryUnitTemplatesTable.oreCostPerUnit,
    })
    .from(militaryUnitTemplatesTable)
    .where(eq(militaryUnitTemplatesTable.ownerNationId, nation.id));
  assert.equal(stored.length, 2);
  for (const row of stored) {
    assert.equal(row.woodCostPerUnit, 3);
    assert.equal(row.oreCostPerUnit, 2);
  }
});

// ── 糧食時代指數（平衡頁面可調） ─────────────────────────────

test("food.eraIndex 預設值與 FOOD_ERA_INDEX 同步、涵蓋所有 ERAS slug", () => {
  const def = DEFAULT_GAME_BALANCE_SETTINGS.food.eraIndex;
  const defKeys = Object.keys(def);
  assert.equal(defKeys.length, ERAS.length);
  for (const era of ERAS) {
    assert.equal(
      def[era.slug as keyof typeof def],
      FOOD_ERA_INDEX[era.slug],
      `food.eraIndex 預設值與 FOOD_ERA_INDEX 不同步：${era.slug}`,
    );
  }
});

test("food.eraIndex：負值/超上限被 schema 拒絕；缺整段回填預設", () => {
  const negative = settingsWith((s) => {
    s.food.eraIndex.roman = -1;
  });
  assert.equal(gameBalanceSettingsSchema.safeParse(negative).success, false);

  const tooBig = settingsWith((s) => {
    s.food.eraIndex.future = 10_001;
  });
  assert.equal(gameBalanceSettingsSchema.safeParse(tooBig).success, false);

  // 舊資料沒有 food 段 → 解析後自動回填預設（不會炸 settings 讀取）。
  const legacy = structuredClone(
    DEFAULT_GAME_BALANCE_SETTINGS,
  ) as Partial<GameBalanceSettings>;
  delete legacy.food;
  const parsed = gameBalanceSettingsSchema.safeParse(legacy);
  assert.equal(parsed.success, true);
  assert.deepEqual(
    parsed.success ? parsed.data.food.eraIndex : null,
    DEFAULT_GAME_BALANCE_SETTINGS.food.eraIndex,
  );
});

// ── Task #523 — 建設成本倍率 ─────────────────────────────────

test("scaleConstructionCost: ceil(成本 × 倍率)、下限 1、壞倍率退回 1", () => {
  // 預設倍率 1 → 原價。
  assert.equal(scaleConstructionCost(800, 1), 800);
  // 向上取整。
  assert.equal(scaleConstructionCost(1000, 1.5), 1500);
  assert.equal(scaleConstructionCost(1001, 0.5), 501);
  assert.equal(scaleConstructionCost(3, 0.33), 1);
  // 下限 1：縮很小也不會歸零。
  assert.equal(scaleConstructionCost(1, 0.1), 1);
  assert.equal(scaleConstructionCost(0, 5), 1);
  // 極小倍率（0.0001）也維持下限 1。
  assert.equal(scaleConstructionCost(800, 0.0001), 1);
  assert.equal(scaleConstructionCost(1_000_000, 0.0001), 100);
  // 壞倍率（NaN／0／負數／Infinity）→ 視為 1。
  assert.equal(scaleConstructionCost(800, Number.NaN), 800);
  assert.equal(scaleConstructionCost(800, 0), 800);
  assert.equal(scaleConstructionCost(800, -2), 800);
  assert.equal(scaleConstructionCost(800, Number.POSITIVE_INFINITY), 800);
});

test("constructionCosts schema：預設 1、超界拒絕、缺整段回填預設", () => {
  const def = DEFAULT_GAME_BALANCE_SETTINGS.constructionCosts;
  assert.deepEqual(def, {
    productivityInvestment: 1,
    resourceBuilding: 1,
    cityBuilding: 1,
  });

  const tooSmall = settingsWith((s) => {
    s.constructionCosts.resourceBuilding = 0.00001;
  });
  assert.equal(gameBalanceSettingsSchema.safeParse(tooSmall).success, false);

  const zero = settingsWith((s) => {
    s.constructionCosts.resourceBuilding = 0;
  });
  assert.equal(gameBalanceSettingsSchema.safeParse(zero).success, false);

  const negative = settingsWith((s) => {
    s.constructionCosts.resourceBuilding = -1;
  });
  assert.equal(gameBalanceSettingsSchema.safeParse(negative).success, false);

  const tooBig = settingsWith((s) => {
    s.constructionCosts.cityBuilding = 101;
  });
  assert.equal(gameBalanceSettingsSchema.safeParse(tooBig).success, false);

  const boundary = settingsWith((s) => {
    s.constructionCosts.productivityInvestment = 0.0001;
    s.constructionCosts.resourceBuilding = 100;
    s.constructionCosts.cityBuilding = 0.001;
  });
  const ok = gameBalanceSettingsSchema.safeParse(boundary);
  assert.equal(ok.success, true);

  // 舊資料沒有 constructionCosts 段 → 解析後自動回填預設。
  const legacy = structuredClone(
    DEFAULT_GAME_BALANCE_SETTINGS,
  ) as Partial<GameBalanceSettings>;
  delete legacy.constructionCosts;
  const parsed = gameBalanceSettingsSchema.safeParse(legacy);
  assert.equal(parsed.success, true);
  assert.deepEqual(
    parsed.success ? parsed.data.constructionCosts : null,
    DEFAULT_GAME_BALANCE_SETTINGS.constructionCosts,
  );
});

after(async () => {
  await pool.end();
});
