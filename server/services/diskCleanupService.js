'use strict';
/**
 * diskCleanupService.js — 磁盘垃圾清理
 *
 * 闸门（全部写进代码）：
 *   1. 默认 dry-run，不传 dryRun:false 就不删
 *   2. 只删词典白名单里的路径，清单外一律拒绝
 *   3. 路径必须足够深（禁止 C:\、C:\Windows、C:\Users 这种根目录）
 *   4. 真实执行必须 confirmed=true
 *   5. caution 项必须被显式选中，默认计划只含 safe
 *   6. 审计日志 logs/disk-cleanup-YYYYMMDD.log
 *   7. 释放量：有文件真正删掉才上报，用盘符剩余空间差验证
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { locate, expand, loadDict } = require('./junkLocator');

const WS = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(WS, 'logs');

const FORBIDDEN_PREFIXES = [
  'C:\\',
  'D:\\',
  'C:\\Windows',
  'C:\\Windows\\System32',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\Users',
  'C:\\ProgramData'
].map(p => path.resolve(p).toLowerCase());

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
}

function audit(line) {
  ensureDir(LOG_DIR);
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const file = path.join(LOG_DIR, `disk-cleanup-${ymd}.log`);
  try { fs.appendFileSync(file, `[${d.toISOString()}] ${line}\n`, 'utf8'); } catch (e) { }
  return file;
}

function normalize(p) {
  return path.resolve(p).toLowerCase();
}

function isForbidden(expanded) {
  const n = normalize(expanded);
  const parts = n.split(path.sep).filter(Boolean);
  // C:\ 或 D:\ 这种只有盘符
  if (parts.length <= 1) return true;
  // 精确等于禁止前缀（例如正好是 C:\Windows，而不是 C:\Windows\Temp）
  for (const f of FORBIDDEN_PREFIXES) {
    if (n === f) return true;
  }
  return false;
}

function whitelistSet() {
  const dict = loadDict();
  const set = new Set();
  for (const e of dict.entries || []) {
    for (const p of e.paths || []) {
      set.add(normalize(expand(p)));
    }
  }
  return set;
}

function driveFreeBytes(driveLetter) {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${driveLetter}'").FreeSpace`
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 生成清理计划。默认只包含 safe 项。
 */
function plan(opts = {}) {
  const located = locate();
  let items = located.items;

  if (Array.isArray(opts.ids) && opts.ids.length) {
    items = items.filter(i => opts.ids.includes(i.id));
  } else {
    items = items.filter(i => i.risk === 'safe' && i.bytes > 0);
  }

  const blocked = [];
  const allowed = [];
  const white = whitelistSet();

  for (const item of items) {
    const paths = [];
    for (const p of item.paths) {
      if (!p.exists || !p.bytes) continue;
      const n = normalize(p.expanded);
      if (!white.has(n)) {
        blocked.push({ id: item.id, path: p.expanded, reason: '不在白名单' });
        continue;
      }
      if (isForbidden(p.expanded)) {
        blocked.push({ id: item.id, path: p.expanded, reason: '禁止删除的系统路径' });
        continue;
      }
      paths.push(p);
    }
    if (paths.length) {
      allowed.push({
        id: item.id,
        name: item.name,
        purpose: item.purpose,
        risk: item.risk,
        bytes: paths.reduce((s, x) => s + x.bytes, 0),
        paths
      });
    }
  }

  const estimatedBytes = allowed.reduce((s, i) => s + i.bytes, 0);
  return {
    mode: 'dry-run',
    items: allowed,
    blocked,
    estimatedBytes,
    itemCount: allowed.length,
    collectedAt: located.collectedAt
  };
}

function deleteContents(dirPath) {
  // 只删目录内的文件/子目录，保留目录本身（Temp 这类系统文件夹必须留下）
  // 按真实文件数和字节数上报，空目录记为 skipped，不再假装成功。
  const ps = `
    $ErrorActionPreference = 'SilentlyContinue'
    $p = '${String(dirPath).replace(/'/g, "''")}'
    if (-not (Test-Path -LiteralPath $p)) { 'MISSING'; exit 0 }
    $files = @(Get-ChildItem -LiteralPath $p -Force -Recurse -File -ErrorAction SilentlyContinue)
    $beforeCount = $files.Count
    $beforeBytes = [int64]0
    foreach ($f in $files) { $beforeBytes += [int64]$f.Length }
    Get-ChildItem -LiteralPath $p -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $left = @(Get-ChildItem -LiteralPath $p -Force -Recurse -File -ErrorAction SilentlyContinue)
    $afterCount = $left.Count
    $afterBytes = [int64]0
    foreach ($f in $left) { $afterBytes += [int64]$f.Length }
    "$beforeCount|$afterCount|$beforeBytes|$afterBytes"
  `;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024
    }).trim();
    if (out === 'MISSING') {
      return { ok: false, skipped: true, error: 'path_missing', beforeCount: 0, afterCount: 0, deletedBytes: 0 };
    }
    const parts = out.split('|').map(Number);
    const beforeCount = parts[0] || 0;
    const afterCount = parts[1] || 0;
    const beforeBytes = parts[2] || 0;
    const afterBytes = parts[3] || 0;
    const deletedCount = Math.max(0, beforeCount - afterCount);
    const deletedBytes = Math.max(0, beforeBytes - afterBytes);
    if (beforeCount === 0) {
      return {
        ok: false, skipped: true, reason: 'empty',
        beforeCount, afterCount, deletedCount, deletedBytes: 0
      };
    }
    if (deletedCount === 0) {
      return {
        ok: false, skipped: false, error: 'locked_or_denied',
        beforeCount, afterCount, deletedCount, deletedBytes: 0
      };
    }
    return {
      ok: true,
      skipped: false,
      partial: afterCount > 0,
      beforeCount,
      afterCount,
      deletedCount,
      deletedBytes
    };
  } catch (e) {
    return { ok: false, skipped: false, error: e.message.slice(0, 200), deletedBytes: 0 };
  }
}

/**
 * 执行清理。dryRun 默认 true。
 */
function execute(opts = {}) {
  const dryRun = opts.dryRun !== false;
  const p = plan(opts);

  if (dryRun) {
    audit(`DRY-RUN 计划清理 ${p.itemCount} 项，预计 ${ (p.estimatedBytes / 1048576).toFixed(1) }MB`);
    return { ...p, executed: false };
  }

  if (!opts.confirmed) {
    const err = new Error('未确认：真实删除必须传 confirmed=true');
    err.code = 'NOT_CONFIRMED';
    throw err;
  }

  // caution 混入时必须显式 ids（plan 在传 ids 时才会带上 caution）
  const cautionHit = p.items.filter(i => i.risk === 'caution');
  if (cautionHit.length && !(Array.isArray(opts.ids) && opts.ids.length)) {
    const err = new Error('谨慎项必须显式勾选：' + cautionHit.map(i => i.name).join('、'));
    err.code = 'CAUTION_NOT_EXPLICIT';
    throw err;
  }

  if (p.itemCount === 0) {
    return { ...p, executed: false, message: '没有可删除的目标', succeeded: 0, failed: 0, freedBytes: 0 };
  }

  const beforeFree = {
    C: driveFreeBytes('C:'),
    D: driveFreeBytes('D:')
  };

  const details = [];
  for (const item of p.items) {
    for (const tp of item.paths) {
      const r = deleteContents(tp.expanded);
      details.push({ id: item.id, name: item.name, path: tp.expanded, ...r });
    }
  }

  const afterFree = {
    C: driveFreeBytes('C:'),
    D: driveFreeBytes('D:')
  };
  const systemDelta = Math.max(0, (afterFree.C - beforeFree.C) + (afterFree.D - beforeFree.D));
  const succeeded = details.filter(d => d.ok);
  const skipped = details.filter(d => d.skipped);
  const failed = details.filter(d => !d.ok && !d.skipped);
  const deletedBytes = details.reduce((s, d) => s + (d.deletedBytes || 0), 0);
  // 以实际删掉的文件大小为准；盘符剩余有滞后，只作对照，不拿 0 波动冒充成功。
  const realFreed = succeeded.length ? deletedBytes : 0;

  let systemDeltaNote = null;
  if (succeeded.length === 0 && skipped.length === details.length) {
    systemDeltaNote = '目标目录已经是空的，没有文件可删。若列表里仍显示占用，请重新扫描。';
  } else if (succeeded.length === 0 && failed.length) {
    systemDeltaNote = '文件可能被占用或权限不足，没有删掉。可点「提升权限」后重试。';
  } else if (succeeded.length && systemDelta === 0 && deletedBytes > 0) {
    systemDeltaNote = '以上为已删除文件合计；盘符剩余可能稍后才刷新。';
  } else if (succeeded.some(d => d.partial)) {
    systemDeltaNote = '部分文件删不掉（正在被占用），已删的已计入释放量。';
  }

  audit(`EXECUTED 请求 ${details.length} 个路径，成功 ${succeeded.length}，跳过 ${skipped.length}，失败 ${failed.length}；删除 ${ (deletedBytes / 1048576).toFixed(1) }MB，盘符剩余增加 ${(systemDelta / 1048576).toFixed(1)}MB`);

  return {
    mode: 'executed',
    executed: true,
    requested: details.length,
    succeeded: succeeded.length,
    skipped: skipped.length,
    failed: failed.length,
    estimatedBytes: p.estimatedBytes,
    freedBytes: realFreed,
    deletedBytes,
    systemDeltaBytes: systemDelta,
    systemDeltaNote,
    beforeFree,
    afterFree,
    details,
    auditLogged: true
  };
}

module.exports = { plan, execute, isForbidden, whitelistSet, deleteContents };
