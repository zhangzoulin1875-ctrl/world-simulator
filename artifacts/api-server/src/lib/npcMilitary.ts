import {
  db,
  militaryUnitTemplatesTable,
  npcArmiesTable,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
  techTreeNodesTable,
  type MilitaryUnitTemplate,
} from "@workspace/db";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getEraIndex } from "./mapRegionEras";
import {
  isCategoryUnlocked,
  MILITARY_KEY_TECHS,
  type MilitaryCategory,
} from "./military";
import { designNpcUnitSet } from "./militaryAi";
import { buildNationGeoCultureContext } from "./nationGeoCulture";
import { effectiveNpcTechEra } from "./npcTech";
import { computeNationStats, getCurrentGameYear, getEraSlugs } from "./nationStats";
import { allocateProportionally } from "./war";

/**
 * Task #389 — NPC 國家自主軍事：常備軍（npc_armies）＋ NPC 專屬兵種模板。
 *
 * 設計要點：
 * - 常備軍每回合以人口比例確定性生產（受人口上限封頂），戰役開打時從常備軍
 *   「抽調」（committed 累加，quantity 不動）；戰役結束以 npc_drawn 快照結算
 *   實際損失並歸還倖存者。週期結算期間不寫 npc_armies（單一結算點，避免雙記帳）。
 * - 兵種模板：用 AI（bulk 模型＋地理人文脈絡）為各 NPC 設計專屬兵種。
 *   Task #549 起預設兵種已全面移除：AI 失敗或尚未設計時安全跳過／延後
 *   （當回合不生產、開戰守門拒絕），永不建立空軍團戰役。
 * - 傷兵：戰役中的傷兵在戰役結束回到 npc_armies.wounded 恢復池，每回合按比例
 *   歸隊（NPC 無復原科技加成）。
 */

// ── 常數 ───────────────────────────────────────────────────────

/** 常備軍規模上限 = 人口 × 此比例。 */
export const NPC_ARMY_CAP_RATIO = 0.005;
/** 每回合生產量 = 人口 × 此比例（受上限封頂）。 */
export const NPC_ARMY_PRODUCTION_RATIO = 0.0004;
/** 每回合生產下限（避免小國永遠長不出軍隊）。 */
export const NPC_ARMY_PRODUCTION_MIN = 100;
/** 每回合傷兵歸隊比例。 */
export const NPC_WOUNDED_RECOVERY_RATE = 0.1;
/** 每回合最多為多少個 NPC 呼叫 AI 設計兵種（成本節流）。 */
export const NPC_UNIT_DESIGN_BUDGET_PER_TURN = 3;

/** NPC 兵力組成權重（與戰役民兵組建一致）。 */
export const NPC_UNIT_WEIGHTS: Record<string, number> = {
  infantry: 45,
  ranged: 25,
  armor: 20,
  artillery: 7,
  ship: 3,
};

// ── 純輔助 ─────────────────────────────────────────────────────

/** 依已研發軍事關鍵科技（keySlug）解鎖的 NPC 兵種類別（與玩家同一守門規則）。 */
export function npcCombatCategories(
  researchedKeySlugs: readonly string[],
): MilitaryCategory[] {
  return (Object.keys(NPC_UNIT_WEIGHTS) as MilitaryCategory[]).filter((c) =>
    isCategoryUnlocked(c, researchedKeySlugs),
  );
}

type Executor = Pick<typeof db, "select">;

/**
 * Task #481 — 某 NPC 已持有的軍事關鍵科技 keySlug 集合（兵種解鎖依據）。
 * 樹狀態已初始化 → 查 player_researched_tree_nodes（nation_id 鍵）；
 * 尚未初始化 → 退回舊時代指標近似（時代 ≤ 有效軍事時代的靜態關鍵科技，
 * 與 lazy init 的授予語義一致，避免在唯讀路徑寫入）。
 */
export async function loadNpcMilitaryKeySlugs(
  executor: Executor,
  nation: { id: string; techEraMilitary: string | null },
  worldEraSlug: string,
): Promise<string[]> {
  const state = await executor
    .select({ id: playerTechTreeStateTable.id })
    .from(playerTechTreeStateTable)
    .where(eq(playerTechTreeStateTable.nationId, nation.id))
    .limit(1);
  if (state.length === 0) {
    const eff = effectiveNpcTechEra(nation.techEraMilitary, worldEraSlug);
    const effIdx = getEraIndex(eff);
    return MILITARY_KEY_TECHS.filter(
      (k) => getEraIndex(k.eraSlug) <= effIdx,
    ).map((k) => k.keySlug);
  }
  const rows = await executor
    .select({ keySlug: techTreeNodesTable.keySlug })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .where(
      and(
        eq(playerResearchedTreeNodesTable.nationId, nation.id),
        eq(techTreeNodesTable.domain, "military"),
        isNotNull(techTreeNodesTable.keySlug),
      ),
    );
  return rows
    .map((r) => r.keySlug)
    .filter((v): v is string => v !== null);
}

/**
 * 讀取某 NPC 在某軍事時代可用的戰鬥兵種模板：優先用該國專屬模板（該時代）；
 * 該時代沒有時退回該國「最新時代」的既有專屬模板（時代推進後 AI 尚未補設計
 * 的過渡期）。Task #549 起預設兵種已全面移除：完全沒有專屬模板 → 回空陣列，
 * 呼叫端必須自行跳過／延後（不得建立空軍團）。
 */
export async function loadNpcCombatTemplates(
  executor: Executor,
  nationId: string,
  eraSlug: string,
): Promise<MilitaryUnitTemplate[]> {
  const owned = await executor
    .select()
    .from(militaryUnitTemplatesTable)
    .where(eq(militaryUnitTemplatesTable.ownerNationId, nationId))
    .orderBy(asc(militaryUnitTemplatesTable.id));
  const eraExact = owned.filter((t) => t.eraSlug === eraSlug);
  if (eraExact.length > 0) return eraExact;
  if (owned.length === 0) return [];

  // 最新時代 = 既有模板中時代 index 最大的那一批（無 eraSlug 視為最舊）。
  let bestIdx = -1;
  for (const t of owned) {
    const idx = t.eraSlug ? getEraIndex(t.eraSlug) : -1;
    if (idx > bestIdx) bestIdx = idx;
  }
  return owned.filter(
    (t) => (t.eraSlug ? getEraIndex(t.eraSlug) : -1) === bestIdx,
  );
}

/**
 * 確保某 NPC 在其軍事時代有專屬兵種模板；沒有時呼叫 AI 設計（bulk 模型＋
 * 地理人文脈絡）。AI 失敗僅記 log 並回 false（呼叫端跳過／延後該國本次
 * 生產或開戰）。回傳是否有實際新設計。
 */
export async function ensureNpcUnitTemplates(
  nation: { id: string; name: string | null },
  eraSlug: string,
  researchedKeySlugs: readonly string[],
): Promise<boolean> {
  const [existing] = await db
    .select({ id: militaryUnitTemplatesTable.id })
    .from(militaryUnitTemplatesTable)
    .where(
      and(
        eq(militaryUnitTemplatesTable.ownerNationId, nation.id),
        eq(militaryUnitTemplatesTable.eraSlug, eraSlug),
      ),
    )
    .limit(1);
  if (existing) return false;

  const categories = npcCombatCategories(researchedKeySlugs);
  if (categories.length === 0) return false;
  try {
    let geoContext = "";
    try {
      geoContext = await buildNationGeoCultureContext(nation.id);
    } catch {
      geoContext = "";
    }
    const gameYear = await getCurrentGameYear();
    const rows = await designNpcUnitSet({
      nationId: nation.id,
      nationName: nation.name ?? "NPC 國家",
      eraSlug,
      gameYear,
      categories,
      geoContext: geoContext || undefined,
    });
    return rows.length > 0;
  } catch (err) {
    logger.error(
      { err, nationId: nation.id, eraSlug },
      "NPC unit set design failed; skipping (no default templates to fall back to)",
    );
    return false;
  }
}

// ── 每回合生產與傷兵歸隊 ───────────────────────────────────────

export interface NpcMilitaryTurnSummary {
  nations: number;
  produced: number;
  recovered: number;
  designed: number;
}

/**
 * 每日回合：所有 NPC 的常備軍生產＋傷兵歸隊＋（節流的）AI 兵種設計。
 * 每國獨立 try/catch，單國失敗不阻斷其他國與回合。
 */
export async function runNpcMilitaryTurn(): Promise<NpcMilitaryTurnSummary> {
  const { statsEra, currentEra } = await getEraSlugs();
  const npcs = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      techEraMilitary: playerNationsTable.techEraMilitary,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.isNpc, true));

  const summary: NpcMilitaryTurnSummary = {
    nations: npcs.length,
    produced: 0,
    recovered: 0,
    designed: 0,
  };
  let designBudget = NPC_UNIT_DESIGN_BUDGET_PER_TURN;

  for (const npc of npcs) {
    try {
      const eraM = effectiveNpcTechEra(npc.techEraMilitary, currentEra);
      const keySlugs = await loadNpcMilitaryKeySlugs(db, npc, currentEra);

      if (designBudget > 0) {
        const designed = await ensureNpcUnitTemplates(npc, eraM, keySlugs);
        if (designed) {
          summary.designed++;
          designBudget--;
        }
      }

      const stats = await computeNationStats(npc.id, statsEra);
      const population = Math.max(0, stats.population);

      const result = await db.transaction(async (tx) => {
        // 傷兵歸隊（NPC 無復原科技加成，固定比例）。
        const woundedRows = await tx
          .select({
            id: npcArmiesTable.id,
            wounded: npcArmiesTable.wounded,
          })
          .from(npcArmiesTable)
          .where(
            and(eq(npcArmiesTable.nationId, npc.id), gt(npcArmiesTable.wounded, 0)),
          )
          .for("update");
        let recovered = 0;
        for (const row of woundedRows) {
          const back = Math.min(
            row.wounded,
            Math.max(1, Math.ceil(row.wounded * NPC_WOUNDED_RECOVERY_RATE)),
          );
          if (back <= 0) continue;
          await tx
            .update(npcArmiesTable)
            .set({
              wounded: sql`GREATEST(0, ${npcArmiesTable.wounded} - ${back})`,
              quantity: sql`${npcArmiesTable.quantity} + ${back}`,
              updatedAt: new Date(),
            })
            .where(eq(npcArmiesTable.id, row.id));
          recovered += back;
        }

        // 生產（人口上限封頂；quantity 含前線抽調中的部隊）。
        const [totals] = await tx
          .select({
            total: sql<string>`COALESCE(SUM(${npcArmiesTable.quantity} + ${npcArmiesTable.wounded}), 0)`,
          })
          .from(npcArmiesTable)
          .where(eq(npcArmiesTable.nationId, npc.id));
        const current = Number(totals?.total ?? 0);
        const cap = Math.floor(population * NPC_ARMY_CAP_RATIO);
        const perTurn = Math.max(
          NPC_ARMY_PRODUCTION_MIN,
          Math.floor(population * NPC_ARMY_PRODUCTION_RATIO),
        );
        const produce = Math.max(0, Math.min(perTurn, cap - current));
        if (produce <= 0) return { produced: 0, recovered };

        // Task #549 — 無專屬模板（AI 尚未設計成功）→ 當回合安全跳過生產。
        const templates = await loadNpcCombatTemplates(tx, npc.id, eraM);
        if (templates.length === 0) return { produced: 0, recovered };
        const shares = allocateProportionally(
          templates.map((t) => NPC_UNIT_WEIGHTS[t.category] ?? 5),
          produce,
        );
        let produced = 0;
        for (let i = 0; i < templates.length; i++) {
          const qty = shares[i] ?? 0;
          if (qty <= 0) continue;
          await tx
            .insert(npcArmiesTable)
            .values({
              nationId: npc.id,
              templateId: templates[i]!.id,
              quantity: qty,
            })
            .onConflictDoUpdate({
              target: [npcArmiesTable.nationId, npcArmiesTable.templateId],
              set: {
                quantity: sql`${npcArmiesTable.quantity} + EXCLUDED.quantity`,
                updatedAt: new Date(),
              },
            });
          produced += qty;
        }
        return { produced, recovered };
      });

      summary.produced += result.produced;
      summary.recovered += result.recovered;
    } catch (err) {
      logger.error(
        { err, nationId: npc.id },
        "NPC military turn failed for nation",
      );
    }
  }
  return summary;
}

// ── 常備軍可用量與抽調 ─────────────────────────────────────────

/** 某 NPC 目前可抽調的常備軍總數（quantity − committed）。 */
export async function npcAvailableTroops(nationId: string): Promise<number> {
  const [row] = await db
    .select({
      available: sql<string>`COALESCE(SUM(GREATEST(0, ${npcArmiesTable.quantity} - ${npcArmiesTable.committed})), 0)`,
    })
    .from(npcArmiesTable)
    .where(eq(npcArmiesTable.nationId, nationId));
  return Number(row?.available ?? 0);
}

export interface NpcDraw {
  template: MilitaryUnitTemplate;
  drawn: number;
}

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 戰役開打時從常備軍抽調兵力（交易內）：committed += drawn（quantity 不動），
 * 以條件 UPDATE 防超抽。最多抽 target；庫存不足時抽到可用量為止。
 * 回傳實際抽調的兵種與數量（可能為空）。
 */
export async function drawNpcTroopsInTx(
  tx: TxLike,
  nationId: string,
  target: number,
): Promise<NpcDraw[]> {
  if (target <= 0) return [];
  const rows = await tx
    .select({
      army: npcArmiesTable,
      template: militaryUnitTemplatesTable,
    })
    .from(npcArmiesTable)
    .innerJoin(
      militaryUnitTemplatesTable,
      eq(militaryUnitTemplatesTable.id, npcArmiesTable.templateId),
    )
    .where(
      and(
        eq(npcArmiesTable.nationId, nationId),
        sql`${npcArmiesTable.quantity} - ${npcArmiesTable.committed} > 0`,
      ),
    )
    .orderBy(asc(npcArmiesTable.id))
    .for("update", { of: npcArmiesTable });

  // 軍團兵種列上限 5：只取可用量最大的前 5 種。
  const sorted = [...rows]
    .map((r) => ({
      ...r,
      available: Math.max(0, r.army.quantity - r.army.committed),
    }))
    .sort((a, b) => b.available - a.available)
    .slice(0, 5);
  if (sorted.length === 0) return [];

  const totalAvailable = sorted.reduce((s, r) => s + r.available, 0);
  const toDraw = Math.min(target, totalAvailable);
  if (toDraw <= 0) return [];
  const shares = allocateProportionally(
    sorted.map((r) => r.available),
    toDraw,
  );

  const draws: NpcDraw[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const want = Math.min(shares[i] ?? 0, sorted[i]!.available);
    if (want <= 0) continue;
    const updated = await tx
      .update(npcArmiesTable)
      .set({
        committed: sql`${npcArmiesTable.committed} + ${want}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(npcArmiesTable.id, sorted[i]!.army.id),
          sql`${npcArmiesTable.quantity} - ${npcArmiesTable.committed} >= ${want}`,
        ),
      )
      .returning({ id: npcArmiesTable.id });
    if (updated.length === 0) continue;
    draws.push({ template: sorted[i]!.template, drawn: want });
  }
  return draws;
}

/**
 * 戰役結束（所有結束路徑共用，交易內）：依 npc_drawn 快照結算 NPC 常備軍。
 * 每列：returned = min(npcDrawn, 現存 quantity + wounded)；
 *       returnWounded = min(wounded, returned)；losses = npcDrawn − returned。
 * 常備軍：committed −= npcDrawn、quantity −= (losses + returnWounded)、
 * wounded += returnWounded（皆 GREATEST(0,·) 防禦）。民兵補足部分（超出
 * npcDrawn 的量）不歸還（民兵解散）。
 */
export async function returnNpcTroopsInTx(
  tx: TxLike,
  rows: readonly {
    nationId: string;
    templateId: number;
    npcDrawn: number;
    quantity: number;
    wounded: number;
  }[],
): Promise<void> {
  for (const row of rows) {
    if (row.npcDrawn <= 0) continue;
    const surviving = Math.max(0, row.quantity) + Math.max(0, row.wounded);
    const returned = Math.min(row.npcDrawn, surviving);
    const returnWounded = Math.min(Math.max(0, row.wounded), returned);
    const losses = row.npcDrawn - returned;
    await tx
      .update(npcArmiesTable)
      .set({
        committed: sql`GREATEST(0, ${npcArmiesTable.committed} - ${row.npcDrawn})`,
        quantity: sql`GREATEST(0, ${npcArmiesTable.quantity} - ${losses + returnWounded})`,
        wounded: sql`${npcArmiesTable.wounded} + ${returnWounded}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(npcArmiesTable.nationId, row.nationId),
          eq(npcArmiesTable.templateId, row.templateId),
        ),
      );
  }
}
