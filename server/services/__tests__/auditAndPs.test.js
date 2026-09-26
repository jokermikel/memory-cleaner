'use strict';
/**
 * lib/auditLog.js + lib/psRunner.js —— 公共模块抽取（短期-11）
 * 运行：node --test server/services/__tests__/auditAndPs.test.js
 *
 * 抽取这两块的动机是「破坏性路径上的重复」：审计格式一处改五遍会漏，
 * PowerShell 参数拼装各写一遍容易出笔误。因此这里既测行为，
 * 也核对「确实没有第二份实现」——否则抽取等于白做。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ws = process.cwd();
const {
  appendAudit, fileNameOf, sweepAuditLogs, LOG_DIR, MAX_BYTES, KEEP_DAYS
} = require(path.join(ws, 'lib/auditLog'));
const { runPsCommand, runPsFile, cleanText, pushParam } = require(path.join(ws, 'lib/psRunner'));

// ─────────── auditLog ───────────

test('审计日志：文件名带渠道与当天日期，格式为 [ISO] 正文，且是追加', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-audit-'));
  const now = new Date(2026, 8, 25, 13, 5, 6); // 本地时间 2026-09-25
  try {
    const f1 = appendAudit('unit-test', '第一条', { dir, now });
    const f2 = appendAudit('unit-test', '第二条', { dir, now });

    assert.strictEqual(f1, f2, '同渠道同一天必须写同一个文件');
    assert.strictEqual(path.basename(f1), 'unit-test-20260925.log');
    assert.strictEqual(fileNameOf('unit-test', now), 'unit-test-20260925.log');

    const lines = fs.readFileSync(f1, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2, '必须是追加而不是覆盖');
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] 第一条$/, '实际: ' + lines[0]);
    assert.match(lines[1], /\] 第二条$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('审计日志：写入失败（目录不可用）不得抛错，且仍返回目标路径', () => {
  const bad = path.join(os.tmpdir(), 'cc-audit-bad-' + Date.now(), 'nested', '\u0000invalid');
  let file = null;
  assert.doesNotThrow(() => { file = appendAudit('unit-test', 'x', { dir: bad }); });
  assert.strictEqual(file, path.join(bad, fileNameOf('unit-test', new Date())));
});

test('审计渠道与既有文件名一一对应（避免归档路径被抽错）', () => {
  const cases = [
    ['cleanup', 'cleanup'],
    ['disk-cleanup', 'disk-cleanup'],
    ['cache-migrate', 'cache-migrate'],
    ['privilege', 'privilege']
  ];
  for (const [channel, expectPrefix] of cases) {
    assert.ok(fileNameOf(channel, new Date()).startsWith(expectPrefix + '-'), channel);
  }
  assert.strictEqual(path.dirname(LOG_DIR), ws, 'LOG_DIR 必须仍在仓库根下的 logs/');
  assert.strictEqual(path.basename(LOG_DIR), 'logs');
});

test('审计实现只有一份：五个服务都改为转调 lib/auditLog', () => {
  const services = [
    ['server/services/cleanupService.js', "'cleanup'"],
    ['server/services/workingSetService.js', "'cleanup'"],
    ['server/services/diskCleanupService.js', "'disk-cleanup'"],
    ['server/services/cacheMigrateService.js', "'cache-migrate'"],
    ['server/services/privilegeService.js', "'privilege'"]
  ];
  for (const [rel, channel] of services) {
    const src = fs.readFileSync(path.join(ws, rel), 'utf8');
    assert.ok(/require\(['"][^'"]*lib\/auditLog['"]\)/.test(src), rel + ' 应引用 lib/auditLog');
    assert.ok(src.includes('appendAudit(' + channel), rel + ' 应转调 appendAudit(' + channel + ')');
    assert.ok(!/appendFileSync\(/.test(src),
      rel + ' 不应再自行 appendFileSync（审计重复实现）');
  }
  // 工作集修剪的 TRIM 前缀必须保留（同文件里区分两种动作）
  const trim = fs.readFileSync(path.join(ws, 'server/services/workingSetService.js'), 'utf8');
  assert.ok(/appendAudit\('cleanup', 'TRIM ' \+ line\)/.test(trim), 'TRIM 前缀不得丢');
});

// ─────────── 短期-12：轮转与保留 ───────────

test('轮转：单文件写满上限即改名成 .1，新写入落在新文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-audit-rot-'));
  const now = new Date(2026, 8, 25, 10, 0, 0);
  try {
    // 第一条就把文件顶到上限（文件尚不存在 → 本次不轮转）
    appendAudit('rot', 'A'.repeat(MAX_BYTES), { dir, now });
    const file = path.join(dir, fileNameOf('rot', now));
    assert.ok(fs.statSync(file).size > MAX_BYTES, '第一条写入后应已超过上限');

    appendAudit('rot', '第二条', { dir, now });
    assert.strictEqual(fs.existsSync(file + '.1'), true, '超限后应轮转出 .1');
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('第二条\n'), '新内容应写进轮转后的新文件');
    assert.ok(fs.readFileSync(file + '.1', 'utf8').startsWith('['), '.1 应保留旧内容');
    assert.ok(fs.statSync(file).size < MAX_BYTES, '新文件必须从零开始');

    // 只保留一代：再轮转一次覆盖旧 .1，不产生 .2
    appendAudit('rot', 'B'.repeat(MAX_BYTES), { dir, now });
    appendAudit('rot', '第三条', { dir, now });
    assert.strictEqual(fs.existsSync(file + '.2'), false, '不得扩展出多代旧档');
    assert.ok(/B{1000,}\n$/.test(fs.readFileSync(file + '.1', 'utf8')), '.1 应为最近一代');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('保留：超过 KEEP_DAYS 天的日志被清除，近期与非日志文件不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-audit-sweep-'));
  const now = Date.now();
  const old = now - (KEEP_DAYS + 3) * 86400000;
  const fresh = now - 1 * 86400000;
  const mk = (name, mtimeMs) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x', 'utf8');
    fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    return p;
  };
  try {
    const stale = mk('cleanup-20260101.log', old);
    const staleRot = mk('cleanup-20260101.log.1', old);
    const ok = mk('disk-cleanup-20260924.log', fresh);
    const foreign = mk('我的截图.log', old);          // 非本模块命名
    const otherExt = mk('notes-20260101.txt', old);   // 日期像但后缀不是 .log
    const notFile = path.join(dir, 'privilege-20260101.log');
    fs.mkdirSync(notFile);

    const r = sweepAuditLogs({ dir, now, keepDays: KEEP_DAYS });
    assert.strictEqual(fs.existsSync(stale), false, '过期日志必须清除');
    assert.strictEqual(fs.existsSync(staleRot), false, '过期的轮转档同样要清');
    assert.strictEqual(fs.existsSync(ok), true, '近期日志必须保留');
    assert.strictEqual(fs.existsSync(foreign), true, '非本模块命名的文件不得动');
    assert.strictEqual(fs.existsSync(otherExt), true, '后缀不符不得动');
    assert.strictEqual(fs.existsSync(notFile), true, '同名目录不得被当成文件删掉');
    assert.deepStrictEqual(r.removed.sort(), ['cleanup-20260101.log', 'cleanup-20260101.log.1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('清理挂在写入时顺带执行，且按目录节流（不会每次写都扫目录）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-audit-auto-'));
  const now = new Date();
  const old = now.getTime() - (KEEP_DAYS + 1) * 86400000;
  try {
    const p = path.join(dir, 'cleanup-20260101.log');
    fs.writeFileSync(p, 'x', 'utf8');
    fs.utimesSync(p, new Date(old), new Date(old));

    appendAudit('auto', '第一条', { dir, now });
    assert.strictEqual(fs.existsSync(p), false, '首次写入应顺带清掉过期日志');

    // 再造一个过期文件：节流窗口内不会被再次扫描（避免每次写日志都 readdir）
    const p2 = path.join(dir, 'cleanup-20260102.log');
    fs.writeFileSync(p2, 'x', 'utf8');
    fs.utimesSync(p2, new Date(old), new Date(old));
    appendAudit('auto', '第二条', { dir, now });
    assert.strictEqual(fs.existsSync(p2), true, '节流窗口内不应重复扫描');

    // 显式调用不受节流限制（需要立即清理时的入口）
    const r = sweepAuditLogs({ dir, now });
    assert.deepStrictEqual(r.removed, ['cleanup-20260102.log']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────── psRunner ───────────

test('参数拼装：布尔裸开关、空值省略、数组以分号连接', () => {
  const args = [];
  pushParam(args, 'A', 'x');
  pushParam(args, 'Flag', true);
  pushParam(args, 'No', false);
  pushParam(args, 'Nil', null);
  pushParam(args, 'Undef', undefined);
  pushParam(args, 'Empty', '');
  pushParam(args, 'List', ['a', 'b']);
  pushParam(args, 'NoList', []);
  assert.deepStrictEqual(args, ['-A', 'x', '-Flag', '-List', 'a;b']);
});

test('cleanText 去 BOM 并 trim', () => {
  assert.strictEqual(cleanText('\uFEFFabc\r\n'), 'abc');
  assert.strictEqual(cleanText('  abc  '), 'abc');
  assert.strictEqual(cleanText(null), '');
  assert.strictEqual(cleanText(undefined), '');
});

test('runPsCommand：能真的执行并回传文本', () => {
  const out = runPsCommand("'cc-' + (1 + 1)", { timeout: 20000 });
  assert.strictEqual(cleanText(out), 'cc-2');
});

test('runPsFile：-File 传参与裸开关能真的被脚本收到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-psfile-'));
  const script = path.join(dir, 'echo-params.ps1');
  fs.writeFileSync(script, [
    'param([string]$A = "", [switch]$Flag, [string]$List = "")',
    'Write-Output ($A + "|" + $Flag + "|" + $List)'
  ].join('\n'), 'ascii');
  try {
    const out = runPsFile(script, { A: 'x', Flag: true, List: ['a', 'b'], Skip: '' },
      { timeout: 20000 });
    assert.strictEqual(cleanText(out), 'x|True|a;b');

    const noFlag = runPsFile(script, { A: 'y', Flag: false }, { timeout: 20000 });
    assert.strictEqual(cleanText(noFlag), 'y|False|');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PS 调用只有一条路径：server/ 下不得再出现裸的 execFileSync(powershell)', () => {
  const roots = ['server', 'lib'];
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      // 测试目录自身允许直接起 PowerShell：它们就是在沙箱里验证 .ps1 脚本
      if (st.isDirectory()) { if (name !== '__tests__') walk(p); continue; }
      if (!name.endsWith('.js')) continue;
      // 去掉注释行：文件头注释里引用的「原先写法」不应算作调用点
      const src = fs.readFileSync(p, 'utf8').split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/execFileSync\(\s*['"]powershell/i.test(src)) offenders.push(path.relative(ws, p));
    }
  };
  for (const r of roots) walk(path.join(ws, r));
  assert.deepStrictEqual(offenders, [], '仍直接调用 PowerShell 的文件: ' + offenders.join(', '));
});

// ─────────── Q9：更小权限的进程句柄 ───────────

test('trimWorkingSet.ps1 先用窄权限句柄，并负责关闭自己打开的句柄', () => {
  const src = fs.readFileSync(path.join(ws, 'server/collectors/trimWorkingSet.ps1'), 'utf8');
  assert.ok(/OpenProcess\(/.test(src), '应自行 OpenProcess 以缩小权限');
  assert.ok(/0x1100/.test(src), '掩码应为 PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_SET_QUOTA');
  assert.ok(/CloseHandle\(/.test(src), '自己打开的句柄必须关闭（否则句柄泄漏）');
  // 回退链必须保留：窄句柄被拒时仍尝试 .NET 句柄
  assert.ok(/\$proc\.Handle/.test(src), '窄句柄失败时应有 .NET 句柄回退');
  // 顺序：窄优先
  assert.ok(src.indexOf('OpenProcess($CC_OPEN_NARROW') < src.indexOf('$proc.Handle'),
    '必须窄权限优先，回退在后');
});

test('smoke：真实对子进程修剪成功（窄句柄路径可用）', async () => {
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-trim-'));
  const targetsFile = path.join(dir, 'targets.json');
  const resultFile = path.join(dir, 'result.json');
  // ping 用作「不占 CPU 的活子进程」：cmd.exe 会一直等它结束
  const child = spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1 > nul'], { windowsHide: true });
  try {
    // 等子进程真正起来
    for (let i = 0; i < 50 && !child.pid; i++) await new Promise(r => setTimeout(r, 20));
    const pid = child.pid;
    assert.ok(pid > 4, '沙箱子进程 PID 应有效');

    const msOut = runPsCommand(
      '$p = Get-Process -Id ' + pid + '; '
      + '$e = [DateTime]::SpecifyKind([DateTime]"1970-01-01", "Utc"); '
      + '[int64](($p.StartTime.ToUniversalTime() - $e).TotalMilliseconds)',
      { timeout: 20000 });
    const startTimeMs = Number(cleanText(msOut));
    assert.ok(Number.isFinite(startTimeMs) && startTimeMs > 0, '应能取到启动时间: ' + msOut);

    fs.writeFileSync(targetsFile, JSON.stringify([{ pid, name: 'cmd', startTimeMs }]), 'utf8');
    const ps1 = path.join(ws, 'server/collectors/trimWorkingSet.ps1');
    runPsFile(ps1, { TargetsFile: targetsFile, ResultFile: resultFile },
      { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });

    const results = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    const entry = Array.isArray(results) ? results[0] : results;
    assert.strictEqual(entry.verified, true, 'PID 身份校验必须通过');
    assert.strictEqual(entry.ok, true, '窄权限句柄下修剪应成功: ' + JSON.stringify(entry));
    assert.ok(['EmptyWorkingSet', 'SetProcessWorkingSetSize'].includes(entry.method), entry.method);
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
