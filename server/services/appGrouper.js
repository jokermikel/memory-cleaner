'use strict';
/**
 * appGrouper.js — 把进程列表归组为「应用」列表
 *
 * 归组规则（按优先级）：
 *   1. 词典里标了 alwaysGroupTo 的进程，强制并入指定应用（如 steamwebhelper -> steam）
 *   2. 词典里标了 parentFollow 的进程，向上找父进程所属应用并并入（如 crashpad_handler -> 宿主应用）
 *   3. svchost 特殊折叠：全部 99 个实例合并为 1 行，可展开
 *   4. 同名进程按名字归组；父进程也在且同名时算作同一个应用
 *   5. 归组后合计内存必须等于归组前合计（守恒）
 */

const path = require('path');
const fs = require('fs');

const DICT_PATH = path.join(__dirname, '..', '..', 'data', 'appDict.zh.json');

function loadDict() {
  try {
    return JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
  } catch (e) {
    return { entries: {} };
  }
}

const FALLBACK = { name: null, purpose: '未收录用途（可通过提权获得更多信息）', category: '未知', vendor: '未知', risk: 'caution' };

function lookup(dict, key) {
  return dict.entries[key] || null;
}

/**
 * 将进程列表归组为应用列表。
 * @param {Array} processes  进程数组，每项须含：pid,name,workingSet,privateBytes,path,ppid,parentName
 * @returns {{apps:Array, totalBytes:number, byKey:Object}}
 */
function groupApps(processes) {
  const dict = loadDict();
  const byPid = new Map();
  for (const p of processes) byPid.set(p.pid, p);

  // 第一步：计算每个进程的归属 key
  const procKeys = new Map(); // pid -> key
  for (const p of processes) {
    const key = resolveKey(p, dict, byPid, procKeys);
    procKeys.set(p.pid, key);
  }

  // 第二步：按 key 聚合
  const groups = new Map();
  for (const p of processes) {
    const key = procKeys.get(p.pid) || p.name;
    if (!groups.has(key)) {
      const entry = lookup(dict, key);
      groups.set(key, {
        key,
        name: (entry && entry.name) || key,
        purpose: (entry && entry.purpose) || FALLBACK.purpose,
        category: (entry && entry.category) || '未知',
        vendor: (entry && entry.vendor) || '未知',
        risk: (entry && entry.risk) || 'caution',
        groupBehavior: (entry && entry.groupBehavior) || null,
        processCount: 0,
        workingSetBytes: 0,
        privateBytes: 0,
        processes: []
      });
    }
    const g = groups.get(key);
    g.processCount += 1;
    g.workingSetBytes += p.workingSet || 0;
    g.privateBytes += p.privateBytes || 0;
    g.processes.push(p);
  }

  // svchost 特殊折叠
  if (groups.has('svchost')) {
    const svc = groups.get('svchost');
    svc.groupBehavior = 'expand';
    svc.name = 'Windows 服务宿主';
  }

  const apps = Array.from(groups.values());
  apps.sort((a, b) => b.workingSetBytes - a.workingSetBytes);

  // 第三步：守恒校验
  const totalBytes = processes.reduce((sum, p) => sum + (p.workingSet || 0), 0);
  const groupedBytes = apps.reduce((sum, a) => sum + a.workingSetBytes, 0);

  return { apps, totalBytes, groupedBytes, conserved: totalBytes === groupedBytes };
}

/**
 * 解析单个进程归属的应用 key。
 */
function resolveKey(p, dict, byPid, procKeys) {
  const entry = lookup(dict, p.name);

  // 规则 1：强制并入指定应用
  if (entry && entry.alwaysGroupTo) return entry.alwaysGroupTo;

  // 规则 2：跟随父进程（处理 crashpad_handler、msedgewebview2 这类被宿主内嵌的组件）
  if (entry && entry.parentFollow && p.ppid) {
    const parent = byPid.get(p.ppid);
    if (parent) {
      const parentKey = procKeys.get(parent.pid);
      if (parentKey && parentKey !== p.name) return parentKey;
    }
  }

  // 规则 3：svchost 特殊折叠
  if (p.name === 'svchost') return 'svchost';

  // 规则 4：同名进程归组
  return p.name;
}

module.exports = { groupApps, loadDict, FALLBACK };
