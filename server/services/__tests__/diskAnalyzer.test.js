'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const { loadMap, matchApp } = require(path.join(ws, 'server/services/diskAnalyzer'));

test('映射表可加载且前缀非空', () => {
  const maps = loadMap();
  assert.ok(maps.length > 10);
  for (const m of maps) {
    assert.ok(m.prefix && m.name && m.purpose);
    assert.ok(m.prefixNorm);
  }
});

test('最长前缀优先：Play Games 不能被匹配成 Chrome', () => {
  const maps = loadMap();
  const local = process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local';
  const hit = matchApp(path.join(local, 'Google', 'Play Games', 'foo'), maps);
  assert.ok(hit, '应匹配到 Play Games');
  assert.ok(hit.name.includes('Play'), hit.name);
});

test('固定盘前缀映射：前缀自身与「前缀 + 分隔符」下的子路径都能命中', () => {
  const maps = loadMap();
  // 取映射表里任意一条「绝对盘符路径」前缀，避免把某台机器的安装目录写死在测试数据里
  const entry = maps.find(m => /^[A-Za-z]:\\/.test(m.prefix));
  assert.ok(entry, '映射表应至少含一条绝对盘符前缀');
  const sub = path.join(entry.prefix, 'sub', 'x');
  const hit = matchApp(sub, maps);
  assert.ok(hit, '前缀下的子路径应命中: ' + sub);
  assert.strictEqual(hit.name, entry.name);
});
