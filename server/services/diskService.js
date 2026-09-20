'use strict';
/**
 * diskService.js — 磁盘扫描汇总
 * 只读：读 C/D 盘总量、一级目录占用、已知垃圾路径大小。
 */

const { scanDisks, listVolumes } = require('../collectors/diskSpace');

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function fmt(bytes) {
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB';
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB';
  return bytes + ' B';
}

/**
 * 采集一次完整磁盘快照。
 */
function snapshot() {
  const raw = scanDisks();

  const drives = raw.drives.map(d => {
    const usedPercent = d.totalBytes ? Math.round(d.usedBytes / d.totalBytes * 1000) / 10 : 0;
    const topSum = (d.topDirs || []).reduce((s, x) => s + (x.bytes || 0), 0);
    const junkSum = (d.junkPaths || []).reduce((s, x) => s + (x.bytes || 0), 0);

    return {
      drive: d.drive,
      volumeName: d.volumeName || '',
      fileSystem: d.fileSystem || '',
      totalBytes: d.totalBytes,
      usedBytes: d.usedBytes,
      freeBytes: d.freeBytes,
      usedPercent,
      topDirs: (d.topDirs || []).map(x => ({
        name: x.name,
        path: x.path,
        bytes: x.bytes || 0,
        percentOfUsed: d.usedBytes ? Math.round((x.bytes || 0) / d.usedBytes * 1000) / 10 : 0
      })),
      junkPaths: (d.junkPaths || []).map(x => ({
        path: x.path,
        expanded: x.expanded,
        bytes: x.bytes || 0,
        exists: !!x.exists
      })),
      topDirsSumBytes: topSum,
      junkSumBytes: junkSum,
      // NTFS 硬链接（WinSxS 等）会让目录合计超过盘已用量，封顶 100% 并注明
      coveragePercent: d.usedBytes ? Math.min(100, Math.round(topSum / d.usedBytes * 1000) / 10) : 0,
      hardlinkNote: topSum > d.usedBytes ? '一级目录合计超过盘已用量，原因是 NTFS 硬链接被重复计数（如 WinSxS），属正常现象' : null,
      errors: d.errors || []
    };
  });

  const totalJunkBytes = drives.reduce((s, d) => s + d.junkSumBytes, 0);

  return {
    drives,
    totalJunkBytes,
    collectedAt: raw.collectedAt,
    hostName: raw.hostName
  };
}

function volumes() {
  const list = listVolumes();
  return {
    drives: list.map(d => ({
      ...d,
      usedPercent: d.totalBytes ? Math.round(d.usedBytes / d.totalBytes * 1000) / 10 : 0
    })),
    collectedAt: new Date().toISOString()
  };
}

module.exports = { snapshot, volumes, fmt, GB, MB };
