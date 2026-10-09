import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNickname, normalizeNickname, nicknameKey } from './nickname.js';

const ok = (s) => assert.equal(validateNickname(s).ok, true, `應通過: ${s}`);
const bad = (s) => assert.equal(validateNickname(s).ok, false, `應拒絕: ${JSON.stringify(s)}`);

test('一般暱稱通過', () => { ok('魯登道夫'); ok('Foch_1918'); ok('小 毛'); ok('Pétain'.replace('é','e')); });
test('長度 2~16 字(以字元計)', () => { bad('a'); ok('ab'); ok('一二三四五六七八九十一二三四五六'); bad('一二三四五六七八九十一二三四五六七'); });
test('前後空白與連續空白被正規化', () => { assert.equal(normalizeNickname('  小   毛  '), '小 毛'); });
test('全形半形視為同一個', () => {
  assert.equal(nicknameKey('ＡＢＣ１２３'), nicknameKey('abc123'));
});
test('大小寫視為同一個', () => { assert.equal(nicknameKey('Foch'), nicknameKey('FOCH')); });
test('隱形/零寬/控制字元被拒絕', () => { bad('小\u200b毛'); bad('小\u202e毛'); bad('ab\u0000'); });
test('特殊符號與 emoji 被拒絕', () => { bad('小毛<script>'); bad('毛😀毛'); bad("a'b"); });
test('純符號被拒絕', () => { bad('__'); bad('..'); bad('- -'); });
test('保留字被拒絕(含全形)', () => { bad('admin'); bad('ＡＤＭＩＮ'); bad('管理員'); bad('系統'); });
test('空值/非字串不會丟例外', () => { bad(''); bad(null); bad(undefined); bad({}); bad([]); ok(12345); });
