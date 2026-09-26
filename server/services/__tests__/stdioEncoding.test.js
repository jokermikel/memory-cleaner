'use strict';
/**
 * 真实 stdio 管道 vs 文件重定向的中文编码对照（长期-1 / S8，对应遗留-23）
 *
 * 为什么要有这个用例：本机测试脚手架 _shim_childio.js 会把子进程 stdio 从「管道」
 * 改成「临时文件」。可 PowerShell 采集脚本走的是
 * `[Console]::OutputEncoding = UTF8` + `[Console]::Out.Write` —— 管道与文件是两条
 * 不同的写入路径，中文最容易在这里失守。若两条路径拿到的字节不一致，
 * 那么「用 shim 跑通」就不能代表「真机管道下也正确」，而这恰恰是最脆弱的路径。
 *
 * 做法：同一段脚本、同一份中文输入，分别经 default 管道与文件重定向采一次，
 * 断言解码结果既等于预期、彼此字节也完全一致。
 *
 * 注意：管道分支刻意用 spawnSync 而非 execFileSync —— 测试脚手架只接管了
 * execFileSync，用它才能保证本用例在任何环境下测的都是真实管道。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const POWERSHELL = 'powershell.exe';

// 故意全是非 ASCII：中文目录名 + 中文标点 + 日文
const PROBE = 'C:\\用户目录\\测试\\视频缓存（临时）\\日本語';

/** 与 collect.ps1 / diskScan.ps1 同款写法：显式 UTF-8（无 BOM）后经 [Console]::Out.Write 输出 */
const SCRIPT =
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ' +
  '[Console]::Out.Write($env:CC_ENC_PROBE)';

const ENV = () => ({ ...process.env, CC_ENC_PROBE: PROBE });

/** 真实管道：spawnSync 默认 stdio 即 pipe，且不受测试脚手架接管 */
function viaPipe() {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-Command', SCRIPT], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: ENV()
  });
  if (r.error) throw r.error;
  assert.strictEqual(r.status, 0, 'PowerShell 应正常退出，stderr: ' + r.stderr);
  return r.stdout;
}

/** 文件重定向：显式 stdio 指向文件句柄（脚手架不改写显式 stdio 的调用） */
function viaFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-enc-'));
  const outFile = path.join(dir, 'out.txt');
  const fd = fs.openSync(outFile, 'w');
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-Command', SCRIPT], {
      windowsHide: true, timeout: 30000, env: ENV(), stdio: ['ignore', fd, 'ignore']
    });
  } finally {
    fs.closeSync(fd);
  }
  try {
    return fs.readFileSync(outFile, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('S8 编码对照：管道与文件重定向拿到一致的中文输出', () => {
  const p = viaPipe();
  const f = viaFile();

  assert.strictEqual(p, PROBE, '管道路径应原样取回中文，实际: ' + JSON.stringify(p));
  assert.strictEqual(f, PROBE, '文件路径应原样取回中文，实际: ' + JSON.stringify(f));
  assert.strictEqual(
    Buffer.from(p, 'utf8').toString('hex'),
    Buffer.from(f, 'utf8').toString('hex'),
    '两条 stdio 路径的字节必须完全一致'
  );
});

test('S8 编码对照：中文经 -File 参数与经 -Command 内联脚本结果一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-enc-ps1-'));
  const ps1 = path.join(dir, 'echo.ps1');
  // .ps1 必须纯 ASCII（PS 5.1 按 ANSI 读脚本），中文只能经参数/环境变量进来
  fs.writeFileSync(ps1, [
    'param([string]$Probe = "")',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    '[Console]::Out.Write($Probe)'
  ].join('\n'), 'ascii');
  try {
    const out = execFileSync(POWERSHELL, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Probe', PROBE
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.strictEqual(out, PROBE, '-File 传参取回的中文应与 -Command 一致，实际: ' + JSON.stringify(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
