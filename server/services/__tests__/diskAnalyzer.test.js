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

test('D:\\steam 映射到 Steam 游戏库', () => {
  const maps = loadMap();
  const hit = matchApp('D:\\steam\\steamapps\\common\\x', maps);
  assert.ok(hit);
  assert.ok(hit.name.includes('Steam'), hit.name);
});
