'use strict';
/**
 * disk-cli.js — 命令行版 C/D 盘占用排行
 * 用法：
 *   node disk-cli.js          分区概览 + 可清理垃圾（约 3 秒）
 *   node disk-cli.js junk     同上
 *   node disk-cli.js plan     打印 dry-run 清理计划（不删）
 *   node disk-cli.js apps     按应用归类占用（约 30~60 秒）
 *   node disk-cli.js C        只扫 C 盘一级目录
 *   node disk-cli.js D        只扫 D 盘一级目录
 *   node disk-cli.js inspect <路径>     检查是否为链接/断链
 *   node disk-cli.js migrate <源> <目标>  缓存迁移 dry-run（默认 junction）
 */

const path = require('path');
const ws = process.cwd();
const { runScan } = require(path.join(ws, 'server/collectors/diskSpace'));
const { fmt, volumes } = require(path.join(ws, 'server/services/diskService'));
const { locate } = require(path.join(ws, 'server/services/junkLocator'));
const { analyze } = require(path.join(ws, 'server/services/diskAnalyzer'));
const { plan } = require(path.join(ws, 'server/services/diskCleanupService'));
const cacheMigrate = require(path.join(ws, 'server/services/cacheMigrateService'));

const arg = (process.argv[2] || 'junk').toLowerCase();

function printDrive(r) {
  const usedPct = r.totalBytes ? (r.usedBytes / r.totalBytes * 100).toFixed(1) : '0';
  console.log('\n════════════════════════════════════════════════');
  console.log(`  ${r.drive}  ${r.volumeName || ''}  (${r.fileSystem})`);
  console.log('════════════════════════════════════════════════');
  console.log(`  总量 ${fmt(r.totalBytes)}  ·  已用 ${fmt(r.usedBytes)} (${usedPct}%)  ·  剩余 ${fmt(r.freeBytes)}`);

  if (r.topDirs && r.topDirs.length) {
    const max = r.topDirs[0].bytes || 1;
    console.log('\n  一级目录占用（按大小降序）');
    r.topDirs
      .filter(d => d.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .forEach((d, i) => {
        const pct = r.usedBytes ? (d.bytes / r.usedBytes * 100).toFixed(1) : '0';
        const barW = 20;
        const n = Math.round(d.bytes / max * barW);
        const bar = '█'.repeat(n) + '░'.repeat(barW - n);
        console.log(`  ${String(i + 1).padStart(2)}. ${String(d.name).padEnd(28)} ${fmt(d.bytes).padStart(10)}  ${pct.padStart(5)}%  ${bar}`);
      });
    const topSum = r.topDirs.reduce((s, d) => s + d.bytes, 0);
    const cov = r.usedBytes ? Math.min(100, topSum / r.usedBytes * 100) : 0;
    console.log(`\n  目录合计 ${fmt(topSum)}  ·  覆盖已用 ${cov.toFixed(1)}%`);
    if (topSum > r.usedBytes) {
      console.log('  （合计略超已用量是 NTFS 硬链接重复计数，属正常）');
    }
  }

  if (r.junkPaths && r.junkPaths.length) {
    const junk = r.junkPaths.filter(j => j.bytes > 0);
    if (junk.length) {
      console.log('\n  已知垃圾路径');
      junk.sort((a, b) => b.bytes - a.bytes).forEach(j => {
        console.log(`     ${fmt(j.bytes).padStart(10)}  ${j.expanded || j.path}`);
      });
      const junkSum = junk.reduce((s, j) => s + j.bytes, 0);
      console.log(`  垃圾合计 ${fmt(junkSum)}`);
    }
  }
}

const C_TOP = ['Users', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'];
const C_JUNK = [
  'C:\\Windows\\Temp',
  'C:\\Windows\\SoftwareDistribution\\Download',
  '%TEMP%',
  '%LOCALAPPDATA%\\Temp',
  '%LOCALAPPDATA%\\Microsoft\\Windows\\INetCache',
  '%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer',
  '%LOCALAPPDATA%\\CrashDumps'
];


function printInspect(target) {
  if (!target) {
    console.log('用法：node disk-cli.js inspect <路径>');
    return;
  }
  const info = cacheMigrate.inspect(target);
  const kind = info.broken ? '断链' : (info.linkKind || info.type);
  console.log('\n════════════════════════════════════════════════');
  console.log('  链接检查器');
  console.log('════════════════════════════════════════════════');
  console.log('  路径   ' + info.path);
  console.log('  类型   ' + kind + (info.isLink ? '（链接）' : ''));
  console.log('  存在   ' + (info.exists ? '是' : '否'));
  if (info.target) console.log('  目标   ' + info.target);
  console.log('  断链   ' + (info.broken ? '是' : '否'));
}

function printMigrate(src, dst) {
  if (!src || !dst) {
    console.log('用法：node disk-cli.js migrate <源目录> <目标目录>');
    console.log('只打印计划，不改文件。真正迁移请用界面二次确认。');
    return;
  }
  try {
    const r = cacheMigrate.execute({ source: src, destination: dst, dryRun: true });
    console.log('\n════════════════════════════════════════════════');
    console.log('  缓存迁移计划（dry-run，不会改文件）');
    console.log('════════════════════════════════════════════════');
    console.log('  源     ' + r.source);
    console.log('  目标   ' + r.destination);
    console.log('  链接   ' + r.linkType + '（mklink /J，无需管理员）');
    console.log('  文件   ' + r.fileCount + ' 个 / ' + fmt(r.estimatedBytes));
    console.log('  目标盘剩余 ' + fmt(r.destFreeBytes));
    console.log('  ' + r.occupiedHint);
    (r.steps || []).forEach((s, i) => console.log('  ' + (i + 1) + '. ' + s));
  } catch (e) {
    console.log('预检失败：' + (e.code || '') + ' ' + e.message);
    if (e.issues) e.issues.forEach(i => console.log('  - ' + i.code + ': ' + i.message));
  }
}

const t0 = Date.now();

function printVolumes() {
  const v = volumes();
  console.log('\n════════════════════════════════════════════════');
  console.log('  分区概览');
  console.log('════════════════════════════════════════════════');
  for (const d of v.drives) {
    console.log(`  ${d.drive} ${d.volumeName || ''}  已用 ${fmt(d.usedBytes)} / ${fmt(d.totalBytes)} (${d.usedPercent}%)  剩余 ${fmt(d.freeBytes)}`);
  }
}

function printJunk() {
  console.log('\n════════════════════════════════════════════════');
  console.log('  可清理垃圾（按词典分类，已去重）');
  console.log('════════════════════════════════════════════════');
  const junk = locate();
  junk.items.filter(i => i.bytes > 0).forEach(i => {
    const tag = i.risk === 'safe' ? '🟢可清' : '🟡谨慎';
    console.log(`  ${tag}  ${fmt(i.bytes).padStart(10)}  ${i.name}`);
    console.log(`        ${i.purpose}`);
  });
  console.log(`\n  🟢 默认可清合计 ${fmt(junk.safeBytes)}`);
  console.log(`  🟡 谨慎项合计   ${fmt(junk.cautionBytes)}（含微信/腾讯视频等用户数据，默认不删）`);
}

function printPlan() {
  const p = plan();
  console.log('\n════════════════════════════════════════════════');
  console.log('  磁盘清理计划（dry-run，不会删除）');
  console.log('════════════════════════════════════════════════');
  p.items.forEach((i, idx) => {
    console.log(`  ${String(idx + 1).padStart(2)}. ${fmt(i.bytes).padStart(10)}  ${i.name}`);
  });
  console.log(`\n  共 ${p.itemCount} 项，预计 ${fmt(p.estimatedBytes)}`);
  console.log('  要真正删除请用界面：启动.bat → C/D 磁盘 → 确认删除勾选项');
}

if (arg === 'inspect') {
  printInspect(process.argv[3]);
} else if (arg === 'migrate') {
  printMigrate(process.argv[3], process.argv[4]);
} else if (arg === 'c' || arg === 'c:') {
  console.log('\n正在扫描 C: …');
  printDrive(runScan('C:', C_TOP, C_JUNK));
} else if (arg === 'd' || arg === 'd:') {
  console.log('\n正在扫描 D: …');
  printDrive(runScan('D:', [], ['D:\\$Recycle.Bin']));
} else if (arg === 'apps') {
  printVolumes();
  console.log('\n正在按应用归类（30~60 秒）…');
  const an = analyze();
  console.log('\n════════════════════════════════════════════════');
  console.log('  按应用占用（C + D）');
  console.log('════════════════════════════════════════════════');
  an.apps.slice(0, 20).forEach((a, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${fmt(a.bytes).padStart(10)}  ${a.name}`);
    console.log(`        ${a.category} · ${a.vendor} · ${a.purpose}`);
  });
} else if (arg === 'plan') {
  printVolumes();
  printPlan();
} else {
  printVolumes();
  printJunk();
}

console.log(`\n完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒\n`);
