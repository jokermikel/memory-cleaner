'use strict';
/**
 * server.js — HTTP 服务入口
 * 零依赖（Node 内置 http）。挂载内存查询接口 + 全部写接口
 * （cleanup/execute、disk/cleanup/execute、disk/migrate/execute、privilege/elevate 等）。
 * 启动：node server.js [端口]，默认 7788
 *
 * ── 访问控制（三层，见 checkRequestAuth）──
 *   1. Host 必须指向环回地址（127.0.0.1 / localhost / ::1）
 *   2. 带 Origin 的跨源请求必须与本服务同源同端口
 *   3. token 校验：写操作（POST 等）**以及一切非豁免的只读接口**都要带
 *      本进程启动时生成的一次性 token；只有 CHEAP_READ_PATHS 里那些毫秒级、
 *      无副作用的接口可以免令牌（默认严格 + 白名单豁免，新增接口自动受保护）
 *   另：带请求体的写操作必须是 application/json（绕开浏览器「简单请求」免预检通道）
 *
 * 说明：token 内嵌在首页 HTML 里下发。外部网页受同源策略限制读不到首页，
 * 因此拿不到 token —— 这是**抬高门槛**，不是绝对隔离；本机程序仍可通过
 * 读取本地文件或首页获得 token。强隔离需要改用命名管道等进程间通道。
 */

const http = require('http');
const crypto = require('crypto');
const { handleMemoryRoutes } = require('./routes/memory');

const PORT = Number(process.argv[2]) || 7788;

/** 一次性访问 token（每次启动重新生成，不落盘） */
const ACCESS_TOKEN = crypto.randomBytes(32).toString('hex');

/** 首页 HTML 里等待被替换的占位符（与 _template.html 中的写法一致） */
const TOKEN_PLACEHOLDER = '__CC_TOKEN_VALUE__';

/** 环回主机名白名单 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 视为「有副作用」的方法，必须带 token */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 需要令牌的接口范围 —— 采用「默认严格 + 白名单豁免」：
 *
 * 除下面这些**毫秒级、无副作用**的只读接口外，所有 `/api/*` 都要求令牌
 * （包括未知路径与将来新增的接口，自动受保护，不会漏）。
 *
 * 为什么连读接口也要令牌：昂贵的只读接口会真的跑 PowerShell 采集或全盘 robocopy 扫描
 * （`/api/disk/snapshot` 与 `/api/disk/apps` 各需 30~60 秒）。恶意页面用
 * `<img src="http://127.0.0.1:7788/api/disk/snapshot">` 就能反复触发——
 * img 请求不带 Origin，常规来源校验挡不住，但它们**一定带不上自定义请求头**，
 * 所以令牌是这条路径上唯一有效的闸门。
 */
const CHEAP_READ_PATHS = new Set([
  '/api/health',                  // 端口探活（launcher 依赖）
  '/api/cleanup/io',              // 磁盘吞吐采样，毫秒级
  '/api/disk/volumes',            // 分区容量（Win32_LogicalDisk），毫秒级
  '/api/disk/migrate/presets',    // 静态预设列表
  '/api/disk/migrate/inspect',    // 单个路径的链接类型检查
  '/api/disk/migrate/records',    // 迁移记录（读本地 JSON）
  '/api/privilege/status'         // 是否管理员
]);

/** 定长比较，避免时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

/** 取 Host 头里的主机名（去掉端口与方括号） */
function hostNameOf(hostHeader) {
  return String(hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * 请求准入判定。
 * @returns {null|{status:number, code:string, message:string}} null 表示放行
 */
function checkRequestAuth(req, pathname) {
  // 只保护 API；首页是 token 的发放点，必须放行
  if (!pathname.startsWith('/api/')) return null;

  // ① Host 校验：本机服务只接受环回访问
  const host = hostNameOf(req.headers.host);
  if (host && !LOCAL_HOSTS.has(host)) {
    return {
      status: 403, code: 'BAD_HOST',
      message: `拒绝访问：Host "${host}" 不是环回地址。本服务仅限本机使用。`
    };
  }

  // ② Origin 校验：跨源请求只允许本服务自身的源
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let ok = false;
    try {
      const o = new URL(origin);
      const port = o.port || (o.protocol === 'https:' ? '443' : '80');
      ok = LOCAL_HOSTS.has(o.hostname.toLowerCase()) && String(port) === String(PORT);
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      return {
        status: 403, code: 'BAD_ORIGIN',
        message: `拒绝访问：来源 "${origin}" 与本服务不同源。请通过 http://127.0.0.1:${PORT} 打开界面。`
      };
    }
  }

  const method = String(req.method || 'GET').toUpperCase();

  // ③ 令牌校验：写操作 + 一切非豁免的读接口都要带令牌
  const isWrite = WRITE_METHODS.has(method);
  const needsToken = isWrite || !CHEAP_READ_PATHS.has(pathname);
  if (needsToken) {
    const token = req.headers['x-cc-token'];
    if (!token || !safeEqual(token, ACCESS_TOKEN)) {
      return {
        status: 403, code: 'UNAUTHORIZED',
        message: isWrite
          ? '拒绝执行：缺少或错误的访问令牌。请通过服务打开的界面操作（直接打开本地 HTML 文件时清理功能不可用）。'
          : '拒绝访问：该接口需要访问令牌（它可能触发较重的扫描）。请通过服务打开的界面访问。'
      };
    }
    // ④ 有请求体的写操作必须是 JSON —— 浏览器的「简单请求」可免预检，
    //    若放任 text/plain 等类型，恶意页面无需预检即可投递 JSON 文本。
    if (isWrite) {
      const len = Number(req.headers['content-length'] || 0);
      if (len > 0) {
        const ct = String(req.headers['content-type'] || '');
        if (!/^application\/json\b/i.test(ct)) {
          return {
            status: 415, code: 'UNSUPPORTED_MEDIA_TYPE',
            message: '写接口只接受 Content-Type: application/json 的请求体。'
          };
        }
      }
    }
  }

  return null;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  let query = {};
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = u.pathname;
    query = Object.fromEntries(u.searchParams.entries());
  } catch (e) {
    return sendJson(res, 400, { error: { code: 'BAD_URL', message: 'URL 解析失败', detail: e.message } });
  }

  // 访问控制闸门（仅作用于 /api/*）
  const denied = checkRequestAuth(req, pathname);
  if (denied) {
    return sendJson(res, denied.status, { error: { code: denied.code, message: denied.message } });
  }

  // 健康检查（附带当前进程权限，界面用来决定要不要显示提权按钮）
  if (pathname === '/api/health') {
    const { isAdmin } = require('./services/privilegeService');
    const admin = isAdmin();
    return sendJson(res, 200, {
      status: 'ok',
      time: new Date().toISOString(),
      isAdmin: admin,
      pid: process.pid
    });
  }

  // 首页：直接返回单文件界面（这样页面与服务同源，清理按钮可用）
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const fs = require('fs');
      const path = require('path');
      const htmlPath = path.join(__dirname, '..', '内存清理助手.html');
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        // 注入本次启动的一次性 token。
        //
        // ⚠ 必须**只替换 window.__CC_TOKEN__ 的赋值那一处**，绝不能用全局字符串替换：
        //   模板里 '__CC_TOKEN_VALUE__' 这个字面量**还出现在前端常量 TOKEN_PLACEHOLDER
        //   的定义中**。全局替换会把两处都换成同一个令牌，于是前端的
        //   `window.__CC_TOKEN__ !== TOKEN_PLACEHOLDER` 恒为 false →
        //   CC_TOKEN=null → HAS_TOKEN=false → 界面上所有需令牌的接口全部 403，
        //   表现为「生成清理计划」报错、磁盘应用列表显示「没有扫到应用占用」。
        //   （2026-09-23 真机验收实测发现；前端亦已改为格式校验，双重防护。）
        const withToken = html.replace(
          /window\.__CC_TOKEN__\s*=\s*'__CC_TOKEN_VALUE__'/,
          "window.__CC_TOKEN__ = '" + ACCESS_TOKEN + "'"
        );
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(withToken);
      }
      return sendJson(res, 404, { error: { code: 'PAGE_NOT_FOUND', message: '未找到 内存清理助手.html，请先运行 node build.js 生成' } });
    } catch (e) {
      return sendJson(res, 500, { error: { code: 'PAGE_ERROR', message: '读取页面失败', detail: e.message } });
    }
  }

  // 内存路由
  if (handleMemoryRoutes(req, res, pathname, query)) return;

  // 404
  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `未找到接口：${pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`内存数据服务已启动：http://127.0.0.1:${PORT}`);
  console.log('  访问控制：写接口需页面内下发的一次性令牌（防跨站触发清理）');
  console.log('  健康检查：  GET /api/health');
  console.log('  完整快照：  GET /api/memory/snapshot');
  console.log('  系统内存：  GET /api/memory/system');
  console.log('  应用排行：  GET /api/memory/apps?limit=20');
  console.log('  进程明细：  GET /api/memory/processes');
  console.log('  清理计划：  GET /api/cleanup/plan（dry-run，不动进程）');
  console.log('  磁盘快照：  GET /api/disk/snapshot（C/D 盘扫描，约 30~60 秒）');
  console.log('  垃圾定位：  GET /api/disk/junk（分类清单，约 3 秒）');
  console.log('  磁盘应用：  GET /api/disk/apps（按应用归类，约 30~60 秒）');
  console.log('  分区概览：  GET /api/disk/volumes（毫秒级）');
  console.log('  磁盘清理计划： GET /api/disk/cleanup/plan');
  console.log('  磁盘清理执行： POST /api/disk/cleanup/execute（需 confirmed=true）');
  console.log('  执行清理：  POST /api/cleanup/execute（需 confirmed=true）');
  console.log('  磁盘忙碌：  GET /api/cleanup/io');
  console.log('  修剪计划：  GET /api/cleanup/trim/plan');
  console.log('  修剪工作集：POST /api/cleanup/trim（公开 API，需 confirmed=true）');
  console.log('  迁移预置：  GET /api/disk/migrate/presets');
  console.log('  链接检查：  GET /api/disk/migrate/inspect?path=');
  console.log('  缓存迁移：  POST /api/disk/migrate/execute（默认 junction）');
  console.log('  权限状态：  GET /api/privilege/status');
  console.log('  提升权限：  POST /api/privilege/elevate（弹出 UAC）');
});

server.on('error', (err) => {
  console.error('服务启动失败：', err.message);
  process.exit(1);
});
