import test from 'node:test';
import assert from 'node:assert/strict';
import { canOrder, canAssign } from './permissions.js';

const S = (role, id = 1, side = 'DE') => ({ id, side, role });
const A = (over = {}) => ({ side: 'DE', assigned_seat: null, ...over });

test('統帥與參謀長可對任何己方軍團下任何命令', () => {
  for (const role of ['commander', 'chief_of_staff']) for (const k of ['move', 'attack', 'hold'])
    assert.equal(canOrder(S(role), A(), k).ok, true, `${role} ${k}`);
});
test('不能指揮敵方軍團(即使是統帥)', () => {
  assert.equal(canOrder(S('commander'), A({ side: 'FR' }), 'move').ok, false);
});
test('後勤官只能待命', () => {
  assert.equal(canOrder(S('quartermaster'), A(), 'hold').ok, true);
  assert.equal(canOrder(S('quartermaster'), A(), 'move').ok, false);
  assert.equal(canOrder(S('quartermaster'), A(), 'attack').ok, false);
});
test('軍官只能指揮分配給自己的軍團', () => {
  assert.equal(canOrder(S('officer', 7), A({ assigned_seat: 7 }), 'attack').ok, true);
  assert.equal(canOrder(S('officer', 7), A({ assigned_seat: 8 }), 'attack').ok, false);
  assert.equal(canOrder(S('officer', 7), A({ assigned_seat: null }), 'hold').ok, false, '未分配的軍團軍官不能碰');
});
test('缺資料與未知職位被拒絕,不丟例外', () => {
  assert.equal(canOrder(null, A(), 'hold').ok, false);
  assert.equal(canOrder(S('officer'), null, 'hold').ok, false);
  assert.equal(canOrder(S('spy'), A(), 'hold').ok, false);
});
test('分配權限:只有統帥/參謀長,且只能分配給己方', () => {
  assert.equal(canAssign(S('commander'), S('officer', 2)).ok, true);
  assert.equal(canAssign(S('chief_of_staff'), S('officer', 2)).ok, true);
  assert.equal(canAssign(S('quartermaster'), S('officer', 2)).ok, false);
  assert.equal(canAssign(S('officer'), S('officer', 2)).ok, false);
  assert.equal(canAssign(S('commander'), S('officer', 2, 'FR')).ok, false, '不能分配給敵方');
});
