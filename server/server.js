'use strict';
/**
 * server.js — HTTP 服务入口
 * 零依赖（Node 内置 http），仅内存数据查询接口，无写操作、无清理动作。
 * 启动：node server.js [端口]，默认 7788
 */

const http = require('http');
const { handleMemoryRoutes } = require('./routes/memory');

const PORT = Number(process.argv[2]) || 7788;

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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
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
