// 命令與分配權限(純函式)。
// 規則(2026-10-09 提案):
//   統帥 commander      :所有己方軍團都能下 move/attack/hold;能分配軍團給軍官
//   參謀長 chief_of_staff:同統帥(可下令、可分配)
//   後勤官 quartermaster :只能下 hold(補給整頓),不能下移動與攻擊;不能分配
//   軍官 officer         :只能對「分配給自己」的軍團下 move/attack/hold
export const CAN_ASSIGN = new Set(['commander', 'chief_of_staff']);
const FULL = new Set(['commander', 'chief_of_staff']);

/** seat: {id, side, role};army: {side, assigned_seat}。回傳 { ok, reason } */
export function canOrder(seat, army, kind) {
  if (!seat || !army) return { ok: false, reason: '找不到席位或軍團' };
  if (seat.side !== army.side) return { ok: false, reason: '不是己方軍團' };
  if (FULL.has(seat.role)) return { ok: true };
  if (seat.role === 'quartermaster') return kind === 'hold' ? { ok: true } : { ok: false, reason: '後勤官只能下達待命(整頓)命令' };
  if (seat.role === 'officer') return army.assigned_seat === seat.id ? { ok: true } : { ok: false, reason: '這支軍團沒有分配給你' };
  return { ok: false, reason: '無效職位' };
}

/** 能否分配軍團:僅統帥/參謀長,且軍官必須同隊 */
export function canAssign(seat, target) {
  if (!seat || !CAN_ASSIGN.has(seat.role)) return { ok: false, reason: '只有統帥或參謀長能分配軍團' };
  if (target && target.side !== seat.side) return { ok: false, reason: '只能分配給己方軍官' };
  return { ok: true };
}
