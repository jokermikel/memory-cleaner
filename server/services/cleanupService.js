'use strict';
/**
 * cleanupService.js — 清理执行层
 *
 * 安全设计（全部在代码里强制，不靠自觉）：
 *   1. 默认 dry-run：只计算出「会关掉什么、预计释放多少」，不动任何进程
 *   2. 拒绝操作 protected 进程：返回明确错误，不静默跳过
 *   3. PID 复用防护：执行前重新校验 PID + 启动时间，避免误杀复用 PID 的新进程
 *   4. 批量上限：一次超过 20 个进程时强制要求显式 confirmed=true
 *   5. 审计日志：所有清理操作落盘 logs/cleanup-YYYYMMDD.log
 *   6. 效果量化：执行前后各采一次内存快照，算真实释放量
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const WS = path.join(__dirname, '..', '..');
const CLEANUP_PS1 = path.join(WS, 'server', 'collectors', 'cleanup.ps1');
const LOG_DIR = path.join(WS, 'logs');
const TMP_DIR = path.join(os.tmpdir());

const BATCH_LIMIT = 20;

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
}

/** ISO-8601 / Date → Unix 毫秒。PowerShell 5.1 解析带时区的字符串会翻车，数字更稳。 */
function toUnixMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const d = new Date(v);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 写审计日志（追加） */
function audit(line) {
  ensureDir(LOG_DIR);
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const file = path.join(LOG_DIR, `cleanup-${ymd}.log`);
  const ts = d.toISOString();
  try { fs.appendFileSync(file, `[${ts}] ${line}\n`, 'utf8'); } catch (e) { }
  return file;
}

/** 读取当前快照（延迟 require 避免循环依赖） */
function getSnapshot() {
  const { snapshot } = require('./memoryService');
  return snapshot(true);
}

/**
 * 规划清理：算出哪些应用/进程会被关闭，以及预计释放量。不做任何实际操作。
 * @param {Object} opts
 * @param {Array<string>} opts.appKeys  要清理的应用 key 列表（不传则取全部 safe 应用）
 * @param {Array<number>} opts.pids     只清理指定 PID（优先于 appKeys）
 * @param {number} [opts.minMb]         只清理占用超过该值的应用
 */
function plan(opts = {}) {
  const snap = getSnapshot();
  let targets = snap.apps;

  if (Array.isArray(opts.pids) && opts.pids.length) {
    // 纯 PID 模式：用户显式指定 PID 视为明确意图，但仍拒绝 protected 应用
    const pidSet = new Set(opts.pids);
    targets = targets.filter(a =>
      a.risk !== 'protected' && a.processes.some(p => pidSet.has(p.pid))
    );
  } else if (Array.isArray(opts.appKeys) && opts.appKeys.length) {
    targets = targets.filter(a => opts.appKeys.includes(a.key));
  } else {
    targets = targets.filter(a => a.risk === 'safe');
  }

  if (opts.minMb) {
    targets = targets.filter(a => a.workingSetBytes >= opts.minMb * 1048576);
  }

  const blocked = snap.apps.filter(a => a.risk === 'protected').map(a => ({
    key: a.key, name: a.name, reason: a.riskReason
  }));

  const procs = [];
  for (const app of targets) {
    for (const p of app.processes) {
      procs.push({
        pid: p.pid,
        name: p.name,
        appKey: app.key,
        appName: app.name,
        startTime: p.startTime || null,
        startTimeMs: toUnixMs(p.startTime),
        workingSet: p.workingSet,
        path: p.path || null
      });
    }
  }

  const estimatedBytes = targets.reduce((s, a) => s + a.workingSetBytes, 0);

  return {
    mode: 'dry-run',
    appCount: targets.length,
    processCount: procs.length,
    estimatedBytes,
    apps: targets.map(a => ({
      key: a.key, name: a.name, risk: a.risk,
      purpose: a.purpose, processCount: a.processCount,
      workingSetBytes: a.workingSetBytes
    })),
    processes: procs,
    blockedProtected: blocked,
    beforeUsedBytes: snap.system.usedBytes,
    beforeFreeBytes: snap.system.freePhysicalBytes,
    warning: procs.length > BATCH_LIMIT
      ? `本次将关闭 ${procs.length} 个进程，超过 ${BATCH_LIMIT} 个上限，执行时必须传 confirmed=true`
      : null,
    collectedAt: snap.collectedAt
  };
}

/**
 * 执行清理。
 * @param {Object} opts
 * @param {Array<string>} opts.appKeys
 * @param {Array<number>} [opts.pids]   只清理指定 PID（更精确）
 * @param {boolean} [opts.force]        优雅关闭失败后是否强制结束
 * @param {boolean} [opts.confirmed]    是否已确认
 * @param {boolean} [opts.dryRun]       默认 true；传 false 才真执行
 * @param {number}  [opts.minMb]
 */
function execute(opts = {}) {
  // 默认 dry-run：只有显式 dryRun=false 才真执行
  const dryRun = opts.dryRun !== false;

  const p = plan(opts);

  // 拒绝操作 protected 进程（如果用户显式指定了 protected 应用的 key）
  if (Array.isArray(opts.appKeys) && opts.appKeys.length) {
    const protectedHit = p.apps.filter(a => a.risk === 'protected');
    if (protectedHit.length) {
      audit(`REJECTED 试图清理保护进程: ${protectedHit.map(a => a.name).join(', ')}`);
      const err = new Error('拒绝执行：选中了禁止结束的系统关键进程（' + protectedHit.map(a => a.name).join('、') + '）');
      err.code = 'PROTECTED_TARGET';
      err.blocked = protectedHit;
      throw err;
    }
  }

  if (dryRun) {
    audit(`DRY-RUN 计划清理 ${p.processCount} 个进程 / ${p.appCount} 个应用，预计释放 ${(p.estimatedBytes / 1048576).toFixed(1)}MB`);
    return { ...p, executed: false };
  }

  // 真执行：需要确认
  if (!opts.confirmed) {
    const err = new Error('未确认：真实执行清理必须传 confirmed=true');
    err.code = 'NOT_CONFIRMED';
    throw err;
  }
  if (p.processCount > BATCH_LIMIT && !opts.force) {
    const err = new Error(`超过批量上限 ${BATCH_LIMIT}，需显式传 force=true 表示知悉`);
    err.code = 'BATCH_LIMIT';
    throw err;
  }
  if (p.processCount === 0) {
    return { ...p, executed: false, message: '没有需要清理的进程' };
  }

  // 精确到 PID（若指定）
  let procs = p.processes;
  if (Array.isArray(opts.pids) && opts.pids.length) {
    procs = procs.filter(x => opts.pids.includes(x.pid));
  }
  if (procs.length === 0) {
    return { ...p, executed: false, message: '指定的 PID 不在清理计划内' };
  }

  const before = getSnapshot();

  const targetsFile = path.join(TMP_DIR, `cc_cleanup_targets_${Date.now()}.json`);
  const resultFile = path.join(TMP_DIR, `cc_cleanup_result_${Date.now()}.json`);
  fs.writeFileSync(targetsFile, JSON.stringify(procs), 'utf8');

  try {
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLEANUP_PS1,
      '-TargetsFile', targetsFile, '-ResultFile', resultFile
    ];
    if (opts.force) args.push('-Force');

    execFileSync('powershell.exe', args, {
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
        results = [];
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

    // 等系统回收内存再采一次
    const after = getSnapshot();

    const succeeded = results.filter(r => r.ok);
    const freedBytes = Math.max(0, before.system.usedBytes - after.system.usedBytes);

    // 真实性校验：如果没有进程真正退出，系统已用内存的差值只是自然波动，
    // 不能当成「清理释放量」上报（否则是误报）。
    const realFreedBytes = succeeded.length > 0 ? freedBytes : 0;

    // 失败原因归类，便于用户判断（尤其服务进程需要管理员权限）
    const failReasons = {};
    for (const r of results) {
      if (r.ok) continue;
      const key = r.error || 'unknown';
      failReasons[key] = (failReasons[key] || 0) + 1;
    }
    if (parseIssue && results.length === 0) {
      failReasons[parseIssue] = procs.length;
    } else if (results.length === 0 && procs.length > 0) {
      failReasons.result_empty = procs.length;
    }

    audit(`EXECUTED 请求关闭 ${procs.length} 个进程，成功 ${succeeded.length} 个；` +
      `已用 ${(before.system.usedBytes / 1048576).toFixed(1)}MB → ${(after.system.usedBytes / 1048576).toFixed(1)}MB；` +
      `真实释放 ${(realFreedBytes / 1048576).toFixed(1)}MB；` +
      `明细: ${succeeded.map(r => r.name + '(' + r.pid + ',' + r.method + ')').join(' ') || '无'}` +
      (Object.keys(failReasons).length ? `；失败原因: ${JSON.stringify(failReasons)}` : ''));

    return {
      mode: 'executed',
      executed: true,
      requested: procs.length,
      succeeded: succeeded.length,
      failed: results.length - succeeded.length,
      freedBytes: realFreedBytes,
      systemDeltaBytes: freedBytes,
      systemDeltaNote: succeeded.length === 0
        ? '没有任何进程被成功关闭，系统内存差值为自然波动，不代表清理效果'
        : null,
      beforeUsedBytes: before.system.usedBytes,
      afterUsedBytes: after.system.usedBytes,
      beforePercent: before.system.usedPercent,
      afterPercent: after.system.usedPercent,
      failReasons,
      details: results,
      auditLogged: true
    };
  } finally {
    try { if (fs.existsSync(targetsFile)) fs.unlinkSync(targetsFile); } catch (e) { }
    try { if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile); } catch (e) { }
  }
}

module.exports = { plan, execute, BATCH_LIMIT, LOG_DIR };
