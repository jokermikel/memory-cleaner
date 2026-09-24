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

/**
 * 闸门判定：连续采样 N 次，**任一次判忙即拒绝**（观察项 O1/D-1 修复，2026-09-24）。
 *
 * 原实现只做**单次瞬时采样**：真机实测 6 轮中有 1 轮读到 `bytesPerSec=0` 而放行 ——
 * 1 秒内吞吐可从 0 跳到 2GB/s，瞬时采样存在漏过窗口。
 * 现改为连续 CONFIRM_ROUNDS 次采样（每次都是独立的 PowerShell 进程，天然有间隔），
 * 只要任意一次达到阈值即 DISK_BUSY 拒绝；全部低于阈值才放行。
 * 拒绝成本只是「多等一会儿」，放行错误成本是「高 I/O 下修剪放大抖动」——非对称，故从严。
 *
 * @param {Object} [opts]            传给 isBusy 的阈值；另支持测试注入 sampleFn / rounds
 * @returns {object} 最后一次采样的字段（含 samples 数组）
 */
const CONFIRM_ROUNDS = 2;

function assertDiskIdle(opts = {}) {
  const sampleFn = typeof opts.sampleFn === 'function' ? opts.sampleFn : sampleDiskIo;
  const rounds = Number.isFinite(opts.rounds) && opts.rounds > 0 ? Math.floor(opts.rounds) : CONFIRM_ROUNDS;
  const samples = [];
  for (let i = 1; i <= rounds; i++) {
    const sample = sampleFn();
    const flag = isBusy(sample, opts);
    if (flag.busy) {
      const err = new Error(flag.reason +
        (i > 1 ? '（连续第 ' + i + ' 次采样确认仍忙）' : ''));
      err.code = 'DISK_BUSY';
      err.sample = sample;
      err.samples = samples.concat(sample);
      throw err;
    }
    samples.push(sample);
  }
  const last = samples[samples.length - 1];
  return { ...last, samples };
}

module.exports = {
  sampleDiskIo,
  isBusy,
  assertDiskIdle,
  parseSample,
  DEFAULT_BYTES_PER_SEC,
  DEFAULT_QUEUE,
  CONFIRM_ROUNDS
};
