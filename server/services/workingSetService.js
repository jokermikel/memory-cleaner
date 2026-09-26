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
const { runPsFileAsync } = require('../../lib/psRunner');
const { appendAudit } = require('../../lib/auditLog');
const { assertDiskIdle } = require('./diskIoGuard');
const { collector, tmpFile } = require('../../lib/paths');

const TRIM_PS1 = collector('trimWorkingSet.ps1');

function toUnixMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const d = new Date(v);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

// 与进程清理共用 cleanup 渠道（历史上就写同一个文件），前缀 TRIM 区分动作。
function audit(line) {
  return appendAudit('cleanup', 'TRIM ' + line);
}

function getSnapshot() {
  const { snapshot } = require('./memoryService');
  return snapshot();
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

/**
 * 执行工作集修剪（长期-2：异步）。
 *
 * 为什么改成 async：真正的耗时步骤是 runPsFile（最多 120 秒）。原先的 execFileSync
 * 会把这 120 秒全部压在事件循环上，期间服务不响应任何请求、也无法取消。
 * 现在改为 runPsFileAsync，并把 ctx.signal 透传下去 —— 用户点「取消」时
 * AbortSignal 会连带杀掉 PowerShell 子进程。
 *
 * @param {Object} opts
 * @param {Object} [ctx] 任务上下文（lib/tasks.js 提供）：{ progress, signal, throwIfAborted }
 */
async function execute(opts = {}, ctx = {}) {
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  const dryRun = opts.dryRun !== false;
  progress(5, '正在生成修剪计划');
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

  progress(20, '正在检查磁盘忙碌状态');
  const disk = assertDiskIdle();
  progress(30, '正在采集执行前快照');
  const before = getSnapshot();

  const targetsFile = tmpFile(`cc_trim_targets_${Date.now()}.json`);
  const resultFile = tmpFile(`cc_trim_result_${Date.now()}.json`);
  fs.writeFileSync(targetsFile, JSON.stringify(procs.map(x => ({
    pid: x.pid,
    name: x.name,
    startTimeMs: toUnixMs(x.startTimeMs != null ? x.startTimeMs : x.startTime)
  }))), 'utf8');

  try {
    progress(40, `正在修剪 ${procs.length} 个进程的工作集`);
    await runPsFileAsync(TRIM_PS1, { TargetsFile: targetsFile, ResultFile: resultFile },
      { timeout: 120000, maxBuffer: 16 * 1024 * 1024, signal: ctx.signal });

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

    progress(80, '正在采集执行后快照');
    const after = getSnapshot();
    const succeeded = results.filter(r => r.ok);
    // 释放量口径：各成功进程工作集的实际下降量之和。
    // 修剪不结束进程，进程仍在运行，所以可用 wsAfter 精确衡量；
    // 不再用整机前后差值（含其它进程自然波动）。
    const wsDelta = results.reduce((s, r) => s + Math.max(0, (r.wsBefore || 0) - (r.wsAfter || 0)), 0);
    const realFreedBytes = succeeded.length > 0 ? wsDelta : 0;
    // 整机前后差值仅作对照，不参与「释放量」上报。
    const systemDeltaBytes = Math.max(0, before.system.usedBytes - after.system.usedBytes);

    const failReasons = {};
    for (const r of results) {
      if (r.ok) continue;
      const key = r.error || 'unknown';
      failReasons[key] = (failReasons[key] || 0) + 1;
    }
    if (parseIssue && results.length === 0) failReasons[parseIssue] = procs.length;

    audit(`EXECUTED 请求修剪 ${procs.length} 个进程，成功 ${succeeded.length} 个；` +
      `释放 ${(realFreedBytes / 1048576).toFixed(1)}MB（各成功进程工作集实际下降量之和）；` +
      `整机已用 ${(before.system.usedBytes / 1048576).toFixed(1)}MB → ${(after.system.usedBytes / 1048576).toFixed(1)}MB` +
      `（差值 ${(systemDeltaBytes / 1048576).toFixed(1)}MB 含自然波动，仅对照）`);

    progress(98, '正在汇总结果');
    return {
      mode: 'executed',
      action: 'trim-working-set',
      executed: true,
      requested: procs.length,
      succeeded: succeeded.length,
      failed: results.length - succeeded.length,
      workingSetDeltaBytes: wsDelta,
      freedBytes: realFreedBytes,
      freedBytesNote: succeeded.length === 0
        ? '没有任何进程被成功修剪，本次释放量为 0'
        : '释放量 = 各成功修剪进程工作集的实际下降量之和（本次动作可归因部分）',
      systemDeltaBytes,
      systemDeltaNote: '工作集修剪只是建议性收缩，进程仍在运行；整机已用内存前后差值含其它进程自然波动，仅供参考，不作为释放量',
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
