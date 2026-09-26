'use strict';
/**
 * tokenInject.test.js —— 访问令牌注入的回归防线
 *
 * 缺陷现场（2026-09-23 真机验收实测）：
 *   server.js 用 `html.replace(new RegExp('__CC_TOKEN_VALUE__','g'), ACCESS_TOKEN)`
 *   做**全局**替换。而 _template.html 里该字面量出现两次：
 *     ① window.__CC_TOKEN__ = '__CC_TOKEN_VALUE__';          ← 应该替换
 *     ② const TOKEN_PLACEHOLDER = '__CC_TOKEN_VALUE__';      ← 不该替换
 *   于是两处都被换成同一个令牌，前端的
 *     `window.__CC_TOKEN__ !== TOKEN_PLACEHOLDER` 恒为 false
 *   → CC_TOKEN = null → HAS_TOKEN = false
 *   → **界面上所有需令牌的接口全部 403**。
 *
 *   症状极具迷惑性：报错与令牌无关 ——「生成清理计划」提示
 *   `Cannot read properties of undefined (reading 'forEach')`，
 *   磁盘应用列表显示「没有扫到应用占用」（因为 403 响应体里没有 apps，
 *   `(d.apps || [])` 静默变成空数组）。只有豁免令牌的接口照常工作，
 *   所以页面看起来"基本正常"，直到你点下按钮。
 *
 *   既有的 e2e 访问控制用例（Node 直接发 HTTP、自己设置 X-CC-Token 头）
 *   完全覆盖不到这条链路 —— 它从不经过前端 JS 读令牌的那一步。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const TPL = path.join(ws, '_template.html');
const SERVER = path.join(ws, 'server', 'server.js');
const FAKE_TOKEN = 'a'.repeat(64);

test('令牌注入：注入后前端判据必须能识别出有效令牌', () => {
  const tpl = fs.readFileSync(TPL, 'utf8');
  // 复刻服务端注入（精确替换，与实现保持一致）
  const served = tpl.replace(
    /window\.__CC_TOKEN__\s*=\s*'__CC_TOKEN_VALUE__'/,
    "window.__CC_TOKEN__ = '" + FAKE_TOKEN + "'"
  );
  // 复刻前端判据（格式校验）
  const m = served.match(/window\.__CC_TOKEN__\s*=\s*'([^']*)'/);
  const raw = m ? m[1] : '';
  assert.ok(/^[0-9a-f]{64}$/.test(raw),
    '注入后前端仍拿不到有效令牌 —— 界面所有需鉴权接口都会 403');
});

test('令牌注入：服务端不得对整个 HTML 做占位符全局替换', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.ok(!/new\s+RegExp\(\s*TOKEN_PLACEHOLDER\s*,\s*'g'\s*\)/.test(src),
    '服务端仍在用全局替换 —— 会误伤模板里其它同名字面量，导致前端判据恒为 false');
});

test('令牌注入：模板里「待替换的占位符赋值」只能有一处', () => {
  const tpl = fs.readFileSync(TPL, 'utf8');
  const assigns = tpl.match(/=\s*'__CC_TOKEN_VALUE__'/g) || [];
  assert.strictEqual(assigns.length, 1,
    "'= '__CC_TOKEN_VALUE__'' 只能出现一次，实测 " + assigns.length + " 处");
});

test('前端令牌判据不依赖占位符字面量，改用 64 位十六进制格式校验', () => {
  const tpl = fs.readFileSync(TPL, 'utf8');
  assert.ok(/\/\^\[0-9a-f\]\{64\}\$\//.test(tpl),
    '前端应使用 /^[0-9a-f]{64}$/ 校验令牌有效性');
  // 只检查「代码中的比较」，注释里提到不算
  const codeOnly = tpl.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/!==\s*TOKEN_PLACEHOLDER/.test(codeOnly),
    '前端不应再与占位符字面量比较 —— 该判据会被服务端替换破坏');
});
