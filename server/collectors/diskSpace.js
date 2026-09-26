'use strict';
/**
 * diskSpace.js — 磁盘扫描 Node 封装
 * 调用 diskScan.ps1，分别扫 C: / D:，返回统一结构。
 */

const os = require('os');
const { runPsCommand, runPsFileAsync, cleanText } = require('../../lib/psRunner');
const { collector, data } = require('../../lib/paths');
const { loadJsonCached } = require('../../lib/dictCache');

const PS1 = collector('diskScan.ps1');

/** C 盘要统计大小的一级目录（已知大户，避免扫无意义的空目录） */
const C_TOP = ['Users', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'];

/** D 盘默认扫全部一级目录（通常数量少） */
const D_TOP = []; // empty = all top-level

/**
 * 「磁盘占用快照」要量算的垃圾条目 —— **路径字符串的唯一来源是 data/junkDict.zh.json**（长期-3b）。
 *
 * 原先这里自带一份 7 条路径的数组，与词典交集只有 5 条、另有 2 条仅此一份，
 * 两处会各自漂移（README 却声称二者共用同一份清单）。现在这里只列条目 id，
 * 字符串一律取自词典 —— 新增/调整路径只有一处要改。
 *
 * 为什么只取这几条、而不是词典全部：快照对每条路径都要跑一次 robocopy 量大小，
 * 词典里还有 NVIDIA/Edge/微信等十几条重目录，全量会把 30~60 秒的扫描再拉长几十秒。
 * 「概览用子集（本清单）、明细走 /api/disk/junk（词典全量）」是刻意的取舍。
 *
 * 覆盖范围与合并前逐条一致：原 JUNK_PATHS 的 7 条 = user-temp(%TEMP% +
 * %LOCALAPPDATA%\Temp) + win-temp + win-update-cache + thumbcache + crash-dumps + inet-cache。
 */
const SNAPSHOT_JUNK_ENTRY_IDS = [
  'user-temp',
  'win-temp',
  'win-update-cache',
  'thumbcache',
  'crash-dumps',
  'inet-cache'
];

/** 词典路径唯一来源：data/junkDict.zh.json（热路径，按 mtime+size 缓存，见 lib/dictCache.js） */
function loadJunkDict() {
  return loadJsonCached(data('junkDict.zh.json'));
}

/**
 * 枚举本机所有「本地固定磁盘」（DriveType=3），返回盘符数组，如 ['C:', 'D:', 'E:']。
 * 不假设一定有 D 盘，也不写死 C: 之外还有哪些盘。
 *
 * 长期-3b：结果进程内缓存。盘符是「一次开机基本不变」的事实，而这里被
 * forbiddenPaths()（每次路径校验）、buildJunkPaths()、scanDisks()、diskAnalyzer
 * 反复调用，每次都起 PowerShell 纯属浪费。刻意保留**同步**签名：调用方
 * forbiddenPaths()/isForbidden() 是同步的纯校验函数，异步化会把它污染到整条链路，
 * 而这条查询本身是毫秒级，不在「60 秒扫描」的关键路径上。
 */
let localDrivesCache = null;
function listLocalDrives() {
  if (localDrivesCache) return localDrivesCache;
  let drives = [];
  try {
    const out = runPsCommand(
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID",
      { timeout: 15000 });
    drives = String(out).split(/\r?\n/).map(s => s.trim())
      .filter(s => /^[A-Za-z]:$/.test(s));
  } catch (e) {
    drives = [];
  }
  // 采不到就退回 ['C:']（与原先一致）；此时不写缓存，下次调用还能重新采一次。
  if (!drives.length) return ['C:'];
  localDrivesCache = drives;
  return drives;
}

/** 仅供测试：清掉盘符缓存，便于用例之间互不影响 */
function clearLocalDrivesCache() {
  localDrivesCache = null;
}

/**
 * 生成带回收站路径的垃圾路径清单：词典里选定的条目（见 SNAPSHOT_JUNK_ENTRY_IDS）
 * + 每个本地磁盘一个 $Recycle.Bin。
 * 这样不管用户是单 C 盘、C+D、还是 C+D+E，都能正确扫到对应回收站。
 *
 * 词典缺条目/读不到时**退回空数组**而不是抛错：快照少算几项垃圾，总好过整个
 * 磁盘扫描失败（该函数的调用方是只读展示路径，不是删除闸门）。
 */
function buildJunkPaths() {
  const junk = [];
  try {
    const dict = loadJunkDict();
    const byId = new Map((dict.entries || []).map(e => [e.id, e]));
    for (const id of SNAPSHOT_JUNK_ENTRY_IDS) {
      const e = byId.get(id);
      if (!e) continue;
      for (const p of e.paths || []) junk.push(p);
    }
  } catch (e) {
    // 见上：宁可少算几项也不让快照挂掉
  }
  for (const drive of listLocalDrives()) {
    junk.push(drive + '\\$Recycle.Bin');
  }
  return junk;
}

/**
 * 跑一次 diskScan.ps1。
 *
 * 长期-2：改用 runPsFileAsync。全盘扫描 30~60 秒，原先 execFileSync 会把事件循环
 * 占满 —— 期间连 GET /api/health 都不响应，界面所有按钮失效。异步后子进程在后台
 * 跑，服务仍可处理其它请求；ctx.signal 透传下去即可取消（杀掉 PowerShell 子进程）。
 *
 * @param {Object} [ctx] 任务上下文 { signal }（可选）
 */
async function runScan(drive, topDirs, junkList, ctx = {}) {
  // 空数组会被 psRunner 省略，与原先「为空则不传」一致。
  const out = await runPsFileAsync(PS1, { Drive: drive, TopDirs: topDirs, JunkList: junkList },
    { timeout: 180000, maxBuffer: 16 * 1024 * 1024, signal: ctx.signal });

  const text = cleanText(out);
  if (!text) throw new Error('磁盘扫描脚本返回空输出 (' + drive + ')');
  try {
    const data = JSON.parse(text);
    // PS 5.1 ConvertTo-Json 把空数组编成 "" 或 [""]，统一纠正
    if (!Array.isArray(data.topDirs)) data.topDirs = [];
    data.topDirs = data.topDirs.filter(d => d && d.name);
    if (!Array.isArray(data.junkPaths)) data.junkPaths = [];
    data.junkPaths = data.junkPaths.filter(j => j && j.path);
    if (!Array.isArray(data.errors)) data.errors = data.errors ? [data.errors] : [];
    return data;
  } catch (e) {
    throw new Error('磁盘扫描 JSON 解析失败 (' + drive + '): ' + e.message + '\n开头: ' + text.slice(0, 200));
  }
}

/**
 * 扫描 C: 和 D: 盘。
 * @returns {{drives:Array, collectedAt:string}}
 */
/**
 * 只读分区容量（Win32_LogicalDisk），毫秒级，不扫目录。
 */
function listVolumes() {
  const out = runPsCommand(
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem | ConvertTo-Json -Compress",
    { timeout: 15000 });
  const arr = JSON.parse(cleanText(out));
  const list = Array.isArray(arr) ? arr : [arr];
  return list.map(d => ({
    drive: d.DeviceID,
    volumeName: d.VolumeName || '',
    fileSystem: d.FileSystem || '',
    totalBytes: Number(d.Size) || 0,
    freeBytes: Number(d.FreeSpace) || 0,
    usedBytes: (Number(d.Size) || 0) - (Number(d.FreeSpace) || 0)
  }));
}

async function scanDisks(ctx = {}) {
  const progress = typeof ctx.progress === 'function' ? ctx.progress : () => {};
  const collectedAt = new Date().toISOString();
  const drives = [];
  const localDrives = listLocalDrives();
  const junk = buildJunkPaths();

  // 系统盘（通常是 C:，但用环境变量求 SystemDrive，不写死）
  const sysDrive = (process.env.SystemDrive || 'C:');

  let i = 0;
  for (const drive of localDrives) {
    if (drive.toUpperCase() === sysDrive.toUpperCase()) {
      // 系统盘：只扫已知大目录 + 垃圾路径（快）
      const cJunk = junk.filter(p => p.startsWith(drive) || p.startsWith('%'));
      progress(Math.round(i / localDrives.length * 90), `正在扫描 ${drive}`);
      drives.push(await runScan(drive, C_TOP, cJunk, ctx));
    } else {
      // 非系统盘：扫全部一级目录 + 该盘回收站（D/E 盘目录通常少）
      const dJunk = junk.filter(p => p.startsWith(drive));
      progress(Math.round(i / localDrives.length * 90), `正在扫描 ${drive}`);
      drives.push(await runScan(drive, D_TOP, dJunk, ctx));
    }
    i += 1;
  }

  progress(95, '正在汇总扫描结果');
  return { drives, collectedAt, hostName: os.hostname() };
}

module.exports = {
  scanDisks, runScan, listVolumes, listLocalDrives, clearLocalDrivesCache,
  buildJunkPaths, SNAPSHOT_JUNK_ENTRY_IDS, C_TOP
};
