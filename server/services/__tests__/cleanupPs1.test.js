'use strict';
/**
 * cleanup.ps1 解析与空结果防护
 * 运行：node --test server/services/__tests__/cleanupPs1.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ws = process.cwd();
const PS1 = path.join(ws, 'server/collectors/cleanup.ps1');

function runCleanup(targets, extraArgs) {
  const targetsFile = path.join(os.tmpdir(), `cc_test_targets_${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
  const resultFile = path.join(os.tmpdir(), `cc_test_result_${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(targetsFile, JSON.stringify(targets), 'utf8');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-TargetsFile', targetsFile, '-ResultFile', resultFile, '-Force'
    ].concat(extraArgs || []), { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    assert.ok(fs.existsSync(resultFile), '必须写出结果文件');
    const txt = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '').trim();
    assert.ok(txt && txt !== 'null', '结果不能是空/null：' + JSON.stringify(txt));
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    try { fs.unlinkSync(targetsFile); } catch (e) { }
    try { fs.unlinkSync(resultFile); } catch (e) { }
  }
}

test('带时区的 startTime + 中文 appName 的 9 条目标必须全部解析出来', () => {
  // ⚠ 隔离要求：条目的 path 必须指向本用例自造的沙箱目录，绝不能指向真实安装目录。
  // cleanup.ps1 在 -Force 下会按 path 的父目录做扫尾（杀同目录下同名进程），
  // 若这里写成某个真实安装目录（例如 C:\app\douyin.exe），机器上真有同名进程在跑时会被误杀。
  // 因此条目的 path 必须落在本用例自造的沙箱里。
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-ps1probe-'));
  const fakeExe = path.join(sandbox, 'douyin.exe');

  const targets = [];
  for (let i = 0; i < 9; i++) {
    targets.push({
      pid: 900001 + i,
      name: 'douyin',
      appKey: 'douyin',
      appName: '抖音',
      startTime: '2026-09-19T15:48:46.2407301+08:00',
      startTimeMs: 1789804126240 + i,
      workingSet: 48037888,
      path: fakeExe
    });
  }
  const results = runCleanup(targets);
  fs.rmSync(sandbox, { recursive: true, force: true });
  assert.strictEqual(results.length, 9, '管道 ConvertFrom-Json 会丢条目，-InputObject 必须保住 9 条');
  assert.ok(results.every(r => r.error === 'process_not_found' || r.method === 'already_gone'));
});

// ───── 短期-6：树杀范围闸门（子树含受保护进程则整体拒绝） ─────

const { spawn } = require('child_process');

function psInt(script) {
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 20000
  }).trim());
}

/** 用 cmd.exe 起一个长跑子进程（ping），返回 { pid, startTimeMs, childName }。 */
function spawnSandboxTree() {
  const child = spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1 > nul'], { windowsHide: true, stdio: 'ignore' });
  return child;
}

async function waitForChildOf(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = psInt(`@(Get-CimInstance Win32_Process | Where-Object { [int]$_.ParentProcessId -eq ${pid} }).Count`);
    if (n > 0) {
      const nm = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process | Where-Object { [int]$_.ParentProcessId -eq ${pid} } | Select-Object -First 1 -ExpandProperty Name)`
      ], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
      return nm;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

function isAlive(pid) {
  return psInt(`@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`) > 0;
}

test('子树含受保护进程时整体拒绝，且不结束任何进程（含负数对照）', async (t) => {
  const child = spawnSandboxTree();
  const pid = child.pid;
  try {
    const childName = await waitForChildOf(pid);
    if (!childName) {
      t.skip('未能构造「父进程 + 子进程」沙箱树，跳过');
      return;
    }
    const base = String(childName).replace(/\.exe$/i, '');
    const startTimeMs = psInt(`[int64]((Get-Process -Id ${pid}).StartTime.ToUniversalTime() - [DateTime]::SpecifyKind([DateTime]'1970-01-01','Utc')).TotalMilliseconds`);
    const target = [{ pid, name: 'cmd', startTimeMs, workingSet: 1048576 }];

    // 正例：子进程名进了受保护清单 → 整个目标被拒绝，父进程必须还活着
    const refused = runCleanup(target, ['-ProtectedNames', base]);
    assert.strictEqual(refused.length, 1);
    assert.strictEqual(refused[0].error, 'tree_contains_protected', '应给出 tree_contains_protected，实际: ' + JSON.stringify(refused[0]));
    assert.ok(Array.isArray(refused[0].treeProtected) && refused[0].treeProtected.length > 0, '应回传命中的受保护进程');
    assert.strictEqual(refused[0].ok, false);
    assert.ok(isAlive(pid), '被拒绝的目标必须原样存活（拒绝早于优雅关闭）');

    // 负数对照：清单里没有该子进程名 → 闸门放行，正常强制结束
    const allowed = runCleanup(target, ['-ProtectedNames', 'cc_no_such_image_name']);
    assert.strictEqual(allowed.length, 1);
    assert.strictEqual(allowed[0].ok, true, '不含受保护进程时应正常结束，实际: ' + JSON.stringify(allowed[0]));
    assert.ok(['force', 'graceful'].includes(allowed[0].method), '实际: ' + JSON.stringify(allowed[0]));
    assert.ok(!isAlive(pid), '放行后进程应已结束');
  } finally {
    try { if (isAlive(pid)) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) { }
  }
});

test('未传 -ProtectedNames 时清单为空，脚本仍可正常跑完', () => {
  const results = runCleanup([{ pid: 900501, name: 'cc_probe', startTimeMs: 1789804126240 }], ['-ProtectedNames', '']);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].error, 'process_not_found');
});

test('非法 JSON 必须写出 json_parse_failed，而不是空文件', () => {
  const targetsFile = path.join(os.tmpdir(), `cc_test_bad_${Date.now()}.json`);
  const resultFile = path.join(os.tmpdir(), `cc_test_bad_result_${Date.now()}.json`);
  fs.writeFileSync(targetsFile, '{not json', 'utf8');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-TargetsFile', targetsFile, '-ResultFile', resultFile, '-Force'
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const txt = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '').trim();
    const parsed = JSON.parse(txt);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    assert.ok(arr.length >= 1);
    assert.ok(String(arr[0].error || '').startsWith('json_parse_failed'));
  } finally {
    try { fs.unlinkSync(targetsFile); } catch (e) { }
    try { fs.unlinkSync(resultFile); } catch (e) { }
  }
});
