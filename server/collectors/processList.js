'use strict';
/**
 * processList.js — 采集进程明细
 * 调用 collect.ps1 拿到 Get-Process（精确 WorkingSet64）+ Win32_Process（父进程/路径）两路数据，
 * 按 PID 合并成统一结构。
 */

const { runPsFile, cleanText } = require('../../lib/psRunner');
const { collector } = require('../../lib/paths');

const PS1_PATH = collector('collect.ps1');

/**
 * 执行采集脚本并返回解析后的 JSON。
 */
function runCollector() {
  const out = runPsFile(PS1_PATH, {}, { timeout: 15000, maxBuffer: 64 * 1024 * 1024 });

  const text = cleanText(out); // 去 BOM 与首尾空白
  if (!text) throw new Error('采集脚本返回空输出');

  try {
    return JSON.parse(text);
  } catch (e) {
    // 调试：把开头和结尾打出来，便于定位
    const head = text.slice(0, 200);
    const tail = text.slice(-200);
    throw new Error(`采集结果 JSON 解析失败: ${e.message}\n开头: ${head}\n结尾: ${tail}`);
  }
}

/**
 * 把两路数据源合并成统一进程结构。
 * @returns {{processes:Array, snapshot:Object}}
 */
function collectProcesses() {
  const snap = runCollector();

  const { asArray } = require('./systemMemory');

  const cimByPid = new Map();
  for (const c of asArray(snap.cimProcesses)) cimByPid.set(c.ProcessId, c);

  const processes = asArray(snap.processes).map(p => {
    const cim = cimByPid.get(p.pid) || {};
    return {
      pid: p.pid,
      name: p.name || 'Unknown',
      workingSet: p.workingSet || 0,
      privateBytes: p.privateBytes || 0,
      pagedMemory: p.pagedMemory || 0,
      virtualBytes: p.virtualBytes || 0,
      startTime: p.startTime || null,
      cpuSeconds: p.cpuSeconds || 0,
      ppid: cim.ParentProcessId != null ? cim.ParentProcessId : null,
      parentName: null, // 稍后填充
      path: cim.ExecutablePath || null
    };
  });

  // 填充 parentName
  const byPid = new Map(processes.map(p => [p.pid, p]));
  for (const p of processes) {
    if (p.ppid && byPid.has(p.ppid)) p.parentName = byPid.get(p.ppid).name;
  }

  return {
    processes,
    snapshot: {
      schemaVersion: snap.schemaVersion,
      collectedAt: snap.collectedAt,
      hostName: snap.hostName,
      isAdmin: snap.isAdmin,
      errors: asArray(snap.errors),
      os: snap.os || null,
      cs: snap.cs || null,
      modules: asArray(snap.modules),
      pagefile: snap.pagefile || null,
      perfOs: snap.perfOs || null
    }
  };
}

module.exports = { collectProcesses, runCollector };
