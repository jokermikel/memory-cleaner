'use strict';
/**
 * diskSpace.js — 磁盘扫描 Node 封装
 * 调用 diskScan.ps1，分别扫 C: / D:，返回统一结构。
 */

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const PS1 = path.join(__dirname, 'diskScan.ps1');

/** C 盘要统计大小的一级目录（已知大户，避免扫无意义的空目录） */
const C_TOP = ['Users', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'];

/** D 盘默认扫全部一级目录（通常数量少） */
const D_TOP = []; // empty = all top-level

/** 已知垃圾路径（环境变量在 PS 侧展开）。回收站路径按盘符动态注入，见 buildJunkPaths()。 */
const JUNK_PATHS = [
  'C:\\Windows\\Temp',
  'C:\\Windows\\SoftwareDistribution\\Download',
  '%TEMP%',
  '%LOCALAPPDATA%\\Temp',
  '%LOCALAPPDATA%\\Microsoft\\Windows\\INetCache',
  '%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer',
  '%LOCALAPPDATA%\\CrashDumps'
];

/**
 * 枚举本机所有「本地固定磁盘」（DriveType=3），返回盘符数组，如 ['C:', 'D:', 'E:']。
 * 不假设一定有 D 盘，也不写死 C: 之外还有哪些盘。
 */
function listLocalDrives() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID"
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return String(out).split(/\r?\n/).map(s => s.trim())
      .filter(s => /^[A-Za-z]:$/.test(s));
  } catch (e) {
    return ['C:'];
  }
}

/**
 * 生成带回收站路径的垃圾路径清单：每个本地磁盘一个 $Recycle.Bin。
 * 这样不管用户是单 C 盘、C+D、还是 C+D+E，都能正确扫到对应回收站。
 */
function buildJunkPaths() {
  const junk = JUNK_PATHS.slice();
  for (const drive of listLocalDrives()) {
    junk.push(drive + '\\$Recycle.Bin');
  }
  return junk;
}

function runScan(drive, topDirs, junkList) {
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', PS1,
    '-Drive', drive
  ];
  if (topDirs && topDirs.length) args.push('-TopDirs', topDirs.join(';'));
  if (junkList && junkList.length) args.push('-JunkList', junkList.join(';'));

  const out = execFileSync('powershell.exe', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180000,
    windowsHide: true
  });

  let text = out;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.trim();
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
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem | ConvertTo-Json -Compress"
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  let text = out.trim().replace(/^\uFEFF/, '');
  const arr = JSON.parse(text);
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

function scanDisks() {
  const collectedAt = new Date().toISOString();
  const drives = [];
  const localDrives = listLocalDrives();
  const junk = buildJunkPaths();

  // 系统盘（通常是 C:，但用环境变量求 SystemDrive，不写死）
  const sysDrive = (process.env.SystemDrive || 'C:');

  for (const drive of localDrives) {
    if (drive.toUpperCase() === sysDrive.toUpperCase()) {
      // 系统盘：只扫已知大目录 + 垃圾路径（快）
      const cJunk = junk.filter(p => p.startsWith(drive) || p.startsWith('%'));
      drives.push(runScan(drive, C_TOP, cJunk));
    } else {
      // 非系统盘：扫全部一级目录 + 该盘回收站（D/E 盘目录通常少）
      const dJunk = junk.filter(p => p.startsWith(drive));
      drives.push(runScan(drive, D_TOP, dJunk));
    }
  }

  return { drives, collectedAt, hostName: os.hostname() };
}

module.exports = { scanDisks, runScan, listVolumes, listLocalDrives, buildJunkPaths, C_TOP, JUNK_PATHS };
