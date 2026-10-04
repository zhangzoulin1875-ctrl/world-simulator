import { and, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db,
  mapRegionsTable,
  playerNationsTable,
  warCampaignsTable,
  type PlayerNation,
} from "@workspace/db";
import { computeNationStats, getStatsEraSlug } from "./nationStats";
import { computeNationFoodReport } from "./foodData";
import {
  formatActivePoliciesLine,
  type ActivePolicySummary,
} from "./politicsAi";
import { BUILDING_LABEL, BUILDING_TYPES } from "./regionBuildings";
import { BUILDINGS } from "./production";

/**
 * 國情快照（2026-10「AI 不知道世界實況」問題的统一解）。
 *
 * 背景：玩家提出「安撫民心」時 AI 不知道正在打仗、提「興建電影院」時 AI
 * 不知道世界真實存在的建築只有哪幾種。與其把每種想法硬接到真實機制（無
 * 底洞），不如餵給 AI 一段「國家現況」快照：戰爭、國力、糧食、現行制度、
 * 真實建築清單，讓判定貼合實況，並由各 AI 模組的規則行處理「敘事性建設
 * 成功也只是一段敘事＋抽象數值」的語意。
 *
 * 快照內容全部來自 DB 現值，具確定性（同一時刻兩端呼叫內容一致），因此
 * 直接把產出的 prompt 字串放進預產雜湊：預產與結算之間局勢變動（新戰役、
 * 數值結算）→ 雜湊不符 → 快取自動失效改現場判定（與想法變動同一防護）。
 */

/** 快照選項。 */
export interface NationContextOptions {
  /** 現行制度清單（沿用 politicsActivePolicies 的載入器）；提供時加入「現行制度」行。 */
  activePolicies?: readonly ActivePolicySummary[] | null;
  /** true＝只輸出戰爭狀態＋現行制度（內政大臣已有自己的國力／糧食報告）。 */
  minimal?: boolean;
}

/** 世界真實建築一行（常數，所有快照共用）。 */
export const REAL_BUILDINGS_LINE = `世界真實建築（僅這些可實際建造，其餘設施皆為敘事性）：城市建築＝${BUILDINGS.map((b) => b.name).join("、")}；地區建築＝${BUILDING_TYPES.map((t) => BUILDING_LABEL[t]).join("、")}`;

/**
 * 組出「── 國家現況 ──」段落（多行 zh-TW，直接插入 user prompt；兩端一致）。
 * 各子段撈取失敗只跳過該行，不讓快照拖垮判定主流程。
 */
export async function buildNationContext(
  nation: PlayerNation,
  eraSlug: string,
  options: NationContextOptions = {},
): Promise<string> {
  const lines: string[] = ["── 國家現況 ──"];

  // 戰爭狀態（多戰線以「；」連接）。
  try {
    lines.push(await buildWarLine(nation));
  } catch {
    /* 跳過 */
  }

  if (!options.minimal) {
    // 國力與內政數值（人口需要 stats era 的地區統計）。
    try {
      const statsEra = await getStatsEraSlug();
      const stats = await computeNationStats(nation.id, statsEra);
      lines.push(
        `國力：國庫 ${Math.round(nation.money).toLocaleString("en-US")} 金、人口 ${stats.population.toLocaleString("en-US")}、稅率 ${nation.taxRatePct}%`,
      );
      lines.push(
        `內政：穩定 ${Math.round(nation.stability)}/100、暴動 ${Math.round(nation.unrest)}/100、厭戰 ${Math.round(nation.warWeariness)}/100`,
      );
      lines.push(
        `滿意度：農 ${Math.round(nation.satisfactionFarmers)}/工 ${Math.round(nation.satisfactionWorkers)}/貴 ${Math.round(nation.satisfactionNobles)}/教 ${Math.round(nation.satisfactionClergy)}/軍 ${Math.round(nation.satisfactionMilitary)}`,
      );
    } catch {
      /* 跳過 */
    }

    // 糧食報告（需要玩家科技紀錄；NPC 無 discordUserId 時略過）。
    if (nation.discordUserId !== null) {
      try {
        const report = await computeNationFoodReport(nation, eraSlug);
        const balance = Math.round(report.balance);
        lines.push(
          `糧食：產 ${Math.round(report.production.total).toLocaleString("en-US")}／耗 ${Math.round(report.consumption.total).toLocaleString("en-US")}／結餘 ${balance.toLocaleString("en-US")}${report.famine ? "（⚠️ 饑荒中）" : ""}`,
        );
      } catch {
        /* 跳過 */
      }
    }

    lines.push(REAL_BUILDINGS_LINE);
  }

  // 現行制度（與 politicsAi 各判定點自帶的清單同一來源；這裡只在大宗
  // 快照（財政）或 minimal 模式（內政大臣）時提供，避免重複行）。
  const policyLine = formatActivePoliciesLine(options.activePolicies);
  if (policyLine !== "") lines.push(policyLine);

  return lines.join("\n");
}

/** 戰爭狀態行：進行中戰役（對象／我方角色／爭奪地區／已結算期數）。 */
async function buildWarLine(nation: PlayerNation): Promise<string> {
  const attackerNation = alias(playerNationsTable, "ctx_att_nation");
  const defenderNation = alias(playerNationsTable, "ctx_def_nation");
  const attackerRegion = alias(mapRegionsTable, "ctx_att_region");
  const defenderRegion = alias(mapRegionsTable, "ctx_def_region");
  const campaigns = await db
    .select({
      id: warCampaignsTable.id,
      attackerNationId: warCampaignsTable.attackerNationId,
      defenderNationId: warCampaignsTable.defenderNationId,
      cycleNumber: warCampaignsTable.cycleNumber,
      attackerName: attackerNation.name,
      defenderName: defenderNation.name,
      defenderRegionName: defenderRegion.name,
      attackerRegionName: attackerRegion.name,
    })
    .from(warCampaignsTable)
    .innerJoin(attackerNation, eq(attackerNation.id, warCampaignsTable.attackerNationId))
    .innerJoin(defenderNation, eq(defenderNation.id, warCampaignsTable.defenderNationId))
    .innerJoin(defenderRegion, eq(defenderRegion.id, warCampaignsTable.defenderRegionId))
    .innerJoin(attackerRegion, eq(attackerRegion.id, warCampaignsTable.attackerRegionId))
    .where(
      and(
        eq(warCampaignsTable.status, "active"),
        or(
          eq(warCampaignsTable.attackerNationId, nation.id),
          eq(warCampaignsTable.defenderNationId, nation.id),
        ),
      ),
    )
    .orderBy(warCampaignsTable.id);

  if (campaigns.length === 0) {
    return "戰爭狀態：承平時期（無進行中戰役）";
  }
  const parts = campaigns.map((c) => {
    const isAttacker = c.attackerNationId === nation.id;
    const enemy = isAttacker ? c.defenderName : c.attackerName;
    const role = isAttacker ? "進攻方" : "防守方";
    const region = isAttacker ? c.defenderRegionName : c.attackerRegionName;
    return `與「${enemy}」交戰中（我方為${role}，爭奪地區：${region}，已歷 ${c.cycleNumber} 期）`;
  });
  return `戰爭狀態：${parts.join("；")}`;
}
