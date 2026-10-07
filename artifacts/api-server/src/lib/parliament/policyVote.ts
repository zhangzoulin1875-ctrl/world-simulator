/**
 * 議會政策表決 — DB 層。
 * 純規則在 vote.ts；這裡負責「讀該國議會 → 判斷要不要表決 → 算票」。
 * 回傳 null = 這個國家／這項政策不走議會表決，呼叫端沿用舊的成功率骰子。
 */
import { eq } from "drizzle-orm";
import { db, parliamentPartiesTable, parliamentStateTable } from "@workspace/db";
import { logger } from "../logger";
import { tierOfNation, ensureParliamentSeeded } from "./service";
import { effectiveParliamentTier, type SeatedParty, type ParliamentStance, type ParliamentTier } from "./core";
import {
  needsParliamentVote, normalizeTags, tallyVote,
  type PolicyResultType, type PolicyTag, type VoteResult,
} from "./vote";
import type { playerNationsTable } from "@workspace/db";

type Nation = typeof playerNationsTable.$inferSelect;

export interface PolicyVoteOutcome {
  tier: ParliamentTier;
  tags: PolicyTag[];
  result: VoteResult;
}

/** 讀該國現有政黨（席次已由公式算好）。 */
export async function loadSeatedParties(nationId: string): Promise<SeatedParty[]> {
  const rows = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  return rows.map((r) => ({
    id: String(r.id), name: r.name, stance: r.stance as ParliamentStance, weight: r.weight, seats: r.seats,
  }));
}

/**
 * 該國這項政策是否需要、並完成議會表決。
 * 任何環節失敗（查不到議會、DB 錯誤）都回傳 null：寧可退回舊機制，也不能卡住結算。
 */
export async function voteOnPolicy(
  nation: Nation,
  resultType: PolicyResultType,
  rawTags: readonly PolicyTag[] | null | undefined,
): Promise<PolicyVoteOutcome | null> {
  try {
    const { tier: baseTier } = await tierOfNation(nation);
    // 專制先快速返回，省一次 DB 查詢；但專制若有非忠誠黨過半會升為半專制，所以仍需看政黨。
    await ensureParliamentSeeded(nation);
    const parties = await loadSeatedParties(nation.id);
    if (parties.length === 0) return null;
    const tier = effectiveParliamentTier(baseTier, parties);
    if (!needsParliamentVote(tier, resultType)) return null;
    const tags = normalizeTags(rawTags);
    return { tier, tags, result: tallyVote(parties, tags) };
  } catch (err) {
    logger.error({ err, nationId: nation.id }, "policy parliament vote failed — falling back to dice");
    return null;
  }
}

/** 強行通過：扣議會滿意度（夾在 0–100）。回傳新值。 */
export async function applyOverridePenalty(nationId: string, newSatisfaction: number): Promise<void> {
  await db.update(parliamentStateTable).set({ satisfaction: newSatisfaction }).where(eq(parliamentStateTable.nationId, nationId));
}
