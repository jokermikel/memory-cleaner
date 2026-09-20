'use strict';
/**
 * memoryService.js — 汇总服务
 * 组合采集 + 归组 + 词典，输出统一 JSON。
 */

const { collectProcesses } = require('../collectors/processList');
const { buildSystemMemory } = require('../collectors/systemMemory');
const { groupApps } = require('./appGrouper');
const { classifyAll } = require('./riskClassifier');

/**
 * 采集一次完整内存快照。
 * @returns {{system:Object, apps:Array, totalBytes:number, groupedBytes:number, conserved:boolean, processCount:number, accessLimitedCount:number, collectedAt:string}}
 */
function snapshot(includeServices = true) {
  const { processes, snapshot: snap } = collectProcesses(includeServices);
  const system = buildSystemMemory(snap);
  const grouped = groupApps(processes);

  const accessLimitedCount = processes.filter(p => !p.path).length;

  // 每个 app 附占比
  for (const app of grouped.apps) {
    app.percentOfTotal = system.totalVisibleBytes
      ? Math.round(app.workingSetBytes / system.totalVisibleBytes * 1000) / 10
      : 0;
  }

  // 风险分级（覆盖词典判定，保证禁止名单优先）
  classifyAll(grouped.apps);

  return {
    system,
    apps: grouped.apps,
    totalBytes: grouped.totalBytes,
    groupedBytes: grouped.groupedBytes,
    conserved: grouped.conserved,
    processCount: processes.length,
    accessLimitedCount,
    collectedAt: snap.collectedAt,
    isAdmin: snap.isAdmin,
    errors: snap.errors || []
  };
}

module.exports = { snapshot };
