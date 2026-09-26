'use strict';
/**
 * uiElevate.test.js —— 「提升权限」按钮的交互回归防线
 *
 * 缺陷现场（2026-09-24 V5 真机验收实测，主人报告）：
 *   点击「🛡️ 提升权限」→ 弹出 Windows UAC → **点「否」** →
 *   按钮永久停留在「正在请求提权…」且禁用，页面看起来卡死。
 *
 * 根因（非逻辑错误，而是 UX 缺陷）：
 *   前端在请求提权后会 `await waitForAdmin(90000)` —— **硬等 90 秒**。
 *   用户在 UAC 点「否」时服务不会以管理员身份重启，
 *   于是页面要干等到 90 秒才恢复按钮；在那之前用户完全无法区分
 *   「点了否」与「还在等」，实测即被判定为「按钮卡死」。
 *
 * 修复要点：
 *   利用一条可靠信号区分两种结局 ——
 *     · 点「是」时**旧服务必然被杀死**，期间 /api/privilege/status 会连不上；
 *     · 点「否」时服务**自始至终健康**。
 *   因此若启动后若干秒内从未观察到掉线、也未变成管理员，即可**提前判定用户取消**，
 *   无需干等。
 *
 * 这组断言保证：① 不再出现 90 秒硬等；② 取消判定与按钮恢复能力不被回退。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const TPL = path.join(ws, '_template.html');

function tpl() {
  return fs.readFileSync(TPL, 'utf8');
}

test('提权等待：不得再使用 90000ms 级别的硬等（用户点否会长时间无反馈）', () => {
  const s = tpl();
  assert.ok(!/waitForAdmin\(\s*90000\s*\)/.test(s),
    '不得再用 waitForAdmin(90000) —— 点「否」后页面会卡在「正在请求提权…」长达 90 秒');
  // 当前采用 40s 上限，仅作占位校验；关键是不应有超大硬等
  const m = s.match(/waitForAdmin\(\s*(\d+)/);
  assert.ok(m, '应存在 waitForAdmin(...) 调用');
  assert.ok(Number(m[1]) <= 60000,
    '等待上限不应超过 60s，实测 ' + m[1] + 'ms');
});

test('提权等待：必须能判定「用户取消 UAC」并恢复按钮', () => {
  const s = tpl();
  assert.ok(/__cancelled/.test(s),
    '必须存在「用户取消」的判定标记，否则点「否」无法给出明确反馈');
  assert.ok(/sawDowntime/.test(s),
    '应通过「服务是否掉线」来区分「点了否」与「点了是正在重启」');
  assert.ok(/CANCEL_PROBE_MS/.test(s),
    '应有取消判定阈值（超过该时长仍未掉线 → 判定取消）');
});

test('提权等待：两条终局路径都必须恢复按钮可用状态', () => {
  const s = tpl();
  // 取点击处理器内、等待结束后的分支
  const i = s.indexOf('const st = await waitForAdmin');
  assert.ok(i > 0, '应存在 waitForAdmin 调用处');
  const seg = s.slice(i, i + 1600);
  const restoreCount = (seg.match(/btn\.disabled = false;/g) || []).length;
  assert.ok(restoreCount >= 2,
    '「取消」与「超时」两条路径都应恢复按钮（实测恢复次数 ' + restoreCount + '）');
  assert.ok(/btn\.textContent = '🛡️ 提升权限'/.test(seg),
    '恢复时应把按钮文案还原');
});
