'use strict';
/**
 * regenerate-baseline.js —— 重建源码 SHA256 基线
 *
 * 背景与教训：
 *   旧版只遍历「上一份基线里的文件清单」逐个重算哈希，不扫描新文件。
 *   结果 HEAD `3d5f2bb` 新增的 workingSetService.js / trimWorkingSet.ps1 /
 *   workingSet.test.js 三个文件**始终不在清单里**——T0.4「生产源码哈希与基线一致」
 *   因此检测不到它们被改动，是一处检测盲区。
 *
 * 本版改为：以 `git ls-files` 追踪的仓库文件为准，按共享规则筛出源码类，再计入本地测试
 * 脚手架，最后逐个算 SHA256。基线**不再继承上一份基线的任何条目**（见下）。
 *
 * 取消「并入旧基线条目」（2026-09-27）：
 *   旧版会把上一份基线里的条目全部保留，本意是护住 `data/snapshot.json` 这类「被 gitignore
 *   但仍想对照」的产物。实际后果是把它钉成了「生产源码」——T0.4 遍历基线**全部**条目比对
 *   哈希，于是只要正常用过一次应用（该文件被重写）而源码一行未动，T0.4 就报「生产源码内容
 *   变化」。基线唯一合法来源是「git 追踪的源码 + 本地测试脚手架」，不再向后看；末尾另有
 *   一条防回退断言，拒绝把被 .gitignore 忽略的文件写进基线。
 *
 * 用法：node tests\regenerate-baseline.js   （从任意目录执行均可）
 *   baseline.json 与本脚本同目录、_baseline-rules.js 在仓库根的 tools\ 下，两者都以
 *   __dirname 为锚点解析，不依赖当前工作目录。run-tests.js 同理：基线与 pre/post-state
 *   和 test-results.json 都落在 tests\ 下，因此 e2e 也可从任意目录启动（遗留-31）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// 本脚本位于 <项目根>\tests\，被测应用即其上一级（项目根），旧基线与本脚本同目录。
// 所有路径以 __dirname 为锚点，从任意 cwd 执行结果一致。
const APP = path.resolve(__dirname, '..');
const srcBaseline = path.join(__dirname, 'baseline.json');

// ── 1. 旧基线（可能不存在）
let old = { files: {} };
try {
  old = JSON.parse(fs.readFileSync(srcBaseline, 'utf8'));
  if (!old.files || typeof old.files !== 'object') old = { files: {} };
} catch (e) {
  console.log('（未读到旧基线，按全新生成处理：' + e.message.split('\n')[0] + '）');
}

// ── 2. git 追踪的文件（只取源码类，排除大体积无关资产）
let tracked = [];
try {
  // core.quotepath=false：否则 git 会把非 ASCII 路径转义成 "\345\220\257..." 形式，
  // 与磁盘真实路径对不上，中文名源文件会被漏掉。
  const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'],
    { cwd: APP, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  tracked = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
} catch (e) {
  console.log('git ls-files 失败，退回旧清单：' + e.message.split('\n')[0]);
}

// 允许进入基线的文件由共享规则决定（与 run-tests.js 的 T0.4b 断言同源，
// 避免两处规则漂移导致断言自证）。
const { isSourceFile } = require(path.resolve(__dirname, '..', 'tools', '_baseline-rules.js'));

const wanted = new Set();
for (const rel of tracked) if (isSourceFile(rel)) wanted.add(rel);

// ── 2b. 显式纳入本地测试脚手架 ──
// 为什么要单独写一段：git 只列出**已追踪**的文件，而本地测试套件在新加、尚未提交时不在其中。
// 实测后果：`server/services/__tests__/` 下 17 个套件曾只有 14 个在基线里，
// `securityRegression` / `tokenInject` / `uiElevate` 三个新套件对 T0.4「生产源码未被改动」
// 完全失明。这里按目录显式枚举，新增套件自动被纳入，不依赖它是否已提交。
const LOCAL_SCAFFOLD_DIRS = ['server/services/__tests__'];
const localScaffold = [];
for (const dir of LOCAL_SCAFFOLD_DIRS) {
  const abs = path.join(APP, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs).sort()) {
    if (!/\.test\.js$/.test(f)) continue;
    const rel = dir + '/' + f;
    if (!wanted.has(rel)) { wanted.add(rel); localScaffold.push(rel); }
  }
}

// 旧基线里本轮不再保留的条目（只作提示，不再继承——见文件头说明）。
// 必须在 2b 之后算：本地测试脚手架是新纳入的合法条目，不算「被剔除」。
const droppedFromOld = Object.keys(old.files).filter(rel => !wanted.has(rel));

// ── 3. 逐个算哈希
const files = {};
const missing = [];
const diff = [];
const added = [];

for (const rel of Array.from(wanted).sort()) {
  const p = path.join(APP, rel);
  if (!fs.existsSync(p)) { missing.push(rel); continue; }
  const buf = fs.readFileSync(p);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const size = buf.length;
  files[rel] = { sha256, size };
  const before = old.files[rel];
  if (!before) {
    added.push({ rel, sha: sha256.slice(0, 10), size });
  } else if (before.sha256 !== sha256 || before.size !== size) {
    diff.push({
      rel,
      oldSha: String(before.sha256).slice(0, 10),
      newSha: sha256.slice(0, 10),
      oldSize: before.size,
      newSize: size
    });
  }
}

// ── 4. 防回退断言：基线里不得出现被 .gitignore 忽略的文件 ──
// 运行期产物（data/snapshot.json 这类每次扫描/迁移都被重写的状态文件）都属被忽略之列。
// 一旦它们进了基线，T0.4 就会在「源码一行未动」时误报内容变化。
// 用 `check-ignore` 逐条核对而不是 `ls-files --others --ignored`：后者只看未追踪文件，
// 漏得掉 `git add -f` 强加进索引的忽略文件。
// 必须带 `--no-index`：默认模式下 check-ignore **不报告已追踪文件**（实测 `git add -f` 之后
// 就把忽略规则忘光了，断言形同虚设），加它才按规则本身判定。
// 注意：无任何命中时它以退出码 1 结束，结果在 e.stdout 里。
function gitIgnored(paths) {
  if (!paths.length) return [];
  const parse = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  try {
    return parse(execFileSync('git', ['check-ignore', '--no-index', ...paths],
      { cwd: APP, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  } catch (e) {
    return parse(e.stdout);
  }
}
const ignoredInBaseline = gitIgnored(Object.keys(files));
if (ignoredInBaseline.length) {
  console.error('拒绝写入：下列文件被 .gitignore 忽略，属运行期产物，不得钉进基线\n' +
    '（否则 T0.4 会在源码未改动时误报「生产源码内容变化」）：\n  ' + ignoredInBaseline.join('\n  '));
  process.exit(1);
}

const out = {
  createdAt: new Date().toISOString(),
  regeneratedFrom: srcBaseline,
  sourceOfTruth: 'git ls-files 的源码子集 + 本地测试脚手架（不继承旧基线条目）',
  files
};

fs.writeFileSync(path.join(__dirname, 'baseline.json'), JSON.stringify(out, null, 2), 'utf8');

console.log('已生成 baseline.json，共 ' + Object.keys(files).length + ' 个文件' +
  '（旧基线 ' + Object.keys(old.files).length + ' 个）');
if (droppedFromOld.length) {
  console.log('\n旧基线中不再保留的条目（' + droppedFromOld.length + ' 个，按「不继承」规则剔除）：' +
    droppedFromOld.join(', '));
}
if (localScaffold.length) {
  console.log('\n本次新纳入的本地测试套件（' + localScaffold.length + ' 个）：');
  for (const rel of localScaffold) console.log('  ' + rel);
}
if (added.length) {
  console.log('\n新增条目（' + added.length + ' 个，此前基线遗漏）：');
  for (const a of added) console.log(`  ${a.rel}: ${a.size}B(${a.sha}..)`);
}
if (missing.length) console.log('\n清单中但文件缺失：' + missing.join(', '));
console.log('\n与旧基线内容有变化的文件（' + diff.length + ' 个）：');
for (const d of diff) {
  console.log(`  ${d.rel}: ${d.oldSize}B(${d.oldSha}..) -> ${d.newSize}B(${d.newSha}..)`);
}
