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

const ROOT = __dirname;
const PORT = 7788;
const NODE = process.execPath;
const LOG_FILE = path.join(ROOT, 'launch.log');

function parseReplacePid(argv) {
  const i = argv.indexOf('--replace');
  if (i < 0) return 0;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * 提权后接管：先停掉旧的普通权限服务（含其子进程），再占用 7788。
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

  const ready = await waitPort(PORT, 20000);
  if (!ready) {
    log('[ERROR] port ' + PORT + ' not listening in 20s.');
    log('        close other app using 7788, then retry.');
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

  server.on('exit', (code) => {
    log('server stopped, code=' + code);
    process.exit(code || 0);
  });
}

main().catch((e) => {
  log('[ERROR] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
