import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  cabinetActionLogsTable,
  cabinetApprovalsTable,
  cabinetCandidatesTable,
  cabinetDomainSettingsTable,
  cabinetMinistersTable,
  mapCitiesTable,
  mapRegionsTable,
  playerNationsTable,
  regionControlsTable,
  type CabinetApproval,
  type CabinetDomainSettingsRow,
  type PlayerNation,
} from "@workspace/db";
import { logger } from "../logger";
import { localDateString } from "../time";
import {
  CABINET_DOMAINS,
  CABINET_DOMAIN_LABELS,
  isAgencyLevel,
  isCabinetDomainDisabled,
  type AgencyLevel,
  type CabinetDomain,
} from "./types";
import { getDomainModule, filterKnownActionKeys } from "./registry";
import {
  notifyCabinetApprovalPending,
  notifyCabinetMinistersRenewed,
} from "./cabinetNotify";

export * from "./types";
export * from "./style";
export * from "./registry";

/**
 * Task #242 — 內閣共用執行期 helper（地基）。所有領域共用；下游任務不改本檔。
 */

/** 國家掌控領土的地區與城市名稱（供 AI 生成大臣的歷史人物參考）。 */
export async function getNationTerritoryNames(
  nationId: string,
): Promise<{ regionNames: string[]; cityNames: string[] }> {
  const regionRows = await db
    .select({ name: mapRegionsTable.name })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, regionControlsTable.regionId),
    )
    .where(eq(regionControlsTable.nationId, nationId));
  const regionNames = regionRows.map((r) => r.name);

  const cityRows = await db
    .select({ name: mapCitiesTable.name })
    .from(mapCitiesTable)
    .innerJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapCitiesTable.regionId),
    )
    .where(eq(regionControlsTable.nationId, nationId));
  const cityNames = cityRows.map((r) => r.name);

  return { regionNames, cityNames };
}

/** 讀取（或建立）某國某領域的設定列，保證回傳可用值。 */
export async function ensureDomainSettings(
  nationId: string,
  domain: CabinetDomain,
): Promise<CabinetDomainSettingsRow> {
  const [existing] = await db
    .select()
    .from(cabinetDomainSettingsTable)
    .where(
      and(
        eq(cabinetDomainSettingsTable.nationId, nationId),
        eq(cabinetDomainSettingsTable.domain, domain),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(cabinetDomainSettingsTable)
    .values({ nationId, domain })
    .onConflictDoNothing({
      target: [
        cabinetDomainSettingsTable.nationId,
        cabinetDomainSettingsTable.domain,
      ],
    })
    .returning();
  if (created) return created;
  // 併發下另一請求已插入 → 再讀一次。
  const [row] = await db
    .select()
    .from(cabinetDomainSettingsTable)
    .where(
      and(
        eq(cabinetDomainSettingsTable.nationId, nationId),
        eq(cabinetDomainSettingsTable.domain, domain),
      ),
    )
    .limit(1);
  return row;
}

/** 代理程度字串 → AgencyLevel（未知值退回 balanced）。 */
export function coerceAgencyLevel(value: string): AgencyLevel {
  return isAgencyLevel(value) ? value : "balanced";
}

/** 內閣行動紀錄保留上限：每國僅保留最新 N 列。 */
export const CABINET_ACTION_LOG_RETENTION = 200;

/** 行動花費種類（金錢／科技點數／生產力）。 */
export type CabinetCostKind = "money" | "tech" | "production";

export interface CabinetActionCost {
  amount: number;
  kind: CabinetCostKind;
}

/**
 * 寫入一筆內閣行動紀錄（自動執行或送審批），並修剪每國舊紀錄至保留上限。
 * fire-and-forget 語意：內部自行吞錯只記 log，永不影響主流程。
 */
export async function recordCabinetAction(params: {
  nationId: string;
  domain: CabinetDomain;
  actionKey: string;
  summary: string;
  mode: "auto" | "approval";
  cost?: CabinetActionCost | null;
  turnDate?: string;
}): Promise<void> {
  try {
    await db.insert(cabinetActionLogsTable).values({
      nationId: params.nationId,
      domain: params.domain,
      actionKey: params.actionKey,
      summary: params.summary,
      mode: params.mode,
      costAmount: params.cost?.amount ?? null,
      costKind: params.cost?.kind ?? null,
      turnDate: params.turnDate ?? localDateString(new Date()),
    });
    // 只保留最新 N 列；併發下各自多刪／少刪一列無礙（下次寫入會再修正）。
    await db.execute(sql`
      DELETE FROM cabinet_action_logs
      WHERE nation_id = ${params.nationId}
        AND id NOT IN (
          SELECT id FROM cabinet_action_logs
          WHERE nation_id = ${params.nationId}
          ORDER BY id DESC
          LIMIT ${CABINET_ACTION_LOG_RETENTION}
        )
    `);
  } catch (err) {
    logger.warn(
      { err, nationId: params.nationId, domain: params.domain },
      "cabinet action log record failed",
    );
  }
}

/**
 * 大臣提出待批准事項：寫入 approvals 佇列、通知玩家並記錄行動紀錄。
 * 供下游領域模組的 runDomain 呼叫。
 */
export async function proposeApproval(params: {
  nation: PlayerNation;
  domain: CabinetDomain;
  ministerName: string;
  actionKey: string;
  summary: string;
  params?: unknown;
  cost?: CabinetActionCost | null;
}): Promise<CabinetApproval> {
  const [row] = await db
    .insert(cabinetApprovalsTable)
    .values({
      nationId: params.nation.id,
      domain: params.domain,
      actionKey: params.actionKey,
      summary: params.summary,
      params: params.params ?? {},
    })
    .returning();
  notifyCabinetApprovalPending({
    discordUserId: params.nation.discordUserId,
    ministerName: params.ministerName,
    domainLabel: CABINET_DOMAIN_LABELS[params.domain],
    summary: params.summary,
  });
  await recordCabinetAction({
    nationId: params.nation.id,
    domain: params.domain,
    actionKey: params.actionKey,
    summary: params.summary,
    mode: "approval",
    cost: params.cost ?? null,
  });
  return row;
}

/**
 * 玩家批准某待批准事項後執行：轉派給該領域模組的 executeApproved。
 * 地基階段 executeApproved 為 no-op，故此處僅完成轉派骨架。
 */
export async function applyApproval(
  approval: CabinetApproval,
  nation: PlayerNation,
): Promise<void> {
  const domain = approval.domain as CabinetDomain;
  const mod = getDomainModule(domain);
  await mod.executeApproved({ nation, approval });
}

/**
 * 時代更替：所有在任大臣卸任（status=dead）、清除全部候選人，並通知玩家
 * 重新任命。回傳受影響的國家 discordUserId（供通知）。冪等：只轉換 active 列。
 */
export async function renewCabinetForEraChange(
  eraLabel: string,
): Promise<void> {
  const dead = await db
    .update(cabinetMinistersTable)
    .set({ status: "dead" })
    .where(eq(cabinetMinistersTable.status, "active"))
    .returning({ nationId: cabinetMinistersTable.nationId });

  // 候選人一律清空（新時代需重新生成）。
  await db.delete(cabinetCandidatesTable);

  if (dead.length === 0) return;

  const nationIds = [...new Set(dead.map((d) => d.nationId))];
  const owners = await db
    .select({
      id: playerNationsTable.id,
      discordUserId: playerNationsTable.discordUserId,
    })
    .from(playerNationsTable)
    .where(
      and(
        inArray(playerNationsTable.id, nationIds),
        isNotNull(playerNationsTable.discordUserId),
      ),
    );
  for (const owner of owners) {
    notifyCabinetMinistersRenewed({
      discordUserId: owner.discordUserId,
      eraLabel,
    });
  }
}

/**
 * 每回合內閣自動代理：對每位在任大臣呼叫其領域模組的 runDomain。
 * 每位大臣獨立包 try/catch，一位失敗不影響其他。地基階段 runDomain 為 no-op。
 */
export async function runCabinetTurn(era: string): Promise<void> {
  const ministers = await db
    .select()
    .from(cabinetMinistersTable)
    .where(eq(cabinetMinistersTable.status, "active"));
  if (ministers.length === 0) return;

  const nationIds = [...new Set(ministers.map((m) => m.nationId))];
  const nations = await db
    .select()
    .from(playerNationsTable)
    .where(inArray(playerNationsTable.id, nationIds));
  const nationById = new Map(nations.map((n) => [n.id, n]));

  for (const minister of ministers) {
    const nation = nationById.get(minister.nationId);
    if (!nation) continue;
    const domain = minister.domain as CabinetDomain;
    if (!CABINET_DOMAINS.includes(domain)) continue;
    // 已停用領域（如外交）不再自動代理。
    if (isCabinetDomainDisabled(domain)) continue;
    try {
      const settings = await ensureDomainSettings(nation.id, domain);
      const enabledActionKeys = filterKnownActionKeys(
        domain,
        settings.enabledActions,
      );
      await getDomainModule(domain).runDomain({
        nation,
        minister,
        settings,
        enabledActionKeys,
        directive: settings.directive,
        agencyLevel: coerceAgencyLevel(settings.agencyLevel),
        era,
      });
    } catch (err) {
      logger.error(
        { err, nationId: nation.id, domain },
        "cabinet runDomain failed for minister",
      );
    }
  }
}

/** 供健檢／測試：某國各領域在任大臣數（應 ≤1）。 */
export async function countActiveMinisters(
  nationId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cabinetMinistersTable)
    .where(
      and(
        eq(cabinetMinistersTable.nationId, nationId),
        eq(cabinetMinistersTable.status, "active"),
      ),
    );
  return row?.n ?? 0;
}
