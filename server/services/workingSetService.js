'use strict';
/**
 * workingSetService.js — 进程级工作集修剪（公开 API）
 *
 * 允许：EmptyWorkingSet / SetProcessWorkingSetSize(-1,-1)
 * 禁止：undocumented system memory APIs、standby or modified page 列表清空、任何未公开内核 API
 *
 * 闸门：默认 dry-run、必须 confirmed、拒绝 protected、PID 复用防护、磁盘忙碌拒绝、审计日志。
 * 不做常驻自动强清。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { assertDiskIdle } = require('./diskIoGuard');

const WS = path.join(__dirname, '..', '..');
const TRIM_PS1 = path.join(WS, 'server', 'collectors', 'trimWorkingSet.ps1');
const LOG_DIR = path.join(WS, 'logs');
const TMP_DIR = os.tmpdir();

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
}

function toUnixMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const d = new Date(v);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function audit(line) {
  ensureDir(LOG_DIR);
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const file = path.join(LOG_DIR, `cleanup-${ymd}.log`);
  try { fs.appendFileSync(file, `[${d.toISOString()}] TRIM ${line}\n`, 'utf8'); } catch (e) { /* ignore */ }
  return file;
}

function getSnapshot() {
  const { snapshot } = require('./memoryService');
  return snapshot(true);
}

/**
 * 规划工作集修剪：不结束进程，只建议性收缩工作集。
 * 默认只挑 safe 应用；显式 appKeys/pids 仍拒绝 protected。
 */
function plan(opts = {}) {
  const { plan: cleanupPlan } = require('./cleanupService');
  const p = cleanupPlan(opts);
  return {
    ...p,
    action: 'trim-working-set',
    warning: '只修剪工作集，不会结束进程。效果通常小于结束进程，但不会丢未保存内容。磁盘大量读写时会拒绝执行。'
  };
}

function execute(opts = {}) {
  const dryRun = opts.dryRun !== false;
  const p = plan(opts);

  if (Array.isArray(opts.appKeys) && opts.appKeys.length) {
    const protectedHit = p.apps.filter(a => a.risk === 'protected');
    if (protectedHit.length) {
      audit(`REJECTED 试图修剪保护进程: ${protectedHit.map(a => a.name).join(', ')}`);
      const err = new Error('拒绝执行：选中了禁止操作的系统关键进程（' + protectedHit.map(a => a.name).join('、') + '）');
      err.code = 'PROTECTED_TARGET';
      err.blocked = protectedHit;
      throw err;
    }
  }

  if (dryRun) {
    audit(`DRY-RUN 计划修剪 ${p.processCount} 个进程 / ${p.appCount} 个应用`);
    return { ...p, executed: false };
  }

  if (!opts.confirmed) {
    const err = new Error('未确认：真实修剪工作集必须传 confirmed=true');
    err.code = 'NOT_CONFIRMED';
    throw err;
  }
  if (p.processCount === 0) {
    return { ...p, executed: false, message: '没有需要修剪的进程' };
  }

  let procs = p.processes;
  if (Array.isArray(opts.pids) && opts.pids.length) {
    procs = procs.filter(x => opts.pids.includes(x.pid));
  }
  if (procs.length === 0) {
    return { ...p, executed: false, message: '指定的 PID 不在修剪计划内' };
  }

  const disk = assertDiskIdle();
  const before = getSnapshot();

  const targetsFile = path.join(TMP_DIR, `cc_trim_targets_${Date.now()}.json`);
  const resultFile = path.join(TMP_DIR, `cc_trim_result_${Date.now()}.json`);
  fs.writeFileSync(targetsFile, JSON.stringify(procs.map(x => ({
    pid: x.pid,
    name: x.name,
    startTimeMs: toUnixMs(x.startTimeMs != null ? x.startTimeMs : x.startTime)
  }))), 'utf8');

  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TRIM_PS1,
      '-TargetsFile', targetsFile, '-ResultFile', resultFile
    ], {
      encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024
    });

    let results = [];
    let parseIssue = null;
    if (!fs.existsSync(resultFile)) {
      parseIssue = 'result_file_missing';
    } else {
      const txt = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!txt || txt === 'null') {
        parseIssue = 'result_empty';
      } else {
        try {
          results = JSON.parse(txt);
          if (!Array.isArray(results)) results = [results];
        } catch (e) {
          parseIssue = 'result_json_invalid';
          results = [];
        }
      }
    }

    const after = getSnapshot();
    const succeeded = results.filter(r => r.ok);
    const freedBytes = Math.max(0, before.system.usedBytes - after.system.usedBytes);
    const realFreedBytes = succeeded.length > 0 ? freedBytes : 0;
    const wsDelta = results.reduce((s, r) => s + Math.max(0, (r.wsBefore || 0) - (r.wsAfter || 0)), 0);

    const failReasons = {};
    for (const r of results) {
      if (r.ok) continue;
      const key = r.error || 'unknown';
      failReasons[key] = (failReasons[key] || 0) + 1;
    }
    if (parseIssue && results.length === 0) failReasons[parseIssue] = procs.length;

    audit(`EXECUTED 请求修剪 ${procs.length} 个进程，成功 ${succeeded.length} 个；` +
      `工作集合计下降 ${(wsDelta / 1048576).toFixed(1)}MB；` +
      `系统已用 ${(before.system.usedBytes / 1048576).toFixed(1)}MB → ${(after.system.usedBytes / 1048576).toFixed(1)}MB`);

    return {
      mode: 'executed',
      action: 'trim-working-set',
      executed: true,
      requested: procs.length,
      succeeded: succeeded.length,
      failed: results.length - succeeded.length,
      workingSetDeltaBytes: wsDelta,
      freedBytes: realFreedBytes,
      systemDeltaBytes: freedBytes,
      systemDeltaNote: succeeded.length === 0
        ? '没有任何进程被成功修剪，系统内存差值为自然波动，不代表清理效果'
        : '工作集修剪只是建议性收缩，进程仍在运行；系统可用内存不一定等量上升',
      beforeUsedBytes: before.system.usedBytes,
      afterUsedBytes: after.system.usedBytes,
      beforePercent: before.system.usedPercent,
      afterPercent: after.system.usedPercent,
      diskIo: { bytesPerSec: disk.bytesPerSec, queueLength: disk.queueLength },
      failReasons,
      details: results,
      auditLogged: true
    };
  } finally {
    try { if (fs.existsSync(targetsFile)) fs.unlinkSync(targetsFile); } catch (e) { /* ignore */ }
    try { if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile); } catch (e) { /* ignore */ }
  }
}

module.exports = { plan, execute };
