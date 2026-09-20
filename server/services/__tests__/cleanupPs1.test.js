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

function runCleanup(targets) {
  const targetsFile = path.join(os.tmpdir(), `cc_test_targets_${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
  const resultFile = path.join(os.tmpdir(), `cc_test_result_${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(targetsFile, JSON.stringify(targets), 'utf8');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-TargetsFile', targetsFile, '-ResultFile', resultFile, '-Force'
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
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
  // 若这里写成 D:\douyin\douyin.exe，机器上真有抖音在跑时会被误杀（实测已复现第 10 条来源）。
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
