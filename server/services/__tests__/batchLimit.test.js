'use strict';
/**
 * batchLimit.test.js —— 批量上限「单一来源」的回归防线（短期-17 / Q5）
 *
 * 缺陷现场：`20` 这个上限同时硬编码在服务端 cleanupService.js 与前端模板两处，
 * 且前端那句「超过了 20 个批量上限」的文案里也写死了数字。谁改了服务端常量，
 * 页面并不知道 —— 确认弹窗按旧上限判定（不提示），服务端按新上限拒绝（报错），
 * 用户看到的是「刚才没说要确认，怎么执行又拦我」。
 *
 * 修复方式：上限的唯一来源是 cleanupService.BATCH_LIMIT，经 /api/health 的
 * batchLimit 字段下发；模板只保留一致的缺省值，用于「本地文件模式」（拿不到服务端）。
 *
 * 这组断言保证：① health 确实下发该字段且取自 cleanupService（不在 server.js 里另立一份）；
 * ② 闸门仍按上限判定，且必须显式 acknowledgeBatchLimit 才放行；
 * ③ 模板不再是第二份事实来源 —— 下发值真的会改变前端的判定阈值。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const TPL = path.join(ws, '_template.html');
const SERVER = path.join(ws, 'server', 'server.js');

function tpl() {
  return fs.readFileSync(TPL, 'utf8');
}

/**
 * 从模板里取出「批量上限闸门」这一段（BATCH_LIMIT / applyBatchLimit / batchInfo）
 * 单独求值 —— 验的是下发值真的能改阈值这一行为，而不是只做源码正则核对。
 */
function loadGate() {
  const s = tpl();
  const start = s.indexOf('let BATCH_LIMIT = 20;');
  const end = s.indexOf('/** 组装 /api/cleanup/execute 的请求体');
  assert.ok(start > 0 && end > start, '模板里应能定位到批量上限闸门段落');
  const src = s.slice(start, end);
  const factory = new Function(src + '\n;return { batchInfo, applyBatchLimit, limit: () => BATCH_LIMIT };');
  return factory();
}

test('批量上限在服务端只有一个来源（cleanupService.BATCH_LIMIT）', () => {
  const svc = require('../cleanupService');
  assert.ok(Number.isInteger(svc.BATCH_LIMIT) && svc.BATCH_LIMIT > 0,
    'BATCH_LIMIT 应是正整数，实测：' + svc.BATCH_LIMIT);

  const src = fs.readFileSync(SERVER, 'utf8');
  assert.ok(/const \{ BATCH_LIMIT \} = require\('\.\/services\/cleanupService'\)/.test(src),
    'server.js 应从 cleanupService 取用 BATCH_LIMIT，而不是自己定义');
  assert.ok(/batchLimit: BATCH_LIMIT/.test(src),
    'health 响应必须下发 batchLimit 字段');
  assert.ok(!/BATCH_LIMIT\s*=\s*\d+/.test(src),
    'server.js 不得出现第二份上限字面量');
});

test('闸门行为不变：不超限放行，超限必须显式知悉', () => {
  const svc = require('../cleanupService');
  const L = svc.BATCH_LIMIT;
  assert.doesNotThrow(() => svc.assertBatchAllowed(L, {}), '恰好等于上限应放行');
  assert.throws(() => svc.assertBatchAllowed(L + 1, {}),
    e => e.code === 'BATCH_LIMIT', '超过上限应抛 BATCH_LIMIT');
  assert.doesNotThrow(() => svc.assertBatchAllowed(L + 1, { acknowledgeBatchLimit: true }),
    '显式知悉后应放行');
});

test('模板不再是第二份事实来源：下发值真的会改判定阈值', () => {
  const g = loadGate();
  // 缺省值只用于本地文件模式：这里只需是个合理正整数，允许与服务端不同
  assert.ok(Number.isInteger(g.limit()) && g.limit() > 0, '缺省上限应是正整数');
  const base = g.limit();

  assert.strictEqual(g.batchInfo([{ processCount: base }]).overLimit, false, '等于缺省上限不算超限');
  assert.strictEqual(g.batchInfo([{ processCount: base + 1 }]).overLimit, true, '超过缺省上限应超限');

  // 服务端下发更大的上限 → 前端阈值随之上移，弹窗里报的数字也同步
  g.applyBatchLimit({ batchLimit: base + 10 });
  assert.strictEqual(g.limit(), base + 10, '应采纳服务端下发的上限');
  assert.strictEqual(g.batchInfo([{ processCount: base + 1 }]).overLimit, false,
    '下发新上限后，原先超限的数量不应再被误判为超限');
  const warn = g.batchInfo([{ processCount: base + 11 }]).warnLine;
  assert.ok(warn.includes(String(base + 11)) && warn.includes(String(base + 10)),
    '警示文案里的进程数与上限都应来自下发值，实测：' + warn);
});

test('下发值与/或字段非法时不覆盖缺省值（不信任页面外输入）', () => {
  const g = loadGate();
  const base = g.limit();
  for (const bad of [null, undefined, {}, { batchLimit: 0 }, { batchLimit: -5 },
    { batchLimit: '30' }, { batchLimit: 1.5 }, { batchLimit: NaN }]) {
    g.applyBatchLimit(bad);
    assert.strictEqual(g.limit(), base, '非法下发值不应改动上限：' + JSON.stringify(bad));
  }
});

test('模板里每个 health 回调都应用了下发值，且没有硬编码的闸门常量', () => {
  const s = tpl();
  assert.ok(!/const BATCH_LIMIT/.test(s), '模板不应把上限写死为 const');
  // 按 health 的**探测点**计数（`apiFetch('/api/health'` 的实际调用），不含注释里的提及
  const health = (s.match(/apiFetch\('\/api\/health'/g) || []).length;
  // 调用点以分号结尾，函数定义行是 `function applyBatchLimit(d){`，据此区分
  const applied = (s.match(/applyBatchLimit\(d\);/g) || []).length;
  assert.ok(health >= 2, '应有多个 health 探测点，实测：' + health);
  assert.strictEqual(applied, health, '每个 health 探测点都应调用 applyBatchLimit(d)');
});
