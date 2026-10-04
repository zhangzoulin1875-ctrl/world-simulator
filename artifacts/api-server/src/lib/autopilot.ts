import { and, desc, eq, gt } from "drizzle-orm";
import {
  db,
  autopilotSettingsTable,
  cabinetActionLogsTable,
  cabinetApprovalsTable,
  playerNationsTable,
  type AutopilotSettings,
  type AutopilotStyle,
  type CabinetMinister,
  type CabinetStyle,
  type PlayerNation,
} from "@workspace/db";
import { logger } from "./logger";
import {
  CABINET_DOMAINS,
  applyApproval,
  coerceAgencyLevel,
  getDomainModule,
  isCabinetDomainDisabled,
  type AgencyLevel,
  type CabinetDomain,
} from "./cabinet";

/**
 * AI 全權託管引擎。
 *
 * 重用內閣（cabinet）的 runDomain 管線——蒐集選項 → AI 規劃 → 程式把關後執行——
 * 但以「記憶體中的虛擬大臣」+「全授權」+「自動核准審批」取代玩家在場：
 *   1. 風格（穩健／均衡／擴張）→ 虛擬大臣的越權／膽小傾向與代理程度。
 *   2. 對每個未停用領域（內政、軍事；外交維持停用＝不主動宣戰）跑 runDomain。
 *   3. 跑完把該國新增的 pending 審批全部自動核准並執行（玩家決策：重大事項全自動）。
 *   4. 把本回合新增的行動紀錄摘要寫回 autopilot_settings.recent_actions。
 * 永不執行：退出國家、刪除國家（本模組完全不碰這兩個入口）。
 */

export const AUTOPILOT_RECENT_ACTIONS_MAX = 30;

/** 風格 → 虛擬大臣性格與代理程度（純函式，可單元測試）。 */
export function styleProfile(style: string): {
  cabinetStyle: CabinetStyle;
  agencyLevel: AgencyLevel;
  label: string;
  goalHint: string;
} {
  switch (style as AutopilotStyle) {
    case "steady":
      return {
        label: "穩健發展",
        agencyLevel: "conservative",
        cabinetStyle: {
          overreach: 50,
          timidity: 75,
          description:
            "穩健持重的國家總管：先保糧食與財政安全，再求科技與經濟成長，避免冒險與擴張。",
        },
        goalHint:
          "優先：糧食安全、國庫健康、科技與經濟成長；軍事只求足夠防守；不主動擴張。",
      };
    case "expansion":
      return {
        label: "擴張",
        agencyLevel: "aggressive",
        cabinetStyle: {
          overreach: 70,
          timidity: 25,
          description:
            "進取果敢的國家總管：積極投資建設與軍備，把握機會壯大國力。",
        },
        goalHint:
          "優先：積極建設、擴充軍備與科技、善用國庫；仍須維持糧食不饑荒、國庫不見底。",
      };
    case "balanced":
    default:
      return {
        label: "均衡",
        agencyLevel: "balanced",
        cabinetStyle: {
          overreach: 50,
          timidity: 50,
          description: "務實平衡的國家總管：在成長、安全與軍備間取得平衡。",
        },
        goalHint: "優先：糧食與財政穩定，其次均衡推進建設、科技與必要軍備。",
      };
  }
}

/** 組出餵給領域模組的「常駐方針」：風格目標 + 玩家自由文字 + 全權託管聲明。 */
export function buildAutopilotDirective(style: string, userDirective: string): string {
  const p = styleProfile(style);
  const parts = [
    `【全權託管】玩家不在線，由你代為管理整個國家，風格：${p.label}。${p.goalHint}`,
    "不得耗盡國庫；遇饑荒優先處理糧食；遭受攻擊時優先防守。",
  ];
  const extra = userDirective.trim();
  if (extra) parts.push(`玩家方針（優先遵從）：${extra}`);
  return parts.join("\n");
}

/** 建立記憶體中的虛擬大臣（不寫 DB、不占大臣名額）。 */
export function makeVirtualMinister(
  nation: PlayerNation,
  domain: CabinetDomain,
  cabinetStyle: CabinetStyle,
  era: string,
): CabinetMinister {
  const now = new Date();
  return {
    id: -1,
    nationId: nation.id,
    domain,
    name: "AI 託管總管",
    origin: "AI 全權託管",
    style: cabinetStyle,
    era,
    status: "active",
    createdAt: now,
    updatedAt: now,
  } as CabinetMinister;
}

/** 託管永不自動核准的動作鍵（玩家本人才能決定）。 */
export const NEVER_AUTO_APPROVE_ACTIONS: ReadonlySet<string> = new Set([
  "declare_war",
]);

/** 自動核准並執行該國所有 pending 審批（原子領取 → applyApproval）。回傳處理筆數。 */
export async function autoApprovePending(nation: PlayerNation): Promise<number> {
  const pending = await db
    .select()
    .from(cabinetApprovalsTable)
    .where(
      and(
        eq(cabinetApprovalsTable.nationId, nation.id),
        eq(cabinetApprovalsTable.status, "pending"),
      ),
    );
  let done = 0;
  for (const p of pending) {
    // 硬性護欄：託管絕不主動宣戰。與「外交領域是否停用」無關——即使日後重新
    // 啟用外交領域，宣戰仍須玩家本人決定，所以這裡一律否決清除。
    // 已停用領域（外交）的事項同樣不可批准：直接否決清除，避免佇列堆積。
    if (
      NEVER_AUTO_APPROVE_ACTIONS.has(p.actionKey) ||
      isCabinetDomainDisabled(p.domain as CabinetDomain)
    ) {
      await db
        .update(cabinetApprovalsTable)
        .set({ status: "rejected", resolvedAt: new Date() })
        .where(
          and(
            eq(cabinetApprovalsTable.id, p.id),
            eq(cabinetApprovalsTable.status, "pending"),
          ),
        );
      continue;
    }
    const [claimed] = await db
      .update(cabinetApprovalsTable)
      .set({ status: "approved", resolvedAt: new Date() })
      .where(
        and(
          eq(cabinetApprovalsTable.id, p.id),
          eq(cabinetApprovalsTable.status, "pending"),
        ),
      )
      .returning();
    if (!claimed) continue;
    try {
      await applyApproval(claimed, nation);
      done++;
    } catch (err) {
      logger.error(
        { err, approvalId: p.id, nationId: nation.id },
        "autopilot: auto-approval execution failed",
      );
    }
  }
  return done;
}

const AREA_LABELS: Record<string, string> = {
  interior: "內政",
  military: "軍事",
  diplomacy: "外交",
  politics: "政治",
  event: "事件",
};

/** 把本回合新增的內閣行動紀錄轉成託管行動摘要。 */
async function collectNewActions(
  nationId: string,
  afterLogId: number,
): Promise<Array<{ at: string; area: string; text: string; ok: boolean }>> {
  const rows = await db
    .select()
    .from(cabinetActionLogsTable)
    .where(
      and(
        eq(cabinetActionLogsTable.nationId, nationId),
        gt(cabinetActionLogsTable.id, afterLogId),
      ),
    )
    .orderBy(desc(cabinetActionLogsTable.id));
  return rows.map((r) => ({
    at: r.createdAt.toISOString(),
    area: AREA_LABELS[r.domain] ?? r.domain,
    text: r.summary,
    ok: true,
  }));
}

async function latestLogId(nationId: string): Promise<number> {
  const [row] = await db
    .select({ id: cabinetActionLogsTable.id })
    .from(cabinetActionLogsTable)
    .where(eq(cabinetActionLogsTable.nationId, nationId))
    .orderBy(desc(cabinetActionLogsTable.id))
    .limit(1);
  return row?.id ?? 0;
}

/** 把新行動併入 recent_actions（新到舊、截斷），並累加 turns_run。 */
export async function appendAutopilotActions(
  nationId: string,
  actions: Array<{ at: string; area: string; text: string; ok: boolean }>,
): Promise<void> {
  const [cur] = await db
    .select({ recent: autopilotSettingsTable.recentActions })
    .from(autopilotSettingsTable)
    .where(eq(autopilotSettingsTable.nationId, nationId))
    .limit(1);
  const merged = [...actions, ...(cur?.recent ?? [])].slice(
    0,
    AUTOPILOT_RECENT_ACTIONS_MAX,
  );
  await db
    .update(autopilotSettingsTable)
    .set({
      recentActions: merged,
      turnsRun: (await currentTurns(nationId)) + 1,
      updatedAt: new Date(),
    })
    .where(eq(autopilotSettingsTable.nationId, nationId));
}

async function currentTurns(nationId: string): Promise<number> {
  const [row] = await db
    .select({ n: autopilotSettingsTable.turnsRun })
    .from(autopilotSettingsTable)
    .where(eq(autopilotSettingsTable.nationId, nationId))
    .limit(1);
  return row?.n ?? 0;
}

/** 對單一託管國家跑一輪完整託管（內閣重用層）。政治／事件層由 autopilotExtras 處理。 */
export async function runAutopilotForNation(
  nation: PlayerNation,
  settings: AutopilotSettings,
  era: string,
): Promise<void> {
  if (!nation.discordUserId) return;
  const profile = styleProfile(settings.style);
  const directive = buildAutopilotDirective(settings.style, settings.directive);
  const beforeLogId = await latestLogId(nation.id);

  for (const domain of CABINET_DOMAINS) {
    if (isCabinetDomainDisabled(domain)) continue;
    const mod = getDomainModule(domain);
    try {
      await mod.runDomain({
        nation,
        minister: makeVirtualMinister(nation, domain, profile.cabinetStyle, era),
        settings: {
          nationId: nation.id,
          domain,
          directive,
          enabledActions: mod.actionKeys.map((a) => a.key),
          agencyLevel: profile.agencyLevel,
        } as never,
        // 全授權：託管期間該領域所有可代理項目一律啟用。
        enabledActionKeys: mod.actionKeys.map((a) => a.key),
        directive,
        agencyLevel: coerceAgencyLevel(profile.agencyLevel),
        era,
      });
    } catch (err) {
      logger.error(
        { err, nationId: nation.id, domain },
        "autopilot: domain runDomain failed",
      );
    }
  }

  // 大臣對重大事項只會「提案」；託管＝玩家授權全自動，立即核准並執行。
  const approved = await autoApprovePending(nation);
  const actions = await collectNewActions(nation.id, beforeLogId);

  // 政治與事件層（政策想法、政府決策、超級事件應對）。動態 import 打斷與
  // autopilotExtras 的循環匯入；失敗只記 log，不影響內閣層已完成的行動。
  try {
    const { runAutopilotExtras } = await import("./autopilotExtras");
    const extras = await runAutopilotExtras(nation, settings.style, settings.directive, era);
    const now = new Date().toISOString();
    for (const note of extras.notes) {
      actions.unshift({
        at: now,
        area: note.startsWith("應對事件") ? AREA_LABELS["event"]! : AREA_LABELS["politics"]!,
        text: note,
        ok: true,
      });
    }
  } catch (err) {
    logger.error({ err, nationId: nation.id }, "autopilot: extras failed");
    actions.unshift({
      at: new Date().toISOString(),
      area: AREA_LABELS["politics"]!,
      text: "政治／事件規劃本回合失敗（已略過）",
      ok: false,
    });
  }
  if (approved > 0) {
    logger.info({ nationId: nation.id, approved }, "autopilot: auto-approved proposals");
  }
  await appendAutopilotActions(nation.id, actions);
}

/**
 * 回合引擎入口：對所有「託管中」的國家各跑一輪。單一國家失敗不影響其他國家。
 * 託管要能在玩家不在線時運作，所以不依賴任何 session／請求脈絡。
 */
export async function runAutopilotTurn(era: string): Promise<{
  nations: number;
  failed: number;
}> {
  const rows = await db
    .select({ settings: autopilotSettingsTable, nation: playerNationsTable })
    .from(autopilotSettingsTable)
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, autopilotSettingsTable.nationId),
    )
    .where(eq(autopilotSettingsTable.enabled, true));

  let failed = 0;
  for (const { settings, nation } of rows) {
    try {
      await runAutopilotForNation(nation, settings, era);
    } catch (err) {
      failed++;
      logger.error(
        { err, nationId: nation.id },
        "autopilot: nation turn failed",
      );
    }
  }
  if (rows.length > 0) {
    logger.info(
      { nations: rows.length, failed },
      "turn engine: autopilot turn done",
    );
  }
  return { nations: rows.length, failed };
}
