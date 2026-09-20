'use strict';
/**
 * diskAnalyzer.js — 把 C/D 盘一级（及关键用户目录）按「应用」归类
 * 匹配规则：最长路径前缀优先；父子目录同时扫到时，父目录扣除子目录字节，避免重复。
 */

const fs = require('fs');
const path = require('path');
const { runScan } = require('../collectors/diskSpace');

const MAP_PATH = path.join(__dirname, '..', '..', 'data', 'diskAppMap.json');

function loadMap() {
  const data = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  // 展开环境变量（%LOCALAPPDATA% / %APPDATA% / %USERPROFILE%），
  // 这样映射表里的用户路径在任意 Windows 机器上都指向当前登录用户。
  const expand = p => p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || ('%' + name + '%'));
  return (data.maps || []).map(m => ({
    ...m,
    prefix: expand(m.prefix),
    prefixNorm: path.resolve(expand(m.prefix)).toLowerCase()
  })).sort((a, b) => b.prefixNorm.length - a.prefixNorm.length);
}

function matchApp(dirPath, maps) {
  const n = path.resolve(dirPath).toLowerCase();
  for (const m of maps) {
    if (n === m.prefixNorm || n.startsWith(m.prefixNorm + path.sep)) return m;
  }
  return null;
}

function isChild(childPath, parentPath) {
  const c = path.resolve(childPath).toLowerCase();
  const p = path.resolve(parentPath).toLowerCase();
  return c !== p && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * 扫描并按应用归类。
 */
function analyze() {
  const maps = loadMap();
  const user = process.env.USERPROFILE || path.join('C:', 'Users', process.env.USERNAME || 'Default');
  const localAppData = process.env.LOCALAPPDATA || path.join(user, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(user, 'AppData', 'Roaming');

  // 把「用户相对路径」转成实际绝对路径（跨机器关键：不硬编码具体用户名）
  const u = (sub) => {
    if (sub.startsWith('AppData\\Local')) return path.join(localAppData, sub.slice('AppData\\Local'.length).replace(/^\\/, ''));
    if (sub.startsWith('AppData\\Roaming')) return path.join(appData, sub.slice('AppData\\Roaming'.length).replace(/^\\/, ''));
    return path.join(user, sub);
  };

  const cDirs = [
    'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
    'Documents', 'Downloads', 'Videos', 'Saved Games', '.cache', '.ollama', '.codex', '.docker',
    'AppData\\Local\\Google\\Play Games',
    'AppData\\Local\\Google\\Chrome',
    'AppData\\Local\\NVIDIA',
    'AppData\\Local\\Temp',
    'AppData\\Local\\Microsoft',
    'AppData\\Local\\Tencent',
    'AppData\\Local\\Doubao',
    'AppData\\Local\\Quark',
    'AppData\\Local\\Steam',
    'AppData\\Local\\Packages',
    'AppData\\Local\\Programs',
    'AppData\\Roaming\\Tencent'
  ].map(u);

  // 取系统盘（SystemDrive），扫描只针对系统盘
  const sysDrive = (process.env.SystemDrive || 'C:').replace(/\\/g, '');
  // 把绝对路径转成「盘符下相对路径」传给 runScan（runScan 会 Join-Path）
  const rel = p => {
    const parsed = path.parse(p);
    const drivePrefix = parsed.root; // 如 'C:\\'
    const rest = p.slice(drivePrefix.length);
    return rest;
  };
  const cDirsRel = cDirs.map(d => rel(d));

  // 非系统盘：只扫映射表里以「非系统盘盘符」开头的前缀（目录名），避免扫全部一级目录超时
  const { listLocalDrives } = require('../collectors/diskSpace');
  const localDrives = listLocalDrives();
  const dataDrives = localDrives.filter(d => d.toUpperCase() !== sysDrive.toUpperCase());

  const cScan = runScan(sysDrive, cDirsRel, []);
  const scans = [cScan];

  for (const dDrive of dataDrives) {
    const prefixRoot = dDrive + '\\';
    const dTop = maps
      .filter(m => m.prefixNorm.startsWith(prefixRoot.toLowerCase()))
      .map(m => {
        const rest = m.prefix.slice(prefixRoot.length); // strip "D:\"
        return rest.split(/[\\/]/)[0];
      })
      .filter((v, i, a) => v && a.indexOf(v) === i);
    scans.push(runScan(dDrive, dTop, []));
  }

  const nodes = [];
  for (const scan of scans) {
    for (const d of (scan.topDirs || [])) {
      if (!d || !d.bytes) continue;
      nodes.push({
        path: d.path,
        name: d.name,
        bytes: d.bytes,
        drive: (d.path || '').slice(0, 2).toUpperCase()
      });
    }
  }

  // 父目录扣除子目录，避免 Play Games 80GB 再被算进 AppData
  for (const parent of nodes) {
    let childSum = 0;
    for (const child of nodes) {
      if (isChild(child.path, parent.path)) childSum += child.bytes;
    }
    parent.ownBytes = Math.max(0, parent.bytes - childSum);
  }

  const groups = new Map();
  const unmatched = [];
  for (const n of nodes) {
    const m = matchApp(n.path, maps);
    const key = m ? m.name : (n.drive + ' 其他');
    if (!groups.has(key)) {
      groups.set(key, {
        name: key,
        purpose: m ? m.purpose : '未映射到已知应用的目录',
        category: m ? m.category : '未分类',
        vendor: m ? m.vendor : '未知',
        bytes: 0,
        dirs: []
      });
    }
    const g = groups.get(key);
    g.bytes += n.ownBytes;
    g.dirs.push({ path: n.path, bytes: n.ownBytes });
    if (!m && n.ownBytes > 50 * 1024 * 1024) unmatched.push(n);
  }

  const apps = Array.from(groups.values())
    .filter(a => a.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  // 动态盘符概览，不再写死 cDrive/dDrive
  const drivesOverview = {};
  for (const scan of scans) {
    const d = scan.drive.replace(/\\/g, '');
    drivesOverview[d] = {
      totalBytes: scan.totalBytes,
      usedBytes: scan.usedBytes,
      freeBytes: scan.freeBytes
    };
  }

  return {
    apps,
    unmatched: unmatched
      .sort((a, b) => b.ownBytes - a.ownBytes)
      .slice(0, 20)
      .map(n => ({ path: n.path, bytes: n.ownBytes })),
    drives: drivesOverview,
    collectedAt: cScan.collectedAt
  };
}

module.exports = { analyze, loadMap, matchApp };
