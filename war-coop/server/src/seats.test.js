import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSeat, vacantCore, CORE_ROLES } from './seats.js';

// 模擬連續加入 n 人,回傳席位表
function join(n) { const seats = []; for (let i = 0; i < n; i++) seats.push(assignSeat(seats)); return seats; }

test('第一人去 DE 當統帥', () => {
  assert.deepEqual(assignSeat([]), { side: 'DE', role: 'commander' });
});
test('第二人去人少的 FR,也當統帥', () => {
  assert.deepEqual(assignSeat([{ side: 'DE', role: 'commander' }]), { side: 'FR', role: 'commander' });
});
test('前 6 人:兩隊各補滿 3 個核心職位', () => {
  const s = join(6);
  for (const side of ['DE', 'FR']) {
    assert.deepEqual(s.filter((x) => x.side === side).map((x) => x.role).sort(), [...CORE_ROLES].sort());
  }
});
test('第 7 人起全是一般軍官', () => {
  const s = join(20);
  assert.ok(s.slice(6).every((x) => x.role === 'officer'));
  assert.equal(s.slice(0, 6).filter((x) => x.role === 'officer').length, 0);
});
test('兩隊人數差不超過 1', () => {
  for (let n = 1; n <= 41; n++) {
    const s = join(n); const d = s.filter((x) => x.side === 'DE').length;
    assert.ok(Math.abs(d - (n - d)) <= 1, `n=${n}`);
  }
});
test('每隊每個核心職位至多一人', () => {
  const s = join(30);
  for (const side of ['DE', 'FR']) for (const r of CORE_ROLES)
    assert.ok(s.filter((x) => x.side === side && x.role === r).length <= 1);
});
test('核心職位離開後,新人補到缺的那隊與職位', () => {
  const s = join(10).filter((x) => !(x.side === 'FR' && x.role === 'quartermaster'));
  // 此時 FR 缺後勤官,且 FR 人數較少 → 新人去 FR 補後勤官
  const cnt = (side) => s.filter((x) => x.side === side).length;
  if (cnt('FR') <= cnt('DE')) assert.deepEqual(assignSeat(s), { side: 'FR', role: 'quartermaster' });
});
test('vacantCore 列出缺的核心職位', () => {
  assert.deepEqual(vacantCore([{ side: 'DE', role: 'commander' }], 'DE'), ['chief_of_staff', 'quartermaster']);
});
