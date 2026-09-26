'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const fs = require('fs');
const { plan, execute } = require(path.join(ws, 'server/services/workingSetService'));

test('plan 返回修剪计划且默认不执行', () => {
  const p = plan();
  assert.strictEqual(p.action, 'trim-working-set');
  assert.strictEqual(p.mode, 'dry-run');
  assert.ok(Array.isArray(p.processes));
  assert.ok(p.apps.every(a => a.risk === 'safe'));
});

test('execute 默认 dry-run', async () => {
  const r = await execute();
  assert.strictEqual(r.executed, false);
  assert.strictEqual(r.mode, 'dry-run');
});

test('未确认真实修剪抛 NOT_CONFIRMED', async () => {
  // 长期-2 起 execute 是异步任务（可取消/超时），失败通过 Promise 拒绝传达
  await assert.rejects(
    execute({ dryRun: false, confirmed: false }),
    e => e && e.code === 'NOT_CONFIRMED'
  );
});

test('指定保护进程抛 PROTECTED_TARGET', async () => {
  await assert.rejects(
    execute({ appKeys: ['lsass'], dryRun: false, confirmed: true }),
    e => e && e.code === 'PROTECTED_TARGET'
  );
});

// ───── PID 复用防护一致性 + 释放量口径（改动 5 / 7）─────

/** 从 .ps1 里抠出 Test-PidReused 函数体，去掉注释与空行做归一化对比 */
function extractPidReuseFn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/function Test-PidReused[\s\S]*?\n\}/);
  assert.ok(m, file + ' 里应存在 Test-PidReused');
  return m[0].split('\n')
    .map(l => l.split('#')[0].replace(/\s+$/, ''))
    .filter(l => l.trim())
    .join('\n');
}

test('trimWorkingSet.ps1 的 PID 复用防护与 cleanup.ps1 逻辑一致（含 startTime 回退）', () => {
  const trim = extractPidReuseFn(path.join(ws, 'server/collectors/trimWorkingSet.ps1'));
  const cleanup = extractPidReuseFn(path.join(ws, 'server/collectors/cleanup.ps1'));
  assert.strictEqual(trim, cleanup,
    '两处 Test-PidReused 必须一致，否则修剪路径会静默返回 verified=false');
});

test('trimWorkingSet.ps1 的回退分支确实存在（防回退被删掉）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/collectors/trimWorkingSet.ps1'), 'utf8');
  assert.ok(/\$t\.startTime\b/.test(src), '必须引用 t.startTime 作为回退');
  assert.ok(/\[DateTime\]::Parse/.test(src), '必须能从字符串解析 startTime');
});

test('参与执行的两个 ps1 保持纯 ASCII（PS 5.1 按 ANSI 读取，非 ASCII 会乱码）', () => {
  // diskScan.ps1 有意豁免：它用 [char]0x5B57 拼出中文「字节」并自注 keep this file ASCII，
  // 是已知且刻意的例外（注释里的中文字面量本身也只是说明，不参与逻辑）。
  for (const f of ['trimWorkingSet.ps1', 'cleanup.ps1']) {
    const buf = fs.readFileSync(path.join(ws, 'server/collectors', f));
    const bad = [];
    for (let i = 0; i < buf.length; i++) if (buf[i] > 127) bad.push(i);
    assert.strictEqual(bad.length, 0, f + ' 含 ' + bad.length + ' 个非 ASCII 字节');
  }
});

test('释放量口径来自工作集实际下降量，而非整机差值（源码核对）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/workingSetService.js'), 'utf8');
  assert.ok(/const\s+wsDelta\s*=/.test(src), '应计算工作集下降量 wsDelta');
  assert.ok(/const\s+realFreedBytes\s*=\s*succeeded\.length\s*>\s*0\s*\?\s*wsDelta\s*:\s*0/.test(src),
    'freedBytes 应取 wsDelta');
  assert.ok(!/const\s+freedBytes\s*=\s*Math\.max\(0,\s*before\.system\.usedBytes/.test(src),
    '不得再用整机差值当 freedBytes');
});
