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

const { loadJsonCached } = require('../../lib/dictCache');
const { data } = require('../../lib/paths');

const DICT_PATH = data('appDict.zh.json');

// 词典在热路径上（每次刷新快照都归组一次），按文件状态缓存，见 lib/dictCache.js。
// 返回值只读：groupApps 只用 lookup() 取值，不会改词典。
function loadDict() {
  try {
    return loadJsonCached(DICT_PATH);
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

  // 第一步：先算出**与父进程无关**的基准 key，得到完整的 pid -> key 映射，
  // 第二步才解析 parentFollow。两趟必须分开：原实现边填 procKeys 边读它，
  // 当子进程先于父进程出现在数组里（PID 回绕时会发生）父链就查不到，
  // 于是静默退化为「按名字分组」——同一台机器两次刷新的分组结果因此不一致，
  // 而内存守恒校验照样通过，没有任何守卫会报警。
  const baseKeys = new Map(); // pid -> key（只取决于自身与词典）
  for (const p of processes) baseKeys.set(p.pid, baseKeyOf(p, dict));

  // 环路保护：父链成环的进程一律不跟随父进程（见 chainWouldCycle 说明）。
  // 成环时「环上每个成员各自保留自身基准 key」，因此结果与进程数组顺序无关。
  const mayFollow = new Set();
  for (const p of processes) {
    const entry = lookup(dict, p.name);
    if (entry && entry.parentFollow && !entry.alwaysGroupTo && p.ppid && !chainWouldCycle(p, dict, byPid)) {
      mayFollow.add(p.pid);
    }
  }

  const procKeys = new Map(); // pid -> key（含父链跟随的最终结果）
  for (const p of processes) {
    procKeys.set(p.pid, resolveKey(p, dict, byPid, baseKeys, procKeys, mayFollow));
  }

  // 第三步：按 key 聚合
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

  // 第四步：守恒校验
  const totalBytes = processes.reduce((sum, p) => sum + (p.workingSet || 0), 0);
  const groupedBytes = apps.reduce((sum, a) => sum + a.workingSetBytes, 0);

  return { apps, totalBytes, groupedBytes, conserved: totalBytes === groupedBytes };
}

/**
 * 沿父链向上走，判断是否会回到链上已出现过的 pid（即成环）。
 *
 * 成环只可能来自异常快照 / PID 复用。返回 true 时该进程不跟随父进程、
 * 保留自身基准 key：这样环上每个成员都各自保留，结果与「谁先被解析」无关。
 * 反之（谁先被解析谁存活）会让同一份数据随数组顺序漂移，而刷新之间 PID 顺序
 * 本来就不保证稳定 —— 那等于换了个地方复现原来的不确定性。
 *
 * @param {Set} seen 链上已出现的 pid
 */
function chainWouldCycle(p, dict, byPid) {
  const seen = new Set([p.pid]);
  let cur = p;
  for (;;) {
    const entry = lookup(dict, cur.name);
    if (!entry || !entry.parentFollow || !cur.ppid) return false;
    const parent = byPid.get(cur.ppid);
    if (!parent) return false;
    if (seen.has(parent.pid)) return true;
    seen.add(parent.pid);
    cur = parent;
  }
}

/**
 * 进程的基准 key：只取决于自身与词典，与父进程无关（对应规则 1 / 3 / 4）。
 */
function baseKeyOf(p, dict) {
  const entry = lookup(dict, p.name);
  if (entry && entry.alwaysGroupTo) return entry.alwaysGroupTo;
  if (p.name === 'svchost') return 'svchost';
  return p.name;
}

/**
 * 解析单个进程归属的应用 key（对应规则 2 的父链跟随）。
 *
 * `mayFollow` 已排除成环者，因此跟随图无环、递归必然终止；
 * 结果按 pid 记忆化，同一份快照无论进程顺序如何，分组结果都一致。
 *
 * @param {Map} baseKeys 基准 key 表，先于本函数全量建好
 * @param {Map} procKeys pid -> 已解析的最终 key
 * @param {Set} mayFollow 允许跟随父进程的 pid 集合
 */
function resolveKey(p, dict, byPid, baseKeys, procKeys, mayFollow) {
  const memo = procKeys.get(p.pid);
  if (memo !== undefined) return memo;

  let key = baseKeys.get(p.pid);

  // 规则 2：跟随父进程（处理 crashpad_handler、msedgewebview2 这类被宿主内嵌的组件）。
  // 词典里 alwaysGroupTo 的优先级高于 parentFollow，与单趟实现保持一致。
  if (mayFollow.has(p.pid)) {
    const parent = byPid.get(p.ppid);
    if (parent) {
      const parentKey = resolveKey(parent, dict, byPid, baseKeys, procKeys, mayFollow);
      if (parentKey && parentKey !== p.name) key = parentKey;
    }
  }

  procKeys.set(p.pid, key);
  return key;
}

module.exports = { groupApps, loadDict, FALLBACK };
