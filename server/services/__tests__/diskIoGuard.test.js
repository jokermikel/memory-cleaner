'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const { isBusy, parseSample, DEFAULT_BYTES_PER_SEC } = require(path.join(ws, 'server/services/diskIoGuard'));

test('parseSample 解析性能计数器输出', () => {
  assert.deepStrictEqual(parseSample('10485760|1.5'), { bytesPerSec: 10485760, queueLength: 1.5 });
  assert.deepStrictEqual(parseSample('\uFEFF0|0\r\n'), { bytesPerSec: 0, queueLength: 0 });
});

test('低于阈值不判忙碌', () => {
  const r = isBusy({ bytesPerSec: 1024, queueLength: 0 });
  assert.strictEqual(r.busy, false);
  assert.strictEqual(r.reason, null);
});

test('磁盘吞吐超过 20MB/s 判忙碌', () => {
  const r = isBusy({ bytesPerSec: DEFAULT_BYTES_PER_SEC, queueLength: 0 });
  assert.strictEqual(r.busy, true);
  assert.ok(r.reason && r.reason.includes('大量读写'));
});

test('磁盘队列过长判忙碌', () => {
  const r = isBusy({ bytesPerSec: 0, queueLength: 3 });
  assert.strictEqual(r.busy, true);
  assert.ok(r.reason && r.reason.includes('队列'));
});

// ═══════ D-1（O1）：闸门连续采样，任一次忙即拒绝（2026-09-24）═══════

const { assertDiskIdle, CONFIRM_ROUNDS } = require(path.join(ws, 'server/services/diskIoGuard'));

test('D-1-a 首次采样抖动读到 0，第二次读到忙 → 必须拒绝（单次采样会漏过）', () => {
  const reads = [
    { bytesPerSec: 0, queueLength: 0 },            // 抖动低谷（V3 真实现象）
    { bytesPerSec: 100 * 1024 * 1024, queueLength: 0 } // 实际忙碌
  ];
  let i = 0;
  let err = null;
  try {
    assertDiskIdle({ sampleFn: () => reads[i++] });
  } catch (e) { err = e; }
  assert.ok(err, '第二次采样判忙必须拒绝');
  assert.strictEqual(err.code, 'DISK_BUSY');
  assert.ok(err.samples && err.samples.length === 2, '应保留两次采样证据');
  assert.ok(/连续第 2 次/.test(err.message), '提示应说明是连续采样确认的');
});

test('D-1-b 两次采样均空闲 → 放行，返回 samples 证据', () => {
  let i = 0;
  const r = assertDiskIdle({ sampleFn: () => ({ bytesPerSec: 1024, queueLength: 0 }) });
  assert.ok(r, '空闲必须放行');
  assert.strictEqual(r.samples.length, CONFIRM_ROUNDS, '默认应采样 ' + CONFIRM_ROUNDS + ' 次');
  assert.strictEqual(r.bytesPerSec, 1024, '返回字段应兼容原单次形态');
});

test('D-1-c 第一次采样即忙 → 立即拒绝（不多做无谓采样）', () => {
  let calls = 0;
  let err = null;
  try {
    assertDiskIdle({
      sampleFn: () => { calls++; return { bytesPerSec: 999 * 1024 * 1024, queueLength: 0 }; }
    });
  } catch (e) { err = e; }
  assert.ok(err && err.code === 'DISK_BUSY');
  assert.strictEqual(calls, 1, '首轮判忙即抛出，不应再采样');
});

test('D-1-d 源码核对：默认连续 2 轮、任一轮忙即 throw、可注入 sampleFn', () => {
  const code = require('fs').readFileSync(path.join(ws, 'server/services/diskIoGuard.js'), 'utf8');
  assert.ok(/CONFIRM_ROUNDS\s*=\s*2/.test(code), '默认轮数必须为 2');
  assert.ok(/opts\.sampleFn/.test(code), '必须支持注入 sampleFn（否则无法离线测试）');
  const seg = code.slice(code.indexOf('function assertDiskIdle'), code.indexOf('module.exports'));
  assert.ok(/if \(flag\.busy\)/.test(seg) && /throw err/.test(seg.replace('throw err', 'throw err')),
    '循环内任一轮判忙必须 throw');
  assert.ok(/for \(let i = 1; i <= rounds; i\+\+\)/.test(seg), '必须是多轮循环而非单次调用');
});
