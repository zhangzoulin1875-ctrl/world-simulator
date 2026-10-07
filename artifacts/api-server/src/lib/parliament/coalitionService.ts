/**
 * 聯合政府服務(DB 層)。規則見 coalition.ts;這裡只負責讀寫與紀錄。
 *
 * 所有寫入在同一個交易內;`reformGovernment` 是「重算整個聯合」,冪等,
 * 大選開票後、議會重組後、每回合結算都可以呼叫。
 */
import { and, eq } from "drizzle-orm";
import { db, parliamentStateTable, parliamentPartiesTable, parliamentLogTable } from "@workspace/db";
import { logger } from "../logger";
import { clampSat, type ParliamentStance, type ParliamentTier, type SeatedParty } from "./core";
import {
  CARETAKER_SAT_FLOOR, CARETAKER_SAT_PENALTY, COLLAPSE_SAT_PENALTY, MAJORITY_SEATS, MAX_FORMATION_FAILURES,
  coalitionRisk, coalitionStability, formCoalition, rollDefections, semiCoalition,
  type CoalitionRisk, type Rng,
} from "./coalition";
import { ELECTION_INTERVAL, hasElections } from "./election";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface GovernmentOutcome {
  /** 組閣後的狀態:聯合 / 單黨 / 看守 / 不適用(專制)。 */
  kind: "coalition" | "single" | "caretaker" | "none";
  memberIds: string[];
  primeId: string | null;
  /** 這次是否因連續失敗而提前大選。 */
  earlyElection: boolean;
}

const toSeated = (r: typeof parliamentPartiesTable.$inferSelect): SeatedParty => ({
  id: String(r.id), name: r.name, stance: r.stance as ParliamentStance, weight: r.weight, seats: r.seats,
});

async function writeLog(tx: Tx, nationId: string, tick: number, summary: string, satDelta = 0) {
  await tx.insert(parliamentLogTable).values({ nationId, tick, kind: "coalition", summary, satDelta });
}

/**
 * 依目前席次重新組閣並寫回:in_coalition、is_ruling(總理黨)、caretaker、formation_failures。
 * - 專制:不適用,全部清掉。
 * - 半專制:現任總理黨自動組閣(沿用目前的 is_ruling,沒有就最大黨)。
 * - 民主:formCoalition;失敗 → 看守政府、失敗計數 +1;滿 MAX_FORMATION_FAILURES → 提前大選。
 * `tick` = 議會目前的 tick(用於紀錄與提前大選計時)。
 */
export async function reformGovernment(
  nationId: string, tier: ParliamentTier, tick: number, opts: { announce?: boolean } = {},
): Promise<GovernmentOutcome> {
  const announce = opts.announce ?? true;
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
    const none: GovernmentOutcome = { kind: "none", memberIds: [], primeId: null, earlyElection: false };
    if (tier === "autocracy" || rows.length === 0) {
      await tx.update(parliamentPartiesTable).set({ inCoalition: false }).where(eq(parliamentPartiesTable.nationId, nationId));
      await tx.update(parliamentStateTable).set({ caretaker: false, formationFailures: 0 }).where(eq(parliamentStateTable.nationId, nationId));
      return none;
    }
    const parties = rows.map(toSeated);
    const [st] = await tx.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
    const incumbentId = rows.find((r) => r.isRuling)?.id;
    const res = tier === "semi"
      ? semiCoalition(parties, incumbentId === undefined ? null : String(incumbentId))
      : formCoalition(parties);

    const setFlags = async (memberIds: string[], primeId: string | null) => {
      for (const r of rows) {
        const id = String(r.id);
        await tx.update(parliamentPartiesTable)
          .set({ inCoalition: memberIds.includes(id), isRuling: id === primeId })
          .where(and(eq(parliamentPartiesTable.id, r.id), eq(parliamentPartiesTable.nationId, nationId)));
      }
    };

    if (res.ok) {
      await setFlags(res.memberIds, res.primeId);
      await tx.update(parliamentStateTable).set({ caretaker: false, formationFailures: 0 }).where(eq(parliamentStateTable.nationId, nationId));
      const wasCaretaker = st?.caretaker ?? false;
      const prev = new Set(rows.filter((r) => r.inCoalition).map((r) => String(r.id)));
      const changed = res.memberIds.length !== prev.size || res.memberIds.some((id) => !prev.has(id));
      if (announce && (changed || wasCaretaker)) {
        const names = res.memberIds.map((id) => parties.find((p) => p.id === id)?.name ?? "?");
        const prime = parties.find((p) => p.id === res.primeId)?.name ?? "?";
        await writeLog(tx, nationId, tick, res.memberIds.length === 1
          ? (res.single ? `${prime}單獨過半,組成單黨政府(${res.seats} 席)。` : `${prime}以 ${res.seats} 席維持執政(未過半,選舉不自由)。`)
          : `議會組成聯合政府:${names.join("、")}(合計 ${res.seats} 席),由${prime}領銜。`);
      }
      // 以成員數判斷:只有一個黨在政府裡就是單黨政府(半專制現任沒過半也一樣)。
      return { kind: res.memberIds.length === 1 ? "single" : "coalition", memberIds: res.memberIds, primeId: res.primeId, earlyElection: false };
    }

    // 組閣失敗:看守政府。沒有成員、沒有總理黨。
    await setFlags([], null);
    const failures = (st?.formationFailures ?? 0) + 1;
    const early = failures >= MAX_FORMATION_FAILURES;
    await tx.update(parliamentStateTable).set({
      caretaker: true,
      formationFailures: early ? 0 : failures,
      // 提前大選:讓「下次大選日」恰好等於現在,下一次結算就開票。
      ...(early ? { lastElectionTick: Math.max(0, tick - ELECTION_INTERVAL) } : {}),
    }).where(eq(parliamentStateTable.nationId, nationId));
    if (announce) {
      await writeLog(tx, nationId, tick, early
        ? `議會連續 ${MAX_FORMATION_FAILURES} 次無法組成過半政府,宣布提前大選。`
        : `沒有任何黨能組成過半政府(門檻 ${MAJORITY_SEATS} 席),由看守政府暫時執政(第 ${failures} 次嘗試)。`);
    }
    return { kind: "caretaker", memberIds: [], primeId: null, earlyElection: early };
  });
}

export interface CoalitionTickOutcome {
  defectors: string[];
  collapsed: boolean;
  /** 本回合因看守/倒閣造成的議會滿意度變化(已扣在 DB;回傳給呼叫端寫日誌/對帳)。 */
  satDelta: number;
}

/**
 * 每回合結算:
 *  - 看守政府:議會滿意度 −CARETAKER_SAT_PENALTY,並再嘗試組閣一次。
 *  - 聯合政府:擲裂解;有人退出 → 退出者離開聯合;剩下不過半 → 倒閣(滿意度 −10、重新組閣)。
 * 專制與單黨政府不會裂解。回傳給呼叫端用來決定是否要再重算。
 */
export async function tickGovernment(
  nationId: string, tier: ParliamentTier, tick: number, rng: Rng = Math.random,
): Promise<CoalitionTickOutcome> {
  const idle: CoalitionTickOutcome = { defectors: [], collapsed: false, satDelta: 0 };
  if (tier === "autocracy" || !hasElections(tier) && tier !== "semi") return idle;
  const [st] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  if (!st) return idle;

  if (st.caretaker) {
    // 看守政府只會把滿意度磨到 CARETAKER_SAT_FLOOR 為止,不會單靠它把國家逼進 0 滿意度革命。
    const after = clampSat(Math.max(Math.min(st.satisfaction, CARETAKER_SAT_FLOOR), st.satisfaction - CARETAKER_SAT_PENALTY));
    const delta = after - st.satisfaction;
    if (delta !== 0) {
      await db.transaction(async (tx) => {
        await tx.update(parliamentStateTable).set({ satisfaction: after }).where(eq(parliamentStateTable.nationId, nationId));
        await writeLog(tx, nationId, tick, "看守政府施政無力,議會不滿加深。", delta);
      });
    }
    await reformGovernment(nationId, tier, tick);
    return { defectors: [], collapsed: false, satDelta: delta };
  }

  // 半專制由現任自動組閣,不裂解
  if (tier !== "democracy") return idle;

  const rows = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  const members = rows.filter((r) => r.inCoalition).map(toSeated);
  const prime = rows.find((r) => r.isRuling);
  if (members.length <= 1 || !prime) return idle;

  const tickRes = rollDefections(members, String(prime.id), rng);
  if (tickRes.defectors.length === 0) return idle;

  const names = tickRes.defectors.map((id) => members.find((m) => m.id === id)?.name ?? "?");
  let satDelta = 0;
  await db.transaction(async (tx) => {
    for (const id of tickRes.defectors) {
      await tx.update(parliamentPartiesTable).set({ inCoalition: false })
        .where(and(eq(parliamentPartiesTable.id, Number(id)), eq(parliamentPartiesTable.nationId, nationId)));
    }
    if (tickRes.collapsed) {
      const after = clampSat(st.satisfaction - COLLAPSE_SAT_PENALTY);
      satDelta = after - st.satisfaction;
      await tx.update(parliamentStateTable).set({ satisfaction: after }).where(eq(parliamentStateTable.nationId, nationId));
      await writeLog(tx, nationId, tick, `${names.join("、")}退出聯合政府,執政聯盟失去過半,內閣倒台。`, satDelta);
    } else {
      await writeLog(tx, nationId, tick, `${names.join("、")}退出聯合政府,但執政聯盟仍掌握過半席次。`);
    }
  });
  if (tickRes.collapsed) {
    // 倒閣後重新組閣;若再失敗就進入看守/提前大選的流程
    await reformGovernment(nationId, tier, tick);
  }
  logger.info({ nationId, defectors: tickRes.defectors, collapsed: tickRes.collapsed }, "parliament: coalition defection");
  return { defectors: tickRes.defectors, collapsed: tickRes.collapsed, satDelta };
}

export interface GovernmentView {
  /** 專制 = false(沒有政府組成可言)。 */
  enabled: boolean;
  kind: "coalition" | "single" | "caretaker" | "none";
  primeId: number | null;
  members: { id: number; name: string; seats: number }[];
  seats: number;
  caretaker: boolean;
  /** 還要失敗幾次就提前大選(只在看守政府時有意義)。 */
  failuresLeft: number;
  /** 聯合穩定度 0–1 與風險等級(單黨/看守為 1/low)。 */
  stability: number;
  risk: CoalitionRisk;
}

/** 給 API / 前端的政府視圖(純讀)。 */
export async function buildGovernmentView(nationId: string, tier: ParliamentTier): Promise<GovernmentView> {
  const off: GovernmentView = {
    enabled: false, kind: "none", primeId: null, members: [], seats: 0, caretaker: false,
    failuresLeft: 0, stability: 1, risk: "low",
  };
  if (tier === "autocracy") return off;
  const [st] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  const rows = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  if (!st || rows.length === 0) return off;
  const members = rows.filter((r) => r.inCoalition);
  const seated = members.map(toSeated);
  const seats = members.reduce((n, r) => n + r.seats, 0);
  const stability = tier === "democracy" ? coalitionStability(seated) : 1;
  const prime = rows.find((r) => r.isRuling) ?? null;
  const kind = st.caretaker ? "caretaker" : members.length > 1 ? "coalition" : members.length === 1 ? "single" : "none";
  return {
    enabled: true, kind, primeId: prime?.id ?? null,
    members: members.map((r) => ({ id: r.id, name: r.name, seats: r.seats })).sort((a, b) => b.seats - a.seats || a.id - b.id),
    seats, caretaker: st.caretaker,
    failuresLeft: st.caretaker ? Math.max(0, MAX_FORMATION_FAILURES - st.formationFailures) : 0,
    stability, risk: coalitionRisk(stability),
  };
}
