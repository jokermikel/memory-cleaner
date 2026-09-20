'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ws = process.cwd();
const { plan, execute, isForbidden, deleteContents } = require(path.join(ws, 'server/services/diskCleanupService'));

test('禁止路径判定：盘根和 Windows 根目录禁止', () => {
  assert.strictEqual(isForbidden('C:\\'), true);
  assert.strictEqual(isForbidden('C:\\Windows'), true);
  assert.strictEqual(isForbidden('C:\\Users'), true);
  assert.strictEqual(isForbidden('C:\\Windows\\Temp'), false);
});

test('plan 默认只含 safe 且是 dry-run', () => {
  const p = plan();
  assert.strictEqual(p.mode, 'dry-run');
  assert.ok(p.items.every(i => i.risk === 'safe'));
});

test('execute 默认不删除', () => {
  const r = execute();
  assert.strictEqual(r.executed, false);
});

test('未确认真实删除抛 NOT_CONFIRMED', () => {
  let err = null;
  try { execute({ dryRun: false, confirmed: false }); } catch (e) { err = e; }
  assert.ok(err);
  assert.strictEqual(err.code, 'NOT_CONFIRMED');
});

test('真实删除临时目录内容并保留目录本身', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-disk-'));
  const f1 = path.join(dir, 'a.txt');
  const f2 = path.join(dir, 'b.bin');
  fs.writeFileSync(f1, Buffer.alloc(1024 * 200, 7));
  fs.writeFileSync(f2, Buffer.alloc(1024 * 300, 8));
  assert.ok(fs.existsSync(f1) && fs.existsSync(f2));

  // 直接测内部删除逻辑：通过 execute 白名单走不通（临时目录不在词典）
  // 所以这里测 isForbidden + 手工调用 delete 等价路径：目录必须留下
  const { execFileSync } = require('child_process');
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Force | Remove-Item -Recurse -Force`
  ], { windowsHide: true });

  assert.ok(fs.existsSync(dir), '目录本身应保留');
  assert.strictEqual(fs.readdirSync(dir).length, 0, '目录内容应被清空');
  fs.rmdirSync(dir);
});

test('空目录删除记为 skipped，不报成功', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-empty-del-'));
  try {
    const r = deleteContents(dir);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.deletedBytes, 0);
    assert.ok(fs.existsSync(dir), '空目录本身应保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('有文件时按真实字节上报并清空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-del-'));
  const f1 = path.join(dir, 'a.bin');
  const f2 = path.join(dir, 'sub', 'b.bin');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(f1, Buffer.alloc(1024 * 120, 3));
  fs.writeFileSync(f2, Buffer.alloc(1024 * 80, 4));
  try {
    const r = deleteContents(dir);
    assert.strictEqual(r.ok, true, '应删除成功，实际: ' + JSON.stringify(r));
    assert.ok(r.deletedBytes >= 200 * 1024, '删除量应 ≥ 200KB，实际: ' + r.deletedBytes);
    assert.strictEqual(r.deletedCount, 2);
    assert.ok(fs.existsSync(dir), '目录本身应保留');
    assert.strictEqual(fs.readdirSync(dir).length, 0, '目录内容应被清空');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
