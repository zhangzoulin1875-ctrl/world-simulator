import { and, eq } from "drizzle-orm";
import {
  db,
  aiPregenCacheTable,
  type PlayerNation,
  type FinancePendingIdea,
  type PoliticsPendingIdea,
} from "@workspace/db";
import { getCurrentEraSlug } from "./nationStats";
import { effectiveTaxEfficiencyPct } from "./economy";
import { buildNationGeoCultureContext } from "./nationGeoCulture";
import { getPoliticsSettings } from "./politicsSettings";
import { isPoliticsDirection } from "./politics";
import { loadActivePolicySummaries } from "./politicsActivePolicies";
import type { ActivePolicySummary } from "./politicsAi";

/**
 * AI 閒時預產（v3）— 快取鍵與存取層。
 *
 * 「不急但重要」的 AI 判定（財政／政治政策想法）可在 AI 佇列閒置時預先
 * 生成，結果存入 ai_pregen_cache；回合結算時以「輸入雜湊」比對，相符才
 * 取用（原子 DELETE...RETURNING，取用即消耗），不符照舊打 AI。玩家改了
 * 想法 → 輸入不同 → 快取自動失效。預產結果「只有」結算會讀取，玩家在
 * 結算前完全看不到。
 */

import { hashPregenInput } from "./aiPregenHash";

export const PREGEN_KIND_FISCAL = "fiscal_idea";
export const PREGEN_KIND_POLITICS = "politics_idea";

export { hashPregenInput };

/** 財政政策判定的完整輸入（與 financeSettlement.settleNation 逐欄位一致）。 */
export async function buildFiscalJudgeInput(
  nation: PlayerNation,
  pending: Pick<FinancePendingIdea, "idea">,
): Promise<{ input: Record<string, unknown>; hash: string }> {
  const eraSlug = await getCurrentEraSlug();
  const geoContext = await buildNationGeoCultureContext(nation.id);
  const input = {
    kind: PREGEN_KIND_FISCAL,
    government: nation.government,
    eraSlug,
    currentTaxRatePct: nation.taxRatePct,
    taxEfficiencyPct: effectiveTaxEfficiencyPct(eraSlug, nation.taxEfficiencyBonus),
    idea: pending.idea,
    geoContext,
  };
  return { input, hash: hashPregenInput(input) };
}

/** 政治政策判定的完整輸入（與 politicsSettlement.judgeIdea 逐欄位一致）。 */
export async function buildPoliticsJudgeInput(
  nation: PlayerNation,
  pending: Pick<PoliticsPendingIdea, "idea" | "direction">,
  preloadedSettings?: Awaited<ReturnType<typeof getPoliticsSettings>>,
  preloadedActivePolicies?: readonly ActivePolicySummary[],
): Promise<{ input: Record<string, unknown>; hash: string }> {
  const eraSlug = await getCurrentEraSlug();
  const geoContext = await buildNationGeoCultureContext(nation.id);
  const settings = preloadedSettings ?? (await getPoliticsSettings());
  // 現行制度清單也進雜湊：玩家在預產與結算之間廢除／新增制度 → 雜湊不
  // 符 → 快取自動失效，改為現場判定（與 idea/政治註記同樣的防護）。
  const activePolicies =
    preloadedActivePolicies ?? (await loadActivePolicySummaries(nation.id));
  const legacyDirection = isPoliticsDirection(pending.direction)
    ? pending.direction
    : null;
  const input = {
    kind: PREGEN_KIND_POLITICS,
    government: nation.government,
    // 與 settlement 的 judgeIdea 完全一致：非法/新制列傳 null（GENERAL
    // 只用於結算落地時的 entry direction，不是 AI 輸入）。
    direction: legacyDirection,
    eraSlug,
    idea: pending.idea,
    politicalNote: nation.politicalNote ?? null,
    activePolicies,
    geoContext,
    settings,
  };
  return { input, hash: hashPregenInput(input) };
}

/**
 * 原子取用預產結果：輸入雜湊相符才刪除該列並回傳結果（取用即消耗，
 * 同一結果絕不會被兩次結算重複套用）；不符或無列回傳 undefined。
 */
export async function takePregenResult<T>(
  kind: string,
  nationId: string,
  inputHash: string,
): Promise<T | undefined> {
  const rows = await db
    .delete(aiPregenCacheTable)
    .where(
      and(
        eq(aiPregenCacheTable.kind, kind),
        eq(aiPregenCacheTable.nationId, nationId),
        eq(aiPregenCacheTable.inputHash, inputHash),
      ),
    )
    .returning({ result: aiPregenCacheTable.result });
  return rows[0]?.result as T | undefined;
}

/** 寫入／覆寫預產結果（一國一 kind 一列）。 */
export async function storePregenResult(
  kind: string,
  nationId: string,
  inputHash: string,
  result: unknown,
): Promise<void> {
  await db
    .insert(aiPregenCacheTable)
    .values({ kind, nationId, inputHash, result })
    .onConflictDoUpdate({
      target: [aiPregenCacheTable.nationId, aiPregenCacheTable.kind],
      set: { inputHash, result, createdAt: new Date() },
    });
}
