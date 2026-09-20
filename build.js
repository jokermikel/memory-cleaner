'use strict';
/**
 * build.js — 生成单文件界面
 * 采集一次真实内存快照，注入 _template.html，输出 内存清理助手.html。
 * 用法：node build.js
 */

const fs = require('fs');
const path = require('path');

const WS = __dirname;
const TPL = path.join(WS, '_template.html');
const OUT = path.join(WS, '内存清理助手.html');
const SNAP_CACHE = path.join(WS, 'data', 'snapshot.json');

function main() {
  if (!fs.existsSync(TPL)) {
    console.error('找不到模板 _template.html');
    process.exit(1);
  }

  process.stdout.write('正在采集内存快照…');
  const { snapshot } = require(path.join(WS, 'server', 'services', 'memoryService'));
  const data = snapshot(true);
  process.stdout.write(' 完成\n');

  // 缓存一份快照，便于排查
  fs.mkdirSync(path.dirname(SNAP_CACHE), { recursive: true });
  fs.writeFileSync(SNAP_CACHE, JSON.stringify(data, null, 2), 'utf8');

  const tpl = fs.readFileSync(TPL, 'utf8');
  if (!tpl.includes('__SNAPSHOT_DATA__')) {
    console.error('模板里没有 __SNAPSHOT_DATA__ 占位符');
    process.exit(1);
  }

  const out = tpl.replace('__SNAPSHOT_DATA__', JSON.stringify(data));
  fs.writeFileSync(OUT, out, 'utf8');

  const safe = data.apps.filter(a => a.risk === 'safe');
  const safeBytes = safe.reduce((s, a) => s + a.workingSetBytes, 0);

  console.log('已生成:', path.basename(OUT), '(' + (out.length / 1024).toFixed(1) + ' KB)');
  console.log('  进程数 ' + data.processCount + ' → 应用数 ' + data.apps.length);
  console.log('  已用 ' + (data.system.usedBytes / 1048576).toFixed(1) + ' MB (' + data.system.usedPercent + '%)');
  console.log('  可清理 ' + safe.length + ' 个应用，合计 ' + (safeBytes / 1048576).toFixed(1) + ' MB');
  console.log('  守恒校验 ' + (data.conserved ? '通过' : '失败'));
}

main();
