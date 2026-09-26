'use strict';
/**
 * psRunner.js — PowerShell 子进程调用的唯一入口（短期-11）
 *
 * 全项目原先有 10 处各写一遍 execFileSync('powershell.exe', [...], {...})，
 * 每处的参数拼装与「去 BOM + trim」也都各写一遍。调用点分散在破坏性路径上
 * （结束进程、删目录、迁移），任何一处笔误都不容易被发现 —— 归一到这里后，
 * 参数约定（尤其布尔开关与空数组）只有一份实现，可被单测覆盖。
 *
 * 两点刻意的保留：
 *   - 超时与 maxBuffer 仍由调用点显式给出：它们取决于具体脚本（毫秒级探活
 *     与全盘扫描差三个数量级），统一默认值只会掩盖真实的性能差异。
 *   - -Command 分支不带 -ExecutionPolicy：只有 -File 需要它，多带反而多一处变数。
 */

const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');

const POWERSHELL = 'powershell.exe';

const execFileAsync = promisify(execFile);

/** 允许透传给 execFileSync/execFile 的选项；runner 自己的键（powershell）不得漏进子进程参数 */
const EXEC_OPTS = ['timeout', 'maxBuffer', 'env', 'cwd', 'stdio', 'input', 'signal'];

/** encoding 与 windowsHide 是全部调用点的共同项，固定在此 */
function execOptsOf(opts) {
  const out = { encoding: 'utf8', windowsHide: true };
  for (const k of EXEC_OPTS) {
    if (opts[k] !== undefined) out[k] = opts[k];
  }
  return out;
}

/**
 * 追加一个 -Name 参数。
 * 约定（与 PowerShell 自身一致，避免各调用点各自判断）：
 *   true        → 裸开关（-Force）
 *   false/null/undefined/'' → 省略
 *   数组        → 以 ';' 连接（PS 侧按 ';' 拆分）
 *   其它        → String(value)
 */
function pushParam(args, name, value) {
  if (value === true) { args.push('-' + name); return; }
  if (value === false || value === null || value === undefined || value === '') return;
  if (Array.isArray(value)) {
    if (!value.length) return;
    args.push('-' + name, value.join(';'));
    return;
  }
  args.push('-' + name, String(value));
}

/**
 * 执行内联脚本（-Command）。脚本中若要用外部输入，走环境变量传值，不要拼字符串。
 * @param {string} script
 * @param {object} [opts] timeout / maxBuffer / env / cwd / powershell
 */
function runPsCommand(script, opts = {}) {
  const exe = opts.powershell || POWERSHELL;
  return execFileSync(exe, ['-NoProfile', '-Command', String(script)], execOptsOf(opts));
}

/**
 * 执行脚本文件（-File），参数按对象顺序拼成 -Name value。
 * @param {string} scriptPath .ps1 绝对路径
 * @param {object} [params]   参数表；取值规则见 pushParam
 * @param {object} [opts]
 */
function runPsFile(scriptPath, params = {}, opts = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  for (const [name, value] of Object.entries(params)) pushParam(args, name, value);
  const exe = opts.powershell || POWERSHELL;
  return execFileSync(exe, args, execOptsOf(opts));
}

/**
 * 去 BOM 并 trim。PS 5.1 的输出常带 UTF-8 BOM，各调用点原本各写一遍。
 * @returns {string}
 */
function cleanText(out) {
  const s = String(out == null ? '' : out);
  return (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s).trim();
}

/**
 * 异步版：参数约定与 runPsCommand 完全一致，只是不再阻塞事件循环（长期-2）。
 *
 * 为什么必须异步：execFileSync 会占满事件循环，扫描 60 秒期间连 GET /api/health
 * 都不响应；异步化后子进程在后台跑，Node 仍能继续处理其它请求。
 *
 * opts.signal 是 AbortSignal：取消任务时用它杀掉子进程（见 lib/tasks.js）。
 * @returns {Promise<string>} stdout（encoding 固定 utf8）
 */
async function runPsCommandAsync(script, opts = {}) {
  const exe = opts.powershell || POWERSHELL;
  const r = await execFileAsync(exe, ['-NoProfile', '-Command', String(script)], execOptsOf(opts));
  return r.stdout;
}

/**
 * 异步版 runPsFile，参数按对象顺序拼成 -Name value。
 * @returns {Promise<string>} stdout
 */
async function runPsFileAsync(scriptPath, params = {}, opts = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  for (const [name, value] of Object.entries(params)) pushParam(args, name, value);
  const exe = opts.powershell || POWERSHELL;
  const r = await execFileAsync(exe, args, execOptsOf(opts));
  return r.stdout;
}

module.exports = {
  runPsCommand,
  runPsFile,
  runPsCommandAsync,
  runPsFileAsync,
  cleanText,
  pushParam,
  POWERSHELL
};
