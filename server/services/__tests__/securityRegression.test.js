'use strict';

/**
 * 修复后安全边界回归测试：M-01 ~ M-05。
 * 所有文件操作限定在临时沙箱；状态文件测试结束后必须恢复。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ws = process.cwd();
const stateFile = path.join(ws, 'data', 'cache-migrations.json');
const disk = require(path.join(ws, 'server/services/diskCleanupService'));
const migrate = require(path.join(ws, 'server/services/cacheMigrateService'));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function removeTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { }
}
function preset(id, dir) {
  return { id, name: id, paths: [dir], risk: 'safe' };
}

// M-01：根目录是 junction 时，删除操作必须拒绝且不得触碰目标。
test('M-01 junction 根目录拒绝清理且链接目标保持不变', async () => {
  const target = tmpDir('cc-reg-target-');
  const holder = tmpDir('cc-reg-link-');
  const link = path.join(holder, 'link');
  const secret = path.join(target, 'secret.txt');
  fs.writeFileSync(secret, 'must-stay', 'utf8');
  try {
    try {
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { windowsHide: true });
    } catch (e) {
      test.skip('当前环境无法创建 junction：' + e.message);
      return;
    }
    const result = await disk.deleteContents(link);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'reparse_point_refused');
    assert.equal(fs.readFileSync(secret, 'utf8'), 'must-stay');
  } finally {
    try { fs.rmdirSync(link); } catch (_) { }
    removeTree(holder);
    removeTree(target);
  }
});

// M-02：同一源路径的迁移必须串行，第二个请求不能进入文件操作。
test('M-02 同源并发迁移返回 MIGRATION_BUSY', async () => {
  const source = tmpDir('cc-reg-mig-src-');
  const destination = path.join(tmpDir('cc-reg-mig-dst-'), 'moved');
  fs.writeFileSync(path.join(source, 'a.bin'), Buffer.alloc(64, 1));
  try {
    const first = migrate.execute({ source, destination, dryRun: true });
    await assert.rejects(
      () => migrate.execute({ source, destination, dryRun: true }),
      e => e && e.code === 'MIGRATION_BUSY'
    );
    await first;
  } finally {
    removeTree(source);
    removeTree(path.dirname(destination));
  }
});

// M-02/M-08：损坏状态不得静默变成空记录。
test('M-02/M-08 损坏迁移状态返回 STATE_CORRUPTED', () => {
  // 迁移记录含本机路径、不随仓库分发，所以在干净机器/CI 上该文件可能根本不存在
  const existed = fs.existsSync(stateFile);
  const original = existed ? fs.readFileSync(stateFile) : null;
  try {
    fs.writeFileSync(stateFile, '{broken-json', 'utf8');
    assert.throws(() => migrate.listMigrations(), e => e && e.code === 'STATE_CORRUPTED');
  } finally {
    if (existed) fs.writeFileSync(stateFile, original);
    else fs.rmSync(stateFile, { force: true });
  }
});

// M-03：源码回归断言，无法验证启动时间时必须 fail-closed。
test('M-03 PowerShell PID 校验无法验证时 fail-closed', () => {
  const files = ['server/collectors/cleanup.ps1', 'server/collectors/trimWorkingSet.ps1'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ws, rel), 'utf8');
    assert.match(src, /verificationFailed\s*=\s*\$true/);
    assert.match(src, /start_time_unverified/);
    assert.match(src, /if \(\$reuse\.verificationFailed\)/);
    assert.doesNotMatch(src, /return \@\{ reused = \$false; verified = \$false \}/);
  }
});

// M-04：主要动态应用/进程字段必须经过 escapeHtml。
test('M-04 主要前端动态字段经过统一 HTML 转义', () => {
  const html = fs.readFileSync(path.join(ws, '_template.html'), 'utf8');
  assert.match(html, /function escapeHtml\(/);
  for (const field of ['a.name', 'a.purpose', 'a.category', 'a.vendor', 'a.riskReason', 'p.name', 'p.path']) {
    assert.ok(html.includes('escapeHtml(' + field + ')'), field + ' 未统一转义');
  }
});

// M-05：评估互斥和超时取消；不等待永不结束的 probe。
test('M-05 预置评估并发互斥且超时后释放锁', async () => {
  const dir = tmpDir('cc-reg-assess-');
  fs.writeFileSync(path.join(dir, 'a.bin'), 'x', 'utf8');
  try {
    const first = migrate.assessPresets({
      items: [preset('cancel', dir)],
      budgetMs: 10,
      probe: { openFile: () => new Promise(() => {}) }
    });
    await assert.rejects(
      () => migrate.assessPresets({ items: [preset('busy', dir)], budgetMs: 10 }),
      e => e && e.code === 'ASSESS_BUSY'
    );
    const result = await first;
    assert.equal(result.items[0].migratable, false);
    assert.equal(result.items[0].blockers[0].code, 'NOT_ASSESSED');

    const after = await migrate.assessPresets({ items: [preset('after', dir)], budgetMs: 500 });
    assert.equal(after.items.length, 1);
  } finally {
    removeTree(dir);
  }
});
