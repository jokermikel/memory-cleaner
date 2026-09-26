'use strict';
/**
 * listPaging.test.js —— 列表分页语义统一（短期-14 / U4）
 *
 * 缺陷现场：分页在两层各说各话 —— 服务端只有一句上限 500 的 limit 夹取
 * （/api/memory/processes 连 offset 都没有），前端又自行 slice 出一页并自称
 * 「显示全部 N 个」。同一份列表可以出现两个互相矛盾的总数。
 *
 * 修复要点：
 *   ① 服务端新增唯一实现 `pageOf()`，所有列表接口（内存应用 / 进程明细 /
 *      内存快照的 apps / 磁盘应用）都走它，统一返回 total/offset/limit/count；
 *   ② 前端只把 count/total 念成「已显示 X / 共 Y 条」，不再自己算总数。
 *
 * 这组断言保证：夹取语义不被改回「超限 = 返回全部」，且没有任何列表接口绕开 pageOf。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const ROUTES = path.join(ws, 'server/routes/memory.js');
const TPL = path.join(ws, '_template.html');

/**
 * 从路由源码里取出参数校验 + pageOf 那一段单独求值：
 * 它们只依赖 Number 与局部常量，可以脱离 HTTP 直接跑真实函数。
 */
function loadPageOf() {
  const s = fs.readFileSync(ROUTES, 'utf8');
  const start = s.indexOf('function parseIntParam(');
  const end = s.indexOf('function sendJson(');
  assert.ok(start > 0 && end > start, '应能定位到分页工具段');
  return new Function(s.slice(start, end) + '\n;return { pageOf, MAX_LIST_LIMIT, MAX_LIST_OFFSET };')();
}

const LIST = Array.from({ length: 1200 }, (_, i) => ({ i }));

test('不传 limit = 不分页，返回全部（limit 回显 null）', () => {
  const { pageOf } = loadPageOf();
  const p = pageOf(LIST, {});
  assert.strictEqual(p.total, 1200);
  assert.strictEqual(p.count, 1200);
  assert.strictEqual(p.items.length, 1200);
  assert.strictEqual(p.limit, null, '未分页时 limit 应为 null，前端据此知道拿到的是全量');
});

test('limit 超上限夹到 500，而不是退回全部（M-07 回归）', () => {
  const { pageOf, MAX_LIST_LIMIT } = loadPageOf();
  const p = pageOf(LIST, { limit: '999999' });
  assert.strictEqual(MAX_LIST_LIMIT, 500);
  assert.strictEqual(p.limit, 500);
  assert.strictEqual(p.count, 500, '超限请求至多拿到上限条数');
  assert.strictEqual(p.total, 1200, 'total 始终是完整总数，用于「已显示 X / 共 Y 条」');
});

test('limit 非法（0 / 负数 / 非数字）= 不分页', () => {
  const { pageOf } = loadPageOf();
  for (const bad of ['0', '-5', 'abc', '', null, undefined]) {
    const p = pageOf(LIST, { limit: bad });
    assert.strictEqual(p.limit, null, 'limit=' + bad + ' 应视为不分页');
    assert.strictEqual(p.count, 1200);
  }
});

test('offset 生效，且 total 是过滤后的总数', () => {
  const { pageOf } = loadPageOf();
  const filtered = LIST.slice(0, 10);
  const p = pageOf(filtered, { limit: '3', offset: '4' });
  assert.strictEqual(p.total, 10, 'total 是过滤后的总数，与是否分页无关');
  assert.strictEqual(p.offset, 4);
  assert.strictEqual(p.count, 3);
  assert.deepStrictEqual(p.items.map(x => x.i), [4, 5, 6]);
});

test('offset 超上限夹取，非法 offset 视为 0', () => {
  const { pageOf, MAX_LIST_OFFSET } = loadPageOf();
  assert.strictEqual(pageOf(LIST, { offset: '999999' }).offset, MAX_LIST_OFFSET);
  for (const bad of ['-1', 'abc', null, undefined]) {
    assert.strictEqual(pageOf(LIST, { offset: bad }).offset, 0, 'offset=' + bad + ' 应为 0');
  }
});

test('count 与 items.length 恒等（前端条数提示直接可见）', () => {
  const { pageOf } = loadPageOf();
  for (const q of [{}, { limit: '7' }, { limit: '7', offset: '1199' }, { limit: '500' }]) {
    const p = pageOf(LIST, q);
    assert.strictEqual(p.count, p.items.length, JSON.stringify(q) + ' 的 count 必须等于本页条数');
  }
});

test('所有列表接口都经 pageOf（不得再各自 slice）', () => {
  const s = fs.readFileSync(ROUTES, 'utf8');
  const uses = (s.match(/pageOf\(/g) || []).length;
  // 定义 1 处 + handleSnapshot / handleApps / handleProcesses / handleDiskApps 各 1 处
  assert.ok(uses >= 5, 'pageOf 应被定义并被四个列表接口复用，实测出现 ' + uses + ' 次');
  // limit 夹取只允许出现在 pageOf 内部一处
  const clamps = (s.match(/clampIntParam\(query\.limit/g) || []).length;
  assert.strictEqual(clamps, 1, 'limit 夹取应只在 pageOf 里出现一次，实测 ' + clamps + ' 次');
  assert.ok(!/const\s+total\s*=\s*apps\.length/.test(s), 'total 应由 pageOf 统一计算');
  // 每个列表接口都必须回传分页元数据
  for (const field of ['total', 'offset', 'limit', 'count']) {
    assert.ok(new RegExp('\\b' + field + ':').test(s), '响应里应包含 ' + field + ' 字段');
  }
  assert.ok(/appsTotal/.test(s), '快照响应的 apps 分页元数据应带 apps 前缀');
  assert.ok(/total:\s*page\.total/.test(s), '磁盘应用列表也应回传 total');
});

test('前端条数提示：统一「已显示 X / 共 Y 条」，不再自造口径', () => {
  const t = fs.readFileSync(TPL, 'utf8');
  const start = t.indexOf('function countHint(');
  const end = t.indexOf('const riskLabel');
  assert.ok(start > 0 && end > start, '模板里应有 countHint');
  const { countHint } = new Function(t.slice(start, end) + '\n;return { countHint };')();
  assert.strictEqual(countHint(30, 150), '已显示 30 / 共 150 条');

  // RAM 列表与磁盘应用列表都必须用它
  const uses = (t.match(/countHint\(/g) || []).length;
  assert.ok(uses >= 3, 'countHint 应被定义并被两处列表复用，实测 ' + uses + ' 次');
  assert.ok(/id="appCountHint"/.test(t) && /id="diskAppCountHint"/.test(t),
    '两个列表都应显示条数提示');
  // 旧文案（只报「当前只显示前 N 个」、总数自算）不得残留
  assert.ok(!/当前只显示前/.test(t), '不应再出现「当前只显示前 N 个」的旧口径文案');
});

test('前端总数优先取服务端 total/count（分页归服务端）', () => {
  const t = fs.readFileSync(TPL, 'utf8');
  assert.ok(/Number\.isFinite\(snapshot\.appsTotal\)/.test(t), 'RAM 列表总数应优先取服务端 appsTotal');
  assert.ok(/Number\.isFinite\(d\.total\)/.test(t), '磁盘应用列表总数应取服务端返回的 total');
});
