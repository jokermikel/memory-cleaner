'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const { loadDict, expand, isSubPath } = require(path.join(ws, 'server/services/junkLocator'));

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
