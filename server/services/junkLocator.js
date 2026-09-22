'use strict';
/**
 * junkLocator.js — 按词典扫描本机垃圾/缓存路径
 * 去重规则：若 A 是 B 的父目录，只保留更具体的那条（子路径），父路径扣掉子路径的字节数。
 */

const fs = require('fs');
const path = require('path');
const { runScan } = require('../collectors/diskSpace');

const DICT_PATH = path.join(__dirname, '..', '..', 'data', 'junkDict.zh.json');

/**
 * 传给 diskScan.ps1 -TopDirs 的哨兵值。
 *
 * locate() 只消费返回值里的 junkPaths，不需要任何一级目录数据。而 -TopDirs 传空
 * 会让脚本走 Get-ChildItem 枚举该盘全部一级目录并逐个 robocopy 量大小
 * （实测本机 D 盘 78 个目录 ≈ 38s），纯属浪费。
 *
 * 传这个哨兵名只会让脚本尝试量算这一个（不存在的）目录，Test-Path 即返回，
 * 成本可忽略；名字自解释，不会被误认为真实业务目录。
 */
const NO_TOP_DIR_SENTINEL = '__cc_no_top_dirs__';

function loadDict() {
  return JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
}

function expand(p) {
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || ('%' + name + '%'));
}

function isSubPath(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  if (c === p) return false;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * 扫描词典中所有路径，返回分类后的垃圾清单。
 */
function locate() {
  const dict = loadDict();
  const entries = dict.entries || [];
  const { listLocalDrives } = require('../collectors/diskSpace');

  // 系统盘取环境变量，不写死 'C:'（系统装在 D/E 盘的机器同样正确）。
  const sysDrive = (process.env.SystemDrive || 'C:');

  // 收集全部路径（去重相同展开路径）
  // 回收站条目（id 以 recycle 开头）动态展开到所有本地盘符，
  // 不写死 C:/D:。其它条目按词典原样展开。
  const pathSet = [];
  const seen = new Set();
  for (const e of entries) {
    let rawPaths = e.paths || [];
    if (e.id.startsWith('recycle')) {
      rawPaths = listLocalDrives().map(d => d + '\\$Recycle.Bin');
    }
    for (const p of rawPaths) {
      const expanded = expand(p);
      const key = expanded.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pathSet.push({ original: p, expanded, entryId: e.id });
    }
  }

  // 一次 robocopy 扫完（pathSet 已含所有盘符的回收站）
  //
  // 盘符：取系统盘而非硬编码 'C:'（系统装在 D/E 盘的机器也能扫对）。
  //       实测 -Drive 只影响结果里的 drive 回显，-JunkList 的展开与量算与之无关。
  // topDirs：这里传一个「哨兵目录名」而不是空数组。
  //       空数组会让 diskScan.ps1 走 Get-ChildItem 枚举该盘全部一级目录并逐个
  //       robocopy 量大小（本机 D 盘 78 个目录 ≈ 38s，纯浪费）；
  //       传一个几乎不可能存在的名字则只会尝试量算这一个目录，成本可忽略。
  //       本函数只需要 junkPaths，不需要任何 topDirs 数据。
  const junkList = pathSet.map(x => x.original);
  const scanned = runScan(sysDrive, [NO_TOP_DIR_SENTINEL], junkList);

  const byExpanded = new Map();
  for (const j of scanned.junkPaths || []) {
    if (j && j.expanded) byExpanded.set(path.resolve(j.expanded).toLowerCase(), j);
  }

  // 组装每条词典条目（用 pathSet 里动态展开后的路径，回收站等动态条目才能生效）
  const items = entries.map(e => {
    const paths = pathSet
      .filter(ps => ps.entryId === e.id)
      .map(ps => {
        const hit = byExpanded.get(path.resolve(ps.expanded).toLowerCase());
        return {
          path: ps.original,
          expanded: ps.expanded,
          bytes: hit ? (hit.bytes || 0) : 0,
          exists: hit ? !!hit.exists : false
        };
      });
    const rawBytes = paths.reduce((s, x) => s + x.bytes, 0);
    return {
      id: e.id,
      name: e.name,
      purpose: e.purpose,
      category: e.category,
      risk: e.risk,
      vendor: e.vendor,
      note: e.note || '',
      paths,
      bytes: rawBytes
    };
  });

  // 重叠去重：子路径从父路径中扣除
  for (const parent of items) {
    for (const child of items) {
      if (parent.id === child.id) continue;
      for (const pp of parent.paths) {
        for (const cp of child.paths) {
          if (pp.exists && cp.exists && isSubPath(cp.expanded, pp.expanded)) {
            parent.bytes = Math.max(0, parent.bytes - cp.bytes);
          }
        }
      }
    }
  }

  items.sort((a, b) => b.bytes - a.bytes);

  const safeBytes = items.filter(i => i.risk === 'safe').reduce((s, i) => s + i.bytes, 0);
  const cautionBytes = items.filter(i => i.risk === 'caution').reduce((s, i) => s + i.bytes, 0);

  return {
    items,
    safeBytes,
    cautionBytes,
    totalBytes: safeBytes + cautionBytes,
    collectedAt: scanned.collectedAt
  };
}

module.exports = { locate, loadDict, expand, isSubPath, NO_TOP_DIR_SENTINEL };
