'use strict';
/**
 * 内存清理安全红线：禁止 Mem Reduct 同类未公开内核 API。
 * 只扫可执行代码（去掉注释），文档/本测试文件里的点名不计入调用。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();

const FORBIDDEN = [
  'NtSetSystemInformation',
  'SystemMemoryListInformation',
  'MemoryPurgeStandbyList',
  'MemoryPurgeLowPriorityStandbyList',
  'MemoryFlushModifiedList',
  'MemoryCommandEmptyWorkingSetsCombined',
  'NtQuerySystemInformation'
];

function stripComments(text, ext) {
  let s = text;
  if (ext === '.js' || ext === '.html' || ext === '.vbs') {
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
    s = s.replace(/(^|[^:])\/\/.*$/gm, '$1');
  }
  if (ext === '.ps1' || ext === '.cmd' || ext === '.bat') {
    s = s.replace(/^[ \t]*#.*$/gm, '');
  }
  return s;
}

function walk(dir, acc) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'logs' || name === 'data') continue;
    if (/\.2026-/.test(name) || name.endsWith('.bak')) continue;
    if (name === 'safety.test.js') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(js|ps1|vbs|cmd|bat|html)$/i.test(name)) acc.push(full);
  }
  return acc;
}

test('全库不含未公开内核内存回收 API', () => {
  const files = walk(ws, []);
  const hits = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const text = stripComments(fs.readFileSync(f, 'utf8'), ext);
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) hits.push(path.relative(ws, f) + ': ' + needle);
    }
  }
  assert.deepStrictEqual(hits, [], '发现禁用 API：\n' + hits.join('\n'));
});

test('工作集修剪脚本只使用公开 API', () => {
  const ps1 = fs.readFileSync(path.join(ws, 'server/collectors/trimWorkingSet.ps1'), 'utf8');
  assert.ok(ps1.includes('EmptyWorkingSet'), '必须调用 EmptyWorkingSet');
  assert.ok(ps1.includes('SetProcessWorkingSetSize'), '必须提供 SetProcessWorkingSetSize 兜底');
  assert.ok(ps1.includes('psapi.dll'), 'EmptyWorkingSet 必须来自 psapi.dll');
  assert.ok(ps1.includes('kernel32.dll'), 'SetProcessWorkingSetSize 必须来自 kernel32.dll');
  assert.ok(!/ntdll/i.test(ps1), '禁止链接 ntdll');
});

test('进程清理脚本不触及内存页列表', () => {
  const ps1 = fs.readFileSync(path.join(ws, 'server/collectors/cleanup.ps1'), 'utf8');
  assert.ok(ps1.includes('CloseMainWindow') || ps1.includes('taskkill'), '只允许结束进程');
  assert.ok(!/EmptyWorkingSet|WorkingSetSize|NtSet/i.test(ps1));
});

test('cleanupService 在真执行前检查磁盘忙碌', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/cleanupService.js'), 'utf8');
  assert.ok(src.includes("require('./diskIoGuard')"));
  assert.ok(src.includes('assertDiskIdle'));
});
