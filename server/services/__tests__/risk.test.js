'use strict';
/**
 * riskClassifier 单元测试
 * 运行：node --test server/services/__tests__/risk.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const { classify, classifyAll } = require(path.join(ws, 'server/services/riskClassifier'));

// 禁止名单命中
test('禁止名单进程判为 protected', () => {
  for (const name of ['System', 'csrss', 'lsass', 'dwm', 'Memory Compression', 'MsMpEng', 'svchost']) {
    const r = classify({ key: name, name });
    assert.strictEqual(r.risk, 'protected', `${name} 必须判为 protected`);
    assert.ok(r.reason.length > 0, `${name} 必须有理由`);
  }
});

// 词典判定
test('词典 safe 进程判为 safe', () => {
  const r = classify({ key: 'douyin', name: '抖音' });
  assert.strictEqual(r.risk, 'safe');
});

test('词典 caution 进程判为 caution', () => {
  const r = classify({ key: 'QQ', name: 'QQ' });
  assert.strictEqual(r.risk, 'caution');
});

// 兜底
test('未知进程默认 caution 且理由说明未知', () => {
  const r = classify({ key: 'totally_unknown_xyz', name: 'totally_unknown_xyz' });
  assert.strictEqual(r.risk, 'caution');
  assert.ok(r.reason.includes('未知'));
});

// 批量
test('classifyAll 给所有应用附加 risk 字段', () => {
  const apps = [
    { key: 'douyin', name: '抖音' },
    { key: 'lsass', name: 'lsass' },
    { key: 'unknown_zzz', name: 'unknown_zzz' }
  ];
  classifyAll(apps);
  assert.strictEqual(apps[0].risk, 'safe');
  assert.strictEqual(apps[1].risk, 'protected');
  assert.strictEqual(apps[2].risk, 'caution');
  assert.ok(apps.every(a => typeof a.riskReason === 'string' && a.riskReason.length > 0));
});
