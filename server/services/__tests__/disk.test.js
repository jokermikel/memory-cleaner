'use strict';
/**
 * diskService 单元测试（不跑真实扫描，用结构校验 + 小目录实测）
 * 运行：node --test server/services/__tests__/disk.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ws = process.cwd();
const { runScan } = require(path.join(ws, 'server/collectors/diskSpace'));
const { snapshot, fmt } = require(path.join(ws, 'server/services/diskService'));

test('fmt 单位换算', () => {
  assert.ok(fmt(1024 ** 3).includes('GB'));
  assert.ok(fmt(5 * 1024 ** 2).includes('MB'));
});

test('runScan 扫 C:\\Windows 返回合法结构', () => {
  const r = runScan('C:', ['Windows'], []);
  assert.strictEqual(r.drive, 'C:');
  assert.ok(r.totalBytes > 0, '总量必须 > 0');
  assert.ok(r.usedBytes > 0, '已用必须 > 0');
  assert.ok(r.freeBytes >= 0);
  assert.ok(Array.isArray(r.topDirs));
  assert.strictEqual(r.topDirs.length, 1);
  assert.strictEqual(r.topDirs[0].name, 'Windows');
  assert.ok(r.topDirs[0].bytes > 10 * 1024 ** 3, 'Windows 目录应 > 10GB，实测 ' + r.topDirs[0].bytes);
  assert.ok(Array.isArray(r.junkPaths));
  assert.ok(Array.isArray(r.errors));
});

test('runScan 扫不存在的目录返回 0 字节不抛错', () => {
  const r = runScan('C:', ['ThisDirDoesNotExist_XYZ'], []);
  assert.strictEqual(r.topDirs.length, 1);
  assert.strictEqual(r.topDirs[0].bytes, 0);
});

test('空目录扫描为 0 字节，不把日期年份当成大小', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-empty-'));
  try {
    const r = runScan('C:', ['tmp'], [dir]);
    const hit = (r.junkPaths || []).find(j => (j.expanded || j.path || '').toLowerCase() === dir.toLowerCase());
    assert.ok(hit, '应扫到临时空目录');
    assert.strictEqual(hit.bytes, 0, '空目录必须是 0，不能是年份（如 2026）。实际: ' + hit.bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('有文件的目录扫描接近真实大小', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-size-'));
  const payload = Buffer.alloc(50 * 1024, 7);
  fs.writeFileSync(path.join(dir, 'a.bin'), payload);
  try {
    const r = runScan('C:', ['tmp'], [dir]);
    const hit = (r.junkPaths || []).find(j => (j.expanded || j.path || '').toLowerCase() === dir.toLowerCase());
    assert.ok(hit, '应扫到有文件的目录');
    assert.ok(hit.bytes >= payload.length, '扫描值应 ≥ 写入的 50KB，实际: ' + hit.bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
