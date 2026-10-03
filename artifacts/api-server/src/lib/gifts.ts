/**
 * 管理員普發／贈送資源給玩家或 NPC 的純函式：請求驗證與通知文案。不碰資料庫，
 * 供 routes/gifts.ts 與單元測試共用。
 *
 * 兩類資源：
 * - 永久（techPoints／money）：一次性加值（amount ≥ 1），原子 SQL 遞增並封頂。
 * - 暫時（satisfaction 滿意度／populationGrowth 人口增長率，Task #355）：管理員
 *   指定持續回合數（durationTurns），每回合遞減並於歸零後自動失效還原。滿意度另
 *   需指定方向（法律／文化／宗教／權利或全部）。暫時 buff 以 discord_user_id 為鍵，
 *   只影響有主玩家國家（NPC／無主自動略過）。
 */

import { POLITICS_DIRECTIONS, type PoliticsDirection } from "./politics";

export type GiftResource =
  | "techPoints"
  | "money"
  | "satisfaction"
  | "populationGrowth";

/** 滿意度 buff 方向：單一方向或全部四向。 */
export type GiftDirection = PoliticsDirection | "all";

export type GiftTarget =
  | { type: "nation"; nationId: string }
  | { type: "allPlayers" }
  | { type: "allNpcs" }
  | { type: "all" };

export interface GiftRequest {
  resource: GiftResource;
  amount: number;
  target: GiftTarget;
  /** 選填附註，會附在收禮方的站內通知中。空字串視為無附註。 */
  note: string | null;
  /** 暫時 buff 的持續回合數（≥1）；永久資源為 null。 */
  durationTurns: number | null;
  /** 滿意度 buff 方向；其他資源為 null。 */
  direction: GiftDirection | null;
}

/**
 * 各資源的中文名稱、上限與是否為暫時 buff。永久資源上限與「國家管理」的 stat
 * 編輯上限一致，避免溢位（科技點數存 int4、金錢存 int8）；暫時 buff 為滿意度／
 * 人口增長率的每回合偏移量（皆 0–100）。
 */
export const GIFT_RESOURCE_SPECS: Record<
  GiftResource,
  { label: string; max: number; temporary: boolean }
> = {
  techPoints: { label: "科技點數", max: 2_000_000_000, temporary: false },
  money: { label: "金錢", max: 1_000_000_000_000_000, temporary: false },
  satisfaction: { label: "滿意度", max: 100, temporary: true },
  populationGrowth: { label: "人口增長率", max: 100, temporary: true },
};

export const GIFT_NOTE_MAX = 200;

/** 暫時 buff 持續回合數上限（避免誤輸入天文數字）。 */
export const GIFT_DURATION_MAX = 1000;

/** 滿意度方向的中文標籤（通知文案用）。 */
const GIFT_DIRECTION_LABELS: Record<GiftDirection, string> = {
  law: "法律",
  culture: "文化",
  religion: "宗教",
  rights: "權利",
  military: "軍方",
  all: "全部方向",
};

function isGiftResource(v: unknown): v is GiftResource {
  return (
    v === "techPoints" ||
    v === "money" ||
    v === "satisfaction" ||
    v === "populationGrowth"
  );
}

function isGiftDirection(v: unknown): v is GiftDirection {
  if (v === "all") return true;
  return (
    typeof v === "string" &&
    (POLITICS_DIRECTIONS as readonly string[]).includes(v)
  );
}

/** 解析附註：非字串或 trim 後為空 → null；過長則截斷。 */
export function parseGiftNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  return trimmed.length > GIFT_NOTE_MAX
    ? trimmed.slice(0, GIFT_NOTE_MAX)
    : trimmed;
}

/** 解析發放對象。回傳合法的 GiftTarget，或帶中文錯誤訊息。 */
export function parseGiftTarget(
  raw: unknown,
): { target: GiftTarget } | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "發放對象格式不正確" };
  }
  const { type, nationId } = raw as { type?: unknown; nationId?: unknown };
  if (type === "allPlayers" || type === "allNpcs" || type === "all") {
    return { target: { type } };
  }
  if (type === "nation") {
    if (typeof nationId !== "string" || nationId.trim() === "") {
      return { error: "請指定要發放的國家" };
    }
    return { target: { type: "nation", nationId: nationId.trim() } };
  }
  return { error: "發放對象格式不正確" };
}

function isPositiveIntInRange(v: unknown, min: number, max: number): boolean {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= min &&
    v <= max
  );
}

/**
 * 解析與驗證整個普發請求 body。回傳合法的 GiftRequest，或帶中文錯誤訊息。
 */
export function parseGiftRequest(
  body: Record<string, unknown>,
): { request: GiftRequest } | { error: string } {
  const { resource, amount } = body;
  if (!isGiftResource(resource)) {
    return { error: "資源類型必須是科技點數、金錢、滿意度或人口增長率" };
  }
  const spec = GIFT_RESOURCE_SPECS[resource];
  if (!isPositiveIntInRange(amount, 1, spec.max)) {
    return {
      error: `${spec.label}數量必須是 1 到 ${spec.max.toLocaleString("en-US")} 之間的整數`,
    };
  }
  const targetResult = parseGiftTarget(body.target);
  if ("error" in targetResult) return targetResult;

  let durationTurns: number | null = null;
  let direction: GiftDirection | null = null;
  if (spec.temporary) {
    if (!isPositiveIntInRange(body.durationTurns, 1, GIFT_DURATION_MAX)) {
      return {
        error: `持續回合數必須是 1 到 ${GIFT_DURATION_MAX} 之間的整數`,
      };
    }
    durationTurns = body.durationTurns as number;
    if (resource === "satisfaction") {
      if (!isGiftDirection(body.direction)) {
        return { error: "請選擇滿意度方向（法律／文化／宗教／權利或全部）" };
      }
      direction = body.direction;
    }
  }

  return {
    request: {
      resource,
      amount: amount as number,
      target: targetResult.target,
      note: parseGiftNote(body.note),
      durationTurns,
      direction,
    },
  };
}

/**
 * Task #504 — 開局資源設定（world_game_state.starting_tech_points／
 * starting_money）的驗證上限與純解析函式。上限與發放資源一致，避免溢位
 * （科技點 int4、金錢 int8）。
 * 開局領土生產力上限（founding_production_cap）同列管理。
 */
export const STARTING_TECH_POINTS_MAX = 2_000_000_000;
export const STARTING_MONEY_MAX = 1_000_000_000_000_000;
export const FOUNDING_PRODUCTION_CAP_MAX = 1_000_000_000;

export interface StartingResourcesUpdate {
  startingTechPoints: number;
  startingMoney: number;
  /** 省略時保留現有值，不更新。 */
  foundingProductionCap?: number;
}

function isNonNegativeIntInRange(v: unknown, max: number): boolean {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= max
  );
}

/** 解析與驗證開局資源設定更新。回傳合法更新值，或帶中文錯誤訊息。 */
export function parseStartingResourcesUpdate(
  body: Record<string, unknown>,
): { update: StartingResourcesUpdate } | { error: string } {
  const { startingTechPoints, startingMoney, foundingProductionCap } = body;
  if (!isNonNegativeIntInRange(startingTechPoints, STARTING_TECH_POINTS_MAX)) {
    return {
      error: `開局科技點數必須是 0 到 ${STARTING_TECH_POINTS_MAX.toLocaleString("en-US")} 之間的整數`,
    };
  }
  if (!isNonNegativeIntInRange(startingMoney, STARTING_MONEY_MAX)) {
    return {
      error: `開局金錢必須是 0 到 ${STARTING_MONEY_MAX.toLocaleString("en-US")} 之間的整數`,
    };
  }
  // foundingProductionCap 選填：提供時才驗證
  if (foundingProductionCap !== undefined) {
    if (!isNonNegativeIntInRange(foundingProductionCap, FOUNDING_PRODUCTION_CAP_MAX)) {
      return {
        error: `開局生產力上限必須是 0 到 ${FOUNDING_PRODUCTION_CAP_MAX.toLocaleString("en-US")} 之間的整數`,
      };
    }
  }
  return {
    update: {
      startingTechPoints: startingTechPoints as number,
      startingMoney: startingMoney as number,
      ...(foundingProductionCap !== undefined && {
        foundingProductionCap: foundingProductionCap as number,
      }),
    },
  };
}

/** 發放對象的中文說明（通知與回應摘要用）。 */
export function giftTargetLabel(target: GiftTarget): string {
  switch (target.type) {
    case "all":
      return "全體國家";
    case "allPlayers":
      return "全體玩家";
    case "allNpcs":
      return "全體 NPC";
    case "nation":
      return "指定國家";
  }
}

/**
 * 滿意度 buff 要套用的方向清單：單一方向 → 該方向；"all" → 四向全部。
 */
export function giftSatisfactionDirections(
  direction: GiftDirection,
): PoliticsDirection[] {
  return direction === "all" ? [...POLITICS_DIRECTIONS] : [direction];
}

/** 收禮玩家看到的站內通知文案。 */
export function buildGiftNotification(
  resource: GiftResource,
  amount: number,
  note: string | null,
  opts?: { durationTurns?: number | null; direction?: GiftDirection | null },
): { title: string; body: string } {
  const label = GIFT_RESOURCE_SPECS[resource].label;
  const amountText = amount.toLocaleString("zh-TW");
  const noteText = note ? `\n附註：${note}` : "";
  const spec = GIFT_RESOURCE_SPECS[resource];

  if (spec.temporary) {
    const turns = opts?.durationTurns ?? 0;
    const dirText =
      resource === "satisfaction" && opts?.direction
        ? `（${GIFT_DIRECTION_LABELS[opts.direction]}）`
        : "";
    return {
      title: "收到管理員發放的暫時加成",
      body: `🎁 管理員發放了 ${label}${dirText} +${amountText}，持續 ${turns} 回合。${noteText}`,
    };
  }

  return {
    title: "收到管理員發放的資源",
    body: `🎁 管理員發放了 ${amountText} ${label}給你的國家。${noteText}`,
  };
}
