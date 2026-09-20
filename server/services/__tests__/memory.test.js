'use strict';
/**
 * 采集引擎 + 归组算法的单元测试
 * 运行：node --test server/services/__tests__/memory.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const { groupApps } = require(path.join(ws, 'server/services/appGrouper'));
const { buildSystemMemory } = require(path.join(ws, 'server/collectors/systemMemory'));

// ---- 测试 1：归组守恒 ----
test('归组后合计内存 = 归组前合计（守恒）', () => {
  const procs = [
    { pid: 1, name: 'douyin', workingSet: 1000, privateBytes: 900, ppid: null, parentName: null, path: 'D:/douyin/douyin.exe' },
    { pid: 2, name: 'douyin', workingSet: 500, privateBytes: 400, ppid: 1, parentName: 'douyin', path: 'D:/douyin/douyin.exe' },
    { pid: 3, name: 'douyin_tray', workingSet: 80, privateBytes: 60, ppid: 1, parentName: 'douyin', path: 'D:/douyin/tray/douyin_tray.exe' },
    { pid: 7, name: 'douyin_guard', workingSet: 40, privateBytes: 30, ppid: 99, parentName: 'svchost', path: 'D:/douyin/douyin_guard.exe' },
    { pid: 4, name: 'QQLive', workingSet: 1200, privateBytes: 1100, ppid: null, parentName: null, path: 'D:/tengxun/QQLive.exe' },
    { pid: 5, name: 'svchost', workingSet: 50, privateBytes: 30, ppid: null, parentName: 'services', path: null },
    { pid: 6, name: 'svchost', workingSet: 30, privateBytes: 20, ppid: null, parentName: 'services', path: null }
  ];
  const r = groupApps(procs);
  assert.strictEqual(r.conserved, true, '守恒校验必须为 true');
  assert.strictEqual(r.totalBytes, 1000 + 500 + 80 + 40 + 1200 + 50 + 30);
  assert.strictEqual(r.groupedBytes, r.totalBytes);
  const douyin = r.apps.find(a => a.key === 'douyin');
  assert.ok(douyin, '应存在抖音应用');
  assert.strictEqual(douyin.processCount, 4, 'tray + guard 都应并入 douyin');
});

// ---- 测试 2：强制归组 + 父子跟随 ----
test('alwaysGroupTo 与 parentFollow 归组规则生效', () => {
  const procs = [
    { pid: 10, name: 'steam', workingSet: 100, privateBytes: 80, ppid: null, parentName: null, path: 'D:/steam/steam.exe' },
    { pid: 11, name: 'steamwebhelper', workingSet: 400, privateBytes: 350, ppid: 10, parentName: 'steam', path: 'D:/steam/steamwebhelper.exe' },
    { pid: 12, name: 'QQLive', workingSet: 300, privateBytes: 250, ppid: null, parentName: null, path: 'D:/tengxun/QQLive.exe' },
    { pid: 13, name: 'TMPThumbHD', workingSet: 100, privateBytes: 50, ppid: 12, parentName: 'QQLive', path: 'D:/tengxun/TMPThumbHD.exe' }
  ];
  const r = groupApps(procs);
  const steam = r.apps.find(a => a.key === 'steam');
  assert.ok(steam, '应存在 steam 应用');
  assert.strictEqual(steam.processCount, 2, 'steamwebhelper 应并入 steam');
  assert.strictEqual(steam.workingSetBytes, 500);

  const qqlive = r.apps.find(a => a.key === 'QQLive');
  assert.ok(qqlive, '应存在 QQLive 应用');
  assert.strictEqual(qqlive.processCount, 2, 'TMPThumbHD 应并入 QQLive');
  assert.strictEqual(qqlive.workingSetBytes, 400);
});

// ---- 测试 3：svchost 折叠 ----
test('svchost 多个实例折叠为一个应用，groupBehavior=expand', () => {
  const procs = Array.from({ length: 99 }, (_, i) => ({
    pid: 1000 + i, name: 'svchost', workingSet: 10, privateBytes: 5, ppid: null, parentName: 'services', path: null
  }));
  const r = groupApps(procs);
  const svc = r.apps.find(a => a.key === 'svchost');
  assert.ok(svc, '应存在 svchost 应用');
  assert.strictEqual(svc.processCount, 99, '99 个实例应折叠为 1 个应用');
  assert.strictEqual(svc.groupBehavior, 'expand');
  assert.strictEqual(svc.workingSetBytes, 990);
});

// ---- 测试 4：未知进程兜底 ----
test('未收录进程返回「未收录」且不抛错', () => {
  const procs = [{ pid: 9999, name: 'some_unknown_process', workingSet: 123, privateBytes: 100, ppid: null, parentName: null, path: null }];
  const r = groupApps(procs);
  const u = r.apps[0];
  assert.ok(u.purpose.includes('未收录'), '未知进程应返回未收录说明');
  assert.strictEqual(u.risk, 'caution', '未知进程默认 caution');
});

// ---- 测试 5：空进程列表不抛错 ----
test('空进程列表返回空应用数组', () => {
  const r = groupApps([]);
  assert.deepStrictEqual(r.apps, []);
  assert.strictEqual(r.conserved, true);
});

// ---- 测试 6：系统内存结构化 ----
test('buildSystemMemory 正确换算单位', () => {
  const snap = {
    os: { TotalVisibleMemorySize: 32561, FreePhysicalMemory: 17000, TotalVirtualMemorySize: 37169, FreeVirtualMemory: 14000 },
    cs: { TotalPhysicalMemory: 34142187520 },
    perfOs: { AvailableMBytes: 17500, CommittedBytes: 24000000000, PercentCommittedBytesInUse: 62 },
    pagefile: { Name: 'C:\\pagefile.sys', AllocatedBaseSize: 4608, CurrentUsage: 114, PeakUsage: 130 },
    modules: [{ BankLabel: 'P0 CHANNEL A', DeviceLocator: 'DIMM 0', Capacity: 17179869184, Speed: 5600, Manufacturer: 'Samsung' }],
    collectedAt: '2026-09-16T00:00:00Z', hostName: 'TEST', isAdmin: false
  };
  const s = buildSystemMemory(snap);
  assert.strictEqual(s.totalHardwareBytes, 34142187520);
  assert.strictEqual(s.totalVisibleBytes, 32561 * 1024);
  assert.strictEqual(s.usedBytes, (32561 - 17000) * 1024);
  assert.strictEqual(s.modules.length, 1);
  assert.strictEqual(s.modules[0].capacityBytes, 17179869184);
  assert.strictEqual(s.modules[0].speedMhz, 5600);
});

console.log('（以上为 node:test 输出，全部通过即为测试通过）');
