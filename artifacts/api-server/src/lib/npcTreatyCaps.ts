/**
 * Task #570 — NPC 締約可提供資源的上限（純函式，不碰 DB）。
 *
 * 只約束「NPC 付出」的一側：
 * - 一次性庫存資源（金錢／科技點／木材／礦石）≤ NPC 現有存量 × stockCapPct%。
 * - 地區：單一條約 ≤ maxRegions 區；每區讓渡比例 ≤ NPC 掌控 % × regionMaxPct%。
 * - 每回合輸送（金錢／科技／生產／糧食／木材／礦石）≤ NPC 對應每回合產出
 *   （稅收／科研點／生產力／糧食產量／木礦建築產出）× perTurnCapPct%。
 *
 * 真人↔真人條約、以及玩家付給 NPC 的一側完全不受影響（守門端負責只在
 * 「NPC 為付出方」時套用）。設定值存於 world_game_state（管理員可調），
 * 載入端見 npcTreatyCapData.ts。
 */

export interface NpcTreatyCapSettings {
  /** 一次性庫存資源上限（% of 存量；0–100）。 */
  stockCapPct: number;
  /** 單一條約可要求 NPC 讓出的地區數上限（0–10）。 */
  maxRegions: number;
  /** 每區讓渡比例上限（% of NPC 掌控 %；0–100）。 */
  regionMaxPct: number;
  /** 每回合輸送上限（% of 對應每回合產出；0–100）。 */
  perTurnCapPct: number;
}

/** 程式內建預設值（與啟動遷移的欄位預設一致）。 */
export const DEFAULT_NPC_TREATY_CAP_SETTINGS: NpcTreatyCapSettings = {
  stockCapPct: 20,
  maxRegions: 3,
  regionMaxPct: 50,
  perTurnCapPct: 10,
};

/** NPC 國家資源快照（庫存＋每回合產出）。 */
export interface NpcTreatyCapSnapshot {
  money: number;
  techPoints: number;
  wood: number;
  ore: number;
  /** 每回合稅收（金錢產出）。 */
  taxIncomePerTurn: number;
  /** 每回合科研點產出。 */
  techPerTurn: number;
  /** 每回合生產力。 */
  productionPerTurn: number;
  /** 每回合糧食產量。 */
  foodPerTurn: number;
  /** 每回合木材產出（伐木場）。 */
  woodPerTurn: number;
  /** 每回合礦石產出（礦場）。 */
  orePerTurn: number;
}

/** 各資源目前的最大可提供量（皆為非負整數）。 */
export interface NpcTreatyCaps {
  money: number;
  techPoints: number;
  wood: number;
  ore: number;
  maxRegions: number;
  regionMaxPct: number;
  perTurnMoney: number;
  perTurnTech: number;
  perTurnProduction: number;
  perTurnFood: number;
  perTurnWood: number;
  perTurnOre: number;
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

function capByPct(amount: number, pct: number): number {
  const base = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return Math.max(0, Math.floor((base * clampPct(pct)) / 100));
}

/** 由 NPC 資源快照＋世界設定計算各資源上限。 */
export function computeNpcTreatyCaps(
  snapshot: NpcTreatyCapSnapshot,
  settings: NpcTreatyCapSettings,
): NpcTreatyCaps {
  return {
    money: capByPct(snapshot.money, settings.stockCapPct),
    techPoints: capByPct(snapshot.techPoints, settings.stockCapPct),
    wood: capByPct(snapshot.wood, settings.stockCapPct),
    ore: capByPct(snapshot.ore, settings.stockCapPct),
    maxRegions: Math.max(0, Math.trunc(settings.maxRegions)),
    regionMaxPct: clampPct(settings.regionMaxPct),
    perTurnMoney: capByPct(snapshot.taxIncomePerTurn, settings.perTurnCapPct),
    perTurnTech: capByPct(snapshot.techPerTurn, settings.perTurnCapPct),
    perTurnProduction: capByPct(
      snapshot.productionPerTurn,
      settings.perTurnCapPct,
    ),
    perTurnFood: capByPct(snapshot.foodPerTurn, settings.perTurnCapPct),
    perTurnWood: capByPct(snapshot.woodPerTurn, settings.perTurnCapPct),
    perTurnOre: capByPct(snapshot.orePerTurn, settings.perTurnCapPct),
  };
}

/**
 * 單一地區可讓渡的最大百分比 = floor(NPC 掌控 % × regionMaxPct / 100)。
 * 掌控 0 或比例 0 → 0（該區完全不可要求）。
 */
export function regionTransferCapPct(
  heldPercent: number,
  regionMaxPct: number,
): number {
  return capByPct(Math.min(100, heldPercent), regionMaxPct);
}

/** NPC 付出側的欄位（守門檢查用；地區帶掌控與讓渡 %）。 */
export interface NpcPaidTreatyFields {
  money: number;
  techPoints: number;
  wood: number;
  ore: number;
  regions: {
    regionId: number;
    regionName?: string;
    /** 這筆條約要求讓渡的百分比（缺項＝整份轉移時請傳掌控 %）。 */
    transferPercent: number;
    heldPercent: number;
  }[];
  perTurnMoney: number;
  perTurnTech: number;
  perTurnProduction: number;
  perTurnFood: number;
  perTurnWood: number;
  perTurnOre: number;
}

const ZERO_NPC_PAID: Omit<NpcPaidTreatyFields, "regions"> = {
  money: 0,
  techPoints: 0,
  wood: 0,
  ore: 0,
  perTurnMoney: 0,
  perTurnTech: 0,
  perTurnProduction: 0,
  perTurnFood: 0,
  perTurnWood: 0,
  perTurnOre: 0,
};

/** 便利建構：只填有值的欄位。 */
export function npcPaidFields(
  partial: Partial<NpcPaidTreatyFields>,
): NpcPaidTreatyFields {
  return { ...ZERO_NPC_PAID, regions: [], ...partial };
}

/**
 * 檢查 NPC 付出側是否超過上限；回傳 zh-TW 違規訊息清單（空陣列＝通過）。
 * 訊息會列出目前上限，供 400 錯誤與 NPC 拒絕說明使用。
 */
export function findNpcTreatyCapViolations(
  fields: NpcPaidTreatyFields,
  caps: NpcTreatyCaps,
): string[] {
  const violations: string[] = [];
  const oneTime: Array<[number, number, string]> = [
    [fields.money, caps.money, "金錢"],
    [fields.techPoints, caps.techPoints, "科技點數"],
    [fields.wood, caps.wood, "木材"],
    [fields.ore, caps.ore, "礦石"],
  ];
  for (const [value, cap, label] of oneTime) {
    if (value > cap) {
      violations.push(`${label} ${value} 超過上限 ${cap}`);
    }
  }
  if (fields.regions.length > caps.maxRegions) {
    violations.push(
      `要求讓渡 ${fields.regions.length} 個地區，超過單一條約上限 ${caps.maxRegions} 區`,
    );
  }
  for (const r of fields.regions) {
    const cap = regionTransferCapPct(r.heldPercent, caps.regionMaxPct);
    if (r.transferPercent > cap) {
      const name = r.regionName ?? `#${r.regionId}`;
      violations.push(
        `「${name}」要求讓渡 ${r.transferPercent}%，超過上限 ${cap}%（掌控 ${r.heldPercent}% 的 ${caps.regionMaxPct}%）`,
      );
    }
  }
  const perTurn: Array<[number, number, string]> = [
    [fields.perTurnMoney, caps.perTurnMoney, "每回合金錢"],
    [fields.perTurnTech, caps.perTurnTech, "每回合科技點數"],
    [fields.perTurnProduction, caps.perTurnProduction, "每回合生產力"],
    [fields.perTurnFood, caps.perTurnFood, "每回合糧食"],
    [fields.perTurnWood, caps.perTurnWood, "每回合木材"],
    [fields.perTurnOre, caps.perTurnOre, "每回合礦石"],
  ];
  for (const [value, cap, label] of perTurn) {
    if (value > cap) {
      violations.push(`${label} ${value} 超過上限 ${cap}`);
    }
  }
  return violations;
}

/** NPC 主動提案 offer 側的夾限結果。 */
export interface ClampedNpcOffer {
  offerMoney: number;
  offerTechPoints: number;
  offerRegionIds: number[];
  offerRegionPercents: Record<string, number>;
  /** 是否有任何欄位被夾限（記 log 用）。 */
  clamped: boolean;
}

/**
 * 把 NPC 主動提案（npcInitiative／聊天交換）offer 側夾進上限。
 * - 金錢／科技點夾到各自上限。
 * - 地區只保留 NPC 實際掌控的前 maxRegions 個；每區百分比（缺項＝整份）
 *   夾到 regionTransferCapPct；夾完 ≤0 的地區直接剔除。
 */
export function clampNpcOfferToCaps(
  offer: {
    offerMoney: number;
    offerTechPoints: number;
    offerRegionIds: number[];
    offerRegionPercents: Record<string, number>;
  },
  held: ReadonlyMap<number, number>,
  caps: NpcTreatyCaps,
): ClampedNpcOffer {
  const money = Math.min(Math.max(0, offer.offerMoney), caps.money);
  const tech = Math.min(Math.max(0, offer.offerTechPoints), caps.techPoints);
  const regionIds: number[] = [];
  const regionPercents: Record<string, number> = {};
  let regionsClamped = false;
  for (const id of offer.offerRegionIds) {
    if (regionIds.includes(id)) continue;
    const heldPct = held.get(id) ?? 0;
    if (heldPct <= 0) {
      regionsClamped = true;
      continue;
    }
    if (regionIds.length >= caps.maxRegions) {
      regionsClamped = true;
      break;
    }
    const cap = regionTransferCapPct(heldPct, caps.regionMaxPct);
    if (cap <= 0) {
      regionsClamped = true;
      continue;
    }
    const requested = offer.offerRegionPercents[String(id)] ?? heldPct;
    const pct = Math.min(Math.max(1, Math.trunc(requested)), cap);
    if (pct !== requested) regionsClamped = true;
    regionIds.push(id);
    regionPercents[String(id)] = pct;
  }
  return {
    offerMoney: money,
    offerTechPoints: tech,
    offerRegionIds: regionIds,
    offerRegionPercents: regionPercents,
    clamped:
      regionsClamped ||
      money !== Math.max(0, offer.offerMoney) ||
      tech !== Math.max(0, offer.offerTechPoints),
  };
}
