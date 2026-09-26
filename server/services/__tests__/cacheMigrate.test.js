'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = process.cwd();

/**
 * 状态文件隔离（遗留-37）：本套件跑的是**真迁移**（`dryRun:false` 建链接、搬文件），
 * 记录会追加进状态文件；而正式服务读的就是仓库里的 `data/cache-migrations.json`。
 * 不隔离的话，每跑一次测试就往用户界面的「可撤销的迁移记录」里塞几条 `%TEMP%` 沙箱记录，
 * 且这些记录的源目录已随用例清理删掉，点「撤销」只会失败。
 * 必须在 require 服务**之前**设好环境变量——服务在模块加载期就把路径定下了。
 */
const ISOLATED_STATE = path.join(os.tmpdir(), 'cc-mig-state-' + process.pid + '.json');
process.env.CC_MIGRATE_STATE_FILE = ISOLATED_STATE;

const {
  isCriticalPath,
  isSubPath,
  precheck,
  execute,
  inspect,
  walkStats,
  probeSourceLocked,
  loadPresets,
  rollbackMigration,
  listMigrations,
  purgeExpiredBackups
} = require(path.join(ws, 'server/services/cacheMigrateService'));

// 与上面注入的环境变量同一个来源，避免两处路径漂移
const STATE_FILE = process.env.CC_MIGRATE_STATE_FILE;

function makeTree() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-src-'));
  const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-dst-'));
  const dest = path.join(destRoot, 'moved');
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'a.bin'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(src, 'sub', 'b.bin'), Buffer.alloc(1024, 2));
  return { src, destRoot, dest };
}

function cleanupTree(src, destRoot, dest) {
  for (const p of [src, dest, destRoot]) {
    try {
      const info = inspect(p);
      if (info.isLink) {
        try { fs.rmdirSync(p); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }
  try {
    const parent = path.dirname(src);
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(path.basename(src) + '.__ccbak_')) {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
      }
    }
  } catch (e) { /* ignore */ }
}

test('关键目录拒绝：Windows / System32 / Program Files / 用户配置根', () => {
  const sys = process.env.SystemDrive || 'C:';
  assert.strictEqual(isCriticalPath(sys + '\\').critical, true);
  assert.strictEqual(isCriticalPath(sys + '\\Windows').critical, true);
  assert.strictEqual(isCriticalPath(sys + '\\Windows\\System32').critical, true);
  assert.strictEqual(isCriticalPath(sys + '\\Program Files').critical, true);
  assert.strictEqual(isCriticalPath(sys + '\\Users').critical, true);
  assert.strictEqual(isCriticalPath(process.env.USERPROFILE).critical, true);
  assert.strictEqual(isCriticalPath(path.join(os.tmpdir(), 'cc-ok-cache')).critical, false);
});

test('目标位于源内部被拒绝', () => {
  const { src, destRoot } = makeTree();
  try {
    const inner = path.join(src, 'inside');
    const r = precheck(src, inner);
    assert.strictEqual(r.ok, false);
    assert.ok(r.issues.some(i => i.code === 'DEST_INSIDE_SOURCE'));
  } finally {
    cleanupTree(src, destRoot, path.join(destRoot, 'moved'));
  }
});

test('预置清单来自垃圾词典且不含 protected', () => {
  const presets = loadPresets();
  assert.ok(presets.length >= 10);
  assert.ok(presets.every(p => p.risk !== 'protected'));
  assert.ok(presets.some(p => /cache|缓存|Temp|临时/i.test(p.name + p.category + p.id)));
});

test('dry-run 不改目录', async () => {
  const { src, destRoot, dest } = makeTree();
  try {
    const before = walkStats(src);
    const r = await execute({ source: src, destination: dest, dryRun: true });
    assert.strictEqual(r.executed, false);
    assert.strictEqual(r.mode, 'dry-run');
    assert.strictEqual(r.linkType, 'junction');
    assert.ok(fs.existsSync(src));
    assert.strictEqual(fs.existsSync(dest), false);
    assert.deepStrictEqual(walkStats(src), before);
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

test('未确认真实迁移抛 NOT_CONFIRMED', async () => {
  const { src, destRoot, dest } = makeTree();
  try {
    let err = null;
    try { await execute({ source: src, destination: dest, dryRun: false, confirmed: false }); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, 'NOT_CONFIRMED');
    assert.ok(fs.existsSync(src));
    assert.strictEqual(fs.existsSync(dest), false);
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

test('沙箱真实迁移：原路径可写、数据在目标、检查器识别 junction', async () => {
  const { src, destRoot, dest } = makeTree();
  let backupPath = null;
  try {
    const r = await execute({ source: src, destination: dest, dryRun: false, confirmed: true, keepBackupDays: 1 });
    assert.strictEqual(r.executed, true, JSON.stringify(r));
    assert.strictEqual(r.linkType, 'junction');
    assert.strictEqual(r.files, 2);
    backupPath = r.backupPath;
    assert.ok(backupPath && fs.existsSync(backupPath), '备份必须保留');

    const info = inspect(src);
    assert.strictEqual(info.isLink, true);
    assert.strictEqual(info.broken, false);
    assert.ok(info.linkKind === 'junction' || info.linkKind === 'symlink' || info.linkKind === 'reparse', info.linkKind);

    const probe = path.join(src, 'via-link.txt');
    fs.writeFileSync(probe, 'hello-migrate', 'utf8');
    const landed = path.join(dest, 'via-link.txt');
    assert.ok(fs.existsSync(landed), '经原路径写入应落在目标盘');
    assert.strictEqual(fs.readFileSync(landed, 'utf8'), 'hello-migrate');
    assert.ok(fs.existsSync(path.join(dest, 'a.bin')));
    assert.ok(fs.existsSync(path.join(dest, 'sub', 'b.bin')));

    const destInfo = inspect(dest);
    assert.strictEqual(destInfo.isLink, false);
    assert.strictEqual(destInfo.type, 'directory');
  } finally {
    try {
      const info = inspect(src);
      if (info.isLink) fs.rmdirSync(src);
    } catch (e) { /* ignore */ }
    if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(src)) {
      try { fs.renameSync(backupPath, src); } catch (e) { /* ignore */ }
    }
    cleanupTree(src, destRoot, dest);
  }
});

test('目标重名非空时拒绝且源完好', () => {
  const { src, destRoot, dest } = makeTree();
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'keep.txt'), 'no-overwrite');
    const r = precheck(src, dest);
    assert.strictEqual(r.ok, false);
    assert.ok(r.issues.some(i => i.code === 'DEST_EXISTS'));
    assert.ok(fs.existsSync(path.join(src, 'a.bin')));
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

test('检查器：普通目录 vs 断链标记字段存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-insp-'));
  try {
    const info = inspect(dir);
    assert.strictEqual(info.exists, true);
    assert.strictEqual(info.isLink, false);
    assert.strictEqual(info.type, 'directory');
    const missing = inspect(path.join(dir, 'no-such'));
    assert.strictEqual(missing.exists, false);
    assert.strictEqual(missing.type, 'missing');
    assert.ok('broken' in missing);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isSubPath 不把自身当子目录', () => {
  assert.strictEqual(isSubPath('C:\\a\\b', 'C:\\a'), true);
  assert.strictEqual(isSubPath('C:\\a', 'C:\\a'), false);
});

// ───────────────────────────────────────────────────────────────────────────
// D1 回归：预检对关键路径必须「短路」，不得做全量递归遍历
//
// 缺陷现场（2026-09-23 实测）：precheck 只把 CRITICAL_PATH 记进 issues 却不返回，
// 随后仍执行 walkStats(source)。把 C:\Windows 填进源目录时，服务会同步递归遍历
// 数十万文件，事件循环被完全阻塞 —— 期间连 GET /api/health 都不响应，
// 连接堆积为 CLOSE_WAIT，遍历完才自行恢复（约 1~3 分钟）。
//
// 这组断言的要点是**能真的失败**：把 cacheMigrateService.js 换回修复前的版本，
// 下面 1、2、4 三条必须变红。
// ───────────────────────────────────────────────────────────────────────────

const HUGE = (process.env.SystemDrive || 'C:') + '\\Windows';

test('D1-a 关键路径预检立即返回（不得做全量遍历）', () => {
  if (!fs.existsSync(HUGE)) return; // 环境无 Windows 目录则跳过
  const t0 = Date.now();
  const r = precheck(HUGE, path.join(os.tmpdir(), 'cc-d1-dst-' + Date.now()));
  const ms = Date.now() - t0;
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some(i => i.code === 'CRITICAL_PATH'), '应报 CRITICAL_PATH');
  // 修复前：需遍历整棵 Windows 树，通常数十秒；修复后：毫秒级短路返回
  assert.ok(ms < 2000, '关键路径预检应 <2s 返回，实测 ' + ms + 'ms（疑似回归成全量遍历）');
});

test('D1-b walkStats 有耗时上限，超限置 truncated 并停止', () => {
  if (!fs.existsSync(HUGE)) return;
  const t0 = Date.now();
  const st = walkStats(HUGE, { maxMs: 150 });
  const ms = Date.now() - t0;
  assert.strictEqual(st.truncated, true, '超限必须置 truncated=true');
  assert.ok(ms < 3000, '限时遍历不得超时太久，实测 ' + ms + 'ms');
});

test('D1-c 小目录统计不受影响（防误伤正常路径）', () => {
  const { src, destRoot, dest } = makeTree();
  try {
    const st = walkStats(src);
    assert.strictEqual(st.files, 2);
    assert.strictEqual(st.truncated, false, '小目录不应被判定为截断');

    const r = precheck(src, dest);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stats.files, 2);
    assert.strictEqual(r.stats.truncated, false);
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

test('D1-d 源码核对：重量级统计被「无阻断问题」守卫，且有上限与提示', () => {
  const src = fs.readFileSync(
    path.join(ws, 'server/services/cacheMigrateService.js'), 'utf8');
  // 阶段 2 必须守在 issues.length === 0 之内
  assert.ok(
    /if \(issues\.length === 0\) \{[\s\S]{0,500}walkStats\(source\)/.test(src),
    'walkStats(source) 必须处于 issues.length === 0 守卫之内');
  // 自查 walkStats 本体不受守卫影响（它自身仍需保留遍历能力）
  assert.ok(/function walkStats\(/.test(src), 'walkStats 必须仍然存在');
  // 上限常量与超限提示必须在位
  assert.ok(/WALK_MAX_MS\s*=\s*\d+/.test(src), '必须定义耗时上限 WALK_MAX_MS');
  assert.ok(/WALK_MAX_FILES\s*=\s*\d+/.test(src), '必须定义文件数上限 WALK_MAX_FILES');
  assert.ok(/SOURCE_TOO_LARGE/.test(src), '大目录必须给出 SOURCE_TOO_LARGE 提示');
});

// ───────────────────────────────────────────────────────────────────────────
// D5 / D3 / D4 回归：迁移复制必须异步、回滚必须清理、失败必须留痕
//
// 缺陷现场（2026-09-24 真机实测）：
//   copyDir() 优先走同步 fs.cpSync —— 复制 45MB/270 文件的目录时**完全阻塞事件循环**，
//   服务对任何请求都不响应，浏览器端表现为「迁移失败: Failed to fetch」（而非服务端错误码）。
//   同时暴露两个次生问题：
//     D3：rb.destCopied 只在复制「完全成功」后置位 → 复制中途失败时回滚跳过清理 → 残留 36 文件
//     D4：进程若在复制期间被结束，日志中没有任何痕迹（连 START 都没写）
//
// 这组断言的要点是**能真的失败**：换回修复前的实现，D5-a / D3 / D4 必须变红。
// ───────────────────────────────────────────────────────────────────────────

const MIGRATE_SRC = path.join(ws, 'server/services/cacheMigrateService.js');
/** 去掉注释行，避免注释里出现的关键字造成假通过 */
function codeOf(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

test('D5-a 复制必须异步实现，不得使用同步 fs.cpSync', () => {
  const code = codeOf(MIGRATE_SRC);
  assert.ok(!/fs\.cpSync\s*\(/.test(code),
    '不得使用同步 fs.cpSync —— 复制期间会阻塞事件循环，服务无法响应任何请求');
  assert.ok(/async function copyDir/.test(code), 'copyDir 必须是 async 函数');
  assert.ok(/fs\.promises\.cp|execFile\(/.test(code),
    '应使用异步复制（fs.promises.cp 或异步 execFile 调 robocopy）');
});

test('D5-b 复制期间事件循环保持可调度（行为级）', async () => {
  const { src, destRoot, dest } = makeTree();
  try {
    // 放大文件数，让复制有足够耗时以观测事件循环是否被让出
    for (let i = 0; i < 400; i++) {
      fs.writeFileSync(path.join(src, 'f' + i + '.bin'), Buffer.alloc(2048, i % 256));
    }
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 2);
    const t0 = Date.now();
    await execute({ source: src, destination: dest, dryRun: false, confirmed: true, keepBackupDays: 1 });
    const dt = Date.now() - t0;
    clearInterval(timer);
    // 同步实现下整个复制期间事件循环被独占，定时器一次都不会触发
    assert.ok(ticks >= 1,
      '复制期间事件循环被阻塞，定时器一次都未触发（复制耗时 ' + dt + 'ms, ticks=' + ticks + '）');
  } finally {
    try {
      const info = inspect(src);
      if (info.isLink) fs.rmdirSync(src);
    } catch (e) { /* ignore */ }
    cleanupTree(src, destRoot, dest);
  }
});

test('D3 destCopied 必须在开始复制之前置位（否则中途失败不回滚目标盘）', () => {
  const code = codeOf(MIGRATE_SRC);
  const iSet = code.indexOf('rb.destCopied = true;');
  const iCopy = code.indexOf('await copyDir(check.source, check.destination);');
  assert.ok(iSet > 0, '必须存在 rb.destCopied = true');
  assert.ok(iCopy > 0, '必须存在 await copyDir(...)');
  assert.ok(iSet < iCopy,
    'destCopied 必须先于 copyDir 置位，否则「复制中途失败」时回滚会跳过目标盘清理（D3）');
});

test('D4 复制前必须落一条 MIGRATE-START 审计（防进程中途结束无痕）', () => {
  const code = codeOf(MIGRATE_SRC);
  assert.ok(/audit\(`MIGRATE-START/.test(code),
    '复制前必须写 MIGRATE-START 审计，否则进程在复制期间被结束时日志完全无痕（D4）');
});

// ───────────────────────────────────────────────────────────────────────────
// 撤销迁移（rollbackMigration）—— 正规回滚通道 + rolledBack 记录标记
//
// 背景：此前的「回滚」只有两条路径：
//   ① 迁移执行失败时的自动 rollback(state)（内存态）
//   ② 人工脚本（无记录标记，事后无法区分「已回滚」与「仍在迁移状态」）
// 本次补齐服务端能力与持久化标记，并守住最关键的安全约束。
// ───────────────────────────────────────────────────────────────────────────

test('撤销迁移：完整走通（迁移 → 撤销 → 记录标记 rolledBack）', async () => {
  const { src, destRoot, dest } = makeTree();
  let backupPath = null;
  try {
    // 先做一次真实迁移
    const mig = await execute({
      source: src, destination: dest, dryRun: false, confirmed: true, keepBackupDays: 1
    });
    assert.strictEqual(mig.executed, true, JSON.stringify(mig));
    backupPath = mig.backupPath;
    assert.strictEqual(inspect(src).isLink, true, '迁移后原路径应为链接');

    // 再撤销
    const rb = await rollbackMigration(src);
    assert.strictEqual(rb.ok, true, JSON.stringify(rb));
    assert.ok(rb.restoredFiles > 0, '应有文件被搬回');
    assert.strictEqual(rb.rolledBackAt ? true : false, true, '应返回 rolledBackAt');

    // 原路径恢复为普通目录
    const info = inspect(src);
    assert.strictEqual(info.exists, true);
    assert.strictEqual(info.isLink, false, '撤销后原路径不应再是链接');
    assert.strictEqual(info.type, 'directory');

    // 数据搬回（与迁移前一致）
    const after = walkStats(src);
    assert.strictEqual(after.files, 2, '原路径应恢复 2 个文件');
    assert.ok(fs.existsSync(path.join(src, 'a.bin')));
    assert.ok(fs.existsSync(path.join(src, 'sub', 'b.bin')));

    // 记录已打标
    const st = listMigrations();
    const rec = (st.records || []).find(r => r.source === src && r.rolledBack);
    assert.ok(rec, '迁移记录应带有 rolledBack=true');
    assert.ok(rec.rolledBackAt, '应写入 rolledBackAt');
    assert.strictEqual(rec.rollbackFiles, after.files);
  } finally {
    try {
      const info = inspect(src);
      if (info.isLink) fs.rmdirSync(src);
    } catch (e) { /* ignore */ }
    if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(src)) {
      try { fs.renameSync(backupPath, src); } catch (e) { /* ignore */ }
    }
    cleanupTree(src, destRoot, dest);
  }
});

test('撤销迁移：非迁移状态的路径被拒绝（不得误删普通目录）', async () => {
  const { src, destRoot, dest } = makeTree();
  try {
    let err = null;
    try { await rollbackMigration(src); } catch (e) { err = e; }
    assert.ok(err, '对普通目录调用撤销应当报错');
    // 可能先命中 NOT_MIGRATED（无记录）或 NOT_A_LINK（有记录但非链接）
    assert.ok(err.code === 'NOT_MIGRATED' || err.code === 'NOT_A_LINK',
      '错误码应为 NOT_MIGRATED 或 NOT_A_LINK，实际 ' + err.code);
    // 关键：原目录必须完好无损
    assert.ok(fs.existsSync(path.join(src, 'a.bin')), '拒绝后原目录内容必须完好');
    assert.strictEqual(inspect(src).isLink, false);
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

test('撤销迁移：源码核对 —— 删链接只用 rmdir，绝不递归删除；且必须写 rolledBack', () => {
  const code = codeOf(MIGRATE_SRC);
  const start = code.indexOf('async function rollbackMigration');
  const end = code.indexOf('function purgeExpiredBackups');
  assert.ok(start > 0 && end > start, '应存在 rollbackMigration 函数');
  const seg = code.slice(start, end);

  assert.ok(/fs\.rmdirSync\(source\)/.test(seg),
    '删除目录链接必须使用 fs.rmdirSync（非递归）');
  // 递归删除 source 有删掉「链接目标」的风险，是最高危写法
  assert.ok(!/rmSync\(\s*source/.test(seg) && !/rm\(\s*source/.test(seg),
    '绝不可对源路径使用递归删除（rmSync/rm）—— 会删掉链接目标');
  assert.ok(/rolledBack\s*=\s*true/.test(seg), '必须写入 rolledBack 标记');
  assert.ok(/rolledBackAt/.test(seg), '必须写入 rolledBackAt 时间戳');
  assert.ok(/restored\.files !== before\.files/.test(seg),
    '搬回后必须校验文件数一致性');
});

// ═══════ D6：迁移预检占用抽样探测（2026-09-24）═══════

test('D6-a 正常目录预检：探测通过且带抽样元数据', () => {
  const { src, destRoot, dest } = makeTree();
  try {
    const r = precheck(src, dest);
    assert.strictEqual(r.ok, true, '正常目录应通过预检');
    assert.ok(r.probe, '预检结果必须带 probe 字段');
    assert.strictEqual(r.probe.dirReadable, true);
    assert.ok(r.probe.sampled > 0, '应实际试读了文件');
    assert.strictEqual(r.probe.locked.length, 0, '正常目录不应有被锁文件');
    assert.ok(r.probe.at && r.probe.note, '必须标注抽样时刻与「基于当前时刻」说明');
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

test('D6-b 被锁文件在预检阶段即暴露 SOURCE_LOCKED（不等到复制）', () => {
  const { src, destRoot, dest } = makeTree();
  try {
    // 注入 openFile：对 a.bin 抛 EBUSY，模拟驱动/日志独占锁
    const r = precheck(src, dest, {
      probe: {
        openFile: (p) => {
          if (path.basename(p) === 'a.bin') {
            const e = new Error('EBUSY: resource busy or locked');
            e.code = 'EBUSY';
            throw e;
          }
        }
      }
    });
    assert.strictEqual(r.ok, false, '被锁时预检必须不通过');
    const issue = r.issues.find(i => i.code === 'SOURCE_LOCKED');
    assert.ok(issue, '必须返回 SOURCE_LOCKED issue，实际: ' + JSON.stringify(r.issues.map(i => i.code)));
    assert.ok(issue.lockedFiles.length === 1 && /a\.bin$/.test(issue.lockedFiles[0].path),
      '应列出被锁文件路径');
    assert.ok(/退出|关闭/.test(issue.message), '必须给出可操作建议（退出/关闭占用程序）');
    assert.ok(/抽样|当前时刻/.test(issue.message), '必须标注结论基于抽样');
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

test('D6-c 源码核对：预检接探测、执行期翻译 EBUSY、抽样有上限', () => {
  const code = codeOf(MIGRATE_SRC);

  // ① precheck 必须调用占用探测
  assert.ok(/probeSourceLocked\(source/.test(code),
    'precheck 必须调用 probeSourceLocked');
  assert.ok(/SOURCE_LOCKED/.test(code) && /SOURCE_UNREADABLE/.test(code),
    '必须区分「个别文件被锁」与「整目录不可读」');
  // ② 探测必须有界（防止探测本身阻塞服务，与 D1 同类风险）
  assert.ok(/PROBE_WALK_MS\s*=\s*\d+/.test(code), '抽样遍历必须有耗时上限 PROBE_WALK_MS');
  assert.ok(/PROBE_WALK_FILES\s*=\s*\d+/.test(code), '抽样候选必须有数量上限 PROBE_WALK_FILES');
  assert.ok(/PROBE_OPEN_MAX\s*=\s*\d+/.test(code), '试读文件数必须有上限 PROBE_OPEN_MAX');
  assert.ok(/PROBE_OPEN_MS\s*=\s*\d+/.test(code), '试读阶段必须有耗时上限 PROBE_OPEN_MS');
  // ③ 只读打开（不得用 r+ / w 探测 —— 会改动用户数据）
  const segStart = code.indexOf('function defaultOpenFile');
  const segEnd = code.indexOf('function driveFreeBytes');
  assert.ok(segStart > 0 && segEnd > segStart, '应存在 defaultOpenFile 与 driveFreeBytes');
  const probeSeg = code.slice(segStart, segEnd);
  assert.ok(/openSync\(\s*p\s*,\s*'r'\s*\)/.test(probeSeg),
    '探测必须以只读方式打开（r），绝不可写');
  // ④ 执行期 EBUSY/EPERM 必须翻译成可操作建议
  assert.ok(/e\.code === 'EBUSY' \|\| e\.code === 'EPERM'/.test(code),
    '执行期必须捕获 EBUSY/EPERM 并给出建议');
  assert.ok(/SOURCE_LOCKED/.test(code), '执行期占用错误应归入 SOURCE_LOCKED');
  // ⑤ COPY_MISMATCH 必须附带建议
  const mm = code.slice(code.indexOf('COPY_MISMATCH'), code.indexOf('COPY_MISMATCH') + 600);
  assert.ok(/关闭占用|重新预检/.test(mm), 'COPY_MISMATCH 必须附可操作建议');
});

test('D6-d probeSourceLocked 行为级：候选有界、锁定被记录、正常文件通过', () => {
  const { src, destRoot, dest } = makeTree();
  try {
    // 极小上限 → 截断生效
    const bounded = probeSourceLocked(src, { walkFiles: 1 });
    assert.ok(bounded.candidates <= 1, '候选收集不得超过 walkFiles 上限');
    assert.strictEqual(bounded.truncated, true, '达到上限必须置 truncated');

    // 正常打开
    const normal = probeSourceLocked(src);
    assert.strictEqual(normal.dirReadable, true);
    assert.ok(normal.sampled > 0 && normal.ok === normal.sampled,
      '无锁时试读应全部成功');
    assert.strictEqual(normal.locked.length, 0);

    // 注入锁
    const locked = probeSourceLocked(src, {
      openFile: () => { const e = new Error('locked'); e.code = 'EBUSY'; throw e; }
    });
    assert.strictEqual(locked.sampled, locked.locked.length, '注入锁后全部计入 locked');
    assert.strictEqual(locked.ok, 0);
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

// ═══════ 预置目录筛选：仅满足全部硬条件且实际可迁移才可选（2026-09-24）═══════

const { assessPresets } = require(path.join(ws, 'server/services/cacheMigrateService'));

function presetItem(id, p, extra) {
  return Object.assign({ id, name: id, paths: [p], risk: 'safe' }, extra || {});
}

test('筛选-a 正常用户缓存目录 → 可选（migratable=true）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-assess-ok-'));
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(512, 1));
  try {
    const r = await assessPresets({ items: [presetItem('ok', dir)] });
    assert.strictEqual(r.migratableCount, 1, '正常目录应可选：' + JSON.stringify(r.items[0].blockers));
    assert.strictEqual(r.items[0].migratable, true);
    assert.strictEqual(r.items[0].blockers.length, 0);
    assert.ok(r.items[0].assessedAt, '必须带评估时刻');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('筛选-b 系统关键路径 / 系统树 / 系统保留目录 / 不存在 / 已是链接 → 禁用', async () => {
  const sys = process.env.SystemDrive || 'C:';
  const mk = async (id, p) => (await assessPresets({ items: [presetItem(id, p)] })).items[0];

  // H2 关键路径
  const crit = await mk('crit', sys + '\\Windows');
  assert.strictEqual(crit.migratable, false);
  assert.strictEqual(crit.blockers[0].code, 'CRITICAL_PATH');

  // H3 系统树（系统组件会持续写入的目录，例如 C:/Windows/Logs）
  const logs = await mk('win-logs', sys + '\\Windows\\Logs');
  assert.strictEqual(logs.migratable, false);
  assert.strictEqual(logs.blockers[0].code, 'SYSTEM_MANAGED');
  const sw = await mk('win-update', sys + '\\Windows\\SoftwareDistribution\\Download');
  assert.strictEqual(sw.blockers[0].code, 'SYSTEM_MANAGED');

  // H3 系统保留目录名
  const rb = await mk('recycle', sys + '\\$Recycle.Bin');
  assert.strictEqual(rb.blockers[0].code, 'SYSTEM_MANAGED');

  // H1 不存在
  const miss = await mk('missing', path.join(os.tmpdir(), 'cc-assess-nope-' + Date.now()));
  assert.strictEqual(miss.blockers[0].code, 'SOURCE_NOT_EXIST');

  // H4 已是链接（junction）
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-assess-lk-src-'));
  const dstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-assess-lk-dst-'));
  const link = path.join(dstRoot, 'lk');
  const { execFileSync } = require('child_process');
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, src], { windowsHide: true });
    const lk = await mk('linked', link);
    assert.strictEqual(lk.blockers[0].code, 'SOURCE_IS_LINK');
  } finally {
    try { fs.rmdirSync(link); } catch (e) { /* ignore */ }
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dstRoot, { recursive: true, force: true });
  }
});

test('筛选-c 抽样试读被锁（EBUSY）→ 禁用 SOURCE_LOCKED（实际可迁移性判定）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-assess-lock-'));
  fs.writeFileSync(path.join(dir, 'held.bin'), Buffer.alloc(256, 2));
  try {
    const r = await assessPresets({
      items: [presetItem('locked', dir)],
      probe: {
        openFile: () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
      }
    });
    assert.strictEqual(r.items[0].migratable, false);
    assert.strictEqual(r.items[0].blockers[0].code, 'SOURCE_LOCKED');
    assert.ok(/占用/.test(r.items[0].blockers[0].message), '必须提示占用与退出程序');
    assert.strictEqual(r.blockedCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('筛选-d 预算耗尽未检测 → 禁用 NOT_ASSESSED（宁可少选不可错选）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-assess-budget-'));
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(64, 3));
  try {
    // budgetMs=0 + openFile 永不完成：抽样必在预算内未完成 → 稳定 NOT_ASSESSED
    const r = await assessPresets({
      items: [presetItem('budget', dir)],
      budgetMs: 0,
      probe: { openFile: () => new Promise(() => { /* 永挂起，模拟检测卡住 */ }) }
    });
    assert.strictEqual(r.items[0].migratable, false);
    assert.strictEqual(r.items[0].blockers[0].code, 'NOT_ASSESSED');
    assert.strictEqual(r.budgetMs, 0, '响应必须回传预算以便排查');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('筛选-e 源码核对：前端禁用展示 + 服务端硬条件齐全', () => {
  const svc = codeOf(MIGRATE_SRC);
  // 服务端六条硬条件
  assert.ok(/SOURCE_NOT_EXIST/.test(svc), 'H1 存在性');
  assert.ok(/CRITICAL_PATH/.test(svc), 'H2 关键路径');
  assert.ok(/SYSTEM_MANAGED/.test(svc), 'H3 系统树/保留目录');
  assert.ok(/SOURCE_IS_LINK/.test(svc), 'H4 已是链接');
  assert.ok(/probeSourceLockedAsync\(/.test(svc), 'H5 必须真试读（异步抽样）');
  assert.ok(/fs\.promises\.open\(\s*p\s*,\s*'r'\s*\)/.test(svc), '异步抽样必须只读打开（r）');
  assert.ok(/NOT_ASSESSED/.test(svc), 'H6 未检测禁用');
  assert.ok(/ASSESS_BUDGET_MS\s*=\s*\d+/.test(svc), '评估必须有共享预算上限');
  assert.ok(/\$recycle\.bin/.test(svc), '系统保留目录黑名单');

  // 前端：不可迁移必须 disabled 展示且带原因，可选的才进 optgroup「可迁移」
  const html = require('fs').readFileSync(path.join(ws, '_template.html'), 'utf8');
  assert.ok(/migratable/.test(html), '前端必须消费 migratable 字段');
  assert.ok(/disabled/.test(html) && /⛔/.test(html), '不可迁移项必须禁用并标记 ⛔');
  assert.ok(/reasonOf|blockers/.test(html), '禁用项必须展示原因');
  assert.ok(/assessPresets|\/api\/disk\/migrate\/presets/.test(html), '必须走评估接口');

  // 路由：presets 必须返回评估结果而非原始清单
  const route = require('fs').readFileSync(path.join(ws, 'server/routes/memory.js'), 'utf8');
  assert.ok(/assessPresets\(\)/.test(route), '路由必须调用 assessPresets');
});

// ═══════ 短期-9：过期备份清理（动作后 + 定时兜底）═══════
//
// 缺陷背景：purgeExpiredBackups 原先只在服务启动时调用一次。本工具是「开着不动」
// 的常驻用法，开数周也不会再清 —— 备份目录与状态记录只增不减。
// 修复：① 每次真正动过迁移记录（execute / rollbackMigration）后顺带清一次；
//       ② 服务端每 6 小时定时兜底。
//
// 下面第一条是行为级断言（真的建备份目录、真的删到位），第二条核对接线。
// 与 securityRegression M-02 同样先备份真实状态文件、finally 还原。
// ═══════════════════════════════════════════════════════════════════════

test('S9-a 清理过期备份：删目录去记录，未过期与格式不符的记录保留', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-purge-'));
  const oldBak = path.join(root, 'src-old.__ccbak_20200101000000__');
  const newBak = path.join(root, 'src-new.__ccbak_20990101000000__');
  const goneBak = path.join(root, 'src-gone.__ccbak_20200101000000__');
  const badBak = path.join(root, 'not-a-backup-name');
  for (const d of [oldBak, newBak, badBak]) {
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'x.bin'), Buffer.alloc(32, 9));
  }

  const stateExisted = fs.existsSync(STATE_FILE);
  const original = stateExisted ? fs.readFileSync(STATE_FILE, 'utf8') : null;
  const now = Date.now();
  const past = new Date(now - 86400000).toISOString();
  const future = new Date(now + 86400000).toISOString();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      records: [
        { source: root + '\\old', backupPath: oldBak, expireAt: past },
        { source: root + '\\new', backupPath: newBak, expireAt: future },
        { source: root + '\\bad', backupPath: badBak, expireAt: past },
        { source: root + '\\gone', backupPath: goneBak, expireAt: past }
      ]
    }, null, 2), 'utf8');

    const r = purgeExpiredBackups(now);

    // 过期且在册的备份目录必须真删掉
    assert.strictEqual(fs.existsSync(oldBak), false, '过期备份目录必须被删除');
    assert.strictEqual(fs.existsSync(newBak), true, '未过期备份目录不得被删');
    assert.strictEqual(fs.existsSync(badBak), true, '格式不符的备份路径不得被删');

    // 记录处理：过期的移出 kept，未过期的原样保留
    const keptSources = r.kept.map(x => x.source);
    assert.ok(!keptSources.includes(root + '\\old'), '已清理的记录不得留在 kept');
    assert.ok(keptSources.includes(root + '\\new'), '未过期记录必须保留');
    assert.ok(r.purged.some(x => x.source === root + '\\old' && x.purged === true),
      '过期记录必须带 purged 标记');
    // 备份目录已不存在 → 视为 alreadyGone，同样移出 kept（否则记录永远清不掉）
    assert.ok(r.purged.some(x => x.source === root + '\\gone' && x.alreadyGone === true),
      '目录已消失的过期记录应标记 alreadyGone');
    const bad = r.kept.find(x => x.source === root + '\\bad');
    assert.strictEqual(bad && bad.purgeSkipped, 'backup_path_format_mismatch',
      '备份名格式不符必须留痕而不是照删');
  } finally {
    if (stateExisted) fs.writeFileSync(STATE_FILE, original, 'utf8');
    else fs.rmSync(STATE_FILE, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('S9-b 源码核对：清理已接线到动作后与服务端定时', () => {
  const svc = codeOf(MIGRATE_SRC);

  // ① 动作后清理函数存在，且失败不得反噬已成功的迁移/回滚（必须 try/catch）
  const segStart = svc.indexOf('function purgeAfterAction');
  assert.ok(segStart > 0, '必须存在 purgeAfterAction');
  const seg = svc.slice(segStart, svc.indexOf('function purgeExpiredBackups', segStart));
  assert.ok(/try \{/.test(seg) && /catch/.test(seg),
    'purgeAfterAction 必须自行吞掉异常，不得让清理失败影响迁移结果');

  // ② execute 成功分支与 rollbackMigration 都必须调用它
  const execSeg = svc.slice(svc.indexOf('async function executeUnlocked'), svc.indexOf('function inspect('));
  assert.ok(/purgeAfterAction\(\)/.test(execSeg), 'execute 成功后必须顺带清理');
  const rbSeg = svc.slice(svc.lastIndexOf('async function rollbackMigration'), svc.indexOf('function purgeAfterAction'));
  assert.ok(/withMigrationLock\(src,/.test(rbSeg),
    'rollbackMigration 必须继续以源路径为键加锁（曾经漏传 src，导致撤销整体失效）');
  assert.ok(/purgeAfterAction\(\)/.test(rbSeg), 'rollbackMigration 后必须顺带清理');

  // ③ 服务端定时兜底：6 小时一次，且必须 unref（不得因定时器吊住进程退出）
  const server = require('fs').readFileSync(path.join(ws, 'server/server.js'), 'utf8');
  assert.ok(/purgeExpiredBackupsQuietly/.test(server), 'server.js 必须有静默清理封装');
  assert.ok(/setInterval\([\s\S]{0,200}purgeExpiredBackupsQuietly[\s\S]{0,80}\.unref\(\)/.test(server),
    '定时清理必须挂在 unref 的 interval 上');
  assert.ok(/PURGE_INTERVAL_MS\s*=\s*[\d\s*]+/.test(server), '定时周期应为显式常量');
});

// 本套件结束后删掉隔离出来的状态文件（含写盘时用的 .tmp-* 中间件），不给 %TEMP% 留垃圾。
// 顺带守住「隔离确实生效」：若哪天有人把注入去掉，这里仍会删仓库里的真实记录文件——所以
// 下面这条断言才是关键，它保证 STATE_FILE 永远不是 `data\cache-migrations.json`。
test.after(() => {
  assert.notStrictEqual(path.resolve(STATE_FILE), path.resolve(path.join(ws, 'data', 'cache-migrations.json')),
    '隔离失效：状态文件又指回仓库里的真实迁移记录了');
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (name.startsWith(path.basename(ISOLATED_STATE))) {
      fs.rmSync(path.join(os.tmpdir(), name), { force: true });
    }
  }
});
