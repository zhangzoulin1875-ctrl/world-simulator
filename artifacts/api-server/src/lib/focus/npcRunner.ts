import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  focusStatesTable,
  focusActiveTable,
  parliamentStateTable,
  diplomacyWarsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { governmentSlugByLabel } from "../governments";
import { edgesFrom } from "./regimeGraph";
import { COMMUNIST_REVOLUTION_ID, REVOLUTION_EXCLUDED_GOVERNMENTS } from "./regimeFocuses";
import { getFocusDef } from "./catalog";
import { startFocus } from "./service";
import { decideNpcFocus, isRadicalFocus, npcRadicalCap, type NpcCandidate } from "./npcDecision";
import type { FocusDef } from "./types";
import { ensureBranches } from "./branchService";

export interface NpcFocusRunSummary {
  npcs: number;
  started: number;
  radicalStarted: number;
  skippedCap: number;
  failed: number;
}

/**
 * 每回合替 NPC 推動政體轉型國策。NPC 與玩家走同一個 startFocus(政體/時代/條件/點數全驗證),
 * 這裡只負責「挑哪一條」:偏向穩定線,黑/紅線與革命機率低,並受全域奪權上限管制。
 * 完成國策、傾向值增長、革命開內戰都由既有的 runFocusSettlement / settleCivilWars 處理。
 */
export async function runNpcFocusDecisions(rand: () => number = Math.random): Promise<NpcFocusRunSummary> {
  const out: NpcFocusRunSummary = { npcs: 0, started: 0, radicalStarted: 0, skippedCap: 0, failed: 0 };
  const npcs = await db.select().from(playerNationsTable).where(eq(playerNationsTable.isNpc, true));
  out.npcs = npcs.length;
  if (npcs.length === 0) return out;
  const npcIds = npcs.map((n) => n.id);

  const states = await db.select().from(focusStatesTable).where(inArray(focusStatesTable.nationId, npcIds));
  const stateBy = new Map(states.map((s) => [s.nationId, s]));
  const actives = await db.select().from(focusActiveTable).where(inArray(focusActiveTable.nationId, npcIds));
  const activeBy = new Map<string, string[]>();
  for (const a of actives) activeBy.set(a.nationId, [...(activeBy.get(a.nationId) ?? []), a.focusId]);
  const pars = await db.select().from(parliamentStateTable).where(inArray(parliamentStateTable.nationId, npcIds));
  const parBy = new Map(pars.map((p) => [p.nationId, p.satisfaction]));

  // 進行中的內戰(任何一方是 NPC 都算);並記下哪些 NPC 正在內戰裡
  const civil = await db
    .select({ a: diplomacyWarsTable.nationAId, b: diplomacyWarsTable.nationBId })
    .from(diplomacyWarsTable)
    .where(and(eq(diplomacyWarsTable.isCivilWar, true), isNull(diplomacyWarsTable.endedAt)));
  const inCivil = new Set<string>();
  for (const w of civil) { inCivil.add(w.a); inCivil.add(w.b); }

  // 全域「奪權事件」進行數 = NPC 內戰場數 + NPC 進行中的黑/紅線/革命轉型國策數
  const npcSet = new Set(npcIds);
  let radicalInFlight = civil.filter((w) => npcSet.has(w.a) || npcSet.has(w.b)).length;
  for (const a of actives) {
    if (!npcSet.has(a.nationId)) continue;
    const d = getFocusDef(a.focusId);
    if (d && d.domain === "regime" && isRadicalFocus(d, isRevolutionId(d))) radicalInFlight++;
  }
  const cap = npcRadicalCap(npcs.length);

  // 洗牌:避免固定排序讓前面的 NPC 永遠先搶到名額
  const order = [...npcs].sort(() => rand() - 0.5);
  for (const n of order) {
    try {
      const st = stateBy.get(n.id);
      if (!st) continue;
      const slug = governmentSlugByLabel(n.government);
      if (!slug) continue;
      const candidates: NpcCandidate[] = [];
      // 只從「自己抽到的分支」裡選(與玩家同一套規則);沒抽過就現在抽並存起來
      const myBranches = new Set(await ensureBranches(n.id, slug, rand));
      for (const e of edgesFrom(slug).filter((x) => myBranches.has(x.to))) {
        const def = getFocusDef(e.focusId);
        if (def) candidates.push({ def, isRevolution: false });
      }
      // 共產革命是獨立入口(不在政體圖裡):紅線終點以外的政體都有這個選項,權重最低、受全域奪權上限管
      const rev = getFocusDef(COMMUNIST_REVOLUTION_ID);
      if (rev && !REVOLUTION_EXCLUDED_GOVERNMENTS.includes(slug)) candidates.push({ def: rev, isRevolution: true });
      const myActive = activeBy.get(n.id) ?? [];
      const hasActiveRegime = myActive.some((id) => getFocusDef(id)?.domain === "regime");
      const picked = decideNpcFocus({
        candidates,
        points: st.points,
        facts: {
          politicalSupport: n.politicalSupport,
          stability: n.stability,
          militarySatisfaction: n.satisfactionMilitary,
          parliamentSatisfaction: parBy.get(n.id) ?? 60,
          blackLean: st.blackLean,
          redLean: st.redLean,
        },
        radicalInFlight,
        radicalCap: cap,
        inCivilWar: inCivil.has(n.id),
        hasActiveRegimeFocus: hasActiveRegime,
        rand,
      });
      if (!picked) continue;
      const revolution = candidates.find((c) => c.def.id === picked.id)?.isRevolution ?? false;
      const radical = isRadicalFocus(picked, revolution);
      const r = await startFocus(n, picked.id);
      if (!r.ok) continue; // 驗證沒過(例如時代未到)= 這回合不動
      out.started++;
      if (radical) { out.radicalStarted++; radicalInFlight++; }
      logger.info({ nationId: n.id, focusId: picked.id, radical }, "npc started regime focus");
    } catch (err) {
      out.failed++;
      logger.error({ err, nationId: n.id }, "npc focus decision failed");
    }
  }
  return out;
}

function isRevolutionId(d: FocusDef): boolean {
  return d.id === COMMUNIST_REVOLUTION_ID;
}
