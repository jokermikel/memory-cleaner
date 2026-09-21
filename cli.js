'use strict';
/**
 * cli.js — 命令行版内存排行
 * 用法：
 *   node cli.js          完整排行（前 30）
 *   node cli.js 10       只看前 10
 *   node cli.js safe     只看可安全清理的
 *   node cli.js qq       搜索含 qq 的应用
 */

const path = require('path');
const ws = process.cwd();
const { snapshot } = require(path.join(ws, 'server/services/memoryService'));

const MB = 1048576;
const GB = 1024 ** 3;

function fmtBytes(b) {
  if (b >= GB) return (b / GB).toFixed(2) + ' GB';
  return (b / MB).toFixed(1) + ' MB';
}

function fmtBar(bytes, max) {
  const w = 20;
  const n = max > 0 ? Math.round(bytes / max * w) : 0;
  return '█'.repeat(n) + '░'.repeat(w - n);
}

const arg = process.argv[2];

process.stdout.write('\n正在采集内存数据…\n');
const r = snapshot(true);
const s = r.system;

// 顶部概览
console.log('\n════════════════════════════════════════════════');
console.log('  整机内存概览');
console.log('════════════════════════════════════════════════');
const mods = Array.isArray(s.modules) ? s.modules : [];
console.log(`  硬件总量：${fmtBytes(s.totalHardwareBytes)}` + (mods.length ? `（${mods.length} 条，${mods.map(m => fmtBytes(m.capacityBytes) + ' ' + (m.manufacturer || '')).join(' + ')}）` : '（未读到内存条明细）'));
console.log(`  系统可见：${fmtBytes(s.totalVisibleBytes)}`);
console.log(`  已    用：${fmtBytes(s.usedBytes)}  (${s.usedPercent}%)`);
console.log(`  可    用：${fmtBytes(s.availableBytes)}`);
console.log(`  提交上限：${fmtBytes(s.commitLimitBytes)}，已提交 ${fmtBytes(s.commitUsedBytes)}`);
console.log(`  待机缓存：${fmtBytes(s.standbyCacheBytes)}（清理它可腾出空间，但可能让程序变慢）`);
console.log(`  采集时间：${r.collectedAt}（${r.isAdmin ? '管理员' : '普通权限'}，${r.accessLimitedCount} 个进程读不到路径）`);
if (!r.isAdmin) console.log(`  ⚠ 当前是普通权限：清理 Windows 服务进程会失败，建议用「启动.bat」以管理员运行`);

// 应用排行
let apps = r.apps;
const q = (arg || '').toLowerCase();

if (q === 'safe' || q === 'caution' || q === 'protected') {
  apps = apps.filter(a => a.risk === q);
  console.log(`\n筛选：风险=${q} 的应用`);
} else if (q && !/^\d+$/.test(q)) {
  apps = apps.filter(a =>
    a.name.toLowerCase().includes(q) || a.purpose.includes(q) || a.vendor.toLowerCase().includes(q)
  );
  console.log(`\n筛选：含「${arg}」的应用`);
}

const limit = /^\d+$/.test(arg || '') ? Number(arg) : 30;
const maxWs = apps.length ? apps[0].workingSetBytes : 1;

console.log('\n════════════════════════════════════════════════');
console.log('  应用内存排行（按占用降序）');
console.log('════════════════════════════════════════════════');
if (!apps.length) {
  console.log('  （无匹配应用）');
} else {
  apps.slice(0, limit).forEach((a, i) => {
    const pct = s.totalVisibleBytes ? (a.workingSetBytes / s.totalVisibleBytes * 100).toFixed(1) : '0';
    const riskLabel = { safe: '🟢可清理', caution: '🟡谨慎', protected: '🔴保护' }[a.risk] || a.risk;
    console.log(`${String(i + 1).padStart(2)}. ${a.name.padEnd(20)} ${fmtBytes(a.workingSetBytes).padStart(9)}  ${pct}%  ${fmtBar(a.workingSetBytes, maxWs)}`);
    console.log(`      ${riskLabel} · ${a.category} · ${a.vendor} · ${a.processCount}个进程`);
    console.log(`      ${a.purpose}`);
  });
}

// 统计
console.log('\n════════════════════════════════════════════════');
console.log(`  共 ${r.processCount} 个进程 → ${apps.length} 个应用（展示前 ${Math.min(limit, apps.length)} 个）`);
console.log(`  归组守恒：${r.conserved ? '✓ 通过' : '✗ 失败'}（归组前 ${fmtBytes(r.totalBytes)} = 归组后 ${fmtBytes(r.groupedBytes)}）`);

const safeTotal = r.apps.filter(a => a.risk === 'safe').reduce((sum, a) => sum + a.workingSetBytes, 0);
console.log(`  可安全清理（🟢）合计：${fmtBytes(safeTotal)}`);
console.log('');
