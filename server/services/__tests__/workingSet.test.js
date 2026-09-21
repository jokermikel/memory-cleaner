'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const { plan, execute } = require(path.join(ws, 'server/services/workingSetService'));

test('plan 返回修剪计划且默认不执行', () => {
  const p = plan();
  assert.strictEqual(p.action, 'trim-working-set');
  assert.strictEqual(p.mode, 'dry-run');
  assert.ok(Array.isArray(p.processes));
  assert.ok(p.apps.every(a => a.risk === 'safe'));
});

test('execute 默认 dry-run', () => {
  const r = execute();
  assert.strictEqual(r.executed, false);
  assert.strictEqual(r.mode, 'dry-run');
});

test('未确认真实修剪抛 NOT_CONFIRMED', () => {
  let err = null;
  try { execute({ dryRun: false, confirmed: false }); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.code, 'NOT_CONFIRMED');
});

test('指定保护进程抛 PROTECTED_TARGET', () => {
  let err = null;
  try { execute({ appKeys: ['lsass'], dryRun: false, confirmed: true }); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.code, 'PROTECTED_TARGET');
});
