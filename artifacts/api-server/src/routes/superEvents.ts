import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  superEventsTable,
  superEventRegionsTable,
  superEventTurnLogsTable,
  superEventResponsesTable,
  superEventSettingsTable,
  superEventNationsTable,
  superEventNationImpactsTable,
  playerNationsTable,
  regionControlsTable,
  type PlayerNation,
  type SuperEvent,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { getEraSlugs } from "../lib/nationStats";
import { requireAdmin } from "../middlewares/requireAdmin";
import { generateSuperEvent } from "../lib/superEventAi";
import { buildRegionSetGeoCultureContext } from "../lib/nationGeoCulture";
import { notifyNewSuperEvent } from "../lib/superEventSettlement";
import { isSuperEventTargetStat } from "../lib/superEventImpact";

const router: IRouter = Router();

const RESPONSE_MAX_LENGTH = 500;

/**
 * 解析管理員傳入的目標數據清單。undefined＝未提供；null／[]＝不限（存 null）；
 * 含未知 key 一律 ok:false（明確 400，絕不 silent 濾掉）。
 */
function parseTargetStats(
  v: unknown,
): { ok: true; stats: string[] | null | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, stats: undefined };
  if (v === null) return { ok: true, stats: null };
  if (!Array.isArray(v)) return { ok: false };
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !isSuperEventTargetStat(item)) {
      return { ok: false };
    }
    if (!out.includes(item)) out.push(item);
  }
  return { ok: true, stats: out.length > 0 ? out : null };
}

/** session → 已建國 nation（同 economy.ts 的 requirePlayer）。 */
async function requirePlayer(
  req: Request,
  res: Response,
): Promise<{ nation: PlayerNation; userId: string } | null> {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return null;
  }
  const userId = session.discordUserId;
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!nation) {
    res.status(400).json({ error: "尚未建國，請先在玩家首頁建立或接手國家" });
    return null;
  }
  return { nation, userId };
}

/** 某國掌控的地區 id 集合。 */
async function loadNationRegionIds(nationId: string): Promise<Set<number>> {
  const rows = await db
    .select({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.nationId, nationId));
  return new Set(rows.map((r) => r.regionId));
}

/** 事件 id → 影響地區 id 陣列。 */
async function loadEventRegions(
  eventIds: string[],
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (eventIds.length === 0) return map;
  const rows = await db
    .select({
      eventId: superEventRegionsTable.eventId,
      regionId: superEventRegionsTable.regionId,
    })
    .from(superEventRegionsTable)
    .where(inArray(superEventRegionsTable.eventId, eventIds));
  for (const r of rows) {
    const arr = map.get(r.eventId) ?? [];
    arr.push(r.regionId);
    map.set(r.eventId, arr);
  }
  return map;
}

/** 事件 id → 指定目標國家 id 陣列（scope = targeted）。 */
async function loadEventNations(
  eventIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (eventIds.length === 0) return map;
  const rows = await db
    .select({
      eventId: superEventNationsTable.eventId,
      nationId: superEventNationsTable.nationId,
    })
    .from(superEventNationsTable)
    .where(inArray(superEventNationsTable.eventId, eventIds));
  for (const r of rows) {
    const arr = map.get(r.eventId) ?? [];
    arr.push(r.nationId);
    map.set(r.eventId, arr);
  }
  return map;
}

/**
 * 判斷某國是否在事件影響範圍內。
 * - global：掌控任一地區的國家都受影響。
 * - regional：僅掌控受影響地區之一的國家（無 silent global fallback）。
 * - targeted：僅事件指定的國家。
 */
function nationAffected(
  event: Pick<SuperEvent, "scope">,
  ctx: {
    eventRegionIds: number[];
    nationRegionIds: Set<number>;
    eventNationIds: string[];
    nationId: string;
  },
): boolean {
  if (event.scope === "targeted") {
    return ctx.eventNationIds.includes(ctx.nationId);
  }
  if (event.scope === "regional") {
    return ctx.eventRegionIds.some((id) => ctx.nationRegionIds.has(id));
  }
  return ctx.nationRegionIds.size > 0;
}

// ── 玩家端（session-gated，OpenAPI in-spec） ──────────────────────

router.get("/super-events", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const events = await db
    .select()
    .from(superEventsTable)
    .orderBy(
      // 進行中在前，其次依建立時間新到舊。
      desc(superEventsTable.status),
      desc(superEventsTable.createdAt),
    );
  const eventIds = events.map((e) => e.id);
  const [regionMap, nationMap, nationRegionIds, myResponses] =
    await Promise.all([
      loadEventRegions(eventIds),
      loadEventNations(eventIds),
      loadNationRegionIds(nation.id),
      eventIds.length > 0
        ? db
            .select({
              eventId: superEventResponsesTable.eventId,
              status: superEventResponsesTable.status,
            })
            .from(superEventResponsesTable)
            .where(eq(superEventResponsesTable.nationId, nation.id))
        : Promise.resolve<{ eventId: string; status: string }[]>([]),
    ]);
  const responseByEvent = new Map(myResponses.map((r) => [r.eventId, r.status]));

  // active 在前（狀態字串 "active" > "ended" 的降序剛好符合），再依時間。
  const sorted = [...events].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  res.json({
    events: sorted.map((e) => ({
      id: e.id,
      title: e.title,
      summary: e.summary,
      category: e.category,
      scope: e.scope,
      kind: e.kind,
      stage: e.stage,
      canSpread: e.canSpread,
      cause: e.cause,
      status: e.status,
      severity: e.severity,
      turnsElapsed: e.turnsElapsed,
      affectsMe: nationAffected(e, {
        eventRegionIds: regionMap.get(e.id) ?? [],
        nationRegionIds,
        eventNationIds: nationMap.get(e.id) ?? [],
        nationId: nation.id,
      }),
      myResponseStatus: responseByEvent.get(e.id) ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});

router.get("/super-events/:id", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  const id = String(req.params.id);

  const [event] = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.id, id))
    .limit(1);
  if (!event) {
    res.status(404).json({ error: "找不到超事件" });
    return;
  }

  const [logs, regionRows, nationRows, nationRegionIds, myResponseRows] =
    await Promise.all([
      db
        .select()
        .from(superEventTurnLogsTable)
        .where(eq(superEventTurnLogsTable.eventId, id))
        .orderBy(desc(superEventTurnLogsTable.turnNumber)),
      db
        .select({ regionId: superEventRegionsTable.regionId })
        .from(superEventRegionsTable)
        .where(eq(superEventRegionsTable.eventId, id)),
      db
        .select({ nationId: superEventNationsTable.nationId })
        .from(superEventNationsTable)
        .where(eq(superEventNationsTable.eventId, id)),
      loadNationRegionIds(nation.id),
      db
        .select()
        .from(superEventResponsesTable)
        .where(
          and(
            eq(superEventResponsesTable.eventId, id),
            eq(superEventResponsesTable.nationId, nation.id),
          ),
        )
        .limit(1),
    ]);

  const regionIds = regionRows.map((r) => r.regionId);
  const nationIds = nationRows.map((r) => r.nationId);
  const mine = myResponseRows[0];

  res.json({
    id: event.id,
    title: event.title,
    summary: event.summary,
    narrative: event.narrative,
    category: event.category,
    scope: event.scope,
    kind: event.kind,
    stage: event.stage,
    canSpread: event.canSpread,
    cause: event.cause,
    status: event.status,
    severity: event.severity,
    turnsElapsed: event.turnsElapsed,
    affectsMe: nationAffected(event, {
      eventRegionIds: regionIds,
      nationRegionIds,
      eventNationIds: nationIds,
      nationId: nation.id,
    }),
    regionIds,
    grantedTechs: event.grantedTechs.map((g) => g.name),
    turnLogs: logs.map((l) => ({
      id: l.id,
      turnNumber: l.turnNumber,
      narrative: l.narrative,
      effectSummary: l.effectSummary,
      stage: l.stage,
      spreadRegionIds: l.spreadRegionIds,
      createdAt: l.createdAt.toISOString(),
    })),
    myResponse: mine
      ? {
          id: mine.id,
          responseText: mine.responseText,
          status: mine.status,
          resultTitle: mine.resultTitle,
          resultDescription: mine.resultDescription,
          createdAt: mine.createdAt.toISOString(),
          judgedAt: mine.judgedAt ? mine.judgedAt.toISOString() : null,
        }
      : null,
    createdAt: event.createdAt.toISOString(),
    endedAt: event.endedAt ? event.endedAt.toISOString() : null,
  });
});

router.post("/super-events/:id/response", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;
  const id = String(req.params.id);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const responseText = body["responseText"];
  if (typeof responseText !== "string" || responseText.trim().length === 0) {
    res.status(400).json({ error: "請輸入你的應對內容" });
    return;
  }
  const trimmed = responseText.trim();
  if (trimmed.length > RESPONSE_MAX_LENGTH) {
    res.status(400).json({ error: `應對內容最長 ${RESPONSE_MAX_LENGTH} 字` });
    return;
  }

  const [event] = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.id, id))
    .limit(1);
  if (!event) {
    res.status(404).json({ error: "找不到超事件" });
    return;
  }
  if (event.status !== "active") {
    res.status(400).json({ error: "此超事件已結束，無法再提交應對" });
    return;
  }

  const [regionRows, nationRows, nationRegionIds] = await Promise.all([
    db
      .select({ regionId: superEventRegionsTable.regionId })
      .from(superEventRegionsTable)
      .where(eq(superEventRegionsTable.eventId, id)),
    db
      .select({ nationId: superEventNationsTable.nationId })
      .from(superEventNationsTable)
      .where(eq(superEventNationsTable.eventId, id)),
    loadNationRegionIds(nation.id),
  ]);
  if (
    !nationAffected(event, {
      eventRegionIds: regionRows.map((r) => r.regionId),
      nationRegionIds,
      eventNationIds: nationRows.map((r) => r.nationId),
      nationId: nation.id,
    })
  ) {
    res.status(400).json({ error: "你的國家不在此超事件的影響範圍內" });
    return;
  }

  // 一國一則（覆寫）：重新提交會重置為 pending，等下回合 AI 判定。
  await db
    .insert(superEventResponsesTable)
    .values({
      eventId: id,
      nationId: nation.id,
      discordUserId: userId,
      responseText: trimmed,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [
        superEventResponsesTable.eventId,
        superEventResponsesTable.nationId,
      ],
      set: {
        responseText: trimmed,
        status: "pending",
        resultTitle: null,
        resultDescription: null,
        judgedAt: null,
        createdAt: new Date(),
      },
    });

  req.log.info(
    { eventId: id, nationId: nation.id },
    "super event response submitted",
  );
  res.json({ ok: true });
});

// ── 管理端（requireAdmin，raw-fetch，NOT in OpenAPI） ──────────────

/** 管理員：完整事件清單（含地區與應對統計）。 */
router.get("/super-events/admin/list", requireAdmin, async (_req, res) => {
  const events = await db
    .select()
    .from(superEventsTable)
    .orderBy(desc(superEventsTable.createdAt));
  const eventIds = events.map((e) => e.id);
  const [regionMap, nationMap] = await Promise.all([
    loadEventRegions(eventIds),
    loadEventNations(eventIds),
  ]);
  res.json({
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      summary: e.summary,
      narrative: e.narrative,
      category: e.category,
      scope: e.scope,
      kind: e.kind,
      stage: e.stage,
      canSpread: e.canSpread,
      cause: e.cause,
      status: e.status,
      severity: e.severity,
      impactPct: e.impactPct,
      turnsElapsed: e.turnsElapsed,
      maxTurns: e.maxTurns,
      aiContext: e.aiContext,
      targetStats: e.targetStats,
      grantedTechs: e.grantedTechs,
      regionIds: regionMap.get(e.id) ?? [],
      nationIds: nationMap.get(e.id) ?? [],
      createdAt: e.createdAt.toISOString(),
      endedAt: e.endedAt ? e.endedAt.toISOString() : null,
    })),
  });
});

/** 管理員：單一事件的玩家應對與每回合紀錄（唯讀）。 */
router.get(
  "/super-events/admin/:id/detail",
  requireAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [event] = await db
      .select()
      .from(superEventsTable)
      .where(eq(superEventsTable.id, id))
      .limit(1);
    if (!event) {
      res.status(404).json({ error: "找不到超事件" });
      return;
    }

    const [responseRows, logs, regionRows, nationRows] = await Promise.all([
      db
        .select({
          id: superEventResponsesTable.id,
          nationId: superEventResponsesTable.nationId,
          nationName: playerNationsTable.name,
          nationLeader: playerNationsTable.leaderName,
          isNpc: playerNationsTable.isNpc,
          responseText: superEventResponsesTable.responseText,
          status: superEventResponsesTable.status,
          resultTitle: superEventResponsesTable.resultTitle,
          resultDescription: superEventResponsesTable.resultDescription,
          createdAt: superEventResponsesTable.createdAt,
          judgedAt: superEventResponsesTable.judgedAt,
        })
        .from(superEventResponsesTable)
        .leftJoin(
          playerNationsTable,
          eq(superEventResponsesTable.nationId, playerNationsTable.id),
        )
        .where(eq(superEventResponsesTable.eventId, id))
        .orderBy(desc(superEventResponsesTable.createdAt)),
      db
        .select()
        .from(superEventTurnLogsTable)
        .where(eq(superEventTurnLogsTable.eventId, id))
        .orderBy(desc(superEventTurnLogsTable.turnNumber)),
      db
        .select({ regionId: superEventRegionsTable.regionId })
        .from(superEventRegionsTable)
        .where(eq(superEventRegionsTable.eventId, id)),
      db
        .select({
          nationId: superEventNationsTable.nationId,
          nationName: playerNationsTable.name,
          isNpc: playerNationsTable.isNpc,
        })
        .from(superEventNationsTable)
        .leftJoin(
          playerNationsTable,
          eq(superEventNationsTable.nationId, playerNationsTable.id),
        )
        .where(eq(superEventNationsTable.eventId, id)),
    ]);

    res.json({
      eventId: event.id,
      title: event.title,
      scope: event.scope,
      targetStats: event.targetStats,
      kind: event.kind,
      stage: event.stage,
      canSpread: event.canSpread,
      regionIds: regionRows.map((r) => r.regionId),
      nations: nationRows.map((r) => ({
        nationId: r.nationId,
        nationName: r.nationName ?? null,
        isNpc: r.isNpc ?? false,
      })),
      responses: responseRows.map((r) => ({
        id: r.id,
        nationId: r.nationId,
        nationName: r.nationName ?? null,
        nationLeader: r.nationLeader ?? null,
        isNpc: r.isNpc ?? false,
        responseText: r.responseText,
        status: r.status,
        resultTitle: r.resultTitle,
        resultDescription: r.resultDescription,
        createdAt: r.createdAt.toISOString(),
        judgedAt: r.judgedAt ? r.judgedAt.toISOString() : null,
      })),
      turnLogs: logs.map((l) => ({
        id: l.id,
        turnNumber: l.turnNumber,
        narrative: l.narrative,
        effectSummary: l.effectSummary,
        stage: l.stage,
        spreadRegionIds: l.spreadRegionIds,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  },
);

/** 管理員：手動建立事件。 */
router.post("/super-events/admin", requireAdmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const title = typeof b["title"] === "string" ? b["title"].trim() : "";
  if (!title) {
    res.status(400).json({ error: "請輸入事件標題" });
    return;
  }
  const scope =
    b["scope"] === "regional"
      ? "regional"
      : b["scope"] === "targeted"
        ? "targeted"
        : "global";
  const kind = b["kind"] === "opportunity" ? "opportunity" : "disaster";
  const canSpread = b["canSpread"] === true;
  const regionIds = parseIntIds(b["regionIds"]);
  const nationIds = parseUuidIds(b["nationIds"]);

  // 精準目標：regional 需至少一個地區、targeted 需至少一個國家（不再 silent 落到全球）。
  if (scope === "regional" && regionIds.length === 0) {
    res.status(400).json({ error: "地區型事件請至少選擇一個受影響地區" });
    return;
  }
  if (scope === "targeted" && nationIds.length === 0) {
    res.status(400).json({ error: "指定國家型事件請至少選擇一個目標國家" });
    return;
  }

  const severity = clampInt(b["severity"], 1, 100, 50);
  const impactPct = clampInt(b["impactPct"], 0, 500, 100);
  const maxTurns =
    b["maxTurns"] === null || b["maxTurns"] === undefined
      ? null
      : clampInt(b["maxTurns"], 1, 1000, 1);
  const targetStatsParsed = parseTargetStats(b["targetStats"]);
  if (!targetStatsParsed.ok) {
    res.status(400).json({ error: "目標數據含未知項目" });
    return;
  }

  const [created] = await db
    .insert(superEventsTable)
    .values({
      title,
      summary: typeof b["summary"] === "string" ? b["summary"].trim() : "",
      narrative:
        typeof b["narrative"] === "string" ? b["narrative"].trim() : "",
      category:
        typeof b["category"] === "string" && b["category"].trim()
          ? b["category"].trim()
          : "其他",
      scope,
      kind,
      canSpread: scope === "regional" ? canSpread : false,
      cause: "admin",
      status: "active",
      severity,
      impactPct,
      maxTurns,
      aiContext:
        typeof b["aiContext"] === "string" ? b["aiContext"].trim() : null,
      targetStats: targetStatsParsed.stats ?? null,
    })
    .returning({ id: superEventsTable.id });
  if (created && scope === "regional" && regionIds.length > 0) {
    await db
      .insert(superEventRegionsTable)
      .values(regionIds.map((regionId) => ({ eventId: created.id, regionId })))
      .onConflictDoNothing();
  }
  if (created && scope === "targeted" && nationIds.length > 0) {
    await db
      .insert(superEventNationsTable)
      .values(nationIds.map((nationId) => ({ eventId: created.id, nationId })))
      .onConflictDoNothing();
  }
  req.log.info({ eventId: created?.id }, "super event created by admin");
  if (created) {
    // 事件在下回合結算前不會被處理，先即時通知受影響玩家（fire-and-forget）。
    void notifyNewSuperEvent({ id: created.id, scope, title });
  }
  res.json({ ok: true, id: created?.id });
});

/**
 * 管理員：AI 立即生成一則事件。
 * scope 預設 global；regional 需 regionIds、targeted 需 nationIds（不再 silent 落到全球）。
 * targeted 時把目標國家名稱作為 focus 交給 AI，生成針對單一國家的內政劇變。
 */
router.post("/super-events/admin/generate", requireAdmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const genTargetStats = parseTargetStats(b["targetStats"]);
  if (!genTargetStats.ok) {
    res.status(400).json({ error: "目標數據含未知項目" });
    return;
  }
  const { currentEra } = await getEraSlugs();
  const scope =
    b["scope"] === "regional"
      ? "regional"
      : b["scope"] === "targeted"
        ? "targeted"
        : "global";
  const canSpread = b["canSpread"] === true;
  const regionIds = parseIntIds(b["regionIds"]);
  const nationIds = parseUuidIds(b["nationIds"]);

  if (scope === "regional" && regionIds.length === 0) {
    res.status(400).json({ error: "地區型事件請至少選擇一個受影響地區" });
    return;
  }
  if (scope === "targeted" && nationIds.length === 0) {
    res.status(400).json({ error: "指定國家型事件請至少選擇一個目標國家" });
    return;
  }

  // targeted：解析目標國家名稱，作為 AI 生成的聚焦對象（focus）。
  let focus: string | null = null;
  if (scope === "targeted") {
    const targets = await db
      .select({
        id: playerNationsTable.id,
        name: playerNationsTable.name,
      })
      .from(playerNationsTable)
      .where(inArray(playerNationsTable.id, nationIds));
    if (targets.length === 0) {
      res.status(400).json({ error: "找不到指定的目標國家" });
      return;
    }
    focus = targets
      .map((t) => t.name?.trim() || "（未命名國家）")
      .join("、");
  }

  // 生成敘事貼合受影響地區的地理人文：regional 用選定地區、targeted 用目標國家掌控
  // 地區、global 不注入（走中性導引）。查詢失敗回空字串，絕不阻斷生成。
  let geoContext = "";
  if (scope === "regional") {
    geoContext = await buildRegionSetGeoCultureContext(regionIds);
  } else if (scope === "targeted") {
    const targetRegions = await db
      .select({ regionId: regionControlsTable.regionId })
      .from(regionControlsTable)
      .where(inArray(regionControlsTable.nationId, nationIds));
    geoContext = await buildRegionSetGeoCultureContext(
      targetRegions.map((r) => r.regionId),
    );
  }

  try {
    const gen = await generateSuperEvent({
      eraSlug: currentEra,
      extraPrompt:
        typeof b["extraPrompt"] === "string" ? b["extraPrompt"] : null,
      kindHint:
        b["kind"] === "opportunity"
          ? "opportunity"
          : b["kind"] === "disaster"
            ? "disaster"
            : null,
      focus,
      geoContext,
      targetStats: genTargetStats.stats ?? null,
    });
    const [created] = await db
      .insert(superEventsTable)
      .values({
        title: gen.title,
        summary: gen.summary,
        narrative: gen.narrative,
        category: gen.category,
        scope,
        kind: gen.kind,
        canSpread: scope === "regional" ? canSpread : false,
        cause: "ai",
        status: "active",
        severity: gen.severity,
        targetStats: genTargetStats.stats ?? null,
      })
      .returning({ id: superEventsTable.id });
    if (created && scope === "regional" && regionIds.length > 0) {
      await db
        .insert(superEventRegionsTable)
        .values(
          regionIds.map((regionId) => ({ eventId: created.id, regionId })),
        )
        .onConflictDoNothing();
    }
    if (created && scope === "targeted" && nationIds.length > 0) {
      await db
        .insert(superEventNationsTable)
        .values(
          nationIds.map((nationId) => ({ eventId: created.id, nationId })),
        )
        .onConflictDoNothing();
    }
    req.log.info(
      { eventId: created?.id, scope },
      "super event generated by admin",
    );
    if (created) {
      // 事件在下回合結算前不會被處理，先即時通知受影響玩家。
      void notifyNewSuperEvent({
        id: created.id,
        scope,
        title: gen.title,
      });
    }
    res.json({ ok: true, id: created?.id });
  } catch (err) {
    req.log.error({ err }, "admin super event generation failed");
    res.status(502).json({ error: "AI 生成事件失敗，請稍後再試" });
  }
});

/** 管理員：編輯事件（omitted = 不變；scope=regional 時 regions 提供才全量替換）。 */
router.patch("/super-events/admin/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const [existing] = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "找不到超事件" });
    return;
  }

  const set: Record<string, unknown> = {};
  if (typeof b["title"] === "string" && b["title"].trim())
    set["title"] = b["title"].trim();
  if (typeof b["summary"] === "string") set["summary"] = b["summary"].trim();
  if (typeof b["narrative"] === "string")
    set["narrative"] = b["narrative"].trim();
  if (typeof b["category"] === "string" && b["category"].trim())
    set["category"] = b["category"].trim();
  if (
    b["scope"] === "global" ||
    b["scope"] === "regional" ||
    b["scope"] === "targeted"
  )
    set["scope"] = b["scope"];
  if (b["kind"] === "disaster" || b["kind"] === "opportunity")
    set["kind"] = b["kind"];
  if (b["stage"] !== undefined && typeof b["stage"] === "string") {
    const stages = ["outbreak", "spreading", "peak", "receding", "ended"];
    if (stages.includes(b["stage"])) set["stage"] = b["stage"];
  }
  if (typeof b["canSpread"] === "boolean") set["canSpread"] = b["canSpread"];
  if (b["status"] === "active" || b["status"] === "ended") {
    set["status"] = b["status"];
    set["endedAt"] = b["status"] === "ended" ? new Date() : null;
  }
  if (b["severity"] !== undefined)
    set["severity"] = clampInt(b["severity"], 1, 100, existing.severity);
  if (b["impactPct"] !== undefined)
    set["impactPct"] = clampInt(b["impactPct"], 0, 500, existing.impactPct);
  if (b["maxTurns"] !== undefined)
    set["maxTurns"] =
      b["maxTurns"] === null ? null : clampInt(b["maxTurns"], 1, 1000, 1);
  if (b["aiContext"] !== undefined)
    set["aiContext"] =
      typeof b["aiContext"] === "string" ? b["aiContext"].trim() : null;
  if (b["targetStats"] !== undefined) {
    const parsed = parseTargetStats(b["targetStats"]);
    if (!parsed.ok) {
      res.status(400).json({ error: "目標數據含未知項目" });
      return;
    }
    set["targetStats"] = parsed.stats ?? null;
  }

  // 精準目標：以「編輯後的最終狀態」驗證（不再 silent 落到全球）。scope 取本次修改後的值；
  // 目標地區／國家取本次是否有帶陣列，否則沿用既有。regional 需至少一地區、targeted 需至少一國家。
  const finalScope = (set["scope"] as string | undefined) ?? existing.scope;
  const finalRegionCount = Array.isArray(b["regionIds"])
    ? parseIntIds(b["regionIds"]).length
    : (await loadEventRegions([id])).get(id)?.length ?? 0;
  const finalNationCount = Array.isArray(b["nationIds"])
    ? parseUuidIds(b["nationIds"]).length
    : (await loadEventNations([id])).get(id)?.length ?? 0;
  if (finalScope === "regional" && finalRegionCount === 0) {
    res.status(400).json({ error: "地區型事件請至少選擇一個受影響地區" });
    return;
  }
  if (finalScope === "targeted" && finalNationCount === 0) {
    res.status(400).json({ error: "指定國家型事件請至少選擇一個目標國家" });
    return;
  }

  if (Object.keys(set).length > 0) {
    await db
      .update(superEventsTable)
      .set(set)
      .where(eq(superEventsTable.id, id));
  }

  if (Array.isArray(b["regionIds"])) {
    const regionIds = parseIntIds(b["regionIds"]);
    await db
      .delete(superEventRegionsTable)
      .where(eq(superEventRegionsTable.eventId, id));
    if (regionIds.length > 0) {
      await db
        .insert(superEventRegionsTable)
        .values(regionIds.map((regionId) => ({ eventId: id, regionId })))
        .onConflictDoNothing();
    }
  }

  if (Array.isArray(b["nationIds"])) {
    const nationIds = parseUuidIds(b["nationIds"]);
    await db
      .delete(superEventNationsTable)
      .where(eq(superEventNationsTable.eventId, id));
    if (nationIds.length > 0) {
      await db
        .insert(superEventNationsTable)
        .values(nationIds.map((nationId) => ({ eventId: id, nationId })))
        .onConflictDoNothing();
    }
  }

  req.log.info({ eventId: id }, "super event edited by admin");
  res.json({ ok: true });
});

/**
 * 管理員：單一事件的每國影響檢視（每回合 + 累計）。用於「影響檢視」面板。
 */
router.get(
  "/super-events/admin/:id/impacts",
  requireAdmin,
  async (req, res) => {
    const id = String(req.params.id);
    const [event] = await db
      .select({ id: superEventsTable.id })
      .from(superEventsTable)
      .where(eq(superEventsTable.id, id))
      .limit(1);
    if (!event) {
      res.status(404).json({ error: "找不到超事件" });
      return;
    }

    const rows = await db
      .select({
        nationId: superEventNationImpactsTable.nationId,
        nationName: playerNationsTable.name,
        isNpc: playerNationsTable.isNpc,
        turnNumber: superEventNationImpactsTable.turnNumber,
        populationDelta: superEventNationImpactsTable.populationDelta,
        productionDelta: superEventNationImpactsTable.productionDelta,
        satisfactionFarmersDelta:
          superEventNationImpactsTable.satisfactionFarmersDelta,
        satisfactionWorkersDelta:
          superEventNationImpactsTable.satisfactionWorkersDelta,
        satisfactionClergyDelta:
          superEventNationImpactsTable.satisfactionClergyDelta,
        satisfactionNoblesDelta:
          superEventNationImpactsTable.satisfactionNoblesDelta,
        stabilityDelta: superEventNationImpactsTable.stabilityDelta,
        unrestDelta: superEventNationImpactsTable.unrestDelta,
      })
      .from(superEventNationImpactsTable)
      .leftJoin(
        playerNationsTable,
        eq(superEventNationImpactsTable.nationId, playerNationsTable.id),
      )
      .where(eq(superEventNationImpactsTable.eventId, id))
      .orderBy(
        superEventNationImpactsTable.nationId,
        desc(superEventNationImpactsTable.turnNumber),
      );

    type Delta = {
      populationDelta: number;
      productionDelta: number;
      satisfactionFarmersDelta: number;
      satisfactionWorkersDelta: number;
      satisfactionClergyDelta: number;
      satisfactionNoblesDelta: number;
      stabilityDelta: number;
      unrestDelta: number;
    };
    const zero = (): Delta => ({
      populationDelta: 0,
      productionDelta: 0,
      satisfactionFarmersDelta: 0,
      satisfactionWorkersDelta: 0,
      satisfactionClergyDelta: 0,
      satisfactionNoblesDelta: 0,
      stabilityDelta: 0,
      unrestDelta: 0,
    });
    const add = (acc: Delta, r: Delta): void => {
      acc.populationDelta += r.populationDelta;
      acc.productionDelta += r.productionDelta;
      acc.satisfactionFarmersDelta += r.satisfactionFarmersDelta;
      acc.satisfactionWorkersDelta += r.satisfactionWorkersDelta;
      acc.satisfactionClergyDelta += r.satisfactionClergyDelta;
      acc.satisfactionNoblesDelta += r.satisfactionNoblesDelta;
      acc.stabilityDelta += r.stabilityDelta;
      acc.unrestDelta += r.unrestDelta;
    };

    const byNation = new Map<
      string,
      {
        nationId: string;
        nationName: string | null;
        isNpc: boolean;
        cumulative: Delta;
        turns: (Delta & { turnNumber: number })[];
      }
    >();
    for (const r of rows) {
      let entry = byNation.get(r.nationId);
      if (!entry) {
        entry = {
          nationId: r.nationId,
          nationName: r.nationName ?? null,
          isNpc: r.isNpc ?? false,
          cumulative: zero(),
          turns: [],
        };
        byNation.set(r.nationId, entry);
      }
      const delta: Delta = {
        populationDelta: r.populationDelta,
        productionDelta: r.productionDelta,
        satisfactionFarmersDelta: r.satisfactionFarmersDelta,
        satisfactionWorkersDelta: r.satisfactionWorkersDelta,
        satisfactionClergyDelta: r.satisfactionClergyDelta,
        satisfactionNoblesDelta: r.satisfactionNoblesDelta,
        stabilityDelta: r.stabilityDelta,
        unrestDelta: r.unrestDelta,
      };
      add(entry.cumulative, delta);
      entry.turns.push({ ...delta, turnNumber: r.turnNumber });
    }

    res.json({ eventId: id, nations: [...byNation.values()] });
  },
);

/** 管理員：刪除事件（cascade 清除地區／回合紀錄／應對）。 */
router.delete("/super-events/admin/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const deleted = await db
    .delete(superEventsTable)
    .where(eq(superEventsTable.id, id))
    .returning({ id: superEventsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "找不到超事件" });
    return;
  }
  req.log.info({ eventId: id }, "super event deleted by admin");
  res.json({ ok: true });
});

/** 管理員：讀取系統設定。 */
router.get("/super-events/admin/settings", requireAdmin, async (_req, res) => {
  const [settings] = await db
    .select()
    .from(superEventSettingsTable)
    .where(eq(superEventSettingsTable.id, 1))
    .limit(1);
  res.json({
    autoGenerateChancePct: settings?.autoGenerateChancePct ?? 5,
    globalImpactPct: settings?.globalImpactPct ?? 100,
    lossMinPct: settings?.lossMinPct ?? 0,
    lossMaxPct: settings?.lossMaxPct ?? 100,
    aiGenerationPrompt: settings?.aiGenerationPrompt ?? "",
  });
});

/** 管理員：更新系統設定。 */
router.put("/super-events/admin/settings", requireAdmin, async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const lossMinPct = clampInt(b["lossMinPct"], 0, 100, 0);
  const lossMaxPct = clampInt(b["lossMaxPct"], 0, 100, 100);
  if (lossMinPct > lossMaxPct) {
    res.status(400).json({ error: "損失下限不可大於損失上限" });
    return;
  }
  await db
    .update(superEventSettingsTable)
    .set({
      autoGenerateChancePct: clampInt(b["autoGenerateChancePct"], 0, 100, 5),
      globalImpactPct: clampInt(b["globalImpactPct"], 0, 500, 100),
      lossMinPct,
      lossMaxPct,
      aiGenerationPrompt:
        typeof b["aiGenerationPrompt"] === "string"
          ? b["aiGenerationPrompt"]
          : "",
    })
    .where(eq(superEventSettingsTable.id, 1));
  req.log.info("super event settings updated by admin");
  res.json({ ok: true });
});

function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 從請求 body 取出去重後的整數 id 陣列（地區 id）。 */
function parseIntIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const set = new Set<number>();
  for (const n of v) {
    if (typeof n === "number" && Number.isInteger(n)) set.add(n);
  }
  return [...set];
}

/** 從請求 body 取出去重後的字串 id 陣列（國家 uuid）。 */
function parseUuidIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const set = new Set<string>();
  for (const s of v) {
    if (typeof s === "string" && s.trim()) set.add(s.trim());
  }
  return [...set];
}

export { router as superEventsRouter };
