'use strict';
/**
 * processList.js — 采集进程明细
 * 调用 collect.ps1 拿到 Get-Process（精确 WorkingSet64）+ Win32_Process（父进程/路径）两路数据，
 * 按 PID 合并成统一结构。
 */

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const PS1_PATH = path.join(__dirname, 'collect.ps1');

/**
 * 执行采集脚本并返回解析后的 JSON。
 */
function runCollector(includeServices) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_PATH];
  if (includeServices) args.push('-IncludeServices');

  const out = execFileSync('powershell.exe', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15000,
    windowsHide: true
  });

  // 去除可能的 BOM 和首尾空白
  let text = out;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.trim();
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
function collectProcesses(includeServices) {
  const snap = runCollector(includeServices);

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
      threadCount: p.threadCount || 0,
      handleCount: p.handleCount || 0,
      startTime: p.startTime || null,
      cpuSeconds: p.cpuSeconds || 0,
      ppid: cim.ParentProcessId != null ? cim.ParentProcessId : null,
      parentName: null, // 稍后填充
      path: cim.ExecutablePath || null,
      commandLine: cim.CommandLine || null
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
      perfOs: snap.perfOs || null,
      perfProc: snap.perfProc || null,
      services: snap.services || null
    }
  };
}

module.exports = { collectProcesses, runCollector };
