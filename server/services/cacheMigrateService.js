'use strict';
/**
 * cacheMigrateService.js — 缓存目录迁移（复制 + 目录链接）
 *
 * 默认创建 junction（mklink /J，本地卷、无需管理员）。
 * 用户显式 linkType=symlink 时才用符号链接（mklink /D，需管理员或开发者模式）。
 *
 * 流程：预检 → 复制并校验 → 原目录改名为备份 → 原位置建链接 → 探针验证 → 失败回滚。
 * 原数据不得丢失。占用中途失败必须回滚，不得半迁移退出。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');

const WS = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(WS, 'logs');
const STATE_FILE = path.join(WS, 'data', 'cache-migrations.json');
const DEFAULT_KEEP_DAYS = 7;

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
}

function audit(line) {
  ensureDir(LOG_DIR);
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const file = path.join(LOG_DIR, `cache-migrate-${ymd}.log`);
  try { fs.appendFileSync(file, `[${d.toISOString()}] ${line}\n`, 'utf8'); } catch (e) { /* ignore */ }
  return file;
}

function expand(p) {
  return String(p || '').replace(/%([^%]+)%/g, (_, name) => process.env[name] || ('%' + name + '%'));
}

function normalize(p) {
  return path.resolve(expand(p)).toLowerCase();
}

function isSubPath(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  if (c === p) return false;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function systemDrive() {
  return (process.env.SystemDrive || 'C:').replace(/\\+$/, '');
}

function userProfile() {
  return process.env.USERPROFILE || os.homedir();
}

function criticalExact() {
  const sys = systemDrive();
  const list = [
    sys + '\\',
    sys + '\\Windows',
    sys + '\\Windows\\System32',
    sys + '\\Windows\\SysWOW64',
    sys + '\\Windows\\WinSxS',
    sys + '\\Program Files',
    sys + '\\Program Files (x86)',
    sys + '\\Users',
    sys + '\\ProgramData',
    userProfile()
  ];
  return new Set(list.map(normalize));
}

function criticalPrefixes() {
  const sys = systemDrive();
  return [
    sys + '\\Windows\\System32\\',
    sys + '\\Windows\\SysWOW64\\',
    sys + '\\Windows\\WinSxS\\',
    sys + '\\Windows\\System32\\config\\'
  ].map(p => path.resolve(p).toLowerCase());
}

function isCriticalPath(p) {
  const n = normalize(p);
  const parts = n.split(path.sep).filter(Boolean);
  if (parts.length <= 1) return { critical: true, reason: '拒绝迁移盘符根目录' };
  if (criticalExact().has(n)) return { critical: true, reason: '拒绝迁移系统关键目录（Windows / System32 / Program Files / 用户配置根等）' };
  for (const pre of criticalPrefixes()) {
    if (n === pre.replace(/\\+$/, '') || n.startsWith(pre)) {
      return { critical: true, reason: '拒绝迁移系统关键目录（System32 / WinSxS / 配置库）' };
    }
  }
  return { critical: false, reason: null };
}

/**
 * 遍历上限（缺陷 D1 修复）：
 *   walkStats 是**同步**递归遍历。若目录规模过大（例如误把 C:\Windows 当成源），
 *   会长时间阻塞 Node 的事件循环 —— 期间服务对任何请求（含毫秒级的 /api/health）
 *   都不响应，连接堆积成 CLOSE_WAIT。
 *   故加「耗时 + 文件数」双上限，任一超限即停止遍历并置 truncated=true，
 *   由调用方（precheck）给出明确提示，而不是让整个服务假死。
 */
const WALK_MAX_MS = 3000;        // 单次遍历耗时上限（毫秒）
const WALK_MAX_FILES = 200000;   // 文件数兜底上限

function walkStats(root, limits = {}) {
  const maxMs = limits.maxMs != null ? limits.maxMs : WALK_MAX_MS;
  const maxFiles = limits.maxFiles != null ? limits.maxFiles : WALK_MAX_FILES;
  const deadline = Date.now() + maxMs;
  let files = 0;
  let bytes = 0;
  let dirs = 0;
  let truncated = false;

  /** 已超限？（truncated 一旦置位，后续所有循环立即退出） */
  const overLimit = () => truncated || files >= maxFiles || Date.now() > deadline;

  function walk(p) {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      if (overLimit()) { truncated = true; return; }
      if (e.name === '.' || e.name === '..') continue;
      const full = path.join(p, e.name);
      let st;
      try { st = fs.lstatSync(full); } catch (err) { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        dirs += 1;
        walk(full);
      } else if (st.isFile()) {
        files += 1;
        bytes += st.size;
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return { files, bytes, dirs, truncated };
}

function driveLetterOf(p) {
  const m = String(path.resolve(p)).match(/^([A-Za-z]:)/);
  return m ? m[1].toUpperCase() : null;
}

function driveFreeBytes(letter) {
  if (!letter) return 0;
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}'").FreeSpace`
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return 0;
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { records: [] };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { records: [] };
  }
}

function saveState(state) {
  ensureDir(path.dirname(STATE_FILE));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function loadPresets() {
  const dictPath = path.join(WS, 'data', 'junkDict.zh.json');
  const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
  const items = [];
  for (const e of dict.entries || []) {
    if (e.risk === 'protected') continue;
    const paths = (e.paths || []).map(expand);
    items.push({
      id: e.id,
      name: e.name,
      purpose: e.purpose,
      category: e.category,
      risk: e.risk,
      vendor: e.vendor,
      paths,
      note: e.note || ''
    });
  }
  return items;
}

function inspectPath(targetPath) {
  const expanded = path.resolve(expand(targetPath));
  const result = {
    path: expanded,
    exists: false,
    type: 'missing',
    isLink: false,
    linkKind: null,
    target: null,
    broken: false,
    attributes: null
  };
  if (!fs.existsSync(expanded) && !linkExists(expanded)) {
    return result;
  }
  let st;
  try { st = fs.lstatSync(expanded); } catch (e) {
    result.exists = false;
    result.type = 'missing';
    return result;
  }
  result.exists = true;
  result.attributes = st;
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$p = '" + expanded.replace(/'/g, "''") + "'",
    '$i = Get-Item -LiteralPath $p -Force',
    'if (-not $i) { \'MISSING\'; exit 0 }',
    '$reparse = [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint)',
    '$kind = [string]$i.LinkType',
    '$tgt = $null',
    'if ($i.Target) { if ($i.Target -is [array]) { $tgt = [string]$i.Target[0] } else { $tgt = [string]$i.Target } }',
    'if (-not $tgt -and $reparse) { try { $tgt = [string](Get-Item -LiteralPath $p).Target } catch {} }',
    '"$reparse|$kind|$tgt"'
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 15000
    }).replace(/^\uFEFF/, '').trim();
    if (out === 'MISSING') {
      result.exists = false;
      result.type = 'missing';
      return result;
    }
    const parts = out.split('|');
    const reparse = String(parts[0]).toLowerCase() === 'true';
    const kind = (parts[1] || '').trim();
    const tgt = (parts.slice(2).join('|') || '').trim() || null;
    if (reparse) {
      result.isLink = true;
      result.linkKind = /junction/i.test(kind) ? 'junction'
        : /symbolic/i.test(kind) ? 'symlink'
        : (st.isSymbolicLink() ? 'symlink' : 'reparse');
      result.target = tgt;
      result.type = result.linkKind;
      if (tgt) {
        const dest = path.isAbsolute(tgt) ? tgt : path.resolve(path.dirname(expanded), tgt);
        result.broken = !fs.existsSync(dest);
      } else {
        result.broken = true;
      }
      return result;
    }
  } catch (e) {
    if (st.isSymbolicLink()) {
      result.isLink = true;
      result.linkKind = 'symlink';
      result.type = 'symlink';
      try { result.target = fs.readlinkSync(expanded); } catch (err) { result.target = null; }
      result.broken = !(result.target && fs.existsSync(result.target));
      return result;
    }
  }
  result.type = st.isDirectory() ? 'directory' : (st.isFile() ? 'file' : 'other');
  result.isLink = false;
  return result;
}

function linkExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function createLink(linkPath, destPath, linkType) {
  const type = linkType === 'symlink' ? 'symlink' : 'junction';
  const flag = type === 'symlink' ? '/D' : '/J';
  try {
    const out = execFileSync('cmd.exe', ['/c', 'mklink', flag, linkPath, destPath], {
      encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    return { ok: true, type, output: String(out || '').trim() };
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().slice(0, 300);
    return { ok: false, type, error: msg || 'mklink_failed' };
  }
}

function removeLink(linkPath) {
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isDirectory()) {
      fs.rmdirSync(linkPath);
      return true;
    }
  } catch (e) { /* ignore */ }
  try {
    execFileSync('cmd.exe', ['/c', 'rmdir', linkPath], { windowsHide: true, timeout: 15000 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 异步复制目录（缺陷 D5 修复，2026-09-24）。
 *
 * 原实现优先走同步 `fs.cpSync`：遍历与复制期间**完全阻塞 Node 事件循环**，
 * 服务对任何请求都不响应 —— 真机实测表现为浏览器端「迁移失败: Failed to fetch」，
 * 且该分支**没有任何超时保护**（下方 robocopy 的 timeout 形同虚设）。
 * 与已修复的 D1（预检同步递归遍历卡死服务）属同一类问题。
 *
 * 现改为异步：
 *   ① 首选 fs.promises.cp —— 复制期间事件循环仍可调度，服务保持可响应；
 *   ② 回退用异步 execFile 调 robocopy，并显式 /R:0 /W:0，
 *      避免在被占用文件上长时间重试等待（原为 /R:1 /W:1）。
 */
async function copyDir(src, dest) {
  ensureDir(path.dirname(dest));
  if (fs.promises && typeof fs.promises.cp === 'function') {
    await fs.promises.cp(src, dest, { recursive: true, errorOnExist: false, force: true });
    return { ok: true, method: 'promises.cp' };
  }
  await new Promise((resolve, reject) => {
    execFile('robocopy.exe',
      [src, dest, '/E', '/COPY:DAT', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
      { windowsHide: true, timeout: 600000 },
      (err) => {
        if (!err) return resolve();
        // robocopy 退出码 0~7 属成功/可接受（>=8 才是真失败）
        const code = err.code;
        if (typeof code === 'number' && code >= 0 && code < 8) return resolve();
        reject(err);
      });
  });
  return { ok: true, method: 'robocopy' };
}

function probeLink(linkPath, destPath) {
  const name = '.cc_migrate_probe_' + Date.now();
  const viaLink = path.join(linkPath, name);
  const viaDest = path.join(destPath, name);
  try {
    fs.writeFileSync(viaLink, 'probe', 'utf8');
    const landed = fs.existsSync(viaDest);
    try { fs.unlinkSync(viaDest); } catch (e) { /* ignore */ }
    try { if (fs.existsSync(viaLink)) fs.unlinkSync(viaLink); } catch (e) { /* ignore */ }
    return landed;
  } catch (e) {
    try { if (fs.existsSync(viaDest)) fs.unlinkSync(viaDest); } catch (err) { /* ignore */ }
    return false;
  }
}

function precheck(src, dest, opts = {}) {
  const issues = [];
  const source = path.resolve(expand(src));
  const destination = path.resolve(expand(dest));
  // ── 阶段 1：轻量检查（只看路径与元数据，不做递归遍历）──
  // 以下任一条件成立即说明「迁移不可能进行」，无需再付出重量级统计的代价。
  const srcCrit = isCriticalPath(source);
  if (srcCrit.critical) issues.push({ code: 'CRITICAL_PATH', message: srcCrit.reason, path: source });
  const destCrit = isCriticalPath(destination);
  if (destCrit.critical) issues.push({ code: 'CRITICAL_PATH', message: destCrit.reason, path: destination });

  if (!fs.existsSync(source)) {
    issues.push({ code: 'SOURCE_MISSING', message: '源目录不存在', path: source });
  } else {
    const st = fs.lstatSync(source);
    if (st.isSymbolicLink()) {
      issues.push({ code: 'SOURCE_IS_LINK', message: '源路径已经是链接，拒绝重复迁移', path: source });
    } else if (!st.isDirectory()) {
      issues.push({ code: 'SOURCE_NOT_DIR', message: '源路径不是目录', path: source });
    }
  }

  if (normalize(source) === normalize(destination)) {
    issues.push({ code: 'SAME_PATH', message: '目标路径不能与源路径相同' });
  }
  if (isSubPath(destination, source)) {
    issues.push({ code: 'DEST_INSIDE_SOURCE', message: '目标路径不能位于源目录内部' });
  }
  if (isSubPath(source, destination)) {
    issues.push({ code: 'SOURCE_INSIDE_DEST', message: '源路径不能位于目标目录内部' });
  }

  const linkType = opts.linkType === 'symlink' ? 'symlink' : 'junction';
  if (linkType === 'junction') {
    const srcVol = driveLetterOf(source);
    const dstVol = driveLetterOf(destination);
    if (!srcVol || !dstVol) {
      issues.push({ code: 'VOLUME_UNKNOWN', message: '无法识别盘符，junction 仅限本地卷' });
    }
  }

  // ── 阶段 2：仅在阶段 1 无任何阻断问题时，才做重量级统计 ──
  // 缺陷 D1 修复（2026-09-23）：
  //   原实现**无条件**执行 `walkStats(source)`。于是即便已判定 CRITICAL_PATH
  //   （例如用户把 C:\Windows 填进源目录），仍会对整棵目录树做同步递归遍历，
  //   数十秒至数分钟内阻塞事件循环，使服务对任何请求（含 /api/health）都不响应。
  //   现在：已判死的输入直接返回；确实需要统计时也受 walkStats 的上限保护。
  let stats = { files: 0, bytes: 0, dirs: 0, truncated: false };
  let free = 0;
  const destDrive = driveLetterOf(destination);

  if (issues.length === 0) {
    stats = walkStats(source);
    if (stats.truncated) {
      // 统计不完整 → 空间判断不可靠，直接要求用户改选更具体的目录
      issues.push({
        code: 'SOURCE_TOO_LARGE',
        message: '源目录规模过大（已扫描 ' + stats.files + ' 个文件 / 约 '
          + Math.ceil(stats.bytes / 1048576) + ' MB 后停止统计）。'
          + '请改选具体的缓存子目录，不要选整盘或整个系统目录。'
      });
    } else {
      free = driveFreeBytes(destDrive);
      if (stats.bytes > 0 && free > 0 && free < stats.bytes + 10 * 1024 * 1024) {
        issues.push({
          code: 'DISK_FULL',
          message: '目标盘剩余空间不足（需要约 ' + Math.ceil(stats.bytes / 1048576) + ' MB，剩余 ' + Math.floor(free / 1048576) + ' MB）'
        });
      }
      if (fs.existsSync(destination)) {
        const destStats = walkStats(destination);
        if (destStats.files > 0 || destStats.dirs > 0) {
          issues.push({ code: 'DEST_EXISTS', message: '目标目录已存在且非空，拒绝覆盖', path: destination });
        }
      }
    }
  }

  const occupiedHint = '请先关闭正在占用该目录的程序。若迁移中途遇到文件占用，会自动回滚，原数据不会丢。';

  return {
    ok: issues.length === 0,
    source,
    destination,
    linkType,
    stats,
    destFreeBytes: free,
    destDrive,
    issues,
    occupiedHint,
    keepBackupDays: opts.keepBackupDays != null ? Number(opts.keepBackupDays) : DEFAULT_KEEP_DAYS
  };
}

async function rollback(state) {
  const notes = [];
  if (state.linkCreated && state.source) {
    try {
      if (linkExists(state.source)) removeLink(state.source);
      notes.push('removed_link');
    } catch (e) {
      notes.push('remove_link_failed');
    }
  }
  if (state.backupPath && fs.existsSync(state.backupPath) && !fs.existsSync(state.source)) {
    try {
      fs.renameSync(state.backupPath, state.source);
      notes.push('restored_backup');
    } catch (e) {
      notes.push('restore_backup_failed:' + e.message);
    }
  }
  if (state.destCopied && state.destination && fs.existsSync(state.destination) && !state.keepDestOnRollback) {
    try {
      // 异步删除：删除大目录时同步 rmSync 同样会阻塞事件循环（与 D5 同类问题）
      await fs.promises.rm(state.destination, { recursive: true, force: true });
      notes.push('removed_dest_copy');
    } catch (e) {
      notes.push('remove_dest_failed:' + e.message);
    }
  }
  return notes;
}

async function execute(opts = {}) {
  const dryRun = opts.dryRun !== false;
  const check = precheck(opts.source, opts.destination, opts);
  if (!check.ok) {
    audit(`REJECTED ${check.issues.map(i => i.code).join(',')}: ${check.source} -> ${check.destination}`);
    const err = fail(check.issues[0].code, check.issues.map(i => i.message).join('；'), { issues: check.issues, check });
    throw err;
  }

  const plan = {
    mode: 'dry-run',
    action: 'cache-migrate',
    source: check.source,
    destination: check.destination,
    linkType: check.linkType,
    estimatedBytes: check.stats.bytes,
    fileCount: check.stats.files,
    dirCount: check.stats.dirs,
    destFreeBytes: check.destFreeBytes,
    occupiedHint: check.occupiedHint,
    keepBackupDays: check.keepBackupDays,
    steps: [
      '预检权限、空间、关键目录、目标不在源内部',
      '复制目录到目标盘并校验文件数量/大小',
      '原目录改名为备份（不直接删除）',
      '在原位置创建 ' + (check.linkType === 'symlink' ? '符号链接 (mklink /D)' : '目录联接 (mklink /J)'),
      '经原路径写入探针文件，确认实际落在目标盘',
      '成功后保留备份 ' + check.keepBackupDays + ' 天；失败自动回滚'
    ]
  };

  if (dryRun) {
    audit(`DRY-RUN ${check.source} -> ${check.destination} (${check.stats.files} files, ${(check.stats.bytes / 1048576).toFixed(1)}MB)`);
    return { ...plan, executed: false };
  }

  if (!opts.confirmed) {
    throw fail('NOT_CONFIRMED', '未确认：真实迁移必须传 confirmed=true');
  }

  const rb = {
    source: check.source,
    destination: check.destination,
    backupPath: null,
    destCopied: false,
    linkCreated: false
  };

  // 缺陷 D4 补充加固：复制**开始前**先落一条 START 审计。
  // 原实现只在成功(EXECUTED) 或异常进 catch(ROLLBACK) 时写日志；若进程在复制期间被结束，
  // 日志中将完全无痕（真机实测正是如此）。留一条 START 即可判定「开始了但没结束」。
  audit(`MIGRATE-START ${check.source} -> ${check.destination} ` +
    `(${check.stats.files} files, ${(check.stats.bytes / 1048576).toFixed(1)}MB)`);

  try {
    // 缺陷 D3 修复：**开始复制之前**就置位 destCopied。
    // 原实现只在复制「完全成功」后才置位，于是「复制中途失败」时目标盘已残留部分文件，
    // 回滚却因 destCopied=false 而跳过清理（真机实测残留 36 文件 / 21.21MB）。
    rb.destCopied = true;
    await copyDir(check.source, check.destination);
    const afterCopy = walkStats(check.destination);
    if (afterCopy.files !== check.stats.files || afterCopy.bytes !== check.stats.bytes) {
      throw fail('COPY_MISMATCH',
        '复制后校验失败：源 ' + check.stats.files + ' 个文件 / ' + check.stats.bytes +
        ' 字节，目标 ' + afterCopy.files + ' 个文件 / ' + afterCopy.bytes + ' 字节');
    }

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const backupPath = check.source + '.__ccbak_' + stamp + '__';
    try {
      fs.renameSync(check.source, backupPath);
    } catch (e) {
      throw fail('SOURCE_IN_USE', '原目录被占用，无法改名备份。请关闭占用该目录的程序后重试。原始错误：' + e.message);
    }
    rb.backupPath = backupPath;

    const linked = createLink(check.source, check.destination, check.linkType);
    if (!linked.ok) {
      throw fail('LINK_FAILED', '创建目录链接失败：' + linked.error + '。junction 无需管理员；符号链接需要管理员或开发者模式');
    }
    rb.linkCreated = true;

    const info = inspectPath(check.source);
    if (!info.isLink) {
      throw fail('LINK_NOT_DETECTED', '链接创建后未能识别为 junction/symlink');
    }
    if (!probeLink(check.source, check.destination)) {
      throw fail('PROBE_FAILED', '经原路径写入测试文件后，未在目标盘找到该文件，已回滚');
    }

    const rec = {
      source: check.source,
      destination: check.destination,
      backupPath,
      linkType: check.linkType,
      migratedAt: new Date().toISOString(),
      expireAt: new Date(Date.now() + check.keepBackupDays * 86400000).toISOString(),
      files: check.stats.files,
      bytes: check.stats.bytes
    };
    const state = loadState();
    state.records = Array.isArray(state.records) ? state.records : [];
    state.records.push(rec);
    saveState(state);

    audit(`EXECUTED ${check.source} -> ${check.destination} via ${check.linkType}; backup ${backupPath}`);
    return {
      mode: 'executed',
      action: 'cache-migrate',
      executed: true,
      source: check.source,
      destination: check.destination,
      backupPath,
      linkType: check.linkType,
      files: check.stats.files,
      bytes: check.stats.bytes,
      inspect: info,
      keepBackupDays: check.keepBackupDays,
      expireAt: rec.expireAt,
      message: '迁移成功。程序仍写原路径，数据已落在目标盘。备份将保留 ' + check.keepBackupDays + ' 天。'
    };
  } catch (e) {
    const notes = await rollback(rb);
    audit(`ROLLBACK ${check.source}: ${e.code || ''} ${e.message}; ${notes.join(',')}`);
    if (e.code) throw e;
    throw fail('MIGRATE_FAILED', '迁移失败并已回滚：' + e.message, { rollback: notes });
  }
}

function inspect(targetPath) {
  return inspectPath(targetPath);
}

function listMigrations() {
  return loadState();
}

function purgeExpiredBackups(nowMs) {
  const now = nowMs || Date.now();
  const state = loadState();
  const kept = [];
  const purged = [];
  for (const rec of state.records || []) {
    const exp = rec.expireAt ? new Date(rec.expireAt).getTime() : 0;
    if (exp && exp <= now && rec.backupPath && fs.existsSync(rec.backupPath)) {
      try {
        fs.rmSync(rec.backupPath, { recursive: true, force: true });
        purged.push({ ...rec, purged: true });
      } catch (e) {
        kept.push({ ...rec, purgeError: e.message });
      }
    } else if (exp && exp <= now) {
      purged.push({ ...rec, purged: true, alreadyGone: true });
    } else {
      kept.push(rec);
    }
  }
  state.records = kept;
  saveState(state);
  if (purged.length) audit(`PURGE ${purged.length} expired backups`);
  return { purged, kept };
}

module.exports = {
  precheck,
  execute,
  inspect,
  inspectPath,
  loadPresets,
  listMigrations,
  purgeExpiredBackups,
  isCriticalPath,
  walkStats,
  isSubPath,
  DEFAULT_KEEP_DAYS
};
