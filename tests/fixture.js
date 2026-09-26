'use strict';
/**
 * fixture.js — 沙箱夹具（测试基础设施，不碰生产源码）
 *
 * 职责：
 *   build   建沙箱：%TEMP%\cc-e2e-<id>\ 下造假应用靶子 + 假垃圾文件
 *   spawn   启动沙箱假进程（用 timeout.exe 副本，纯命令行，不依赖 GUI 会话）
 *   clean   销毁沙箱（只删自己的目录）
 *
 * 红线：所有路径都从 os.tmpdir() 派生，绝不引用生产白名单里的任何真实路径。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const TARGET_NAME = 'cc_test_dummy.exe';

function sandboxDir(id) {
  return path.join(os.tmpdir(), 'cc-e2e-' + (id || 'main'));
}

/**
 * 把靶子 exe 复制到沙箱。timeout.exe / ping.exe 偶发被占用（EBUSY），所以：
 *   1. 多个候选源文件，逐个尝试；
 *   2. 每个源带重试，短暂退避；
 *   3. 已存在且校验通过则直接复用，不重复复制。
 * 只用沙箱内的路径，绝不动源文件。
 */
function copyTarget(exe) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = ['timeout.exe', 'ping.exe'].map(f => path.join(sysRoot, 'System32', f));
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const src of candidates) {
      if (!fs.existsSync(src)) continue;
      try {
        if (fs.existsSync(exe)) fs.unlinkSync(exe);
        fs.copyFileSync(src, exe);
        if (fs.statSync(exe).size > 0) return exe;
      } catch (e) {
        lastErr = e;
        try { execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'],
          { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* 忽略 */ }
      }
    }
    // 退避后重试：被占用的源文件通常几百毫秒后就可用
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 700'],
      { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* 忽略 */ }
  }
  throw new Error('复制靶子 exe 失败（源文件被占用）: ' + (lastErr && lastErr.message));
}

/** 建沙箱：靶子进程文件 + 假垃圾目录（含 3MiB 文件） */
function build(id) {
  const dir = sandboxDir(id);
  const junkRoot = path.join(dir, 'fake-junk');
  const nested = path.join(junkRoot, 'nested');
  fs.mkdirSync(nested, { recursive: true });

  // 靶子可执行文件：从系统 exe 复制改名，绝不占用 node/powershell/cmd 这种通用名
  const exe = path.join(dir, TARGET_NAME);
  copyTarget(exe);

  // 假垃圾：3 个文件共 3 MiB，便于校验 deletedBytes
  const files = [];
  const sizes = [1048576, 1048576, 1048576];
  sizes.forEach((n, i) => {
    const f = path.join(i < 2 ? junkRoot : nested, 'junk_' + i + '.bin');
    fs.writeFileSync(f, Buffer.alloc(n, 0x41));
    files.push({ path: f, bytes: n });
  });
  // 一个只读文件，用来验证 locked_or_denied 分支（可选）
  const locked = path.join(junkRoot, 'locked.bin');
  fs.writeFileSync(locked, Buffer.alloc(1024 * 64, 0x42));
  files.push({ path: locked, bytes: 65536 });

  return { dir, junkRoot, nested, exe, files, totalBytes: 3 * 1048576 + 65536 };
}

/** 启动沙箱假进程。返回 PID（靠 Get-Process 解析，不猜） */
function spawn(id) {
  const dir = sandboxDir(id);
  const exe = path.join(dir, TARGET_NAME);
  if (!fs.existsSync(exe)) throw new Error('靶子不存在，请先 build：' + exe);
  // timeout.exe 副本：给它一个长时限，让它常驻
  // 坑1：start 的第一个引号参数是窗口标题，必须显式给，否则参数错位、进程起不来。
  // 坑2：execFileSync 调 cmd 会一直等 start 返回而 ETIMEDOUT（start 不回）。
  //      所以用 shell:true 的字符串形式，node 不会等它。
  const inner = `start "cc-test" /min "${exe}" /t 900 /nobreak`;
  try {
    execSync(inner, { windowsHide: true, timeout: 6000, stdio: 'ignore' });
  } catch (e) { /* start 已拉起进程；超时属正常 */ }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const pids = list();
    if (pids.length) return pids;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 700'],
      { windowsHide: true, stdio: 'ignore' });
  }
  return [];
}

/** 列出正在运行的靶子 PID（用 Get-Process，避免 tasklist 过滤器的中文本地化与引号问题） */
function list() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Get-Process -Name '${TARGET_NAME.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return out.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number);
  } catch (e) {
    return [];
  }
}

/** 只销毁本夹具的沙箱目录 */
function clean(id) {
  const dir = sandboxDir(id);
  const resolved = path.resolve(dir).toLowerCase();
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  if (!resolved.startsWith(tmp + path.sep)) throw new Error('拒绝删除沙箱外路径: ' + dir);
  if (!path.basename(resolved).startsWith('cc-e2e-')) throw new Error('拒绝删除非夹具目录: ' + dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: dir, stillExists: fs.existsSync(dir) };
}

module.exports = { build, spawn, list, clean, sandboxDir, TARGET_NAME };

if (require.main === module) {
  const action = process.argv[2];
  const id = process.argv[3];
  if (action === 'build') console.log(JSON.stringify(build(id), null, 2));
  else if (action === 'spawn') console.log(JSON.stringify({ pids: spawn(id) }));
  else if (action === 'list') console.log(JSON.stringify({ pids: list() }));
  else if (action === 'clean') console.log(JSON.stringify(clean(id)));
  else console.log('用法: node fixture.js build|spawn|list|clean [id]');
}
