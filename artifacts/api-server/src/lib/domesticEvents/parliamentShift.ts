import { PARLIAMENT_TOTAL_SEATS, allocateSeats, type SeatedParty } from "../parliament/core";

/** 社會黨(福利派)在「取得多數」事件後的席次 */
export const SOCIALIST_MAJORITY_SEATS = 55;
export const SOCIALIST_PARTY_NAME = "社會黨";

/**
 * 事件對議會席次的改動(純函式,回傳新陣列,不修改輸入)。
 *  - socialists_in:福利派黨(沒有就新增)推到多數席次,其餘按原比例縮小且每黨至少 1 席
 *  - socialists_out:福利派黨被逐出議會,席次按比例還給其他黨;若只剩它一個黨就原樣保留(不留空議會)
 */
export function shiftParliament(
  parties: readonly SeatedParty[],
  mode: "socialists_in" | "socialists_out",
  total: number = PARLIAMENT_TOTAL_SEATS,
): SeatedParty[] {
  if (mode === "socialists_out") {
    const rest = parties.filter((p) => p.stance !== "welfare");
    if (rest.length === 0 || rest.length === parties.length) return parties.map((p) => ({ ...p }));
    return allocateSeats(rest.map((p) => ({ id: p.id, name: p.name, stance: p.stance, weight: Math.max(1, p.seats) })), total);
  }

  const existing = parties.find((p) => p.stance === "welfare");
  const socialist: SeatedParty = existing
    ? { ...existing }
    : { id: "p-socialist", name: SOCIALIST_PARTY_NAME, stance: "welfare", weight: SOCIALIST_MAJORITY_SEATS, seats: 0 };
  const others = parties.filter((p) => p.stance !== "welfare" && p.stance !== "loyalist");
  const loyal = parties.filter((p) => p.stance === "loyalist");
  const rest = [...others, ...loyal];
  const target = Math.min(total - Math.max(0, rest.length), SOCIALIST_MAJORITY_SEATS);
  const remaining = total - target;
  if (rest.length === 0) return [{ ...socialist, seats: total }];
  const restSeated = allocateSeats(rest.map((p) => ({ id: p.id, name: p.name, stance: p.stance, weight: Math.max(1, p.seats) })), remaining);
  return [{ ...socialist, seats: target }, ...restSeated];
}

/** 這些席次裡,是否有單一政黨過半 */
export function hasMajority(parties: readonly SeatedParty[], total: number = PARLIAMENT_TOTAL_SEATS): boolean {
  return parties.some((p) => p.seats * 2 > total);
}
