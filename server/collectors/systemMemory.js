'use strict';
/**
 * systemMemory.js — 整机内存信息汇总
 * 数据来源：collect.ps1 采集的 os / cs / modules / pagefile / perfOs。
 * 只做单位换算和结构化，不重新采集。
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * @param {Object} snapshot  来自 collectProcesses 的 snapshot 字段
 * @returns {Object} 整机内存结构
 */
function buildSystemMemory(snapshot) {
  const os = snapshot.os || {};
  const cs = snapshot.cs || {};
  const perfOs = snapshot.perfOs || {};

  const totalVisibleBytes = (os.TotalVisibleMemorySize || 0) * 1024;
  const freePhysicalBytes = (os.FreePhysicalMemory || 0) * 1024;
  const totalHardwareBytes = cs.TotalPhysicalMemory || totalVisibleBytes;
  const usedBytes = Math.max(0, totalVisibleBytes - freePhysicalBytes);

  return {
    totalHardwareBytes,          // 硬件装机量
    totalVisibleBytes,           // 系统可见量（界面主口径）
    freePhysicalBytes,           // 空闲物理内存（不含待机缓存）
    usedBytes,                   // 已用 = 可见 - 空闲
    usedPercent: totalVisibleBytes ? Math.round(usedBytes / totalVisibleBytes * 1000) / 10 : 0,
    availableBytes: (perfOs.AvailableMBytes || 0) * MB, // 任务管理器口径「可用」
    commitLimitBytes: (os.TotalVirtualMemorySize || 0) * 1024,
    commitUsedBytes: (perfOs.CommittedBytes) || ((os.TotalVirtualMemorySize - os.FreeVirtualMemory) * 1024),
    commitUsedPercent: perfOs.PercentCommittedBytesInUse || 0,
    standbyCacheBytes: (perfOs.StandbyCacheNormalPriorityBytes || 0) + (perfOs.StandbyCacheCoreBytes || 0) + (perfOs.StandbyCacheReserveBytes || 0),
    modifiedCacheBytes: perfOs.ModifiedPageListBytes || 0,
    poolPagedBytes: perfOs.PoolPagedBytes || 0,
    poolNonpagedBytes: perfOs.PoolNonpagedBytes || 0,
    pageFile: snapshot.pagefile ? {
      name: snapshot.pagefile.Name || '',
      allocatedBytes: (snapshot.pagefile.AllocatedBaseSize || 0) * MB,
      currentUsageBytes: (snapshot.pagefile.CurrentUsage || 0) * MB,
      peakUsageBytes: (snapshot.pagefile.PeakUsage || 0) * MB
    } : null,
    modules: (snapshot.modules || []).map(m => ({
      bank: m.BankLabel || '',
      slot: m.DeviceLocator || '',
      capacityBytes: m.Capacity || 0,
      speedMhz: m.Speed || 0,
      configuredSpeedMhz: m.ConfiguredClockSpeed || 0,
      manufacturer: m.Manufacturer || '',
      partNumber: (m.PartNumber || '').trim(),
      serialNumber: m.SerialNumber || ''
    })),
    collectedAt: snapshot.collectedAt || null,
    hostName: snapshot.hostName || '',
    isAdmin: snapshot.isAdmin || false
  };
}

module.exports = { buildSystemMemory, GB, MB };
