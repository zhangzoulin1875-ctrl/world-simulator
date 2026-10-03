import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  cabinetActionLogsTable,
  cabinetApprovalsTable,
  cabinetCandidatesTable,
  cabinetDomainSettingsTable,
  cabinetMinistersTable,
  playerNationsTable,
  worldGameStateTable,
  type CabinetActionLog,
  type CabinetApproval,
  type CabinetCandidate,
  type CabinetDomainSettingsRow,
  type CabinetMinister,
  type PlayerNation,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { logger } from "../lib/logger";
import { aiRateLimit } from "../middlewares/aiRateLimit";
import { ERAS, getEraIndex } from "../lib/mapRegionEras";
import {
  AGENCY_LEVELS,
  AGENCY_LEVEL_LABELS,
  CABINET_DOMAINS,
  CABINET_DOMAIN_LABELS,
  CABINET_DOMAIN_SCOPES,
  coerceAgencyLevel,
  ensureDomainSettings,
  filterKnownActionKeys,
  getDomainModule,
  getNationTerritoryNames,
  isCabinetDomain,
  isCabinetDomainDisabled,
  applyApproval,
  type CabinetDomain,
} from "../lib/cabinet";
import { generateMinisterCandidates } from "../lib/cabinet/cabinetAi";
import { AiQuotaExceededError } from "../lib/gameAi";

const router: IRouter = Router();

/** 同 politics.ts 的 requirePlayer（session → 已建國的 nation）。 */
async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
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

function eraLabelOf(slug: string): string {
  return ERAS[getEraIndex(slug)]?.label ?? slug;
}

async function currentEra(): Promise<string> {
  const [state] = await db
    .select({ currentEra: worldGameStateTable.currentEra })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return state?.currentEra ?? ERAS[0]!.slug;
}

function serializeMinister(m: CabinetMinister) {
  return {
    id: m.id,
    domain: m.domain,
    name: m.name,
    origin: m.origin,
    style: m.style,
    era: m.era,
    eraLabel: eraLabelOf(m.era),
    status: m.status,
    createdAt: m.createdAt.toISOString(),
  };
}

function serializeCandidate(c: CabinetCandidate) {
  return {
    id: c.id,
    domain: c.domain,
    name: c.name,
    origin: c.origin,
    style: c.style,
  };
}

function serializeSettings(
  domain: CabinetDomain,
  s: CabinetDomainSettingsRow,
) {
  return {
    domain,
    directive: s.directive,
    agencyLevel: coerceAgencyLevel(s.agencyLevel),
    enabledActions: filterKnownActionKeys(domain, s.enabledActions),
  };
}

function serializeApproval(a: CabinetApproval) {
  return {
    id: a.id,
    domain: a.domain,
    domainLabel: CABINET_DOMAIN_LABELS[a.domain as CabinetDomain] ?? a.domain,
    actionKey: a.actionKey,
    summary: a.summary,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
  };
}

function serializeActionLog(l: CabinetActionLog) {
  return {
    id: l.id,
    domain: l.domain,
    domainLabel: CABINET_DOMAIN_LABELS[l.domain as CabinetDomain] ?? l.domain,
    actionKey: l.actionKey,
    summary: l.summary,
    mode: l.mode,
    costAmount: l.costAmount ?? null,
    costKind: l.costKind ?? null,
    turnDate: l.turnDate ?? null,
    createdAt: l.createdAt.toISOString(),
  };
}

/**
 * 內閣總覽：三領域各自的在任大臣、設定、可授權項目、候選人，加上待批准佇列。
 */
router.get("/cabinet/overview", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const [ministers, candidates, settingsRows, approvals, era] =
    await Promise.all([
      db
        .select()
        .from(cabinetMinistersTable)
        .where(
          and(
            eq(cabinetMinistersTable.nationId, nation.id),
            eq(cabinetMinistersTable.status, "active"),
          ),
        ),
      db
        .select()
        .from(cabinetCandidatesTable)
        .where(eq(cabinetCandidatesTable.nationId, nation.id))
        .orderBy(cabinetCandidatesTable.id),
      db
        .select()
        .from(cabinetDomainSettingsTable)
        .where(eq(cabinetDomainSettingsTable.nationId, nation.id)),
      db
        .select()
        .from(cabinetApprovalsTable)
        .where(
          and(
            eq(cabinetApprovalsTable.nationId, nation.id),
            eq(cabinetApprovalsTable.status, "pending"),
          ),
        )
        .orderBy(desc(cabinetApprovalsTable.createdAt))
        .limit(100),
      currentEra(),
    ]);

  const ministerByDomain = new Map(ministers.map((m) => [m.domain, m]));
  const settingsByDomain = new Map(settingsRows.map((s) => [s.domain, s]));

  const domains = CABINET_DOMAINS.map((domain) => {
    const mod = getDomainModule(domain);
    const minister = ministerByDomain.get(domain);
    const settings = settingsByDomain.get(domain);
    return {
      domain,
      label: CABINET_DOMAIN_LABELS[domain],
      scope: CABINET_DOMAIN_SCOPES[domain],
      disabled: isCabinetDomainDisabled(domain),
      minister: minister ? serializeMinister(minister) : null,
      candidates: candidates
        .filter((c) => c.domain === domain)
        .map(serializeCandidate),
      settings: settings
        ? serializeSettings(domain, settings)
        : { domain, directive: "", agencyLevel: "balanced" as const, enabledActions: [] },
      actionKeys: mod.actionKeys,
    };
  });

  res.json({
    era,
    eraLabel: eraLabelOf(era),
    agencyLevels: AGENCY_LEVELS.map((level) => ({
      value: level,
      label: AGENCY_LEVEL_LABELS[level],
    })),
    domains,
    pendingApprovals: approvals.map(serializeApproval),
  });
});

/** 生成某領域三位候選大臣（AI，quality 模型；aiRateLimit）。 */
router.post("/cabinet/domains/:domain/candidates", aiRateLimit, async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const domainParam = String(req.params.domain ?? "");
  if (!isCabinetDomain(domainParam)) {
    res.status(400).json({ error: "未知的內閣領域" });
    return;
  }
  const domain: CabinetDomain = domainParam;
  if (isCabinetDomainDisabled(domain)) {
    res.status(403).json({ error: "此內閣代理已停用，無法生成候選人" });
    return;
  }

  const [active] = await db
    .select({ id: cabinetMinistersTable.id })
    .from(cabinetMinistersTable)
    .where(
      and(
        eq(cabinetMinistersTable.nationId, nation.id),
        eq(cabinetMinistersTable.domain, domain),
        eq(cabinetMinistersTable.status, "active"),
      ),
    )
    .limit(1);
  if (active) {
    res.status(409).json({ error: "此職位已有在任大臣，請先卸任再重新任命" });
    return;
  }

  const era = await currentEra();
  const { regionNames, cityNames } = await getNationTerritoryNames(nation.id);

  let generated;
  try {
    generated = await generateMinisterCandidates({
      domain,
      nationName: nation.name,
      eraLabel: eraLabelOf(era),
      regionNames,
      cityNames,
    });
  } catch (err) {
    if (err instanceof AiQuotaExceededError) {
      // Task #593 — 內閣人選生成今日 token 配額用罄 → 503。
      res.status(503).json({ error: err.message });
      return;
    }
    logger.error({ err, nationId: nation.id, domain }, "cabinet candidate generation failed");
    res.status(502).json({ error: "內閣人選生成失敗，請稍後再試" });
    return;
  }

  // 全數替換該領域現有候選人（重生成 = 覆蓋）。
  const inserted = await db.transaction(async (tx) => {
    await tx
      .delete(cabinetCandidatesTable)
      .where(
        and(
          eq(cabinetCandidatesTable.nationId, nation.id),
          eq(cabinetCandidatesTable.domain, domain),
        ),
      );
    return tx
      .insert(cabinetCandidatesTable)
      .values(
        generated.map((c) => ({
          nationId: nation.id,
          domain,
          name: c.name,
          origin: c.origin,
          style: c.style,
          era,
        })),
      )
      .returning();
  });

  res.json({ candidates: inserted.map(serializeCandidate) });
});

const appointSchema = z.object({ candidateId: z.number().int().positive() });

/** 自候選人中任命某領域大臣；成功後清除該領域全部候選人。 */
router.post("/cabinet/domains/:domain/appoint", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const domainParam = String(req.params.domain ?? "");
  if (!isCabinetDomain(domainParam)) {
    res.status(400).json({ error: "未知的內閣領域" });
    return;
  }
  const domain: CabinetDomain = domainParam;
  if (isCabinetDomainDisabled(domain)) {
    res.status(403).json({ error: "此內閣代理已停用，無法任命大臣" });
    return;
  }

  const parsed = appointSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "缺少候選人編號" });
    return;
  }

  try {
    const minister = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(cabinetCandidatesTable)
        .where(
          and(
            eq(cabinetCandidatesTable.id, parsed.data.candidateId),
            eq(cabinetCandidatesTable.nationId, nation.id),
            eq(cabinetCandidatesTable.domain, domain),
          ),
        )
        .limit(1);
      if (!candidate) {
        throw new Error("CANDIDATE_NOT_FOUND");
      }
      const [existing] = await tx
        .select({ id: cabinetMinistersTable.id })
        .from(cabinetMinistersTable)
        .where(
          and(
            eq(cabinetMinistersTable.nationId, nation.id),
            eq(cabinetMinistersTable.domain, domain),
            eq(cabinetMinistersTable.status, "active"),
          ),
        )
        .limit(1);
      if (existing) {
        throw new Error("ALREADY_APPOINTED");
      }
      const [created] = await tx
        .insert(cabinetMinistersTable)
        .values({
          nationId: nation.id,
          domain,
          name: candidate.name,
          origin: candidate.origin,
          style: candidate.style,
          era: candidate.era,
          status: "active",
        })
        .returning();
      await tx
        .delete(cabinetCandidatesTable)
        .where(
          and(
            eq(cabinetCandidatesTable.nationId, nation.id),
            eq(cabinetCandidatesTable.domain, domain),
          ),
        );
      return created;
    });
    res.json({ minister: serializeMinister(minister) });
  } catch (err) {
    if (err instanceof Error && err.message === "CANDIDATE_NOT_FOUND") {
      res.status(404).json({ error: "找不到該候選人" });
      return;
    }
    if (err instanceof Error && err.message === "ALREADY_APPOINTED") {
      res.status(409).json({ error: "此職位已有在任大臣" });
      return;
    }
    throw err;
  }
});

/** 卸任某領域在任大臣。 */
router.post("/cabinet/domains/:domain/dismiss", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const domainParam = String(req.params.domain ?? "");
  if (!isCabinetDomain(domainParam)) {
    res.status(400).json({ error: "未知的內閣領域" });
    return;
  }
  const domain: CabinetDomain = domainParam;

  const dismissed = await db
    .update(cabinetMinistersTable)
    .set({ status: "dismissed" })
    .where(
      and(
        eq(cabinetMinistersTable.nationId, nation.id),
        eq(cabinetMinistersTable.domain, domain),
        eq(cabinetMinistersTable.status, "active"),
      ),
    )
    .returning({ id: cabinetMinistersTable.id });
  if (dismissed.length === 0) {
    res.status(404).json({ error: "此職位目前沒有在任大臣" });
    return;
  }
  res.json({ ok: true });
});

const settingsSchema = z.object({
  directive: z.string().trim().max(1000).optional(),
  agencyLevel: z.enum(AGENCY_LEVELS).optional(),
  enabledActions: z.array(z.string()).max(50).optional(),
});

/** 更新某領域設定：常駐方針、代理程度、可授權項目。 */
router.put("/cabinet/domains/:domain/settings", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const domainParam = String(req.params.domain ?? "");
  if (!isCabinetDomain(domainParam)) {
    res.status(400).json({ error: "未知的內閣領域" });
    return;
  }
  const domain: CabinetDomain = domainParam;

  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "設定格式不正確" });
    return;
  }

  await ensureDomainSettings(nation.id, domain);

  const update: Partial<CabinetDomainSettingsRow> = {};
  if (parsed.data.directive !== undefined) update.directive = parsed.data.directive;
  if (parsed.data.agencyLevel !== undefined) update.agencyLevel = parsed.data.agencyLevel;
  if (parsed.data.enabledActions !== undefined) {
    // 僅保留本領域已宣告的 actionKeys（去除未知 key）。
    update.enabledActions = filterKnownActionKeys(domain, parsed.data.enabledActions);
  }

  if (Object.keys(update).length > 0) {
    await db
      .update(cabinetDomainSettingsTable)
      .set(update)
      .where(
        and(
          eq(cabinetDomainSettingsTable.nationId, nation.id),
          eq(cabinetDomainSettingsTable.domain, domain),
        ),
      );
  }

  const settings = await ensureDomainSettings(nation.id, domain);
  res.json({ settings: serializeSettings(domain, settings) });
});

/** 批准待批准事項 → 轉派該領域模組 executeApproved（地基階段為 no-op）。 */
router.post("/cabinet/approvals/:id/approve", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const id = Number.parseInt(req.params.id ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "無效的編號" });
    return;
  }

  // 已停用領域（如外交）的待批准事項不可批准，僅能否決清除。
  const [pending] = await db
    .select({ domain: cabinetApprovalsTable.domain })
    .from(cabinetApprovalsTable)
    .where(
      and(
        eq(cabinetApprovalsTable.id, id),
        eq(cabinetApprovalsTable.nationId, nation.id),
        eq(cabinetApprovalsTable.status, "pending"),
      ),
    )
    .limit(1);
  if (!pending) {
    res.status(404).json({ error: "找不到待批准事項，或已處理" });
    return;
  }
  if (
    isCabinetDomain(pending.domain) &&
    isCabinetDomainDisabled(pending.domain)
  ) {
    res
      .status(403)
      .json({ error: "此內閣代理已停用，無法批准此事項；可否決以清除" });
    return;
  }

  const claimed = await db
    .update(cabinetApprovalsTable)
    .set({ status: "approved", resolvedAt: new Date() })
    .where(
      and(
        eq(cabinetApprovalsTable.id, id),
        eq(cabinetApprovalsTable.nationId, nation.id),
        eq(cabinetApprovalsTable.status, "pending"),
      ),
    )
    .returning();
  const approval = claimed[0];
  if (!approval) {
    res.status(404).json({ error: "找不到待批准事項，或已處理" });
    return;
  }

  try {
    await applyApproval(approval, nation);
  } catch (err) {
    logger.error({ err, approvalId: id }, "cabinet approval execution failed");
    res.status(502).json({ error: "執行批准事項失敗，請稍後再試" });
    return;
  }

  res.json({ ok: true });
});

/** 否決待批准事項。 */
router.post("/cabinet/approvals/:id/reject", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const id = Number.parseInt(req.params.id ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "無效的編號" });
    return;
  }

  const rejected = await db
    .update(cabinetApprovalsTable)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(
      and(
        eq(cabinetApprovalsTable.id, id),
        eq(cabinetApprovalsTable.nationId, nation.id),
        eq(cabinetApprovalsTable.status, "pending"),
      ),
    )
    .returning({ id: cabinetApprovalsTable.id });
  if (rejected.length === 0) {
    res.status(404).json({ error: "找不到待批准事項，或已處理" });
    return;
  }
  res.json({ ok: true });
});

/**
 * 內閣行動紀錄：自動執行與提報批准的歷史，回合新→舊排序，可依領域篩選。
 */
router.get("/cabinet/action-log", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const domainRaw = typeof req.query.domain === "string" ? req.query.domain : "";
  const domainFilter = isCabinetDomain(domainRaw) ? domainRaw : null;

  const rows = await db
    .select()
    .from(cabinetActionLogsTable)
    .where(
      domainFilter
        ? and(
            eq(cabinetActionLogsTable.nationId, nation.id),
            eq(cabinetActionLogsTable.domain, domainFilter),
          )
        : eq(cabinetActionLogsTable.nationId, nation.id),
    )
    .orderBy(desc(cabinetActionLogsTable.id))
    .limit(200);

  res.json({ logs: rows.map(serializeActionLog) });
});

export default router;
