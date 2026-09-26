'use strict';
/**
 * diskCleanupService.js — 磁盘垃圾清理
 *
 * 闸门（全部写进代码）：
 *   1. 默认 dry-run，不传 dryRun:false 就不删
 *   2. 只删词典白名单里的路径，清单外一律拒绝
 *   3. 路径必须足够深：盘根，以及各本地盘符下的系统目录本身
 *      （Windows / Windows\System32 / Program Files / Program Files (x86) / ProgramData / Users）
 *      一律禁止。盘符动态取，不写死 C:/D:。子树放行由白名单把关（见 plan）。
 *   4. 真实执行必须 confirmed=true
 *   5. caution 项必须被显式选中，默认计划只含 safe
 *   6. 审计日志 logs/disk-cleanup-YYYYMMDD.log
 *   7. 释放量：有文件真正删掉才上报，用盘符剩余空间差验证（按本机全部固定盘聚合）
 */

const fs = require('fs');
const path = require('path');
const { runPsCommandAsync, cleanText } = require('../../lib/psRunner');
const { appendAudit } = require('../../lib/auditLog');
const { locate, expand, loadDict } = require('./junkLocator');
const { listLocalDrives, listVolumes } = require('../collectors/diskSpace');

/**
 * 每个盘符下都不允许直接清理的系统级目录（相对盘根）。
 * 刻意不复用 diskSpace.js 的 C_TOP：那个常量是「扫描哪些一级目录」的性能取舍，
 * 这里是「不许删」的安全边界，两者的变更理由不同，不该互相牵动。
 */
const FORBIDDEN_SUBDIRS = [
  'Windows',
  'Windows\\System32',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'Users'
];

/**
 * 禁止清理的路径集合 = 本机每个本地盘符 × FORBIDDEN_SUBDIRS，外加盘符根（X:\）。
 *
 * 为什么动态生成：原先硬编码只有 C:\ 与 D:\，一旦系统装在别的盘、或机器上还有 E:/F:，
 * E:\Windows 这类系统目录就完全落不到拦截范围内 —— 这是磁盘删除的最后一道路径防线。
 *
 * 口径说明：本集合只拦「盘根」与「系统目录本身」，**不拦其子树**。
 * C:\Windows\Temp、C:\Windows\SoftwareDistribution\Download、
 * C:\Users\<用户>\AppData\Local\Temp 这些合法清理目标必须放行
 * （既有断言：diskCleanup.test.js 与 e2e T5.8）。子树层面的把关交给白名单。
 *
 * 惰性求值 + 缓存：listLocalDrives() 要起一次 PowerShell，不在模块加载期跑。
 */
let forbiddenCache = null;
function forbiddenPaths() {
  if (forbiddenCache) return forbiddenCache;
  let drives = [];
  try {
    drives = listLocalDrives();
  } catch (e) {
    drives = [];
  }
  if (!drives.length) drives = [process.env.SystemDrive || 'C:'];
  const list = [];
  for (const d of drives) {
    const root = String(d).trim().replace(/[\\/]+$/, '').toUpperCase();
    if (!/^[A-Z]:$/.test(root)) continue;
    list.push(normalize(root + '\\'));
    for (const sub of FORBIDDEN_SUBDIRS) list.push(normalize(root + '\\' + sub));
  }
  forbiddenCache = list;
  return list;
}

/** 写审计日志（实现见 lib/auditLog.js，短期-11 归一） */
function audit(line) {
  return appendAudit('disk-cleanup', line);
}

function normalize(p) {
  return path.resolve(p).toLowerCase();
}

/**
 * 路径书写形式的硬校验（短期-5）。
 *
 * 为什么需要：白名单与禁止路径的比对都用 path.resolve() 的字符串结果，而 Windows 对
 * 「同一个真实位置」存在多种写法，其中一部分会让字符串比对与实际落点不是同一个东西：
 *   - NTFS 备用数据流（ADS）：`C:\Temp\a.txt:payload` —— 盘符之后的 `:` 指向另一条流，
 *     字符串上看不出异常，写入/删除却落到别处；
 *   - 扩展长度 / 设备前缀 `\\?\`、`\\.\` —— 绕过 Win32 的规范化与长度限制，
 *     使「是不是禁止路径」的判断与实际目标不一致；
 *   - 结尾的点或空格 —— Windows 会静默去掉（`C:\Temp\evil.` 实际是 `C:\Temp\evil`），
 *     于是白名单里写着 A、真正动到的是 B。
 * 这三类在垃圾词典里本就不该出现，一律拒绝（fail-closed），不做「帮忙纠正」。
 *
 * @returns {string|null} null 表示通过；否则返回拒绝原因标识
 */
function unsafePathReason(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'empty_path';
  if (!path.isAbsolute(raw)) return 'not_absolute';
  if (/^\\\\[?.]\\/.test(raw)) return 'extended_path_prefix';
  if (raw.replace(/^[A-Za-z]:/, '').includes(':')) return 'ads_stream';
  for (const seg of raw.split(/[\\/]+/)) {
    if (seg && /[ .]$/.test(seg)) return 'trailing_dot_or_space';
  }
  return null;
}

function isForbidden(expanded) {
  const n = normalize(expanded);
  const parts = n.split(path.sep).filter(Boolean);
  // X:\ 这种只有盘符
  if (parts.length <= 1) return true;
  // 精确等于禁止路径（例如正好是 C:\Windows，而不是 C:\Windows\Temp）；
  // 刻意不拦子树 —— 子树由白名单把关，否则会误伤 C:\Windows\Temp 这类合法清理目标。
  for (const f of forbiddenPaths()) {
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

/**
 * 采集本机全部本地固定盘的剩余空间，返回 { 'C:': bytes, 'D:': bytes, ... }。
 *
 * 原先只读 C: 和 D: 两个写死的盘符：机器上还有 E:/F: 时，清理这些盘产生的空间
 * 变化完全观测不到，systemDeltaBytes 只会偏小；系统盘不是 C: 的机器连主盘都测不到。
 * 这里改为按 listVolumes() 返回的实际盘符逐个取值 —— 语义由「C+D 两盘」变为
 * 「全部固定盘」，属用户可见的数值口径变化。
 *
 * 只用一次 PowerShell 往返（listVolumes 内部一次 ConvertTo-Json），不做 N 次查询。
 * 采集失败时返回空 map：前后两次都拿到空 map，差值自然是 0，不会凭空伪造释放量。
 */
function driveFreeMap() {
  try {
    const map = {};
    for (const v of listVolumes()) {
      const letter = String(v.drive || '').trim().toUpperCase();
      if (!/^[A-Z]:$/.test(letter)) continue;
      const n = Number(v.freeBytes);
      map[letter] = Number.isFinite(n) && n > 0 ? n : 0;
    }
    return map;
  } catch (e) {
    return {};
  }
}

/**
 * 两张「盘符 → 剩余空间」快照之间的净增量 = Σ(后 − 前)。
 *
 * 口径与原先对 C+D 的处理一致：单盘剩余减少（其它程序在写）会抵掉一部分增量，
 * 得到的是「整机固定盘剩余空间的净增」，不是各盘增量之和。
 * 只在 after 里出现的新盘符没有基线，不计入（避免把一块新挂载的盘算成释放量）。
 */
function sumFreeDelta(before, after) {
  let delta = 0;
  for (const letter of Object.keys(after)) {
    if (!(letter in before)) continue;
    delta += (Number(after[letter]) || 0) - (Number(before[letter]) || 0);
  }
  return delta;
}

/**
 * locate() 结果的短 TTL 缓存。
 *
 * 前端流程是「先 dry-run 出计划 → 用户看过再点确认执行」，两次调用各跑一遍全盘
 * 垃圾量算（本机实测约 4 秒，全是 robocopy）。用户从看计划到确认通常只隔几秒，
 * 这点时间里目录占用不可能有实质变化，缓存掉第二次扫描是安全的。
 *
 * TTL 刻意取得短，且真实删除后立即失效（见 invalidateLocateCache）：
 *   - 过期自然重扫，不会长期显示旧数据；
 *   - 删过一轮之后再算计划，一定拿到新的量算结果。
 */
const LOCATE_TTL_MS = 20000;
let locateCache = null; // { at:number, value:Object }

async function locateCached(ctx = {}) {
  const now = Date.now();
  if (locateCache && now - locateCache.at < LOCATE_TTL_MS) return locateCache.value;
  const value = await locate(ctx);
  locateCache = { at: now, value };
  return value;
}

function invalidateLocateCache() {
  locateCache = null;
}

/**
 * 生成清理计划。默认只包含 safe 项。
 * 长期-2：异步（内部 locate 要跑 robocopy 量算，数秒级）。
 */
async function plan(opts = {}, ctx = {}) {
  const located = await locateCached(ctx);
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
      const unsafe = unsafePathReason(p.expanded);
      if (unsafe) {
        blocked.push({ id: item.id, path: p.expanded, reason: '路径写法不受支持：' + unsafe });
        continue;
      }
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

/**
 * 清空目录内容（保留目录本身）。
 *
 * 传值方式（短期-5）：待清理路径经**环境变量** `CC_CLEAN_TARGET` 传入，脚本正文里
 * 不再对路径做任何字符串拼接。原先用 `'${dirPath}'` 直接内联进 PowerShell 源码，
 * 只转义了单引号 —— 只要词典里出现一个反引号、`$` 或换行，脚本就能被改写。
 * 环境变量是「数据」不是「代码」，值与脚本正文之间没有任何解析关系。
 * 同理不采用 `-Command` 拼接 + 手工转义的做法。
 *
 * 长期-2：改为异步（runPsCommandAsync），删一个目录可能要几十秒到数分钟，
 * 原先同步跑会把事件循环占满；现在子进程在后台跑，服务仍可响应其它请求，
 * ctx.signal 透传下去即可取消（杀掉 PowerShell 子进程）。
 */
async function deleteContents(dirPath, ctx = {}) {
  // 只删目录内的文件/子目录，保留目录本身（Temp 这类系统文件夹必须留下）。
  // 根目录或任一级直接子项是 reparse point 时拒绝，避免路径竞态跟随 junction/symlink。
  // 按真实文件数和字节数上报，空目录记为 skipped，不再假装成功。
  const unsafe = unsafePathReason(dirPath);
  if (unsafe) {
    return {
      ok: false, skipped: false, error: 'unsafe_path', reason: unsafe,
      beforeCount: 0, afterCount: 0, deletedBytes: 0
    };
  }
  const ps = `
    $ErrorActionPreference = 'Stop'
    $p = $env:CC_CLEAN_TARGET
    if ([string]::IsNullOrEmpty($p)) { 'NO_TARGET'; exit 0 }
    if (-not (Test-Path -LiteralPath $p)) { 'MISSING'; exit 0 }
    $root = Get-Item -LiteralPath $p -Force
    if (($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { 'REPARSE_ROOT'; exit 0 }
    $children = @(Get-ChildItem -LiteralPath $p -Force)
    foreach ($child in $children) {
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        'REPARSE_CHILD|' + $child.FullName
        exit 0
      }
    }
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
    const out = cleanText(await runPsCommandAsync(ps, {
      timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CC_CLEAN_TARGET: dirPath },
      signal: ctx.signal
    }));
    if (out === 'NO_TARGET') {
      return { ok: false, skipped: true, error: 'path_missing', beforeCount: 0, afterCount: 0, deletedBytes: 0 };
    }
    if (out === 'MISSING') {
      return { ok: false, skipped: true, error: 'path_missing', beforeCount: 0, afterCount: 0, deletedBytes: 0 };
    }
    if (out === 'REPARSE_ROOT' || out.startsWith('REPARSE_CHILD|')) {
      return { ok: false, skipped: false, error: 'reparse_point_refused', beforeCount: 0, afterCount: 0, deletedBytes: 0 };
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
 * @param {Object} [opts]
 * @param {Object} [ctx] 任务上下文（长期-2）：{ signal, progress, throwIfAborted }
 */
async function execute(opts = {}, ctx = {}) {
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  const throwIfAborted = typeof ctx.throwIfAborted === 'function' ? ctx.throwIfAborted : () => {};
  const dryRun = opts.dryRun !== false;
  progress(5, '正在量算垃圾占用');
  const p = await plan(opts, ctx);

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

  const beforeFree = driveFreeMap();

  const details = [];
  const total = p.items.reduce((s, i) => s + i.paths.length, 0);
  let done = 0;
  for (const item of p.items) {
    for (const tp of item.paths) {
      // 每删一个目录之前检查一次取消/超时：已取消就立刻停手，
      // 不做「取消之后又删掉一批」这种超出用户意图的破坏性操作。
      throwIfAborted();
      const r = await deleteContents(tp.expanded, ctx);
      details.push({ id: item.id, name: item.name, path: tp.expanded, ...r });
      done += 1;
      progress(10 + Math.round(80 * done / Math.max(1, total)), `已处理 ${done}/${total} 个目录`);
    }
  }

  // 删过之后缓存里的量算结果已经作废，下一次计划必须重新扫。
  invalidateLocateCache();

  progress(95, '正在核对释放量');
  const afterFree = driveFreeMap();
  const systemDelta = Math.max(0, sumFreeDelta(beforeFree, afterFree));
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

  audit(`EXECUTED 请求 ${details.length} 个路径，成功 ${succeeded.length}，跳过 ${skipped.length}，失败 ${failed.length}；删除 ${ (deletedBytes / 1048576).toFixed(1) }MB，全部固定盘剩余增加 ${(systemDelta / 1048576).toFixed(1)}MB`);

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

module.exports = { plan, execute, isForbidden, forbiddenPaths, FORBIDDEN_SUBDIRS, whitelistSet, deleteContents, driveFreeMap, unsafePathReason };
