'use strict';
/**
 * lib/dictCache.js —— 词典热路径缓存（短期-10）
 * 运行：node --test server/services/__tests__/dictCache.test.js
 *
 * 要点：缓存必须真的生效（不重复读盘），但文件一变就必须重新读 ——
 * 「缓存住旧词典」比「每次都读」更危险，改词典不生效还查不出原因。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = process.cwd();
const { loadJsonCached, clearDictCache } = require(path.join(ws, 'lib/dictCache'));

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

test('同一文件同一状态：第二次调用复用同一对象（不重复解析）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dictcache-'));
  const file = path.join(dir, 'd.json');
  try {
    writeJson(file, { entries: [{ id: 'a' }] });
    clearDictCache();
    const first = loadJsonCached(file);
    const second = loadJsonCached(file);
    assert.strictEqual(first, second, '状态未变时必须返回同一实例（说明走的缓存）');
    assert.strictEqual(second.entries[0].id, 'a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('内容变化：size 或 mtime 变即失效，重新读取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dictcache-'));
  const file = path.join(dir, 'd.json');
  try {
    writeJson(file, { v: 1 });
    clearDictCache();
    const before = loadJsonCached(file);
    assert.strictEqual(before.v, 1);

    // 内容长度变化 → size 变 → 必然失效
    writeJson(file, { v: 22 });
    const after = loadJsonCached(file);
    assert.strictEqual(after.v, 22, '文件被替换后必须读到新内容');
    assert.notStrictEqual(after, before, '不得返回旧对象');

    // 仅 mtime 变化（长度不变）也要失效：模拟编辑器写回同长度内容
    writeJson(file, { v: 33 });
    const st = fs.statSync(file);
    fs.utimesSync(file, st.atime, new Date(st.mtimeMs - 5000));
    const afterMtime = loadJsonCached(file);
    assert.strictEqual(afterMtime.v, 33, 'mtime 变化必须触发重读');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('失败不缓存：文件损坏时每次如实抛出，修好后无需重启', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dictcache-'));
  const file = path.join(dir, 'broken.json');
  try {
    fs.writeFileSync(file, '{ broken', 'utf8');
    clearDictCache();
    assert.throws(() => loadJsonCached(file), /JSON|Unexpected/, '损坏时必须抛出');

    // 缺失文件也必须抛出（不能悄悄返回空对象，调用方依赖错误来兜底）
    assert.throws(() => loadJsonCached(path.join(dir, 'no-such.json')));

    // 修好同一个路径后立即可用
    writeJson(file, { ok: true });
    assert.strictEqual(loadJsonCached(file).ok, true, '修好文件后应立即可读，不需清缓存');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('三个热路径加载器都改走缓存（源码核对）', () => {
  const targets = [
    'server/services/appGrouper.js',
    'server/services/junkLocator.js',
    'server/services/diskAnalyzer.js'
  ];
  for (const rel of targets) {
    const src = fs.readFileSync(path.join(ws, rel), 'utf8');
    assert.ok(/require\(['"][^'"]*lib\/dictCache['"]\)/.test(src),
      rel + ' 应引用 lib/dictCache');
    assert.ok(!/JSON\.parse\(\s*fs\.readFileSync/.test(src),
      rel + ' 不应再自行 readFileSync + JSON.parse（热路径重复解析）');
  }
});

test('缓存确实用上：真实词典两次加载是同一实例，且结构完好', () => {
  const { loadDict: loadAppDict } = require(path.join(ws, 'server/services/appGrouper'));
  const { loadDict: loadJunkDict } = require(path.join(ws, 'server/services/junkLocator'));
  const { loadMap } = require(path.join(ws, 'server/services/diskAnalyzer'));

  clearDictCache();
  assert.strictEqual(loadAppDict(), loadAppDict(), 'appDict 应命中缓存');
  assert.strictEqual(loadJunkDict(), loadJunkDict(), 'junkDict 应命中缓存');

  // 映射表每次都会重新派生数组，这里只校验内容仍然完整可解析
  const maps = loadMap();
  assert.ok(maps.length > 10);
  assert.ok(maps[0].prefixNorm.length >= maps[maps.length - 1].prefixNorm.length,
    '最长前缀仍排在前面（排序未被缓存破坏）');
});
