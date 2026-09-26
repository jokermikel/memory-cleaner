'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const fs = require('fs');
const { loadDict, expand, isSubPath, NO_TOP_DIR_SENTINEL } = require(path.join(ws, 'server/services/junkLocator'));

test('词典可加载且条目完整', () => {
  const dict = loadDict();
  assert.ok(Array.isArray(dict.entries));
  assert.ok(dict.entries.length >= 10);
  for (const e of dict.entries) {
    assert.ok(e.id, '缺 id');
    assert.ok(e.name, '缺 name');
    assert.ok(e.purpose, '缺 purpose');
    assert.ok(['safe', 'caution', 'protected'].includes(e.risk), e.id + ' risk 非法');
    assert.ok(Array.isArray(e.paths) && e.paths.length > 0, e.id + ' 缺 paths');
  }
});

test('环境变量展开', () => {
  const p = expand('%TEMP%');
  assert.ok(p && !p.includes('%TEMP%'), 'TEMP 应被展开，实际: ' + p);
});

test('子路径判定', () => {
  assert.strictEqual(isSubPath('C:\\Users\\a\\cache', 'C:\\Users\\a'), true);
  assert.strictEqual(isSubPath('C:\\Users\\a', 'C:\\Users\\a'), false);
  assert.strictEqual(isSubPath('C:\\Users\\b', 'C:\\Users\\a'), false);
});

// ───── 扫描盘符（改动 4：不再写死 'C:'）─────

test('扫描盘符不再写死 C:，改用 SystemDrive（源码核对）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/junkLocator.js'), 'utf8');
  assert.ok(!/runScan\(\s*'C:'/.test(src), "不得再写死 runScan('C:', ...)");
  assert.ok(/process\.env\.SystemDrive\s*\|\|\s*'C:'/.test(src),
    "应取 SystemDrive 并用 'C:' 兜底");
  // 长期-2 起 runScan 多了第 4 个参数（任务上下文 ctx，用于取消/超时）
  assert.ok(/runScan\(sysDrive,\s*\[NO_TOP_DIR_SENTINEL\],\s*junkList(,\s*ctx)?\)/.test(src),
    '应传哨兵 topDirs，避免脚本枚举全盘一级目录');
});

test('哨兵目录名不会与真实业务目录冲突', () => {
  assert.strictEqual(typeof NO_TOP_DIR_SENTINEL, 'string');
  assert.ok(NO_TOP_DIR_SENTINEL.length > 0);
  // 不参与任何真实的垃圾路径匹配
  const dict = loadDict();
  for (const e of dict.entries) {
    for (const p of (e.paths || [])) {
      assert.ok(!p.includes(NO_TOP_DIR_SENTINEL), e.id + ' 的路径不应含哨兵名');
    }
  }
});

// ───── 词典 note 与 CLI 清单一致性（改动 8 / 9）─────

test('词典 note 不再写死本机实测值（改动 8）', () => {
  const dict = loadDict();
  const offenders = dict.entries.filter(e => /本机实测/.test(e.note || '')).map(e => e.id);
  assert.deepStrictEqual(offenders, [],
    '这些条目的 note 仍含「本机实测」，换机器后会误导：' + offenders.join(', '));
});

test('词典 _meta 说明 note 只是示例量级、真实值来自扫描（改动 8）', () => {
  const dict = loadDict();
  assert.ok(dict._meta, '应有 _meta');
  assert.ok(dict._meta['note_说明'], '应有 _meta.note_说明');
  assert.ok(/实时扫描/.test(dict._meta['note_说明']),
    'note_说明 应指出真实大小来自实时扫描');
});

test('CLI 复用服务端的垃圾路径清单（改动 9）', () => {
  const cliSrc = fs.readFileSync(path.join(ws, 'disk-cli.js'), 'utf8');
  assert.ok(/buildJunkPaths/.test(cliSrc), 'disk-cli.js 应复用 diskSpace.buildJunkPaths()');
  assert.ok(!/C_JUNK\s*=\s*\[/.test(cliSrc), '不应再自带一份 C_JUNK 常量（会与 Web 端分叉）');

  const { buildJunkPaths } = require(path.join(ws, 'server/collectors/diskSpace'));
  const cJunk = buildJunkPaths().filter(p => p.startsWith('C:') || p.startsWith('%'));
  assert.ok(cJunk.some(p => /Recycle\.Bin/i.test(p)),
    'C 盘垃圾清单应包含回收站（原 C_JUNK 缺这一项，与 Web 端不一致）');
});

test('死代码 _probePath.ps1 已删除（改动 12）', () => {
  const p = path.join(ws, 'server/collectors/_probePath.ps1');
  assert.strictEqual(fs.existsSync(p), false,
    '该脚本硬编码了一批本机 PID，全项目零引用，应已删除');
});

// ───── 长期-3b：垃圾路径唯一来源 ─────

test('快照垃圾清单与词典同源，源码里不再有第二份路径字符串', () => {
  const diskSpace = require(path.join(ws, 'server/collectors/diskSpace'));
  const { buildJunkPaths, SNAPSHOT_JUNK_ENTRY_IDS } = diskSpace;
  const dict = loadDict();
  const byId = new Map(dict.entries.map(e => [e.id, e]));
  const dictPaths = new Set();
  for (const e of dict.entries) for (const p of (e.paths || [])) dictPaths.add(p);

  const junk = buildJunkPaths();
  // 回收站由代码按盘符注入，其余每一条都必须能在词典里找到出处
  const fromDict = junk.filter(p => !/\$Recycle\.Bin$/i.test(p));
  for (const p of fromDict) {
    assert.ok(dictPaths.has(p), p + ' 不在词典里：快照清单又自带了一份路径字符串');
  }
  // 选定的 id 必须真实存在（改名/删条目会被这里拦下）
  for (const id of SNAPSHOT_JUNK_ENTRY_IDS) {
    assert.ok(byId.has(id), id + ' 不在 junkDict 里（条目被改名或删除？）');
  }
  // 源码里不得再出现自带的路径数组
  const src = fs.readFileSync(path.join(ws, 'server/collectors/diskSpace.js'), 'utf8');
  assert.ok(!/const JUNK_PATHS\s*=/.test(src), '不应再有自带的 JUNK_PATHS 数组');
  assert.ok(!/'C:\\\\Windows\\\\Temp'/.test(src) && !/'%TEMP%'/.test(src),
    '路径字符串应只存在于词典，不应写死在 diskSpace.js 里');
});

test('原 JUNK_PATHS 独有的两条已并入词典（覆盖不缩水）', () => {
  const { buildJunkPaths } = require(path.join(ws, 'server/collectors/diskSpace'));
  const fromDict = buildJunkPaths().filter(p => !/\$Recycle\.Bin$/i.test(p));
  assert.ok(fromDict.some(p => /INetCache/i.test(p)), 'INetCache 应仍在快照清单里');
  assert.ok(fromDict.some(p => p.toLowerCase() === '%localappdata%\\temp'),
    '%LOCALAPPDATA%\\Temp 应仍在快照清单里（用户把 TEMP 改到别处时的兜底）');

  const dict = loadDict();
  const inet = dict.entries.find(e => e.id === 'inet-cache');
  assert.ok(inet, '词典应新增 inet-cache 条目');
  assert.strictEqual(inet.risk, 'safe', 'INetCache 是纯缓存，应为 safe');
  const userTemp = dict.entries.find(e => e.id === 'user-temp');
  assert.ok((userTemp.paths || []).length >= 2, 'user-temp 应同时覆盖 %TEMP% 与 %LOCALAPPDATA%\\Temp');
});

test('INetCache 进入磁盘清理白名单（并入词典的直接后果）', () => {
  const { whitelistSet } = require(path.join(ws, 'server/services/diskCleanupService'));
  const { expand } = require(path.join(ws, 'server/services/junkLocator'));
  const target = path.resolve(expand('%LOCALAPPDATA%\\Microsoft\\Windows\\INetCache')).toLowerCase();
  assert.ok(whitelistSet().has(target), 'INetCache 应在可清理白名单里，否则合并后仍不可删');
});
