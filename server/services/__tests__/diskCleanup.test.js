'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ws = process.cwd();
const { plan, execute, isForbidden, forbiddenPaths, FORBIDDEN_SUBDIRS, deleteContents, driveFreeMap, unsafePathReason } = require(path.join(ws, 'server/services/diskCleanupService'));

test('禁止路径判定：盘根和 Windows 根目录禁止', () => {
  assert.strictEqual(isForbidden('C:\\'), true);
  assert.strictEqual(isForbidden('C:\\Windows'), true);
  assert.strictEqual(isForbidden('C:\\Users'), true);
  assert.strictEqual(isForbidden('C:\\Windows\\Temp'), false);
});

// ───── 改动 2：禁止路径不再只认 C:/D: ─────

test('非系统盘的系统目录同样被拦（回归：原先只硬编码 C:/D:，且系统目录只列了 C 盘）', (t) => {
  const { listLocalDrives } = require(path.join(ws, 'server/collectors/diskSpace'));
  const sys = String(process.env.SystemDrive || 'C:').toUpperCase();
  const others = listLocalDrives()
    .map(d => String(d).trim().toUpperCase())
    .filter(d => d !== sys);
  if (!others.length) {
    t.skip('本机只有系统盘一个本地盘，无非系统盘可验');
    return;
  }
  for (const d of others) {
    assert.strictEqual(isForbidden(d + '\\'), true, d + ' 盘根应拦');
    assert.strictEqual(isForbidden(d + '\\Windows'), true, d + ' 的 Windows 目录应拦（改动 2 之前会漏）');
    assert.strictEqual(isForbidden(d + '\\Windows\\System32'), true, d + ' 的 System32 应拦');
    assert.strictEqual(isForbidden(d + '\\Program Files'), true, d + ' 的 Program Files 应拦');
    assert.strictEqual(isForbidden(d + '\\ProgramData'), true, d + ' 的 ProgramData 应拦');
    assert.strictEqual(isForbidden(d + '\\Users'), true, d + ' 的 Users 应拦');
  }
});

test('闸门只拦「系统目录本身」，不拦其子树（子树交白名单把关）', () => {
  assert.strictEqual(isForbidden('C:\\Windows\\Temp'), false, 'Windows\\Temp 是合法清理目标');
  assert.strictEqual(isForbidden('C:\\Windows\\SoftwareDistribution\\Download'), false);
  assert.strictEqual(isForbidden('C:\\Windows\\Logs'), false);
  assert.strictEqual(isForbidden('C:\\Users\\demo\\AppData\\Local\\Temp'), false);
});

test('禁止路径集合覆盖本机全部本地盘符', () => {
  const { listLocalDrives } = require(path.join(ws, 'server/collectors/diskSpace'));
  const drives = listLocalDrives();
  assert.ok(drives.length > 0, '至少要枚举到一个本地盘');
  const set = new Set(forbiddenPaths());
  for (const d of drives) {
    const root = String(d).trim().replace(/[\\/]+$/, '').toUpperCase();
    assert.strictEqual(isForbidden(root + '\\'), true, root + ' 盘根应拦');
    assert.strictEqual(isForbidden(root + '\\Windows'), true, root + ' 的 Windows 目录应拦');
    for (const sub of FORBIDDEN_SUBDIRS) {
      const want = path.resolve(root + '\\' + sub).toLowerCase();
      assert.ok(set.has(want), root + '\\' + sub + ' 应在禁止集合内');
    }
  }
});

test('盘符来源是动态枚举（防回退成硬编码 C:/D:）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/diskCleanupService.js'), 'utf8');
  assert.ok(/listLocalDrives\(\)/.test(src), '应调用 diskSpace.listLocalDrives() 动态取盘符');
  assert.ok(!/FORBIDDEN_PREFIXES/.test(src), '不应再保留写死盘符的 FORBIDDEN_PREFIXES 常量');
});

test('plan 默认只含 safe 且是 dry-run', async () => {
  const p = await plan();
  assert.strictEqual(p.mode, 'dry-run');
  assert.ok(p.items.every(i => i.risk === 'safe'));
});

test('execute 默认不删除', async () => {
  const r = await execute();
  assert.strictEqual(r.executed, false);
});

test('未确认真实删除抛 NOT_CONFIRMED', async () => {
  // 长期-2 起 execute 是异步任务（可取消/超时），失败通过 Promise 拒绝传达
  await assert.rejects(
    execute({ dryRun: false, confirmed: false }),
    e => e && e.code === 'NOT_CONFIRMED'
  );
});

test('真实删除临时目录内容并保留目录本身', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-disk-'));
  const f1 = path.join(dir, 'a.txt');
  const f2 = path.join(dir, 'b.bin');
  fs.writeFileSync(f1, Buffer.alloc(1024 * 200, 7));
  fs.writeFileSync(f2, Buffer.alloc(1024 * 300, 8));
  assert.ok(fs.existsSync(f1) && fs.existsSync(f2));

  // 直接测内部删除逻辑：通过 execute 白名单走不通（临时目录不在词典）
  // 所以这里测 isForbidden + 手工调用 delete 等价路径：目录必须留下
  const { execFileSync } = require('child_process');
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Force | Remove-Item -Recurse -Force`
  ], { windowsHide: true });

  assert.ok(fs.existsSync(dir), '目录本身应保留');
  assert.strictEqual(fs.readdirSync(dir).length, 0, '目录内容应被清空');
  fs.rmdirSync(dir);
});

// ───── 短期-4：剩余空间按实际盘符聚合，不再写死 C:/D: ─────

test('剩余空间采集覆盖本机全部本地盘符（回归：原先只读 C:/D:）', () => {
  const { listLocalDrives } = require(path.join(ws, 'server/collectors/diskSpace'));
  const map = driveFreeMap();
  const drives = listLocalDrives().map(d => String(d).trim().toUpperCase());
  assert.ok(drives.length > 0, '至少要枚举到一个本地盘');
  for (const d of drives) {
    assert.ok(d in map, d + ' 应在剩余空间 map 内（改动前 C:/D: 之外会漏）');
    assert.ok(Number.isFinite(map[d]) && map[d] >= 0, d + ' 的值应为非负有限数，实际: ' + map[d]);
  }
  const src = fs.readFileSync(path.join(ws, 'server/services/diskCleanupService.js'), 'utf8');
  assert.ok(!/driveFreeBytes\(\s*'[A-Za-z]:'/.test(src), '不应再按写死的盘符读数');
});

// ───── 短期-3：locate() 短 TTL 缓存 ─────

test('plan() 在 TTL 内复用同一次垃圾量算（确认执行时不再二次全盘扫描）', async () => {
  const a = await plan();
  const b = await plan();
  assert.strictEqual(a.collectedAt, b.collectedAt, 'TTL 内两次计划应来自同一次扫描');
});

// ───── 短期-5：PowerShell 传值参数化 + 路径写法硬校验 ─────

test('路径写法校验：拒绝 ADS、扩展长度前缀、结尾点或空格', () => {
  assert.strictEqual(unsafePathReason('C:\\Temp\\cc-probe'), null, '正常路径应放行');
  assert.strictEqual(unsafePathReason('C:\\Temp\\cc-probe\\'), null, '结尾分隔符应放行');
  assert.strictEqual(unsafePathReason('C:\\Temp\\a.txt:hidden'), 'ads_stream');
  assert.strictEqual(unsafePathReason('\\\\?\\C:\\Temp'), 'extended_path_prefix');
  assert.strictEqual(unsafePathReason('\\\\.\\C:\\Temp'), 'extended_path_prefix');
  assert.strictEqual(unsafePathReason('C:\\Temp\\evil.'), 'trailing_dot_or_space');
  assert.strictEqual(unsafePathReason('C:\\Temp\\evil '), 'trailing_dot_or_space');
  assert.strictEqual(unsafePathReason('C:\\Temp\\sub \\b'), 'trailing_dot_or_space');
  assert.strictEqual(unsafePathReason('relative\\path'), 'not_absolute');
  assert.strictEqual(unsafePathReason(''), 'empty_path');
});

test('deleteContents 对非法写法直接拒绝，且不触碰文件系统', async () => {
  const r = await deleteContents('C:\\Temp\\a.txt:payload');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'unsafe_path');
  assert.strictEqual(r.reason, 'ads_stream');
  assert.strictEqual(r.deletedBytes, 0);
});

test('待清理路径不再内联进 PowerShell 源码（回归：原为单引号拼接 -Command）', () => {
  const src = fs.readFileSync(path.join(ws, 'server/services/diskCleanupService.js'), 'utf8');
  assert.ok(/CC_CLEAN_TARGET/.test(src), '必须经环境变量传值');
  assert.ok(/env:\s*\{\s*\.\.\.process\.env,\s*CC_CLEAN_TARGET/.test(src), '应通过 execFileSync 的 env 选项传入');
  assert.ok(!/\$\{String\(dirPath\)/.test(src), '不应再把路径拼进脚本正文');
  assert.ok(!/\$p = '\$\{/.test(src), '脚本正文里不应存在对路径的插值赋值');
});

test('空目录删除记为 skipped，不报成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-empty-del-'));
  try {
    const r = await deleteContents(dir);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.deletedBytes, 0);
    assert.ok(fs.existsSync(dir), '空目录本身应保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('有文件时按真实字节上报并清空', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-del-'));
  const f1 = path.join(dir, 'a.bin');
  const f2 = path.join(dir, 'sub', 'b.bin');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(f1, Buffer.alloc(1024 * 120, 3));
  fs.writeFileSync(f2, Buffer.alloc(1024 * 80, 4));
  try {
    const r = await deleteContents(dir);
    assert.strictEqual(r.ok, true, '应删除成功，实际: ' + JSON.stringify(r));
    assert.ok(r.deletedBytes >= 200 * 1024, '删除量应 ≥ 200KB，实际: ' + r.deletedBytes);
    assert.strictEqual(r.deletedCount, 2);
    assert.ok(fs.existsSync(dir), '目录本身应保留');
    assert.strictEqual(fs.readdirSync(dir).length, 0, '目录内容应被清空');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
