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
const fs = require('fs');
const { plan, execute, assertBatchAllowed, sumFreedBytes, protectedImageNames, BATCH_LIMIT } = require(path.join(ws, 'server/services/cleanupService'));

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

test('默认 execute 是 dry-run，不会真执行', async () => {
  const r = await execute();
  assert.strictEqual(r.executed, false);
  assert.strictEqual(r.mode, 'dry-run');
});

test('显式指定保护进程时抛 PROTECTED_TARGET 错误', async () => {
  // 长期-2 起 execute 是异步任务（可取消/超时），失败通过 Promise 拒绝传达
  await assert.rejects(
    execute({ appKeys: ['lsass'], dryRun: false, confirmed: true }),
    e => e && e.code === 'PROTECTED_TARGET'
  );
});

test('真实执行但未确认时抛 NOT_CONFIRMED 错误', async () => {
  await assert.rejects(
    execute({ dryRun: false, confirmed: false, appKeys: ['douyin'] }),
    e => e && e.code === 'NOT_CONFIRMED'
  );
});

test('批量上限常量为 20', () => {
  assert.strictEqual(BATCH_LIMIT, 20);
});

// ───── 批量上限闸门（改动 1：force 不再放行批量）─────

test('批量上限：未超限时不需要任何额外标志', () => {
  assert.doesNotThrow(() => assertBatchAllowed(BATCH_LIMIT - 1, {}));
  assert.doesNotThrow(() => assertBatchAllowed(BATCH_LIMIT, {}), '恰好等于上限不应触发');
});

test('批量上限：超限且未传 acknowledgeBatchLimit 时抛 BATCH_LIMIT', () => {
  let threw = null;
  try {
    assertBatchAllowed(BATCH_LIMIT + 1, {});
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, '超限必须抛错');
  assert.strictEqual(threw.code, 'BATCH_LIMIT');
});

test('批量上限：只传 force 不能放行（回归断言，防闸门再次被绕过）', () => {
  let threw = null;
  try {
    assertBatchAllowed(BATCH_LIMIT + 1, { force: true });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'force 只负责强制结束，不得用于放行批量');
  assert.strictEqual(threw.code, 'BATCH_LIMIT');
});

test('批量上限：显式 acknowledgeBatchLimit=true 才放行', () => {
  assert.doesNotThrow(() => assertBatchAllowed(BATCH_LIMIT + 1, { acknowledgeBatchLimit: true }));
  assert.doesNotThrow(() => assertBatchAllowed(BATCH_LIMIT + 100, { acknowledgeBatchLimit: true }));
});

test('execute 已接入批量上限闸门（代码路径核对，防接线被摘掉）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/cleanupService.js'), 'utf8');
  assert.ok(/assertBatchAllowed\(p\.processCount\s*,\s*opts\)/.test(src),
    'execute 必须调用 assertBatchAllowed(p.processCount, opts)');
  assert.ok(!/processCount\s*>\s*BATCH_LIMIT\s*&&\s*!opts\.force/.test(src),
    '不得再用 force 放行批量（这正是被绕过的原始写法）');
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

// ───── 释放量口径（改动 7：不再把自然波动算成战果）─────

// ───── 短期-6：交给 cleanup.ps1 的受保护影像名清单 ─────

test('受保护影像名清单包含名单文件与快照里的 protected 应用', () => {
  const names = protectedImageNames(null);
  assert.ok(names.includes('csrss'), '应含 protectedProcesses.json 的名单');
  assert.ok(names.includes('svchost'));
  assert.ok(names.every(n => n === n.toLowerCase()), '必须统一小写，PowerShell 侧按小写比对');

  // 只写在词典/快照里、不在名单文件中的应用名同样要带上
  const fake = { apps: [{ risk: 'protected', processes: [{ name: 'cc_probe_guard' }] }, { risk: 'safe', processes: [{ name: 'cc_probe_plain' }] }] };
  const withSnap = protectedImageNames(fake);
  assert.ok(withSnap.includes('cc_probe_guard'), '快照里判为 protected 的进程名必须纳入');
  assert.ok(!withSnap.includes('cc_probe_plain'), 'safe 应用的进程名不应纳入');
});

test('树杀闸门已接线：force 分支会下发 -ProtectedNames（源码核对，防接线被摘掉）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/cleanupService.js'), 'utf8');
  // 短期-11 起统一经 lib/psRunner 传参（参数名→-Name 的拼装在那里）
  // 长期-2 起改用异步版 runPsFileAsync（execFile + signal 可取消）
  assert.ok(/runPsFileAsync\(CLEANUP_PS1,\s*\{[\s\S]{0,240}ProtectedNames:\s*opts\.force\s*\?\s*protectedImageNames\(before\)/.test(src),
    'force 分支必须向 cleanup.ps1 传 -ProtectedNames');
  assert.ok(/Force:\s*!!opts\.force/.test(src), 'force 应作为裸开关下发');
  const ps1 = fs.readFileSync(path.join(ws, 'server/collectors/cleanup.ps1'), 'utf8');
  assert.ok(/treeGuardActive/.test(ps1) && /tree_contains_protected/.test(ps1), 'cleanup.ps1 应含树杀闸门');
});

test('释放量口径：只累加成功进程的 wsBefore', () => {
  const r = sumFreedBytes([
    { ok: true, wsBefore: 100 * 1048576 },
    { ok: false, wsBefore: 999 * 1048576 },   // 失败的不计入
    { ok: true, wsBefore: 50 * 1048576 }
  ]);
  assert.strictEqual(r.succeededCount, 2);
  assert.strictEqual(r.freedBytes, 150 * 1048576);
});

test('释放量口径：全部失败则为 0（不是整机波动）', () => {
  const r = sumFreedBytes([
    { ok: false, wsBefore: 800 * 1048576 },
    { ok: false, wsBefore: 0 }
  ]);
  assert.strictEqual(r.succeededCount, 0);
  assert.strictEqual(r.freedBytes, 0);
});

test('释放量口径：空/非法输入安全返回 0', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    const r = sumFreedBytes(bad);
    assert.strictEqual(r.freedBytes, 0);
    assert.strictEqual(r.succeededCount, 0);
  }
});

test('释放量口径：缺失或非法 wsBefore 不污染合计', () => {
  const r = sumFreedBytes([
    { ok: true },                        // 缺 wsBefore
    { ok: true, wsBefore: null },
    { ok: true, wsBefore: -5 },          // 负数丢弃
    { ok: true, wsBefore: 'abc' },       // 非数字丢弃
    { ok: true, wsBefore: 10 * 1048576 }
  ]);
  assert.strictEqual(r.succeededCount, 5);
  assert.strictEqual(r.freedBytes, 10 * 1048576, '只有合法正数被累加');
});

test('释放量已改为进程级口径（源码核对，防改回整机差值）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/cleanupService.js'), 'utf8');
  assert.ok(/sumFreedBytes\(results\)/.test(src), 'execute 必须用 sumFreedBytes(results)');
  assert.ok(!/const\s+freedBytes\s*=\s*Math\.max\(0,\s*before\.system\.usedBytes\s*-\s*after\.system\.usedBytes\)/.test(src),
    '不得再用整机前后差值当 freedBytes（那会把自然波动算成战果）');
  assert.ok(/systemDeltaBytes/.test(src), '整机差值应保留为 systemDeltaBytes 对照字段');
});

test('释放量已改为进程级口径（workingSetService 同样核对）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/workingSetService.js'), 'utf8');
  assert.ok(!/const\s+realFreedBytes\s*=\s*succeeded\.length\s*>\s*0\s*\?\s*freedBytes\s*:\s*0/.test(src),
    '不得再把整机差值 freedBytes 当释放量');
  assert.ok(/const\s+realFreedBytes\s*=\s*succeeded\.length\s*>\s*0\s*\?\s*wsDelta\s*:\s*0/.test(src),
    'workingSetService 释放量应为工作集实际下降量 wsDelta');
});
