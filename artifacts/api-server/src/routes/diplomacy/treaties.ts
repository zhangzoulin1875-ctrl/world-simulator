import { Router, type IRouter } from "express";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  or,
} from "drizzle-orm";
import {
  db,
  regionControlsTable,
  mapRegionsTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { pgErrorCode } from "../../lib/playerValidation";
import { aiRateLimit } from "../../middlewares/aiRateLimit";
import {
  canonicalPair,
  clampChatRelationDelta,
  clampRelationScore,
  findActiveSuzerainId,
  isTreatyType,
  npcReproposalCooldownMessage,
  npcReproposalCooldownRemainingMs,
  parseTreatyRegionSelection,
  summarizeNpcRelationEvents,
  summarizeNpcTreatyHistory,
  NPC_RELATION_EVENTS_MAX_AGE_MS,
  NPC_RELATION_EVENTS_MAX_ENTRIES,
  TREATY_TYPES,
} from "../../lib/diplomacy";
import { decideNpcTreatyResponse } from "../../lib/diplomacyAi";
import { AiQuotaExceededError } from "../../lib/gameAi";
import { buildNationGeoCultureContext } from "../../lib/nationGeoCulture";
import { ensurePoliticalNote } from "../../lib/politicalNote";
import { getAiJudgmentDirective } from "../../lib/aiDirective";
import { notifyTreatyProposal } from "../../lib/diplomacyNotify";
import { HttpError } from "../../lib/treatyActivation";
import { applyNpcTreatyDecision } from "../../lib/npcTreatyDecision";
import {
  findNpcTreatyCapViolations,
  npcPaidFields,
  type NpcTreatyCaps,
} from "../../lib/npcTreatyCaps";
import { loadNpcTreatyCaps } from "../../lib/npcTreatyCapData";
import { fetchNpcTreatyHistory } from "../../lib/npcTreatyHistory";
import { requirePlayer, loadNationOr404 } from "./shared";
import { serializeTreaty, loadTreatyContext } from "./treatyContext";

const router: IRouter = Router();

router.get("/diplomacy/treaties", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const myId = player.nation.id;
  const [{ treaties, nameById }, myRegions, allRegions] = await Promise.all([
    loadTreatyContext(myId),
    db
      .select({
        regionId: regionControlsTable.regionId,
        regionName: mapRegionsTable.name,
        percent: regionControlsTable.percent,
      })
      .from(regionControlsTable)
      .innerJoin(
        mapRegionsTable,
        eq(mapRegionsTable.id, regionControlsTable.regionId),
      )
      .where(eq(regionControlsTable.nationId, myId))
      .orderBy(asc(regionControlsTable.regionId)),
    // Task #374 — 條約清單需顯示雙方領土名稱（含對方地區），附上全地圖名稱表。
    db
      .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
      .from(mapRegionsTable),
  ]);
  const regionNames: Record<string, string> = {};
  for (const r of allRegions) regionNames[String(r.id)] = r.name;
  res.json({
    treatyTypes: TREATY_TYPES.map((t) => ({
      slug: t.slug,
      label: t.label,
      description: t.description,
    })),
    treaties: treaties.map((t) => serializeTreaty(t, nameById, myId)),
    myRegions,
    regionNames,
  });
});

// Task #374 — 「要求對方提供」領土選擇器：列出指定國家目前掌控的地區。
router.get("/diplomacy/nations/:nationId/regions", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const target = await loadNationOr404(res, req.params.nationId);
  if (!target) return;
  const regions = await db
    .select({
      regionId: regionControlsTable.regionId,
      regionName: mapRegionsTable.name,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, regionControlsTable.regionId),
    )
    .where(eq(regionControlsTable.nationId, target.id))
    .orderBy(asc(regionControlsTable.regionId));
  res.json({ regions });
});

router.post("/diplomacy/treaties", aiRateLimit, async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const myId = player.nation.id;

  const body = req.body ?? {};
  const targetNationId = body.targetNationId;
  if (typeof targetNationId !== "string") {
    res.status(400).json({ error: "缺少對象國家" });
    return;
  }
  const target = await loadNationOr404(res, targetNationId);
  if (!target) return;
  if (target.id === myId) {
    res.status(400).json({ error: "不能與自己締約" });
    return;
  }
  if (!isTreatyType(body.type)) {
    res.status(400).json({ error: "不支援的條約類型" });
    return;
  }
  const type = body.type;

  let durationDays: number | null = null;
  if (body.durationDays !== null && body.durationDays !== undefined) {
    if (
      typeof body.durationDays !== "number" ||
      !Number.isInteger(body.durationDays) ||
      body.durationDays < 1 ||
      body.durationDays > 3650
    ) {
      res.status(400).json({ error: "時效必須是 1 到 3650 天，或留空表示無期限" });
      return;
    }
    durationDays = body.durationDays;
  }

  // 禁止領土轉移條約：offerRegionIds 或 requestRegionIds 非空陣列 → 400。
  // 領土取得應僅透過戰爭，條約不允許和平割讓地區。
  if (
    (Array.isArray(body.offerRegionIds) && body.offerRegionIds.length > 0) ||
    (Array.isArray(body.requestRegionIds) && body.requestRegionIds.length > 0)
  ) {
    res.status(400).json({ message: "條約不允許包含領土轉移條件" });
    return;
  }

  // Task #374 — 條約雙向交換：所有類型（含自訂）都可附帶一次性
  // 金錢／科技，且分「我方提供」（offer*）與「要求對方提供」
  // （request*）兩側。
  const isCustom = type === "custom";

  const oneTimeFields: Array<[unknown, string]> = [
    [body.offerMoney ?? 0, "我方提供的金錢"],
    [body.offerTechPoints ?? 0, "我方提供的科技點數"],
    [body.requestMoney ?? 0, "要求對方提供的金錢"],
    [body.requestTechPoints ?? 0, "要求對方提供的科技點數"],
    [body.offerWood ?? 0, "我方提供的木材"],
    [body.offerOre ?? 0, "我方提供的礦石"],
    [body.requestWood ?? 0, "要求對方提供的木材"],
    [body.requestOre ?? 0, "要求對方提供的礦石"],
  ];
  for (const [raw, label] of oneTimeFields) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      res.status(400).json({ error: `${label}必須是不小於 0 的整數` });
      return;
    }
  }
  const offerMoney = (body.offerMoney ?? 0) as number;
  const offerTechPoints = (body.offerTechPoints ?? 0) as number;
  const requestMoney = (body.requestMoney ?? 0) as number;
  const requestTechPoints = (body.requestTechPoints ?? 0) as number;
  const offerWood = (body.offerWood ?? 0) as number;
  const offerOre = (body.offerOre ?? 0) as number;
  const requestWood = (body.requestWood ?? 0) as number;
  const requestOre = (body.requestOre ?? 0) as number;
  if (offerWood > player.nation.wood) {
    res.status(400).json({ error: "我方提供的木材超過你目前持有的木材" });
    return;
  }
  if (offerOre > player.nation.ore) {
    res.status(400).json({ error: "我方提供的礦石超過你目前持有的礦石" });
    return;
  }
  if (offerMoney > player.nation.money) {
    res.status(400).json({ error: "我方提供的金錢超過你目前持有的金錢" });
    return;
  }
  if (offerTechPoints > player.nation.techPoints) {
    res
      .status(400)
      .json({ error: "我方提供的科技點數超過你目前持有的科技點數" });
    return;
  }

  const [myControls, targetControls] = await Promise.all([
    db
      .select({
        regionId: regionControlsTable.regionId,
        percent: regionControlsTable.percent,
      })
      .from(regionControlsTable)
      .where(eq(regionControlsTable.nationId, myId)),
    db
      .select({
        regionId: regionControlsTable.regionId,
        percent: regionControlsTable.percent,
      })
      .from(regionControlsTable)
      .where(eq(regionControlsTable.nationId, target.id)),
  ]);
  const myHeld = new Map(myControls.map((r) => [r.regionId, r.percent]));
  const targetHeld = new Map(
    targetControls.map((r) => [r.regionId, r.percent]),
  );

  const offerSelection = parseTreatyRegionSelection({
    rawRegionIds: body.offerRegionIds,
    rawRegionPercents: body.offerRegionPercents,
    held: myHeld,
    sideLabel: "我方提供",
  });
  if (!offerSelection.ok) {
    res.status(400).json({ error: offerSelection.error });
    return;
  }
  const requestSelection = parseTreatyRegionSelection({
    rawRegionIds: body.requestRegionIds,
    rawRegionPercents: body.requestRegionPercents,
    held: targetHeld,
    sideLabel: "要求對方提供",
  });
  if (!requestSelection.ok) {
    res.status(400).json({ error: requestSelection.error });
    return;
  }
  const offerRegionIds = offerSelection.regionIds;
  const offerRegionPercents = offerSelection.regionPercents;
  const requestRegionIds = requestSelection.regionIds;
  const requestRegionPercents = requestSelection.regionPercents;

  // Task #214 — 自訂條約欄位：自訂條款文字（≤500 字）＋ 每回合經常性轉移量
  // （金錢／科技／生產力，整數 ≥ 0）＋ 付款方向（proposerIsPayer）。
  let customClause: string | null = null;
  let perTurnMoney = 0;
  let perTurnTech = 0;
  let perTurnProduction = 0;
  let perTurnFood = 0;
  // Task #476 — 每回合木材／礦石（庫存制：結算時不足該項則本回合略過）。
  let perTurnWood = 0;
  let perTurnOre = 0;
  // Task #527 — 反向每回合經常性轉移（由 perTurn 付款方的對方支付），
  // 兩方向可同時存在（雙向互相轉移）。
  let requestPerTurnMoney = 0;
  let requestPerTurnTech = 0;
  let requestPerTurnProduction = 0;
  let requestPerTurnFood = 0;
  let requestPerTurnWood = 0;
  let requestPerTurnOre = 0;
  // Task #374 — 一次性附帶固定為「offer=提案方付、request=對方付」；
  // proposerIsPayer 僅決定自訂條約每回合經常性轉移的方向，玩家提案
  // 一律存 true（提案方付款）除非自訂條約指定相反。
  let proposerIsPayer = true;
  if (isCustom) {
    const rawClause = body.customClause;
    if (rawClause !== null && rawClause !== undefined) {
      if (typeof rawClause !== "string") {
        res.status(400).json({ error: "自訂條款必須是文字" });
        return;
      }
      const trimmed = rawClause.trim();
      if (trimmed.length > 500) {
        res.status(400).json({ error: "自訂條款不可超過 500 字" });
        return;
      }
      customClause = trimmed.length > 0 ? trimmed : null;
    }
    const perTurnFields: Array<[unknown, string, (n: number) => void]> = [
      [body.perTurnMoney, "每回合金錢", (n) => (perTurnMoney = n)],
      [body.perTurnTech, "每回合科技點數", (n) => (perTurnTech = n)],
      [body.perTurnProduction, "每回合生產力", (n) => (perTurnProduction = n)],
      [body.perTurnFood, "每回合糧食", (n) => (perTurnFood = n)],
      [body.perTurnWood, "每回合木材", (n) => (perTurnWood = n)],
      [body.perTurnOre, "每回合礦石", (n) => (perTurnOre = n)],
      [
        body.requestPerTurnMoney,
        "對方每回合金錢",
        (n) => (requestPerTurnMoney = n),
      ],
      [
        body.requestPerTurnTech,
        "對方每回合科技點數",
        (n) => (requestPerTurnTech = n),
      ],
      [
        body.requestPerTurnProduction,
        "對方每回合生產力",
        (n) => (requestPerTurnProduction = n),
      ],
      [
        body.requestPerTurnFood,
        "對方每回合糧食",
        (n) => (requestPerTurnFood = n),
      ],
      [
        body.requestPerTurnWood,
        "對方每回合木材",
        (n) => (requestPerTurnWood = n),
      ],
      [
        body.requestPerTurnOre,
        "對方每回合礦石",
        (n) => (requestPerTurnOre = n),
      ],
    ];
    for (const [raw, label, set] of perTurnFields) {
      const val = raw ?? 0;
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
        res.status(400).json({ error: `${label}必須是不小於 0 的整數` });
        return;
      }
      set(val);
    }
    if (typeof body.proposerIsPayer !== "boolean") {
      res.status(400).json({ error: "請指定自訂條約的付款方向" });
      return;
    }
    proposerIsPayer = body.proposerIsPayer;
    if (
      !customClause &&
      perTurnMoney === 0 &&
      perTurnTech === 0 &&
      perTurnProduction === 0 &&
      perTurnFood === 0 &&
      perTurnWood === 0 &&
      perTurnOre === 0 &&
      requestPerTurnMoney === 0 &&
      requestPerTurnTech === 0 &&
      requestPerTurnProduction === 0 &&
      requestPerTurnFood === 0 &&
      requestPerTurnWood === 0 &&
      requestPerTurnOre === 0
    ) {
      res.status(400).json({
        error: "自訂條約至少要有條款文字或一項每回合經常性轉移",
      });
      return;
    }
  }

  // 附庸條約：貢金比例（1–100）＋ 方向（proposerIsVassal：true = 我方
  // 成為對方的附庸；false = 邀請對方成為我方的附庸）。
  let tributePct = 0;
  let proposerIsVassal = true;
  if (type === "vassal") {
    const rawPct = body.tributePct;
    if (
      typeof rawPct !== "number" ||
      !Number.isInteger(rawPct) ||
      rawPct < 1 ||
      rawPct > 100
    ) {
      res.status(400).json({ error: "貢金比例必須是 1 到 100 的整數" });
      return;
    }
    tributePct = rawPct;
    if (typeof body.proposerIsVassal !== "boolean") {
      res.status(400).json({ error: "請指定附庸條約的方向（誰是附庸）" });
      return;
    }
    proposerIsVassal = body.proposerIsVassal;
    // 友善快速路徑：準附庸已有生效中的宗主 → 409。併發時由部分唯一索引
    // diplomacy_treaties_vassal_nation_active_uidx 在接受（activateTreaty）時擋下。
    const prospectiveVassalId = proposerIsVassal ? myId : target.id;
    const existing = await db
      .select({
        type: diplomacyTreatiesTable.type,
        proposerNationId: diplomacyTreatiesTable.proposerNationId,
        targetNationId: diplomacyTreatiesTable.targetNationId,
        status: diplomacyTreatiesTable.status,
        expiresAt: diplomacyTreatiesTable.expiresAt,
        proposerIsVassal: diplomacyTreatiesTable.proposerIsVassal,
      })
      .from(diplomacyTreatiesTable)
      .where(
        and(
          eq(diplomacyTreatiesTable.type, "vassal"),
          eq(diplomacyTreatiesTable.status, "active"),
        ),
      );
    if (findActiveSuzerainId(existing, prospectiveVassalId) !== null) {
      res.status(409).json({
        error: proposerIsVassal
          ? "你的國家已是其他國家的附庸，須先廢除現有附庸條約"
          : "對方已是其他國家的附庸，無法再成為你的附庸",
      });
      return;
    }
  }

  // Task #570 — NPC 締約可提供資源的上限：對 NPC 的提案，「要求對方提供」
  // 一側（一次性金錢/科技/木/礦、領土、每回合輸送）不得超過該 NPC 的資源
  // 上限（world_game_state 管理員可調）。真人↔真人與玩家付出側不受影響。
  let npcCaps: NpcTreatyCaps | null = null;
  if (target.isNpc) {
    const caps = await loadNpcTreatyCaps(target);
    npcCaps = caps;
    // NPC 付出的每回合欄位方向：proposerIsPayer=true → 對方（NPC）付
    // requestPerTurn*；false → NPC 為 perTurn* 的付款方。
    const npcPerTurn = proposerIsPayer
      ? {
          money: requestPerTurnMoney,
          tech: requestPerTurnTech,
          production: requestPerTurnProduction,
          food: requestPerTurnFood,
          wood: requestPerTurnWood,
          ore: requestPerTurnOre,
        }
      : {
          money: perTurnMoney,
          tech: perTurnTech,
          production: perTurnProduction,
          food: perTurnFood,
          wood: perTurnWood,
          ore: perTurnOre,
        };
    let regionNameById = new Map<number, string>();
    if (requestRegionIds.length > 0) {
      const rows = await db
        .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
        .from(mapRegionsTable)
        .where(inArray(mapRegionsTable.id, requestRegionIds));
      regionNameById = new Map(rows.map((r) => [r.id, r.name]));
    }
    const violations = findNpcTreatyCapViolations(
      npcPaidFields({
        money: requestMoney,
        techPoints: requestTechPoints,
        wood: requestWood,
        ore: requestOre,
        regions: requestRegionIds.map((id) => {
          const heldPercent = targetHeld.get(id) ?? 0;
          return {
            regionId: id,
            regionName: regionNameById.get(id),
            transferPercent: requestRegionPercents[String(id)] ?? heldPercent,
            heldPercent,
          };
        }),
        perTurnMoney: npcPerTurn.money,
        perTurnTech: npcPerTurn.tech,
        perTurnProduction: npcPerTurn.production,
        perTurnFood: npcPerTurn.food,
        perTurnWood: npcPerTurn.wood,
        perTurnOre: npcPerTurn.ore,
      }),
      caps,
    );
    if (violations.length > 0) {
      res.status(400).json({
        error: `超過 NPC 可提供的資源上限：${violations.join("；")}`,
      });
      return;
    }
  }

  // Task #72 — 對 NPC 對象的重提冷卻：同一 pair 最近一筆被拒絕或撤回的
  // 提案若在冷卻時間內，擋下新提案（防止「提案 → 拒絕/對案 → 撤回 →
  // 立刻重提」無限刷 AI 判斷）。玩家對玩家不受此限制。
  if (target.isNpc) {
    const [recentEnded] = await db
      .select({ updatedAt: diplomacyTreatiesTable.updatedAt })
      .from(diplomacyTreatiesTable)
      .where(
        and(
          inArray(diplomacyTreatiesTable.status, ["rejected", "withdrawn"]),
          or(
            and(
              eq(diplomacyTreatiesTable.proposerNationId, myId),
              eq(diplomacyTreatiesTable.targetNationId, target.id),
            ),
            and(
              eq(diplomacyTreatiesTable.proposerNationId, target.id),
              eq(diplomacyTreatiesTable.targetNationId, myId),
            ),
          ),
        ),
      )
      .orderBy(desc(diplomacyTreatiesTable.updatedAt))
      .limit(1);
    if (recentEnded) {
      const remainingMs = npcReproposalCooldownRemainingMs(
        recentEnded.updatedAt,
      );
      if (remainingMs > 0) {
        res.status(429).json({
          error: npcReproposalCooldownMessage(remainingMs),
        });
        return;
      }
    }
  }

  // 防止重複提案：同一對象已有待回覆的提案。
  const [pending] = await db
    .select({ id: diplomacyTreatiesTable.id })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.status, "proposed"),
        or(
          and(
            eq(diplomacyTreatiesTable.proposerNationId, myId),
            eq(diplomacyTreatiesTable.targetNationId, target.id),
          ),
          and(
            eq(diplomacyTreatiesTable.proposerNationId, target.id),
            eq(diplomacyTreatiesTable.targetNationId, myId),
          ),
        ),
      ),
    )
    .limit(1);
  if (pending) {
    res.status(409).json({ error: "與該國已有待回覆的條約提案，請先處理" });
    return;
  }

  // Task #67 — 上面的 SELECT 只是友善的快速路徑；併發連點時由部分唯一索引
  // diplomacy_treaties_proposed_pair_uidx 在資料庫層保證同一 pair 僅一筆
  // proposed，違反時走 pgErrorCode → 乾淨的 409。
  let treaty: DiplomacyTreaty | undefined;
  try {
    [treaty] = await db
      .insert(diplomacyTreatiesTable)
      .values({
        proposerNationId: myId,
        targetNationId: target.id,
        type,
        durationDays,
        offerMoney,
        offerTechPoints,
        offerWood,
        offerOre,
        offerRegionIds,
        offerRegionPercents,
        requestMoney,
        requestTechPoints,
        requestWood,
        requestOre,
        requestRegionIds,
        requestRegionPercents,
        customClause,
        perTurnMoney,
        perTurnTech,
        perTurnProduction,
        perTurnFood,
        perTurnWood,
        perTurnOre,
        requestPerTurnMoney,
        requestPerTurnTech,
        requestPerTurnProduction,
        requestPerTurnFood,
        requestPerTurnWood,
        requestPerTurnOre,
        proposerIsPayer,
        tributePct,
        proposerIsVassal,
        status: "proposed",
        awaitingNationId: target.id,
      })
      .returning();
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      res.status(409).json({ error: "與該國已有待回覆的條約提案，請先處理" });
      return;
    }
    throw err;
  }
  if (!treaty) {
    res.status(500).json({ error: "條約提案寫入失敗" });
    return;
  }

  req.log.info(
    { treatyId: treaty.id, type, targetNationId: target.id },
    "treaty proposed",
  );

  // 對象是玩家 → 等待人工回覆。
  if (!target.isNpc) {
    // Task #41 — 私訊通知被提案的玩家（fire-and-forget）。
    notifyTreatyProposal({
      targetDiscordUserId: target.discordUserId,
      proposerNationName: player.nation.name,
      treatyType: type,
    });
    const { nameById } = await loadTreatyContext(myId);
    res.json({
      npcDecision: null,
      treaty: serializeTreaty(treaty, nameById, myId),
    });
    return;
  }

  // 對象是 NPC → AI 即時判斷。
  // Task #374 — 兩側領土都帶上「名稱（xx%）」給 NPC 判斷。
  // Task #376 — 另附提案國目前掌控地區清單（名稱＋掌控 %），供 NPC 對案索求領土。
  const regions = await db
    .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
    .from(mapRegionsTable);
  const byId = new Map(regions.map((r) => [r.id, r.name]));
  const describe = (ids: number[], percents: Record<string, number>) =>
    ids.map((id) => {
      const name = byId.get(id) ?? `#${id}`;
      const pct = percents[String(id)];
      return pct !== undefined && pct < 100 ? `${name}（${pct}%）` : name;
    });
  const offerRegionNames = describe(offerRegionIds, offerRegionPercents);
  const requestRegionNames = describe(requestRegionIds, requestRegionPercents);
  const proposerRegions = myControls
    .filter((r) => r.percent > 0)
    .map((r) => ({
      name: byId.get(r.regionId) ?? `#${r.regionId}`,
      heldPercent: r.percent,
    }));
  const { low, high } = canonicalPair(myId, target.id);
  const [relation] = await db
    .select()
    .from(diplomacyRelationsTable)
    .where(
      and(
        eq(diplomacyRelationsTable.nationAId, low),
        eq(diplomacyRelationsTable.nationBId, high),
      ),
    )
    .limit(1);
  const [war] = await db
    .select({ id: diplomacyWarsTable.id })
    .from(diplomacyWarsTable)
    .where(
      and(
        eq(diplomacyWarsTable.nationAId, low),
        eq(diplomacyWarsTable.nationBId, high),
        isNull(diplomacyWarsTable.endedAt),
      ),
    )
    .limit(1);

  // Task #76 — 讓 NPC 記得同一 pair 近期被拒/撤回/對案的提案：
  // 取最近 7 天內最多 5 筆已結束的提案摘要（含 NPC 先前的 responseNote）
  // 納入判斷 prompt，讓重提幾乎相同條件時回覆前後一致、逐次更嚴格。
  // 查詢已抽至 lib/npcTreatyHistory.ts（整合測試直接驗證同一查詢）。
  const recentHistory = summarizeNpcTreatyHistory(
    await fetchNpcTreatyHistory({
      myNationId: myId,
      npcNationId: target.id,
      excludeTreatyId: treaty.id,
    }),
  );

  // Task #84 — 讓 NPC 記得同一 pair 近期的關係動作（送禮／侮辱／設館／撤館）：
  // 取最近 7 天內最多 8 筆事件納入判斷 prompt，NPC 回覆可提及近期互動，
  // 也能識破「先侮辱再送禮洗分數」的套路。
  const relationEventRows = await db
    .select({
      action: diplomacyRelationEventsTable.action,
      actorNationId: diplomacyRelationEventsTable.actorNationId,
      createdAt: diplomacyRelationEventsTable.createdAt,
    })
    .from(diplomacyRelationEventsTable)
    .where(
      and(
        gte(
          diplomacyRelationEventsTable.createdAt,
          new Date(Date.now() - NPC_RELATION_EVENTS_MAX_AGE_MS),
        ),
        or(
          and(
            eq(diplomacyRelationEventsTable.actorNationId, myId),
            eq(diplomacyRelationEventsTable.targetNationId, target.id),
          ),
          and(
            eq(diplomacyRelationEventsTable.actorNationId, target.id),
            eq(diplomacyRelationEventsTable.targetNationId, myId),
          ),
        ),
      ),
    )
    .orderBy(desc(diplomacyRelationEventsTable.createdAt))
    .limit(NPC_RELATION_EVENTS_MAX_ENTRIES);
  const recentRelationEvents = summarizeNpcRelationEvents(
    relationEventRows.map((r) => ({
      action: r.action,
      actedByNpc: r.actorNationId === target.id,
      createdAt: r.createdAt,
    })),
  );

  // Task #127 — 讓 NPC 的外交回覆帶出自身治理風格：惰性生成並快取其政治註記
  // （allowNpc），AI 失敗回 null 時照常判斷（不加入 prompt）。
  const npcPoliticalNote = await ensurePoliticalNote(target, { allowNpc: true });

  // Task #369 — 讓 NPC 締約回覆用語貼合提案國（對方）所在地區文化。
  const counterpartGeoContext = await buildNationGeoCultureContext(
    player.nation.id,
  );

  let decision;
  try {
    decision = await decideNpcTreatyResponse({
      npcName: target.name ?? "NPC",
      proposerName: player.nation.name ?? "（未命名）",
      treatyType: type,
      durationDays,
      offerMoney,
      offerTechPoints,
      offerWood,
      offerOre,
      offerRegionNames,
      requestMoney,
      requestTechPoints,
      requestWood,
      requestOre,
      requestRegionNames,
      relationScore: relation?.score ?? 0,
      atWar: war !== undefined,
      recentHistory,
      recentRelationEvents,
      politicalNote: npcPoliticalNote,
      diplomaticAttitude: target.diplomaticAttitude,
      adminDirective: await getAiJudgmentDirective(),
      counterpartGeoContext,
      proposerRegions,
      // Task #214 — 自訂條約：NPC 為受提案方（target），付款方向依 proposerIsPayer。
      custom: isCustom
        ? {
            clause: customClause,
            perTurnMoney,
            perTurnTech,
            perTurnProduction,
            perTurnFood,
            perTurnWood,
            perTurnOre,
            // Task #527 — 反向每回合（由 perTurn 付款方的對方支付）。
            requestPerTurnMoney,
            requestPerTurnTech,
            requestPerTurnProduction,
            requestPerTurnFood,
            requestPerTurnWood,
            requestPerTurnOre,
            npcIsPayer: !proposerIsPayer,
          }
        : null,
      // 附庸條約：NPC 為受提案方（target）——提案方是附庸（proposerIsVassal）
      // 時 NPC 是宗主，反之 NPC 被請求成為附庸。
      vassal:
        type === "vassal"
          ? { npcIsVassal: !proposerIsVassal, tributePct }
          : null,
      // Task #570 — 我國資源紅線：NPC 對案與承諾不得超過可付出上限。
      npcResourceCaps: npcCaps,
    });
  } catch (err) {
    // AI 失敗：撤回提案，讓玩家可重試（不留下卡住的 proposed 列）。
    await db
      .delete(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.id, treaty.id));
    if (err instanceof AiQuotaExceededError) {
      // Task #593 — NPC 條約決策今日 token 配額用罄（提案已撤回）→ 503。
      res.status(503).json({ error: err.message });
      return;
    }
    req.log.error({ err, treatyId: treaty.id }, "NPC treaty AI failed");
    res.status(502).json({ error: "NPC 外交回覆失敗，請再試一次" });
    return;
  }

  try {
    // Task #52 — accept/counter 皆在交易內 FOR UPDATE 重讀條約；
    // accept 餘額不足 → 400 並撤回提案（不會卡在 proposed）。
    await applyNpcTreatyDecision(treaty.id, decision);
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }

  // Task #228 — 條約談判同樣附帶一次 AI 判定的關係值變化（每次 −20～+20；
  // 與總分一起夾在 −100～100）。失敗不影響條約決定本身。
  const treatyRelationDelta = clampChatRelationDelta(decision.relationDelta);
  if (treatyRelationDelta !== 0) {
    const { low, high } = canonicalPair(myId, target.id);
    try {
      await db.transaction(async (tx) => {
        await tx
          .insert(diplomacyRelationsTable)
          .values({ nationAId: low, nationBId: high })
          .onConflictDoNothing();
        const [rel] = await tx
          .select({ score: diplomacyRelationsTable.score })
          .from(diplomacyRelationsTable)
          .where(
            and(
              eq(diplomacyRelationsTable.nationAId, low),
              eq(diplomacyRelationsTable.nationBId, high),
            ),
          )
          .for("update");
        const newScore = clampRelationScore(
          (rel?.score ?? 0) + treatyRelationDelta,
        );
        await tx
          .update(diplomacyRelationsTable)
          .set({ score: newScore })
          .where(
            and(
              eq(diplomacyRelationsTable.nationAId, low),
              eq(diplomacyRelationsTable.nationBId, high),
            ),
          );
        await tx.insert(diplomacyRelationEventsTable).values({
          actorNationId: myId,
          targetNationId: target.id,
          action: "treaty_negotiation",
        });
      });
    } catch (err) {
      req.log.error(
        { err, treatyId: treaty.id },
        "treaty negotiation relation delta failed",
      );
    }
  }

  const { treaties, nameById } = await loadTreatyContext(myId);
  const updated = treaties.find((t) => t.id === treaty.id);
  req.log.info(
    { treatyId: treaty.id, decision: decision.decision },
    "NPC treaty decision",
  );
  res.json({
    npcDecision: decision.decision,
    npcNote: decision.note,
    treaty: updated ? serializeTreaty(updated, nameById, myId) : null,
  });
});

export default router;
