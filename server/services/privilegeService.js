'use strict';
/**
 * privilegeService.js — Windows 提权
 *
 * 普通权限下部分系统进程杀不掉、约一半进程读不到可执行路径。
 * 本模块负责：检测是否管理员、弹出 UAC、用管理员身份重启 launcher。
 *
 * 弹 UAC 的方式：wscript.exe + Shell.Application.ShellExecute(..., "runas")。
 * 不用 PowerShell Start-Process -Verb RunAs，原因：
 *   1. 从无窗口后台进程 spawn 时，UAC 经常不出现在交互桌面
 *   2. powershell -Command 在 PS 5.1 下会把中文路径编码弄坏
 *
 * 安全约束：
 *   1. 只在 127.0.0.1 本地服务里调用（server 已绑定环回）
 *   2. 真正授权靠 Windows UAC，用户点「否」则什么都不发生
 *   3. dryRun 只返回计划，不弹窗、不拉起进程
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { appendAudit } = require('../../lib/auditLog');
const { ROOT } = require('../../lib/paths');

const ELEVATE_VBS = path.join(ROOT, 'elevate.vbs');

/** 写审计日志（实现见 lib/auditLog.js，短期-11 归一） */
function audit(line) {
  return appendAudit('privilege', line);
}

/**
 * 管理员状态缓存。
 * `net session` 需要启动一个子进程，本机实测首次约 65ms；而 /api/health 会被前端
 * 轮询、磁盘清理前后也会读。该权限位在**同一个进程生命周期内不可能改变**
 * （提权是另起一个管理员进程），所以探测一次即可，之后为纯内存读取。
 */
let adminCache = null;

/**
 * 实测当前进程是否以管理员运行。
 * `net session` 在非管理员下会失败，这是 Windows 上最稳的探测方式。
 */
function probeIsAdmin() {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

/** 当前进程是否以管理员运行（带进程内缓存，见 adminCache 说明）。 */
function isAdmin() {
  if (adminCache === null) adminCache = probeIsAdmin();
  return adminCache;
}

/** 作废缓存，下次调用重新探测。提权流程后调用。 */
function resetAdminCache() {
  adminCache = null;
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function wscriptPath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', 'wscript.exe');
}

/**
 * 拼装 wscript 调用参数。路径原样传入，由 VBScript 走 Unicode，不经 PowerShell。
 */
function buildElevateSpawn(opts = {}) {
  const nodeExe = opts.nodeExe || process.execPath;
  const launcher = opts.launcher || path.join(ROOT, 'launcher.js');
  const replacePid = opts.replacePid != null ? opts.replacePid : process.pid;
  const vbs = opts.vbs || ELEVATE_VBS;
  return {
    file: wscriptPath(),
    args: [vbs, nodeExe, launcher, String(replacePid)],
    cwd: opts.workDir || ROOT
  };
}

/**
 * 兼容旧测试：PowerShell Start-Process 命令（仅 dry-run / 单测用，真正提权走 VBS）。
 */
function buildElevateCommand(opts = {}) {
  const spec = buildElevateSpawn(opts);
  const nodeExe = spec.args[1];
  const launcher = spec.args[2];
  const replacePid = spec.args[3];
  const workDir = spec.cwd;
  return (
    'Start-Process -FilePath ' + psQuote(nodeExe) +
    ' -ArgumentList @(' + [launcher, '--replace', String(replacePid)].map(psQuote).join(',') + ')' +
    ' -WorkingDirectory ' + psQuote(workDir) +
    ' -Verb RunAs'
  );
}

function status() {
  const admin = isAdmin();
  return {
    isAdmin: admin,
    pid: process.pid,
    platform: process.platform,
    canElevate: process.platform === 'win32' && !admin,
    message: admin
      ? '当前已是管理员权限，可清理系统服务进程'
      : '当前为普通权限：清理系统服务可能被拒绝，部分进程路径读不到'
  };
}

function assertWscript() {
  const exe = wscriptPath();
  if (!fs.existsSync(exe)) {
    const err = new Error('未找到 wscript.exe，无法弹出 UAC 提权窗口');
    err.code = 'WSCRIPT_NOT_FOUND';
    throw err;
  }
}

/**
 * 请求提升权限。
 * @param {{dryRun?: boolean}} opts
 * @returns {{ok:boolean, alreadyAdmin:boolean, pending:boolean, isAdmin:boolean, message:string}}
 */
function elevate(opts = {}) {
  const admin = isAdmin();
  if (admin) {
    audit('elevate skipped: already admin pid=' + process.pid);
    return {
      ok: true,
      alreadyAdmin: true,
      pending: false,
      dryRun: !!opts.dryRun,
      isAdmin: true,
      pid: process.pid,
      message: '当前已是管理员权限，无需重复提权'
    };
  }

  if (process.platform !== 'win32') {
    const err = new Error('提升权限仅支持 Windows');
    err.code = 'UNSUPPORTED_PLATFORM';
    throw err;
  }

  const launcherPath = path.join(ROOT, 'launcher.js');
  if (!fs.existsSync(launcherPath)) {
    const err = new Error('找不到 launcher.js，无法提权重启');
    err.code = 'LAUNCHER_NOT_FOUND';
    throw err;
  }
  if (!fs.existsSync(ELEVATE_VBS)) {
    const err = new Error('找不到 elevate.vbs，无法弹出 UAC');
    err.code = 'ELEVATE_VBS_NOT_FOUND';
    throw err;
  }

  const parentPid = Number(process.env.LAUNCHER_PID);
  const replacePid = (Number.isInteger(parentPid) && parentPid > 0) ? parentPid : process.pid;
  const spec = buildElevateSpawn({
    nodeExe: process.execPath,
    launcher: launcherPath,
    workDir: ROOT,
    replacePid
  });

  if (opts.dryRun) {
    return {
      ok: true,
      alreadyAdmin: false,
      pending: false,
      dryRun: true,
      isAdmin: false,
      pid: process.pid,
      command: spec.file + ' ' + spec.args.join(' '),
      message: 'dry-run：将弹出 UAC 并以管理员身份重启服务'
    };
  }

  assertWscript();
  audit('elevate requested pid=' + process.pid + ' replace=' + replacePid + ' via=' + spec.file);

  const child = spawn(spec.file, spec.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd: spec.cwd
  });
  child.on('error', (err) => {
    audit('elevate spawn error: ' + err.message);
  });
  child.on('exit', (code) => {
    audit('elevate wscript exit code=' + code);
  });
  if (child.pid) audit('elevate wscript pid=' + child.pid);
  child.unref();

  // 提权已发起：作废缓存，让后续健康检查重新探测而不是沿用旧结论。
  // （正常情况下提权会产生一个全新的管理员进程接管服务，本进程随即退出。）
  resetAdminCache();

  return {
    ok: true,
    alreadyAdmin: false,
    pending: true,
    dryRun: false,
    isAdmin: false,
    pid: process.pid,
    helperPid: child.pid || null,
    message: '已弹出 Windows 用户账户控制，请点击「是」。确认后服务将以管理员身份重启。'
  };
}

module.exports = {
  isAdmin,
  resetAdminCache,
  status,
  elevate,
  buildElevateCommand,
  buildElevateSpawn,
  psQuote,
  wscriptPath
};
