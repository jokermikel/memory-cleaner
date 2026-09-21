'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ws = process.cwd();
const { buildSystemMemory, memoryTypeName, asArray } = require(path.join(ws, 'server/collectors/systemMemory'));

test('内存条代数按本机 SMBIOS 码翻译，不写死 DDR', () => {
  assert.strictEqual(memoryTypeName({ SMBIOSMemoryType: 34 }), 'DDR5');
  assert.strictEqual(memoryTypeName({ SMBIOSMemoryType: 26 }), 'DDR4');
  assert.strictEqual(memoryTypeName({ SMBIOSMemoryType: 24 }), 'DDR3');
  assert.strictEqual(memoryTypeName({ MemoryType: 20 }), 'DDR');
  assert.strictEqual(memoryTypeName({}), '');
});

test('buildSystemMemory 把本机模块原样带出 memoryType', () => {
  const r = buildSystemMemory({
    os: { TotalVisibleMemorySize: 1024, FreePhysicalMemory: 512, TotalVirtualMemorySize: 2048, FreeVirtualMemory: 1024 },
    cs: { TotalPhysicalMemory: 1024 * 1024 },
    perfOs: { AvailableMBytes: 1, CommittedBytes: 1, PercentCommittedBytesInUse: 1 },
    modules: [{
      BankLabel: 'BANK 0',
      DeviceLocator: 'DIMM A',
      Capacity: 8 * 1024 ** 3,
      Speed: 4800,
      ConfiguredClockSpeed: 4800,
      Manufacturer: 'TestVendor',
      PartNumber: 'ABC',
      SerialNumber: '1',
      SMBIOSMemoryType: 34
    }]
  });
  assert.strictEqual(r.modules.length, 1);
  assert.strictEqual(r.modules[0].memoryType, 'DDR5');
  assert.strictEqual(r.modules[0].manufacturer, 'TestVendor');
  assert.strictEqual(r.modules[0].speedMhz, 4800);
});

test('asArray：0 条 / 1 条对象 / 多条数组都收成数组', () => {
  assert.deepStrictEqual(asArray(null), []);
  assert.deepStrictEqual(asArray(''), []);
  assert.deepStrictEqual(asArray(undefined), []);
  const one = { BankLabel: 'BANK 0', Capacity: 8, SMBIOSMemoryType: 26 };
  assert.strictEqual(asArray(one).length, 1);
  assert.strictEqual(asArray(one)[0].BankLabel, 'BANK 0');
  assert.strictEqual(asArray([one, one]).length, 2);
});

test('单条内存条被 PS 收成对象时 buildSystemMemory 不崩', () => {
  const r = buildSystemMemory({
    os: { TotalVisibleMemorySize: 1024, FreePhysicalMemory: 512, TotalVirtualMemorySize: 2048, FreeVirtualMemory: 1024 },
    cs: { TotalPhysicalMemory: 8 * 1024 ** 3 },
    perfOs: { AvailableMBytes: 1, CommittedBytes: 1, PercentCommittedBytesInUse: 1 },
    modules: {
      BankLabel: 'BANK 0',
      DeviceLocator: 'DIMM1',
      Capacity: 16 * 1024 ** 3,
      Speed: 3200,
      ConfiguredClockSpeed: 3200,
      Manufacturer: 'SoloDIMM',
      PartNumber: 'ONE-STICK',
      SerialNumber: 'X',
      SMBIOSMemoryType: 26
    }
  });
  assert.strictEqual(Array.isArray(r.modules), true);
  assert.strictEqual(r.modules.length, 1);
  assert.strictEqual(r.modules[0].memoryType, 'DDR4');
  assert.strictEqual(r.modules[0].manufacturer, 'SoloDIMM');
  assert.strictEqual(r.modules[0].slot, 'DIMM1');
});

test('没有内存条信息时 modules 为空数组，不抛错', () => {
  const r = buildSystemMemory({
    os: { TotalVisibleMemorySize: 1024, FreePhysicalMemory: 512, TotalVirtualMemorySize: 2048, FreeVirtualMemory: 1024 },
    cs: { TotalPhysicalMemory: 1024 },
    perfOs: {},
    modules: null
  });
  assert.deepStrictEqual(r.modules, []);
});
