'use strict';
/**
 * routes/memory.js — 内存数据 RESTful 路由
 * 只做路由与参数校验，业务逻辑全部在 service 层。
 * 每个 handler 都有 try/catch，任何异常都返回结构化 JSON 错误，不裸抛。
 */

const { snapshot } = require('../services/memoryService');
const { plan, execute } = require('../services/cleanupService');
const { snapshot: diskSnapshot, volumes: diskVolumes } = require('../services/diskService');
const { locate } = require('../services/junkLocator');
const { analyze } = require('../services/diskAnalyzer');
const { plan: diskPlan, execute: diskExecute } = require('../services/diskCleanupService');
const { status: privilegeStatus, elevate } = require('../services/privilegeService');
const { plan: trimPlan, execute: trimExecute } = require('../services/workingSetService');
const { sampleDiskIo } = require('../services/diskIoGuard');
const cacheMigrate = require('../services/cacheMigrateService');

/** 参数校验：把字符串解析为正整数，非法返回 null */
function parseIntParam(v, min = 0) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) return null;
  return n;
}

/** 参数校验：从白名单取值，非法返回默认值 */
function enumParam(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
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

function sendError(res, status, code, message, detail) {
  sendJson(res, status, { error: { code, message, detail: detail || null } });
}

/**
 * GET /api/memory/snapshot
 * 完整内存快照：系统 + 应用排行 + 守恒校验。
 * 支持 ?limit=N（返回前 N 个应用，默认全部）
 */
function handleSnapshot(query, res) {
  try {
    const data = snapshot(true);
    const limit = parseIntParam(query.limit, 1);
    if (limit) data.apps = data.apps.slice(0, limit);
    sendJson(res, 200, data);
  } catch (e) {
    sendError(res, 500, 'SNAPSHOT_FAILED', '内存快照采集失败', e.message);
  }
}

/**
 * GET /api/memory/system
 * 仅整机内存信息。
 */
function handleSystem(query, res) {
  try {
    const data = snapshot(false);
    sendJson(res, 200, data.system);
  } catch (e) {
    sendError(res, 500, 'SYSTEM_FAILED', '系统内存采集失败', e.message);
  }
}

/**
 * GET /api/memory/apps
 * 应用排行。
 * 支持 ?limit=N、?sort=memory|name、?risk=safe|caution|protected、?q=关键字
 */
function handleApps(query, res) {
  try {
    const data = snapshot(true);
    let apps = data.apps;

    // 过滤
    const risk = enumParam(query.risk, ['safe', 'caution', 'protected'], null);
    if (risk) apps = apps.filter(a => a.risk === risk);

    const q = query.q;
    if (q && typeof q === 'string' && q.trim()) {
      const kw = q.trim().toLowerCase();
      apps = apps.filter(a =>
        a.name.toLowerCase().includes(kw) ||
        a.purpose.toLowerCase().includes(kw) ||
        a.vendor.toLowerCase().includes(kw)
      );
    }

    // 排序
    const sort = enumParam(query.sort, ['memory', 'name'], 'memory');
    if (sort === 'name') apps = [...apps].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    // 默认已按内存降序（groupApps 已排）

    // 分页
    const limit = parseIntParam(query.limit, 1);
    const offset = parseIntParam(query.offset, 0) || 0;
    const total = apps.length;
    const sliced = limit ? apps.slice(offset, offset + limit) : apps.slice(offset);

    sendJson(res, 200, {
      total,
      offset,
      count: sliced.length,
      apps: sliced,
      totalBytes: data.totalBytes,
      groupedBytes: data.groupedBytes,
      conserved: data.conserved,
      collectedAt: data.collectedAt
    });
  } catch (e) {
    sendError(res, 500, 'APPS_FAILED', '应用排行采集失败', e.message);
  }
}

/**
 * GET /api/memory/processes
 * 进程明细（未归组的原始进程列表）。
 * 支持 ?limit=N、?q=进程名
 */
function handleProcesses(query, res) {
  try {
    const { collectProcesses } = require('../collectors/processList');
    const { processes } = collectProcesses(false);
    let list = processes;

    const q = query.q;
    if (q && typeof q === 'string' && q.trim()) {
      const kw = q.trim().toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(kw));
    }

    const limit = parseIntParam(query.limit, 1);
    const total = list.length;
    const sliced = limit ? list.slice(0, limit) : list;

    sendJson(res, 200, { total, count: sliced.length, processes: sliced });
  } catch (e) {
    sendError(res, 500, 'PROCESSES_FAILED', '进程明细采集失败', e.message);
  }
}

/**
 * 读取并解析请求体（POST JSON）。
 * 注意：请求体过大时不要 req.destroy()——那会直接断开 socket，
 * 导致外层 sendError 的 400 响应写不出去、客户端拿到「连接被重置」的空响应。
 * 用 settled 标志即可：拒绝后停止累积数据，让上层正常回 400 BAD_BODY。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > 1024 * 1024) {
        settled = true;
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', (e) => {
      if (!settled) { settled = true; reject(e); }
    });
  });
}

/**
 * GET /api/cleanup/plan
 * 生成清理计划（dry-run），不执行任何操作。
 * 支持 ?minMb=N 只挑占用超阈值的应用
 */
function handleCleanupPlan(query, res) {
  try {
    const minMb = parseIntParam(query.minMb, 0);
    const p = plan({ minMb: minMb || 0 });
    sendJson(res, 200, p);
  } catch (e) {
    sendError(res, 500, 'PLAN_FAILED', '生成清理计划失败', e.message);
  }
}

/**
 * POST /api/cleanup/execute
 * 执行清理。安全闸门：
 *   - 默认 dryRun=true（只回计划）
 *   - 真实执行需要 body.confirmed === true
 *   - 计划进程数超过 20 时还需 body.acknowledgeBatchLimit === true（force 不再放行批量）
 *   - 选中保护进程会返回 403
 */
async function handleCleanupExecute(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, 400, 'BAD_BODY', '请求体解析失败', e.message);
  }

  try {
    const result = execute({
      appKeys: Array.isArray(body.appKeys) ? body.appKeys : undefined,
      pids: Array.isArray(body.pids) ? body.pids : undefined,
      force: body.force === true,
      acknowledgeBatchLimit: body.acknowledgeBatchLimit === true,
      confirmed: body.confirmed === true,
      dryRun: body.dryRun !== false,
      minMb: Number.isFinite(body.minMb) ? body.minMb : 0
    });
    sendJson(res, 200, result);
  } catch (e) {
    if (e.code === 'PROTECTED_TARGET') {
      return sendError(res, 403, 'PROTECTED_TARGET', e.message, { blocked: e.blocked });
    }
    if (e.code === 'NOT_CONFIRMED' || e.code === 'BATCH_LIMIT') {
      return sendError(res, 400, e.code, e.message);
    }
    if (e.code === 'DISK_BUSY') {
      return sendError(res, 409, 'DISK_BUSY', e.message, e.sample || null);
    }
    sendError(res, 500, 'CLEANUP_FAILED', '清理执行失败', e.message);
  }
}

/**
 * 路由分发。返回 true 表示已处理。
 */

function handleCleanupIo(query, res) {
  try {
    sendJson(res, 200, sampleDiskIo());
  } catch (e) {
    sendError(res, 500, 'IO_SAMPLE_FAILED', '读取磁盘忙碌状态失败', e.message);
  }
}

function handleTrimPlan(query, res) {
  try {
    const minMb = parseIntParam(query.minMb, 0);
    sendJson(res, 200, trimPlan({ minMb: minMb || 0 }));
  } catch (e) {
    sendError(res, 500, 'TRIM_PLAN_FAILED', '生成工作集修剪计划失败', e.message);
  }
}

async function handleTrimExecute(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, 400, 'BAD_BODY', '请求体解析失败', e.message);
  }
  try {
    const result = trimExecute({
      appKeys: Array.isArray(body.appKeys) ? body.appKeys : undefined,
      pids: Array.isArray(body.pids) ? body.pids : undefined,
      confirmed: body.confirmed === true,
      dryRun: body.dryRun !== false,
      minMb: Number.isFinite(body.minMb) ? body.minMb : 0
    });
    sendJson(res, 200, result);
  } catch (e) {
    if (e.code === 'PROTECTED_TARGET') {
      return sendError(res, 403, 'PROTECTED_TARGET', e.message, { blocked: e.blocked });
    }
    if (e.code === 'NOT_CONFIRMED') {
      return sendError(res, 400, e.code, e.message);
    }
    if (e.code === 'DISK_BUSY') {
      return sendError(res, 409, 'DISK_BUSY', e.message, e.sample || null);
    }
    sendError(res, 500, 'TRIM_FAILED', '工作集修剪失败', e.message);
  }
}

function handleMigratePresets(query, res) {
  try {
    sendJson(res, 200, { items: cacheMigrate.loadPresets() });
  } catch (e) {
    sendError(res, 500, 'MIGRATE_PRESETS_FAILED', '读取可迁移缓存清单失败', e.message);
  }
}

function handleMigrateInspect(query, res) {
  try {
    const target = query.path || query.p;
    if (!target || typeof target !== 'string' || !target.trim()) {
      return sendError(res, 400, 'BAD_PATH', '请提供 path 参数');
    }
    sendJson(res, 200, cacheMigrate.inspect(target.trim()));
  } catch (e) {
    sendError(res, 500, 'INSPECT_FAILED', '检查链接失败', e.message);
  }
}

function handleMigrateRecords(query, res) {
  try {
    sendJson(res, 200, cacheMigrate.listMigrations());
  } catch (e) {
    sendError(res, 500, 'MIGRATE_RECORDS_FAILED', '读取迁移记录失败', e.message);
  }
}

const MIGRATE_CLIENT_CODES = new Set([
  'NOT_CONFIRMED', 'CRITICAL_PATH', 'SOURCE_MISSING', 'SOURCE_IS_LINK',
  'SOURCE_NOT_DIR', 'SAME_PATH', 'DEST_INSIDE_SOURCE', 'SOURCE_INSIDE_DEST',
  'VOLUME_UNKNOWN', 'DISK_FULL', 'DEST_EXISTS', 'COPY_MISMATCH',
  'SOURCE_IN_USE', 'LINK_FAILED', 'LINK_NOT_DETECTED', 'PROBE_FAILED'
]);

async function handleMigratePrecheck(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, 400, 'BAD_BODY', '请求体解析失败', e.message);
  }
  try {
    const r = cacheMigrate.precheck(body.source, body.destination, {
      linkType: body.linkType,
      keepBackupDays: body.keepBackupDays
    });
    sendJson(res, r.ok ? 200 : 400, r);
  } catch (e) {
    sendError(res, 500, 'PRECHECK_FAILED', '迁移预检失败', e.message);
  }
}

async function handleMigrateExecute(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, 400, 'BAD_BODY', '请求体解析失败', e.message);
  }
  try {
    // 注意：execute 已改为异步（缺陷 D5 修复 —— 同步复制会阻塞事件循环）
    const result = await cacheMigrate.execute({
      source: body.source,
      destination: body.destination,
      linkType: body.linkType,
      keepBackupDays: body.keepBackupDays,
      dryRun: body.dryRun !== false,
      confirmed: body.confirmed === true
    });
    sendJson(res, 200, result);
  } catch (e) {
    if (e.code && MIGRATE_CLIENT_CODES.has(e.code)) {
      return sendError(res, 400, e.code, e.message, { issues: e.issues || null, check: e.check || null });
    }
    sendError(res, 500, 'MIGRATE_FAILED', '缓存迁移失败', e.message);
  }
}

function handleMemoryRoutes(req, res, pathname, query) {
  switch (pathname) {
    case '/api/memory/snapshot':
      handleSnapshot(query, res);
      return true;
    case '/api/memory/system':
      handleSystem(query, res);
      return true;
    case '/api/memory/apps':
      handleApps(query, res);
      return true;
    case '/api/memory/processes':
      handleProcesses(query, res);
      return true;
    case '/api/cleanup/plan':
      handleCleanupPlan(query, res);
      return true;
    case '/api/cleanup/io':
      handleCleanupIo(query, res);
      return true;
    case '/api/cleanup/trim/plan':
      handleTrimPlan(query, res);
      return true;
    case '/api/cleanup/trim':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      handleTrimExecute(req, res);
      return true;
    case '/api/disk/migrate/presets':
      handleMigratePresets(query, res);
      return true;
    case '/api/disk/migrate/inspect':
      handleMigrateInspect(query, res);
      return true;
    case '/api/disk/migrate/records':
      handleMigrateRecords(query, res);
      return true;
    case '/api/disk/migrate/precheck':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      handleMigratePrecheck(req, res);
      return true;
    case '/api/disk/migrate/execute':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      // execute 为异步：补 catch 兜底，避免未处理的 Promise 拒绝
      handleMigrateExecute(req, res).catch((e) => {
        try {
          if (!res.headersSent) {
            sendError(res, 500, 'MIGRATE_FAILED', '缓存迁移失败', e && e.message);
          }
        } catch (err) { /* 响应已断开，忽略 */ }
      });
      return true;
    case '/api/cleanup/execute':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      handleCleanupExecute(req, res);
      return true;
    case '/api/disk/volumes':
      handleDiskVolumes(query, res);
      return true;
    case '/api/disk/snapshot':
      handleDiskSnapshot(query, res);
      return true;
    case '/api/disk/junk':
      handleDiskJunk(query, res);
      return true;
    case '/api/disk/apps':
      handleDiskApps(query, res);
      return true;
    case '/api/disk/cleanup/plan':
      handleDiskCleanupPlan(query, res);
      return true;
    case '/api/disk/cleanup/execute':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      handleDiskCleanupExecute(req, res);
      return true;
    case '/api/privilege/status':
      handlePrivilegeStatus(query, res);
      return true;
    case '/api/privilege/elevate':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      handlePrivilegeElevate(req, res);
      return true;
    default:
      return false;
  }
}

/**
 * GET /api/disk/snapshot
 * C/D 盘占用快照（一级目录 + 已知垃圾路径）。扫描约 30~60 秒。
 */
function handleDiskVolumes(query, res) {
  try {
    sendJson(res, 200, diskVolumes());
  } catch (e) {
    sendError(res, 500, 'DISK_VOLUMES_FAILED', '读取分区信息失败', e.message);
  }
}

function handleDiskSnapshot(query, res) {
  try {
    const data = diskSnapshot();
    sendJson(res, 200, data);
  } catch (e) {
    sendError(res, 500, 'DISK_SCAN_FAILED', '磁盘扫描失败', e.message);
  }
}

/**
 * GET /api/disk/junk
 * 按词典分类的可清理垃圾清单（已去重）。约 3 秒。
 */
function handleDiskJunk(query, res) {
  try {
    const data = locate();
    sendJson(res, 200, data);
  } catch (e) {
    sendError(res, 500, 'JUNK_SCAN_FAILED', '垃圾定位失败', e.message);
  }
}

/**
 * GET /api/disk/apps
 * C/D 盘按应用归类的空间占用。扫描约 30~60 秒。
 */
function handleDiskApps(query, res) {
  try {
    const data = analyze();
    sendJson(res, 200, data);
  } catch (e) {
    sendError(res, 500, 'DISK_ANALYZE_FAILED', '磁盘应用归类失败', e.message);
  }
}

function handleDiskCleanupPlan(query, res) {
  try {
    const data = diskPlan();
    sendJson(res, 200, data);
  } catch (e) {
    sendError(res, 500, 'DISK_PLAN_FAILED', '生成磁盘清理计划失败', e.message);
  }
}

/**
 * GET /api/privilege/status
 * 当前进程是否管理员、能否提权。
 */
function handlePrivilegeStatus(query, res) {
  try {
    sendJson(res, 200, privilegeStatus());
  } catch (e) {
    sendError(res, 500, 'PRIVILEGE_STATUS_FAILED', '读取权限状态失败', e.message);
  }
}

/**
 * POST /api/privilege/elevate
 * 弹出 UAC，以管理员身份重启 launcher。
 * body.dryRun === true 时只返回计划，不弹窗。
 */
async function handlePrivilegeElevate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, 400, 'BAD_BODY', '请求体解析失败', e.message);
  }
  try {
    const result = elevate({ dryRun: body.dryRun === true });
    sendJson(res, 200, result);
  } catch (e) {
    if (
      e.code === 'UNSUPPORTED_PLATFORM' ||
      e.code === 'POWERSHELL_NOT_FOUND' ||
      e.code === 'LAUNCHER_NOT_FOUND' ||
      e.code === 'WSCRIPT_NOT_FOUND' ||
      e.code === 'ELEVATE_VBS_NOT_FOUND'
    ) {
      return sendError(res, 400, e.code, e.message);
    }
    sendError(res, 500, 'ELEVATE_FAILED', '提升权限失败', e.message);
  }
}

async function handleDiskCleanupExecute(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, 400, 'BAD_BODY', '请求体解析失败', e.message);
  }
  try {
    const result = diskExecute({
      ids: Array.isArray(body.ids) ? body.ids : undefined,
      dryRun: body.dryRun !== false,
      confirmed: body.confirmed === true
    });
    sendJson(res, 200, result);
  } catch (e) {
    if (e.code === 'NOT_CONFIRMED' || e.code === 'CAUTION_NOT_EXPLICIT') {
      return sendError(res, 400, e.code, e.message);
    }
    sendError(res, 500, 'DISK_CLEANUP_FAILED', '磁盘清理失败', e.message);
  }
}

module.exports = { handleMemoryRoutes };
