/**
 * 油井戰役服務:發起、追加艦隊、到時結算。
 *
 * 不變量(測試逐條驗證):
 *  - 一座油井同時只有一場 active 戰役(部分唯一索引兜底,並行發起只會成功一個)。
 *  - 投入的艦隊只能是 ship 模板,且不超過「可派遣量」(持有 − 陸戰佔用 − 傷兵 − 其他油井鎖定)。
 *  - 結算以 CAS 認領(UPDATE ... WHERE status='active'),並行結算只有一個真正扣損失與換手。
 *  - 損失直接從 player_armies 扣;戰役轉 settled 後鎖定自動解除,生還者立刻可用,不需「歸還」。
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  resolveOilBattle, applyLosses, garrisonFleet, settleTimeFor, validateCommit,
  type FleetLine, type OilBattleResult,
} from "./oilCombat";
import { oilLockedByTemplate } from "./oilRigService";
import { attackerRangeFactor } from "./oilRigCore";
import { fleetPower } from "./oilCombat";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class OilCampaignError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

/** 取得 pg 錯誤碼(drizzle 會把 pg 錯誤包在 cause)。 */
function pgCode(err: unknown): string | undefined {
  for (let e: any = err, i = 0; e && i < 5; e = e.cause, i++) if (typeof e.code === "string") return e.code;
  return undefined;
}

export interface Committer {
  nationId: string;
  discordUserId: string;
}

/**
 * 在交易內(已鎖國家列之後)重新計算某國各兵種可派遣量:
 *   持有 − 陸戰進行中佔用(含前線傷兵) − 全國傷兵池 − 其他進行中油井戰役鎖定。
 * 刻意不接受呼叫端傳入的快照:快照在鎖之前取得,可能已過期;而且若呼叫端的數字已經扣過油井鎖定,
 * 這裡再扣一次就會雙重扣除。口徑與 routes/war/shared.ts 的 buildAvailableUnits 一致(有測試對照)。
 */
export async function computeAvailableInTx(tx: Tx, who: Committer): Promise<(templateId: number) => number> {
  const owned = new Map<number, number>();
  const a = await tx.execute(sql`SELECT template_id, quantity::text AS q FROM player_armies WHERE discord_user_id = ${who.discordUserId}`);
  for (const r of a.rows as Array<{ template_id: number; q: string }>) owned.set(Number(r.template_id), Number(r.q));

  const pool = new Map<number, number>();
  const w = await tx.execute(sql`SELECT template_id, wounded::text AS q FROM player_wounded_units WHERE discord_user_id = ${who.discordUserId}`);
  for (const r of w.rows as Array<{ template_id: number; q: string }>) pool.set(Number(r.template_id), Number(r.q));

  const land = new Map<number, number>();
  const l = await tx.execute(sql`
    SELECT u.template_id, SUM(u.quantity + u.wounded)::text AS q
    FROM war_campaign_legion_units u
    JOIN war_campaign_legions g ON g.id = u.legion_id
    JOIN war_campaigns c ON c.id = g.campaign_id
    WHERE g.nation_id = ${who.nationId}::uuid AND c.status = 'active'
    GROUP BY u.template_id
  `);
  for (const r of l.rows as Array<{ template_id: number; q: string }>) land.set(Number(r.template_id), Number(r.q));

  const oil = await oilLockedByTemplate(who.nationId, tx);
  return (t) => Math.max(0, (owned.get(t) ?? 0) - (pool.get(t) ?? 0) - (land.get(t) ?? 0) - (oil.get(t) ?? 0));
}

interface TemplateRow { id: number; category: string; hp: number; attack: number; defense: number }

async function loadTemplates(tx: Tx, ids: number[]): Promise<Map<number, TemplateRow>> {
  const m = new Map<number, TemplateRow>();
  if (ids.length === 0) return m;
  const r = await tx.execute(sql`
    SELECT id, category, hp, attack, defense FROM military_unit_templates WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  `);
  for (const row of r.rows as unknown as TemplateRow[]) m.set(Number(row.id), { ...row, id: Number(row.id), hp: Number(row.hp), attack: Number(row.attack), defense: Number(row.defense) });
  return m;
}

/** 在交易內:驗證並寫入某國對某戰役某方的艦隊投入(同模板累加)。 */
async function commitFleetInTx(
  tx: Tx, campaignId: number, side: "attacker" | "defender", who: Committer,
  requested: ReadonlyArray<{ templateId: unknown; quantity: unknown }>,
): Promise<void> {
  const ids = requested.map((r) => r.templateId).filter((t): t is number => typeof t === "number" && Number.isInteger(t) && t > 0);
  const tpl = await loadTemplates(tx, ids);
  const availableOf = await computeAvailableInTx(tx, who);
  const check = validateCommit(requested, (t) => tpl.get(t)?.category === "ship", availableOf);
  if (!check.ok) throw new OilCampaignError(400, check.error, "BAD_COMMIT");
  for (const l of check.lines) {
    await tx.execute(sql`
      INSERT INTO oil_campaign_fleets (campaign_id, nation_id, side, template_id, quantity)
      VALUES (${campaignId}, ${who.nationId}::uuid, ${side}, ${l.templateId}, ${l.quantity})
      ON CONFLICT (campaign_id, nation_id, side, template_id)
      DO UPDATE SET quantity = oil_campaign_fleets.quantity + EXCLUDED.quantity
    `);
  }
}

export interface LaunchParams {
  rigSlug: string;
  attacker: Committer;
  fleet: ReadonlyArray<{ templateId: unknown; quantity: unknown }>;
  now?: Date;
}

/**
 * 發起戰役。資格(海軍科技/沿海/航程)由呼叫端先用 canContestRig 驗,這裡只管資料庫不變量。
 * 回傳新戰役 id 與結算時間。
 */
export async function launchOilCampaign(p: LaunchParams): Promise<{ campaignId: number; settleAt: Date }> {
  const now = p.now ?? new Date();
  try {
    return await db.transaction(async (tx: Tx) => {
      // 鎖攻方國家列:同一國並行發起/追加會排隊,可派量檢查不會被同時通過
      await tx.execute(sql`SELECT id FROM player_nations WHERE id = ${p.attacker.nationId}::uuid FOR UPDATE`);

      const seasonRes = await tx.execute(sql`SELECT id FROM oil_seasons WHERE status = 'active' LIMIT 1`);
      const season = (seasonRes.rows as { id: number }[])[0];
      if (!season) throw new OilCampaignError(423, "目前沒有進行中的賽季", "NO_ACTIVE_SEASON");

      const rigRes = await tx.execute(sql`SELECT id, holder_nation_id FROM oil_rigs WHERE slug = ${p.rigSlug} FOR UPDATE`);
      const rig = (rigRes.rows as { id: number; holder_nation_id: string | null }[])[0];
      if (!rig) throw new OilCampaignError(404, "找不到這座油井", "UNKNOWN_RIG");
      if (rig.holder_nation_id === p.attacker.nationId) throw new OilCampaignError(400, "這座油井已經是你的了", "ALREADY_HOLDER");

      const settleAt = settleTimeFor(now);
      const ins = await tx.execute(sql`
        INSERT INTO oil_campaigns (season_id, rig_id, attacker_nation_id, defender_nation_id, status, started_at, settle_at)
        VALUES (${season.id}, ${rig.id}, ${p.attacker.nationId}::uuid, ${rig.holder_nation_id}::uuid, 'active', ${now.toISOString()}::timestamptz, ${settleAt.toISOString()}::timestamptz)
        RETURNING id
      `);
      const campaignId = (ins.rows as { id: number }[])[0]!.id;
      await commitFleetInTx(tx, campaignId, "attacker", p.attacker, p.fleet);
      return { campaignId, settleAt };
    });
  } catch (err) {
    if (pgCode(err) === "23505") throw new OilCampaignError(409, "這座油井已有進行中的戰役", "RIG_BUSY");
    throw err;
  }
}

/**
 * 追加艦隊。攻方只能加攻方、現任守方只能加守方;其他國不能介入(簡化,避免三方混戰)。
 * 戰役已過結算時間但尚未被結算掃到時也拒絕(避免在結算前一刻偷塞)。
 */
export async function reinforceOilCampaign(p: {
  campaignId: number; who: Committer; fleet: ReadonlyArray<{ templateId: unknown; quantity: unknown }>; now?: Date;
}): Promise<{ side: "attacker" | "defender" }> {
  const now = p.now ?? new Date();
  return db.transaction(async (tx: Tx) => {
    await tx.execute(sql`SELECT id FROM player_nations WHERE id = ${p.who.nationId}::uuid FOR UPDATE`);
    const cr = await tx.execute(sql`
      SELECT id, status, settle_at, attacker_nation_id, defender_nation_id FROM oil_campaigns WHERE id = ${p.campaignId} FOR UPDATE
    `);
    const c = (cr.rows as { id: number; status: string; settle_at: string | Date; attacker_nation_id: string; defender_nation_id: string | null }[])[0];
    if (!c) throw new OilCampaignError(404, "找不到這場戰役", "UNKNOWN_CAMPAIGN");
    if (c.status !== "active") throw new OilCampaignError(409, "這場戰役已結束", "NOT_ACTIVE");
    if (new Date(c.settle_at).getTime() <= now.getTime()) throw new OilCampaignError(409, "這場戰役即將結算,無法再追加", "TOO_LATE");
    const side: "attacker" | "defender" | null =
      c.attacker_nation_id === p.who.nationId ? "attacker" : c.defender_nation_id === p.who.nationId ? "defender" : null;
    if (!side) throw new OilCampaignError(403, "你不是這場戰役的參與方", "NOT_PARTICIPANT");
    await commitFleetInTx(tx, p.campaignId, side, p.who, p.fleet);
    return { side };
  });
}

export interface SettleOutcome {
  campaignId: number;
  result: OilBattleResult;
  rigSlug: string;
  newHolderNationId: string | null;
  attackerLosses: Array<{ templateId: number; lost: number }>;
  defenderLosses: Array<{ templateId: number; lost: number }>;
}

/** 讀某方艦隊成 FleetLine(附模板數值)。 */
async function loadSide(tx: Tx, campaignId: number, side: "attacker" | "defender"): Promise<{ lines: FleetLine[]; byNation: Map<string, Array<{ templateId: number; quantity: number }>> }> {
  const r = await tx.execute(sql`
    SELECT f.nation_id, f.template_id, f.quantity::text AS quantity, t.hp, t.attack, t.defense
    FROM oil_campaign_fleets f JOIN military_unit_templates t ON t.id = f.template_id
    WHERE f.campaign_id = ${campaignId} AND f.side = ${side}
  `);
  const sums = new Map<number, FleetLine>();
  const byNation = new Map<string, Array<{ templateId: number; quantity: number }>>();
  for (const row of r.rows as Array<{ nation_id: string; template_id: number; quantity: string; hp: number; attack: number; defense: number }>) {
    const tid = Number(row.template_id), q = Number(row.quantity);
    const cur = sums.get(tid);
    if (cur) cur.quantity += q;
    else sums.set(tid, { templateId: tid, quantity: q, stats: { hp: Number(row.hp), attack: Number(row.attack), defense: Number(row.defense) } });
    const list = byNation.get(row.nation_id) ?? [];
    list.push({ templateId: tid, quantity: q });
    byNation.set(row.nation_id, list);
  }
  return { lines: [...sums.values()], byNation };
}

/** 把損失比例套到某方各國的投入,並從 player_armies 扣掉。回傳各艦種損失合計。 */
async function applySideLosses(
  tx: Tx, side: { lines: FleetLine[]; byNation: Map<string, Array<{ templateId: number; quantity: number }>> }, ratio: number,
): Promise<Array<{ templateId: number; lost: number }>> {
  const totals = applyLosses(side.lines, ratio); // 以整方合計算損失
  const out: Array<{ templateId: number; lost: number }> = [];
  for (const t of totals) {
    if (t.lost <= 0) continue;
    // 損失按各國投入量比例分攤(最大餘數法,確保各國加總 = t.lost,不多不少)
    const contributors = [...side.byNation.entries()]
      .map(([nationId, ls]) => ({ nationId, q: ls.find((l) => l.templateId === t.templateId)?.quantity ?? 0 }))
      .filter((c) => c.q > 0);
    const totalQ = contributors.reduce((s, c) => s + c.q, 0);
    if (totalQ <= 0) continue;
    const shares = contributors.map((c) => {
      const exact = (t.lost * c.q) / totalQ;
      return { ...c, base: Math.floor(exact), frac: exact - Math.floor(exact) };
    });
    let remainder = t.lost - shares.reduce((s, x) => s + x.base, 0);
    [...shares].sort((a, b) => b.frac - a.frac || b.q - a.q).forEach((x) => { if (remainder > 0) { x.base += 1; remainder -= 1; } });
    for (const s of shares) {
      if (s.base <= 0) continue;
      const take = Math.min(s.base, s.q);
      await tx.execute(sql`
        UPDATE player_armies SET quantity = GREATEST(0, quantity - ${take})
        WHERE template_id = ${t.templateId} AND discord_user_id = (SELECT discord_user_id FROM player_nations WHERE id = ${s.nationId}::uuid)
      `);
    }
    out.push({ templateId: t.templateId, lost: t.lost });
  }
  return out;
}

/**
 * 結算一場戰役(已到期才會處理)。回傳 null = 無需處理(不存在/未到期/已被別人結算)。
 * CAS 認領:只有把 status 從 active 改成 settled 的那個呼叫能繼續,並行結算不會重複扣損或換手。
 */
export async function settleOilCampaign(campaignId: number, now: Date = new Date()): Promise<SettleOutcome | null> {
  return db.transaction(async (tx: Tx) => {
    const claim = await tx.execute(sql`
      UPDATE oil_campaigns SET status = 'settled', settled_at = ${now.toISOString()}::timestamptz
      WHERE id = ${campaignId} AND status = 'active' AND settle_at <= ${now.toISOString()}::timestamptz
      RETURNING id, rig_id, attacker_nation_id, defender_nation_id
    `);
    const c = (claim.rows as { id: number; rig_id: number; attacker_nation_id: string; defender_nation_id: string | null }[])[0];
    if (!c) return null;

    const rigRes = await tx.execute(sql`SELECT slug, holder_nation_id, garrison_strength FROM oil_rigs WHERE id = ${c.rig_id} FOR UPDATE`);
    const rig = (rigRes.rows as { slug: string; holder_nation_id: string | null; garrison_strength: number }[])[0]!;

    const att = await loadSide(tx, campaignId, "attacker");
    const def = await loadSide(tx, campaignId, "defender");
    // 發起時有守方、但守方現在已不是持有者(中途易手):以發起時的紀錄為準,艦隊照算
    // 無人佔領 → 守軍迎戰;有人佔領但沒投入艦隊 → 只剩守軍(同樣用 garrison 折算,避免白送)
    const defenderLines = def.lines.length > 0 ? def.lines : garrisonFleet(Number(rig.garrison_strength));
    const range = await attackerEffectiveFactor(tx, rig.slug, att);
    const result = resolveOilBattle(att.lines, defenderLines, range.factor);

    const attackerLosses = await applySideLosses(tx, att, result.attackerLossRatio);
    // 虛擬守軍(templateId 0)不對應真實艦隊,不扣損失;真實守方艦隊才扣
    const defenderLosses = def.lines.length > 0 ? await applySideLosses(tx, def, result.defenderLossRatio) : [];

    let newHolder: string | null = rig.holder_nation_id;
    if (result.outcome === "attacker_wins") {
      newHolder = c.attacker_nation_id;
      await tx.execute(sql`
        UPDATE oil_rigs SET holder_nation_id = ${newHolder}::uuid, held_since = ${now.toISOString()}::timestamptz WHERE id = ${c.rig_id}
      `);
    }
    await tx.execute(sql`
      UPDATE oil_campaigns SET outcome = ${result.outcome}, attacker_power = ${result.attackerPower}, defender_power = ${result.defenderPower}
      WHERE id = ${campaignId}
    `);
    return { campaignId, result, rigSlug: rig.slug, newHolderNationId: newHolder, attackerLosses, defenderLosses };
  });
}

/** 掃描並結算所有到期的 active 戰役(回合引擎/排程呼叫)。逐場獨立交易,一場失敗不影響其他。 */
export async function settleDueOilCampaigns(now: Date = new Date()): Promise<{ settled: number; failed: number }> {
  const due = await db.execute(sql`SELECT id FROM oil_campaigns WHERE status = 'active' AND settle_at <= ${now.toISOString()}::timestamptz ORDER BY settle_at`);
  let settled = 0, failed = 0;
  for (const row of due.rows as { id: number }[]) {
    try { if (await settleOilCampaign(row.id, now)) settled++; } catch { failed++; }
  }
  return { settled, failed };
}


// ── 資格 ────────────────────────────────────────────────────

/** 單區控制比例達此值才算「控制」該地區(油井資格用)。 */
export const OIL_CONTROL_MIN_PERCENT = 50;

/**
 * 攻方有效戰力係數(距離衰減):各國戰力按「該國離油井的最近自有地區距離」算各自係數,
 * 再以戰力為權重加權平均 —— 單國時等於該國係數;多國聯手時遠國拖累、近國拉抬,
 * 且艦數與損失分攤完全不受影響(衰減只作用在戰力上)。
 * 攻方沒有任何戰力時回傳 1(沒有東西可衰減)。
 */
async function attackerEffectiveFactor(
  tx: Tx, rigSlug: string,
  side: { lines: FleetLine[]; byNation: Map<string, Array<{ templateId: number; quantity: number }>> },
): Promise<{ factor: number; nations: Array<{ nationId: string; km: number | null; factor: number; power: number }> }> {
  const statsById = new Map(side.lines.map((l) => [l.templateId, l.stats]));
  const nations: Array<{ nationId: string; km: number | null; factor: number; power: number }> = [];
  let weighted = 0, total = 0;
  for (const [nationId, ls] of side.byNation) {
    const power = fleetPower(ls.map((l) => ({ templateId: l.templateId, quantity: l.quantity, stats: statsById.get(l.templateId)! })));
    if (!(power > 0)) continue;
    const { km, factor } = attackerRangeFactor(await controlledRegionNames(nationId, tx), rigSlug);
    nations.push({ nationId, km: km === null ? null : Math.round(km), factor, power });
    weighted += power * factor; total += power;
  }
  return { factor: total > 0 ? weighted / total : 1, nations };
}

/** 該國控制(percent ≥ 50)的地區名稱。 */
export async function controlledRegionNames(nationId: string, q: Pick<typeof db, "execute"> = db): Promise<string[]> {
  const r = await q.execute(sql`
    SELECT m.name FROM region_controls c JOIN map_regions m ON m.id = c.region_id
    WHERE c.nation_id = ${nationId}::uuid AND c.percent >= ${OIL_CONTROL_MIN_PERCENT}
  `);
  return (r.rows as { name: string }[]).map((x) => x.name);
}

/** 戰役對外視圖(給玩家看):雙方投入量與預估戰力。 */
export async function describeOilCampaign(campaignId: number): Promise<null | {
  id: number; rigSlug: string; status: string; startedAt: Date; settleAt: Date; outcome: string | null;
  attackerNationId: string; defenderNationId: string | null;
  attackerShips: number; defenderShips: number; attackerPower: number; defenderPower: number;
  /** 以目前投入量若現在結算的結果(含守方地利);追加艦隊後可能改變。 */
  forecast: "attacker_wins" | "defender_wins";
  /** 攻方距離衰減後的有效戰力係數(0.4~1);attackerPower 已含此係數。 */
  rangeFactor: number;
  /** 各攻方國家的進攻距離(km;null = 查無地區座標,按最遠算)與各自係數。 */
  attackerDistances: Array<{ nationId: string; km: number | null; factor: number }>;
}> {
  const c = await db.execute(sql`
    SELECT c.id, c.status, c.started_at, c.settle_at, c.outcome, c.attacker_nation_id, c.defender_nation_id, r.slug, r.garrison_strength
    FROM oil_campaigns c JOIN oil_rigs r ON r.id = c.rig_id WHERE c.id = ${campaignId}
  `);
  const row = (c.rows as Array<Record<string, any>>)[0];
  if (!row) return null;
  return db.transaction(async (tx: Tx) => {
    const att = await loadSide(tx, campaignId, "attacker");
    const def = await loadSide(tx, campaignId, "defender");
    const defLines = def.lines.length > 0 ? def.lines : garrisonFleet(Number(row.garrison_strength));
    // 顯示值與結算同一來源(resolveOilBattle),避免玩家看到的數字與實際對戰用的不同
    // (尤其守方地利 ×1.15:顯示 10000 對 10000 會讓人以為平手,結算卻是守方贏)。
    const range = await attackerEffectiveFactor(tx, String(row.slug), att);
    const forecast = resolveOilBattle(att.lines, defLines, range.factor);
    return {
      id: Number(row.id), rigSlug: String(row.slug), status: String(row.status),
      startedAt: new Date(row.started_at), settleAt: new Date(row.settle_at), outcome: row.outcome ?? null,
      attackerNationId: String(row.attacker_nation_id), defenderNationId: row.defender_nation_id ? String(row.defender_nation_id) : null,
      attackerShips: att.lines.reduce((s, l) => s + l.quantity, 0),
      defenderShips: def.lines.reduce((s, l) => s + l.quantity, 0),
      attackerPower: Math.round(forecast.attackerPower), defenderPower: Math.round(forecast.defenderPower),
      forecast: forecast.outcome,
      rangeFactor: Math.round(range.factor * 1000) / 1000,
      attackerDistances: range.nations.map((n) => ({ nationId: n.nationId, km: n.km, factor: Math.round(n.factor * 1000) / 1000 })),
    };
  });
}

// ── 排程 ────────────────────────────────────────────────────

const SETTLE_LOOP_MS = 60_000;
let settleLoopRunning = false;

/**
 * 每分鐘掃描到期的油井戰役並結算。獨立於回合引擎:戰役用真實時間(6 小時),
 * 回合引擎半夜不推進,綁回合會讓戰役拖到隔天。
 * 防重入:上一輪還沒跑完就跳過這一輪。賽季凍結期間不結算(換手會改變已定案的計分)。
 */
export function startOilCampaignSettleLoop(deps: {
  isFrozen: () => Promise<boolean>;
  onError: (err: unknown, msg: string) => void;
  onSettled?: (n: { settled: number; failed: number }) => void;
}): void {
  const tick = async () => {
    if (settleLoopRunning) return;
    settleLoopRunning = true;
    try {
      if (await deps.isFrozen()) return;
      const r = await settleDueOilCampaigns();
      if (r.settled > 0 || r.failed > 0) deps.onSettled?.(r);
    } catch (err) {
      deps.onError(err, "oil campaign settle loop failed");
    } finally {
      settleLoopRunning = false;
    }
  };
  setTimeout(() => void tick(), 30_000).unref();
  setInterval(() => void tick(), SETTLE_LOOP_MS).unref();
}
