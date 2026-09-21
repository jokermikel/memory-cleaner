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
