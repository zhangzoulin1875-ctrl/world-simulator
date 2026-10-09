// 席位分配規則(純函式,不碰資料庫,方便測試)
// 規則(2026-10-09):不做 AI 代打。每隊 3 個核心職位,其餘加入者一律是一般軍官。
export const SIDES = ['DE', 'FR'];
export const CORE_ROLES = ['commander', 'chief_of_staff', 'quartermaster']; // 依補位順序
export const ROLE_LABEL = {
  commander: '統帥', chief_of_staff: '參謀長', quartermaster: '後勤官', officer: '軍官',
};

/** seats: [{side, role}]。回傳 {side, role}:新玩家該去哪一隊、什麼職位。
 *  分邊:人數少的一隊優先;同數時,核心職位空缺較多的一隊優先;再同則 DE。
 *  職位:該隊還有空的核心職位就補(依 CORE_ROLES 順序),否則是 officer。 */
export function assignSeat(seats) {
  const count = (side) => seats.filter((s) => s.side === side).length;
  const vacant = (side) => CORE_ROLES.filter((r) => !seats.some((s) => s.side === side && s.role === r)).length;
  const side = [...SIDES].sort((a, b) =>
    count(a) - count(b) || vacant(b) - vacant(a) || SIDES.indexOf(a) - SIDES.indexOf(b))[0];
  const role = CORE_ROLES.find((r) => !seats.some((s) => s.side === side && s.role === r)) ?? 'officer';
  return { side, role };
}

/** 核心職位離開後,是否要由軍官遞補?規則:不自動遞補,保留給玩家投票/任命(之後做)。 */
export function vacantCore(seats, side) {
  return CORE_ROLES.filter((r) => !seats.some((s) => s.side === side && s.role === r));
}
