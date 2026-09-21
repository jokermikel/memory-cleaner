'use strict';
/**
 * diskIoGuard.js — 磁盘忙碌闸门
 *
 * 大文件下载/拷贝期间，内存页会与页面文件频繁交换。
 * 此时结束进程或修剪工作集会放大抖动；更严禁强制清空 Standby/Modified 列表。
 * 本模块只读公开性能计数器，不碰任何未公开 API。
 */

const { execFileSync } = require('child_process');

const DEFAULT_BYTES_PER_SEC = 20 * 1024 * 1024; // 20 MB/s
const DEFAULT_QUEUE = 3;

function parseSample(out) {
  const text = String(out || '').replace(/^\uFEFF/, '').trim();
  const parts = text.split('|');
  const bytesPerSec = Number(parts[0]) || 0;
  const queueLength = Number(parts[1]) || 0;
  return { bytesPerSec, queueLength };
}

function sampleDiskIo() {
  if (process.platform !== 'win32') {
    return { bytesPerSec: 0, queueLength: 0, busy: false, reason: null, ok: true };
  }
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter \"Name='_Total'\"",
    "if (-not $d) { '0|0'; exit 0 }",
    '$bytes = 0; try { $bytes = [int64]$d.DiskBytesPersec } catch { $bytes = 0 }',
    '$q = 0; try { $q = [double]$d.CurrentDiskQueueLength } catch { $q = 0 }',
    '"$bytes|$q"'
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 15000
    });
    const sample = parseSample(out);
    const flag = isBusy(sample);
    return { ...sample, ...flag, ok: true };
  } catch (e) {
    return {
      bytesPerSec: 0,
      queueLength: 0,
      busy: false,
      reason: null,
      ok: false,
      error: e.message.slice(0, 200)
    };
  }
}

function isBusy(sample, opts = {}) {
  const maxB = opts.maxBytesPerSec != null ? opts.maxBytesPerSec : DEFAULT_BYTES_PER_SEC;
  const maxQ = opts.maxQueue != null ? opts.maxQueue : DEFAULT_QUEUE;
  const bytes = Number(sample && sample.bytesPerSec) || 0;
  const queue = Number(sample && sample.queueLength) || 0;
  if (bytes >= maxB) {
    return {
      busy: true,
      reason: '磁盘正在大量读写（' + (bytes / 1048576).toFixed(1) + ' MB/s），请等下载或拷贝完成后再清理，避免页面文件交换被打断'
    };
  }
  if (queue >= maxQ) {
    return {
      busy: true,
      reason: '磁盘队列长度为 ' + queue + '，系统正忙于读写。请等下载或拷贝完成后再清理'
    };
  }
  return { busy: false, reason: null };
}

function assertDiskIdle(opts) {
  const sample = sampleDiskIo();
  const flag = isBusy(sample, opts);
  if (flag.busy) {
    const err = new Error(flag.reason);
    err.code = 'DISK_BUSY';
    err.sample = sample;
    throw err;
  }
  return sample;
}

module.exports = {
  sampleDiskIo,
  isBusy,
  assertDiskIdle,
  parseSample,
  DEFAULT_BYTES_PER_SEC,
  DEFAULT_QUEUE
};
