import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planDeployment } from './deploy.js';
const R = JSON.parse(readFileSync(new URL('../map/regions.json', import.meta.url), 'utf8'));
const by = new Map(R.map((r) => [r.id, r]));

test('每方 6 支,共 12 支', () => {
  const d = planDeployment(R); assert.equal(d.length, 12);
  assert.equal(d.filter((a) => a.side === 'DE').length, 6); assert.equal(d.filter((a) => a.side === 'FR').length, 6);
});
test('部署在己方控制區,不在後方區、不在首都', () => {
  for (const a of planDeployment(R)) {
    const r = by.get(a.region);
    assert.equal(r.owner, a.side); assert.equal(r.rear, false);
    assert.ok(!(r.tag || '').startsWith('capital'), '首都不放野戰軍(有常駐守備)');
  }
});
test('決定論:同輸入同輸出', () => { assert.deepEqual(planDeployment(R), planDeployment(R)); });
test('可指定數量,且軍團名稱不重複', () => {
  const d = planDeployment(R, 10); assert.equal(d.length, 20);
  assert.equal(new Set(d.map((a) => a.name)).size, 20);
});
