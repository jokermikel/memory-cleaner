'use strict';
/**
 * cleanupService 单元测试
 * 重点验证「防护闸门」：默认 dry-run、拒绝保护进程、未确认不执行。
 * 运行：node --test server/services/__tests__/cleanup.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const { plan, execute, BATCH_LIMIT } = require(path.join(ws, 'server/services/cleanupService'));

test('plan 返回 dry-run 计划，不执行任何操作', () => {
  const p = plan();
  assert.strictEqual(p.mode, 'dry-run');
  assert.ok(typeof p.processCount === 'number');
  assert.ok(typeof p.estimatedBytes === 'number');
  assert.ok(Array.isArray(p.processes));
  assert.ok(Array.isArray(p.apps));
  // 计划里的应用必须都是 safe（默认只挑可清理的）
  assert.ok(p.apps.every(a => a.risk === 'safe'), '默认计划只能包含 safe 应用');
});

test('默认 execute 是 dry-run，不会真执行', () => {
  const r = execute();
  assert.strictEqual(r.executed, false);
  assert.strictEqual(r.mode, 'dry-run');
});

test('显式指定保护进程时抛 PROTECTED_TARGET 错误', () => {
  let threw = null;
  try {
    // lsass 在禁止名单里，且词典/名单都会判 protected
    execute({ appKeys: ['lsass'], dryRun: false, confirmed: true });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, '必须抛错');
  assert.strictEqual(threw.code, 'PROTECTED_TARGET');
});

test('真实执行但未确认时抛 NOT_CONFIRMED 错误', () => {
  let threw = null;
  try {
    execute({ dryRun: false, confirmed: false, appKeys: ['douyin'] });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, '未确认必须抛错');
  assert.strictEqual(threw.code, 'NOT_CONFIRMED');
});

test('批量上限常量为 20', () => {
  assert.strictEqual(BATCH_LIMIT, 20);
});

test('执行计划的 PID 与启动时间结构完整（防 PID 复用校验所需字段）', () => {
  const p = plan();
  for (const proc of p.processes.slice(0, 20)) {
    assert.ok(typeof proc.pid === 'number');
    assert.ok(typeof proc.name === 'string');
    assert.ok('startTime' in proc, '必须带 startTime 用于 PID 复用校验');
    assert.ok('startTimeMs' in proc, '必须带 startTimeMs，避免 PS 5.1 解析带时区的字符串翻车');
    assert.ok('path' in proc, '必须带 path，扫尾时按安装目录匹配，避免按进程名误杀');
  }
});
