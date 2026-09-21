'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = process.cwd();
const {
  isCriticalPath,
  isSubPath,
  precheck,
  execute,
  inspect,
  walkStats,
  loadPresets
} = require(path.join(ws, 'server/services/cacheMigrateService'));

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

test('dry-run 不改目录', () => {
  const { src, destRoot, dest } = makeTree();
  try {
    const before = walkStats(src);
    const r = execute({ source: src, destination: dest, dryRun: true });
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

test('未确认真实迁移抛 NOT_CONFIRMED', () => {
  const { src, destRoot, dest } = makeTree();
  try {
    let err = null;
    try { execute({ source: src, destination: dest, dryRun: false, confirmed: false }); } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, 'NOT_CONFIRMED');
    assert.ok(fs.existsSync(src));
    assert.strictEqual(fs.existsSync(dest), false);
  } finally {
    cleanupTree(src, destRoot, dest);
  }
});

test('沙箱真实迁移：原路径可写、数据在目标、检查器识别 junction', () => {
  const { src, destRoot, dest } = makeTree();
  let backupPath = null;
  try {
    const r = execute({ source: src, destination: dest, dryRun: false, confirmed: true, keepBackupDays: 1 });
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
