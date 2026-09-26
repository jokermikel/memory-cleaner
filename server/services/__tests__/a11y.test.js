'use strict';
/**
 * a11y.test.js —— 可访问性回归防线（短期-15 / U5）
 *
 * 缺陷现场：① 长时间操作（清理 / 修剪 / 扫描）的结果只写进 innerHTML，
 * 读屏用户完全不知道操作结束了；② 「显示全部」是带 onclick 的 <div>，
 * 进不了 Tab 序列；③ 可展开的应用行同样只能点鼠标；④ 风险状态靠 emoji + 背景色表达。
 *
 * 这组断言保证：结果区有 aria-live、交互控件是真正的按钮 / 可聚焦元素、
 * 风险状态另有一段不依赖 emoji 与颜色的文字。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const TPL = path.join(ws, '_template.html');

const tpl = () => fs.readFileSync(TPL, 'utf8');

/** 从模板里取出风险文案表求值（纯常量，无依赖） */
function loadRiskText() {
  const t = tpl();
  const start = t.indexOf('const riskAria = {');
  const end = t.indexOf('const riskCls =');
  assert.ok(start > 0 && end > start, '模板里应有 riskAria 文案表');
  return new Function(t.slice(start, end) + '\n;return { riskAria };')();
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

test('长时间操作的结果区都带 role=status + aria-live', () => {
  const t = tpl();
  const regions = ['ramSelResult', 'cleanupResult', 'diskResult', 'migResult', 'diskAppSelSummary'];
  for (const id of regions) {
    const re = new RegExp('id="' + id + '"[^>]*>');
    const m = t.match(re);
    assert.ok(m, '应存在结果区 ' + id);
    assert.ok(/role="status"/.test(m[0]), id + ' 应有 role="status"');
    assert.ok(/aria-live="polite"/.test(m[0]), id + ' 应有 aria-live="polite"');
  }
});

test('「显示全部」是真正的按钮，不是带 onclick 的 div', () => {
  const t = tpl();
  // 两处「显示全部」都必须是 createElement('button')
  const created = t.match(/createElement\('button'\)/g) || [];
  assert.strictEqual(created.length, 2, '两处「显示全部」都应是 <button>，实测 ' + created.length + ' 处');
  assert.ok(!/createElement\('div'\)[\s\S]{0,200}?显示全部/.test(t),
    '不得再用 <div> 承载「显示全部」（键盘用户 Tab 不到）');
  assert.ok(/\.show-all-btn:focus-visible/.test(t), '按钮必须有可见的键盘焦点样式');
});

test('可展开的应用行可聚焦、可键盘操作，并同步 aria-expanded', () => {
  const t = tpl();
  assert.ok(/tabindex="0" role="button" aria-expanded="false"/.test(t),
    '可展开行应带 tabindex/role/aria-expanded');
  assert.ok(/row\.setAttribute\('aria-expanded'/.test(t), '展开状态变化时必须同步 aria-expanded');
  assert.ok(/row\.addEventListener\('keydown'/.test(t), '可展开行必须响应键盘');
  assert.ok(/e\.key !== 'Enter' && e\.key !== ' '/.test(t), 'Enter 与空格都应触发展开');
  assert.ok(/e\.preventDefault\(\);\s*\/\/ 空格默认会滚动页面/.test(t), '空格需阻止默认滚动');
  // 展开行也必须有可见焦点
  assert.ok(/\.app-row\.expandable:focus-visible/.test(t), '展开行应有可见的键盘焦点样式');
});

test('风险状态另有一段不依赖 emoji 与颜色的文字', () => {
  const { riskAria } = loadRiskText();
  for (const key of ['safe', 'caution', 'protected']) {
    assert.ok(riskAria[key], 'riskAria 缺少 ' + key);
    assert.ok(!EMOJI.test(riskAria[key]), key + ' 的替代文本不得含 emoji：' + riskAria[key]);
    assert.ok(/^风险等级：/.test(riskAria[key]), key + ' 的替代文本应以「风险等级：」开头');
    assert.ok(/[\u4e00-\u9fa5]/.test(riskAria[key]), key + ' 的替代文本必须是中文');
  }
  assert.ok(/aria-label="'\+escapeHtml\(riskAria\[rk\]\)\+'"/.test(tpl()),
    '风险标签必须挂上 riskAria（且经 escapeHtml）');
});
