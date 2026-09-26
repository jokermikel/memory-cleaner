'use strict';
/**
 * launcher.js — 真正的启动逻辑（Node 读 UTF-8，不会像 cmd 那样因编码闪退）
 * 由 start.cmd / 启动.bat 调用。不自动弹 UAC，避免窗口被关掉。
 */

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { resolvePort, EXIT_PORT_IN_USE } = require('./lib/ports');

const ROOT = __dirname;
// 端口唯一来源：CC_PORT 环境变量可覆盖，默认值在 lib/ports.js（与 server.js 同源）。
const PORT = resolvePort();
const NODE = process.execPath;
const LOG_FILE = path.join(ROOT, 'launch.log');

function parseReplacePid(argv) {
  const i = argv.indexOf('--replace');
  if (i < 0) return 0;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * 提权后接管：先停掉旧的普通权限服务（含其子进程），再占用端口。
 * Windows 上 process.kill 不会带上子进程，必须用 taskkill /T。
 */
function stopOldInstance(oldPid) {
  if (!oldPid || oldPid === process.pid) return;
  log('[elevate] stopping previous instance pid=' + oldPid);
  try {
    execFileSync('taskkill', ['/PID', String(oldPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
    log('[elevate] previous instance stopped');
  } catch (e) {
    log('[elevate] taskkill: ' + e.message);
  }
}

function log(msg) {
  const line = msg + '\n';
  try { process.stdout.write(line); } catch (e) { }
  try { fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + line, 'utf8'); } catch (e) { }
}

function isAdmin() {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 探测端口是否已有进程在监听。
 *
 * 为什么必须先探测再启动：`waitPort` 只能回答「这个端口有没有人在听」，回答不了
 * 「在听的是不是我们刚起的服务」。端口被别的程序占用时，旧实现会把它当成
 * 「服务已就绪」，然后把浏览器指向别人的服务 —— 用户看到的是一张陌生页面，
 * 而真正的服务早就以 EADDRINUSE 退出了。
 */
function probePort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) { }
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

/** 端口被占用时给用户的可操作提示。 */
function logPortBusyHint() {
  log('[ERROR] 端口 ' + PORT + ' 已被占用，服务无法启动。');
  log('');
  log('  若 Memory Cleaner 已在运行：');
  log('     直接打开 http://127.0.0.1:' + PORT + '/ 使用即可，本窗口可以关闭。');
  log('  若是其它程序占用该端口：');
  log('     先结束该程序，或者换端口启动（命令行执行）：');
  log('       set CC_PORT=8899 && 启动.bat');
  log('');
}

function waitPort(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

function runNode(rel, args) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(ROOT, rel)].concat(args || []), {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: false
    });
    child.on('exit', (code) => resolve(code || 0));
    child.on('error', (err) => {
      log('[ERROR] ' + err.message);
      resolve(1);
    });
  });
}

async function main() {
  try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch (e) { }
  log('');
  log('==========================================');
  log('  Memory Cleaner / Disk Cleaner');
  log('==========================================');
  log('  dir  : ' + ROOT);
  log('  node : ' + NODE);
  log('  admin: ' + (isAdmin() ? 'yes' : 'no (OK, limited scan)'));
  log('');

  process.chdir(ROOT);

  const replacePid = parseReplacePid(process.argv);
  if (replacePid) stopOldInstance(replacePid);

  // 端口预检：放在停止旧实例之后，避免把刚接管的端口误判为被占用。
  if (await probePort(PORT)) {
    logPortBusyHint();
    process.exit(EXIT_PORT_IN_USE);
  }

  log('[1/3] collecting snapshot...');
  const buildCode = await runNode('build.js', []);
  if (buildCode !== 0) {
    const html = path.join(ROOT, '内存清理助手.html');
    if (!fs.existsSync(html)) {
      log('[ERROR] build failed and no previous HTML found.');
      process.exit(1);
    }
    log('[WARN] build failed, using last HTML.');
  }

  log('[2/3] starting server http://127.0.0.1:' + PORT + '/');
  const server = spawn(NODE, [path.join(ROOT, 'server', 'server.js'), String(PORT)], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
    env: Object.assign({}, process.env, { LAUNCHER_PID: String(process.pid) })
  });

  server.on('error', (err) => {
    log('[ERROR] server spawn failed: ' + err.message);
  });

  // 就绪判定不能只看「端口有人在听」——端口被别的程序占用时那是别人的服务。
  // 因此与「server 进程已退出」竞速：谁先到就以谁为准，退出时带上退出码。
  // 只有一个 exit 监听器：就绪之前它负责判失败，就绪之后它负责收尾退出。
  let outcomeSettled = false;
  let serverExitCode = null;
  const exitedEarly = new Promise((resolve) => {
    server.on('exit', (code) => {
      serverExitCode = code == null ? 0 : code;
      log('server stopped, code=' + serverExitCode);
      if (!outcomeSettled) resolve('exit');
      else process.exit(serverExitCode);
    });
  });
  const outcome = await Promise.race([waitPort(PORT, 20000).then(ok => (ok ? 'ready' : 'timeout')), exitedEarly]);
  outcomeSettled = true;

  if (outcome === 'exit' || (outcome === 'ready' && serverExitCode !== null)) {
    if (serverExitCode === EXIT_PORT_IN_USE) {
      logPortBusyHint();
      process.exit(EXIT_PORT_IN_USE);
    }
    log('[ERROR] 服务进程已退出，退出码 ' + serverExitCode + '（详见上方输出与 launch.log）。');
    process.exit(serverExitCode || 1);
  }
  if (outcome === 'timeout') {
    log('[ERROR] 端口 ' + PORT + ' 在 20 秒内没有就绪。');
    log('        可能被其它程序占用、或被防火墙拦截；可执行 netstat -ano | findstr :' + PORT + ' 查看占用者。');
    process.exit(1);
  }

  if (replacePid) {
    log('[3/3] elevated instance ready, keeping current browser tab');
  } else {
    log('[3/3] opening browser...');
    try {
      spawn('cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:' + PORT + '/'], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      }).unref();
    } catch (e) {
      log('[WARN] cannot open browser, visit http://127.0.0.1:' + PORT + '/ yourself');
    }
  }

  log('');
  log('Server running. Close this window to stop.');
  log('');

  const shutdown = () => {
    try { server.kill('SIGTERM'); } catch (e) { }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log('[ERROR] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
