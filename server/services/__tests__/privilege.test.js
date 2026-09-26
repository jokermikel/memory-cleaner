'use strict';
/**
 * privilegeService 单元测试
 * 不弹 UAC、不杀进程：只验证探测、dry-run、命令拼装。
 * 运行：node --test server/services/__tests__/privilege.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const {
  isAdmin,
  status,
  elevate,
  buildElevateCommand,
  buildElevateSpawn,
  psQuote,
  wscriptPath
} = require(path.join(ws, 'server/services/privilegeService'));

test('isAdmin 返回布尔值', () => {
  assert.strictEqual(typeof isAdmin(), 'boolean');
});

test('status 字段完整', () => {
  const s = status();
  assert.strictEqual(typeof s.isAdmin, 'boolean');
  assert.strictEqual(typeof s.pid, 'number');
  assert.ok(s.pid > 0);
  assert.strictEqual(typeof s.canElevate, 'boolean');
  assert.strictEqual(s.canElevate, process.platform === 'win32' && !s.isAdmin);
  assert.ok(typeof s.message === 'string' && s.message.length > 0);
  assert.strictEqual(s.platform, process.platform);
});

test('elevate dry-run 不抛错、不把 pending 设为 true', () => {
  const r = elevate({ dryRun: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pending, false);
  assert.strictEqual(typeof r.alreadyAdmin, 'boolean');
  assert.strictEqual(r.isAdmin, r.alreadyAdmin);
  assert.ok(r.message);
});

test('已是管理员时 dry-run 也返回 alreadyAdmin', () => {
  const r = elevate({ dryRun: true });
  if (isAdmin()) {
    assert.strictEqual(r.alreadyAdmin, true);
    assert.strictEqual(r.isAdmin, true);
    assert.match(r.message, /管理员/);
  } else {
    assert.strictEqual(r.alreadyAdmin, false);
    assert.strictEqual(r.dryRun, true);
  }
});

test('psQuote 把单引号加倍，用于 PowerShell 字面量', () => {
  assert.strictEqual(psQuote('abc'), "'abc'");
  assert.strictEqual(psQuote("O'Brien"), "'O''Brien'");
});

test('buildElevateCommand 含 RunAs，路径带空格也不拆', () => {
  const cmd = buildElevateCommand({
    nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    launcher: 'D:\\some dir\\launcher.js',
    workDir: 'D:\\some dir',
    replacePid: 4321
  });
  assert.match(cmd, /-Verb RunAs/);
  assert.match(cmd, /Start-Process/);
  assert.match(cmd, /--replace/);
  assert.match(cmd, /4321/);
  assert.match(cmd, /Program Files/);
  assert.match(cmd, /some dir/);
  // 路径被单引号包裹，不会按空格拆成多个参数
  assert.match(cmd, /'C:\\Program Files\\nodejs\\node\.exe'/);
});

test('buildElevateSpawn 走 wscript + elevate.vbs，路径原样传入', () => {
  const spec = buildElevateSpawn({
    nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    launcher: 'D:\\清理\\launcher.js',
    workDir: 'D:\\清理',
    replacePid: 4321
  });
  assert.ok(spec.file.toLowerCase().endsWith('wscript.exe'));
  assert.strictEqual(spec.args.length, 4);
  assert.ok(spec.args[0].toLowerCase().endsWith('elevate.vbs'));
  assert.strictEqual(spec.args[1], 'C:\\Program Files\\nodejs\\node.exe');
  assert.strictEqual(spec.args[2], 'D:\\清理\\launcher.js');
  assert.strictEqual(spec.args[3], '4321');
  assert.strictEqual(spec.cwd, 'D:\\清理');
});

test('本机存在 wscript.exe 和 elevate.vbs', () => {
  const fs = require('fs');
  assert.ok(fs.existsSync(wscriptPath()), '应能找到 wscript.exe');
  assert.ok(fs.existsSync(path.join(ws, 'elevate.vbs')), '应能找到 elevate.vbs');
});
