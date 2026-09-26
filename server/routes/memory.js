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
// 长任务注册表（长期-2）：进度/取消/超时/单飞的唯一实现
const tasks = require('../../lib/tasks');

/** 参数校验：把字符串解析为正整数，非法返回 null */
function parseIntParam(v, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

const MAX_LIST_LIMIT = 500;
const MAX_LIST_OFFSET = 100000;

/**
 * 参数夹取：解析为正整数后夹到 [min, max]；无法解析时仍返回 null。
 *
 * 为什么不能用 parseIntParam 的上限做分页：
 *   超出上限时 parseIntParam 返回 null，调用方的 `if (limit)` 会退化成
 *   「不传 limit」= 返回全部条目 —— 即 `?limit=999999` 反而拿到全量列表，
 *   「上限」形同虚设（M-07）。分页参数改用夹取后，超限请求至多拿到上限条数。
 */
function clampIntParam(v, min, max) {
  const n = parseIntParam(v, min, Number.MAX_SAFE_INTEGER);
  if (n === null) return null;
  return Math.min(n, max);
}

/** 参数校验：从白名单取值，非法返回默认值 */
function enumParam(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

/**
 * 列表分页的**唯一实现**（短期-14 / U4）。
 *
 * 为什么要有这个函数：原先「一页多少条、一共多少条」在两层各说各话 ——
 * 服务端只有一句上限 500 的 limit 夹取（有的接口连 offset 都没有），前端又自行
 * slice 出一页并自称「显示全部 N 个」。于是同一份列表可以出现两个互相矛盾的总数。
 * 现在分页只归服务端：响应里固定带上 total（过滤/排序后的总数）、offset、limit、
 * count（本页条数），前端只负责把 count/total 原样念给用户，不再自己算口径。
 *
 * limit 缺省（不传/非法）= 不分页，返回全部；超出上限一律**夹到上限**而不是退回全部
 * （否则 `?limit=999999` 反而拿到全量列表，「上限」形同虚设，见 M-07）。
 */
function pageOf(list, query) {
  const limit = clampIntParam(query.limit, 1, MAX_LIST_LIMIT);
  const offset = clampIntParam(query.offset, 0, MAX_LIST_OFFSET) || 0;
  const total = list.length;
  const items = limit ? list.slice(offset, offset + limit) : list.slice(offset);
  return { total, offset, limit: limit || null, count: items.length, items };
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
 * 异步 handler 的统一兜底（Q3）。
 *
 * 异步 handler 内部已经有 try/catch，但「函数体被完整包裹」是一条只能靠人守的
 * 不变量：任何一处漏掉，游离的 Promise 拒绝在 Node ≥15 会让**整个服务进程退出**。
 * 这里统一兜住，并保证每个请求最多发送一次响应（已发出响应就只吞掉异常）。
 */
function guardAsync(promise, res, code, message) {
  Promise.resolve(promise).catch((e) => {
    try {
      if (!res.headersSent) sendError(res, 500, code, message, e && e.message);
    } catch (err) { /* 响应已断开，忽略 */ }
  });
}

/**
 * 长任务统一入口（长期-2）。
 *
 * 背景见 lib/tasks.js 文件头：磁盘扫描 30~60 秒、磁盘清理可达数分钟，原先这些活儿
 * 都在请求线程上同步跑，事件循环被占满 —— 期间连 /api/health 都不响应，操作也没法取消。
 *
 * 现在的形态：
 *   - 活儿登记进 lib/tasks.js 的任务表（可在 GET /api/jobs 看到进度）
 *   - 同 key 只允许一个在飞，后到的请求立刻拿到 409（这就是 短期-2 的终解，
 *     替代原先那个「完成后 1 秒冷却窗」的权宜之计）
 *   - 客户端可 POST /api/jobs/:id/cancel 取消，signal 会连带杀掉 PowerShell 子进程
 *   - **响应形状刻意保持不变**（成功仍是 200 + 原来的 JSON），既有 173 条 e2e 依赖它
 *
 * @param {string} key       单飞键
 * @param {Object} opts      { kind, label, timeoutMs, failCode, failMessage }
 * @param {Function} runner  async (ctx) => data
 * @param {Function} [onError] 业务错误码映射（任务契约之外的码由它处理）
 */
async function runTask(res, key, opts, runner, onError) {
  try {
    const data = await tasks.startExclusive(key, runner, opts);
    if (!res.headersSent) sendJson(res, 200, data);
  } catch (e) {
    if (res.headersSent) return;
    if (sendTaskError(res, e)) return;
    if (onError) return onError(e);
    sendError(res, 500, opts.failCode || 'TASK_FAILED', opts.failMessage || '任务执行失败', e && e.message);
  }
}

/**
 * 任务错误码 → HTTP 状态。lib/tasks.js 的「传输契约」在路由层落地，
 * 调用点不得各自解释（否则同一个 TASK_BUSY 在三个接口会有三种状态码与文案）。
 */
const TASK_ERROR_STATUS = {
  TASK_TIMEOUT: 504,
  TASK_CANCELLED: 409,
  TASK_BUSY: 409,
  TASK_NOT_FOUND: 404,
  TASK_NOT_RUNNING: 409
};

/** @returns {boolean} true 表示已按任务契约发出响应 */
function sendTaskError(res, e) {
  const status = TASK_ERROR_STATUS[e && e.code];
  if (!status) return false;
  sendError(res, status, e.code, e.message, e.job ? { job: e.job } : null);
  return true;
}

/**
 * GET /api/jobs
 * 任务列表：在飞的排前面，其余按完成时间倒序。前端据此显示进度与「取消」按钮。
 */
function handleJobsList(query, res) {
  const list = tasks.list();
  if (query.id) {
    const one = tasks.get(String(query.id));
    if (!one) return sendError(res, 404, 'TASK_NOT_FOUND', '任务不存在或已超出保留范围');
    return sendJson(res, 200, { job: one });
  }
  sendJson(res, 200, { jobs: list, running: list.filter(j => j.state === 'running').length });
}

/**
 * GET /api/jobs/:id
 * 单个任务的进度快照。
 */
function handleJobDetail(res, id) {
  const job = tasks.get(id);
  if (!job) return sendError(res, 404, 'TASK_NOT_FOUND', '任务不存在或已超出保留范围');
  sendJson(res, 200, { job });
}

/**
 * POST /api/jobs/:id/cancel
 * 取消在飞任务。取消会把 AbortSignal 传到底层 execFile，连带杀掉 PowerShell 子进程。
 */
function handleJobCancel(req, res, id) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
  }
  try {
    sendJson(res, 202, { job: tasks.cancel(id) });
  } catch (e) {
    if (sendTaskError(res, e)) return;
    sendError(res, 500, 'TASK_CANCEL_FAILED', '取消任务失败', e.message);
  }
}

/**
 * GET /api/memory/snapshot
 * 完整内存快照：系统 + 应用排行 + 守恒校验。
 * 支持 ?limit=N（返回前 N 个应用，默认全部）
 */
function handleSnapshot(query, res) {
  try {
    const data = snapshot();
    // 分页口径与服务端其它列表接口一致（见 pageOf）：apps 是列表，元数据带 apps 前缀，
    // 避免与「应用数」这类同名字段混淆。
    const page = pageOf(data.apps, query);
    data.apps = page.items;
    data.appsTotal = page.total;
    data.appsOffset = page.offset;
    data.appsLimit = page.limit;
    data.appsCount = page.count;
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
    const data = snapshot();
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
    const data = snapshot();
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

    // 分页：见 pageOf（服务端是分页的唯一归属层）
    const page = pageOf(apps, query);

    sendJson(res, 200, {
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      count: page.count,
      apps: page.items,
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
    const { processes } = collectProcesses();
    let list = processes;

    const q = query.q;
    if (q && typeof q === 'string' && q.trim()) {
      const kw = q.trim().toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(kw));
    }

    // 分页：见 pageOf（此前只有 limit、没有 offset，与 /api/memory/apps 语义不一致）
    const page = pageOf(list, query);
    sendJson(res, 200, { total: page.total, offset: page.offset, limit: page.limit, count: page.count, processes: page.items });
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

  return runTask(res, 'cleanup-execute', {
    kind: 'cleanup', label: '关闭进程清理内存', timeoutMs: 300000,
    failCode: 'CLEANUP_FAILED', failMessage: '清理执行失败'
  }, (ctx) => execute({
    appKeys: Array.isArray(body.appKeys) ? body.appKeys : undefined,
    pids: Array.isArray(body.pids) ? body.pids : undefined,
    force: body.force === true,
    acknowledgeBatchLimit: body.acknowledgeBatchLimit === true,
    confirmed: body.confirmed === true,
    dryRun: body.dryRun !== false,
    minMb: Number.isFinite(body.minMb) ? body.minMb : 0
  }, ctx), (e) => {
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
  });
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
  return runTask(res, 'trim-execute', {
    kind: 'trim', label: '修剪进程工作集', timeoutMs: 300000,
    failCode: 'TRIM_FAILED', failMessage: '工作集修剪失败'
  }, (ctx) => trimExecute({
    appKeys: Array.isArray(body.appKeys) ? body.appKeys : undefined,
    pids: Array.isArray(body.pids) ? body.pids : undefined,
    confirmed: body.confirmed === true,
    dryRun: body.dryRun !== false,
    minMb: Number.isFinite(body.minMb) ? body.minMb : 0
  }, ctx), (e) => {
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
  });
}

async function handleMigratePresets(query, res) {
  try {
    // 返回经可迁移性评估的清单：每项含 migratable / blockers，
    // 前端据此把不满足硬条件的条目渲染为禁用（附原因），可选的才允许点击。
    sendJson(res, 200, await cacheMigrate.assessPresets());
  } catch (e) {
    // 评估已有并发互斥（M-05）：正在评估时第二次请求必须回传 ASSESS_BUSY，
    // 而不是折成 500 MIGRATE_PRESETS_FAILED —— 前者「稍后重试即可」是可操作的，
    // 后者会被当成服务故障。409 与 DISK_BUSY 同族：本机状态导致当前不可完成。
    if (e && e.code === 'ASSESS_BUSY') {
      return sendError(res, 409, 'ASSESS_BUSY', e.message);
    }
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
    // 状态文件损坏（M-08）必须原样透出，不能折成通用 500：
    // 若被包装成「读取迁移记录失败」，界面会把「记录损坏、需人工复核」
    // 误读成「暂时读不到」，而损坏文件本身又必须保留待查。
    if (e && (e.code === 'STATE_CORRUPTED' || e.code === 'STATE_WRITE_FAILED')) {
      return sendError(res, 409, e.code, e.message);
    }
    sendError(res, 500, 'MIGRATE_RECORDS_FAILED', '读取迁移记录失败', e.message);
  }
}

const MIGRATE_CLIENT_CODES = new Set([
  'NOT_CONFIRMED', 'CRITICAL_PATH', 'SOURCE_MISSING', 'SOURCE_IS_LINK',
  'SOURCE_NOT_DIR', 'SAME_PATH', 'DEST_INSIDE_SOURCE', 'SOURCE_INSIDE_DEST',
  'VOLUME_UNKNOWN', 'DISK_FULL', 'DEST_EXISTS', 'COPY_MISMATCH',
  'SOURCE_IN_USE', 'LINK_FAILED', 'LINK_NOT_DETECTED', 'PROBE_FAILED',
  'MIGRATION_BUSY', 'STATE_CORRUPTED', 'STATE_WRITE_FAILED', 'BAD_SOURCE', 'ASSESS_BUSY'
]);

/** 撤销迁移（回滚）专属的客户端错误码 —— 与迁移执行区分开，便于前端分别提示 */
const ROLLBACK_CLIENT_CODES = new Set([
  'NOT_MIGRATED', 'SOURCE_MISSING', 'NOT_A_LINK', 'DEST_MISSING',
  'UNLINK_FAILED', 'RESTORE_FAILED', 'RESTORE_MISMATCH'
]);

async function handleMigrateRollback(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendError(res, 400, 'BAD_BODY', '请求体解析失败', e.message);
  }
  try {
    const result = await cacheMigrate.rollbackMigration(body.source, {
      keepDestCopy: body.keepDestCopy === true
    });
    sendJson(res, 200, result);
  } catch (e) {
    if (e.code && ROLLBACK_CLIENT_CODES.has(e.code)) {
      return sendError(res, 400, e.code, e.message);
    }
    sendError(res, 500, 'ROLLBACK_FAILED', '撤销迁移失败', e.message);
  }
}

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
  // ───── 长任务接口（长期-2）─────
  // 前缀匹配，不走下面的精确 switch（switch 是 O(1) 但表达不了 /api/jobs/:id 这类路径）
  if (pathname === '/api/jobs') {
    handleJobsList(query, res);
    return true;
  }
  const jobMatch = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(pathname);
  if (jobMatch) {
    let id = jobMatch[1];
    try { id = decodeURIComponent(id); } catch (e) { /* 保持原样，查不到就是 404 */ }
    if (jobMatch[2]) handleJobCancel(req, res, id);
    else handleJobDetail(res, id);
    return true;
  }

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
      guardAsync(handleTrimExecute(req, res), res, 'TRIM_FAILED', '工作集修剪失败');
      return true;
    case '/api/disk/migrate/presets':
      // 评估为异步（H5 占用抽样并发执行）：统一走 guardAsync 兜底
      guardAsync(handleMigratePresets(query, res), res, 'MIGRATE_PRESETS_FAILED', '读取可迁移缓存清单失败');
      return true;
    case '/api/disk/migrate/inspect':
      handleMigrateInspect(query, res);
      return true;
    case '/api/disk/migrate/rollback':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      guardAsync(handleMigrateRollback(req, res), res, 'ROLLBACK_FAILED', '撤销迁移失败');
      return true;
    case '/api/disk/migrate/records':
      handleMigrateRecords(query, res);
      return true;
    case '/api/disk/migrate/precheck':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      guardAsync(handleMigratePrecheck(req, res), res, 'PRECHECK_FAILED', '迁移预检失败');
      return true;
    case '/api/disk/migrate/execute':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      // execute 为异步：统一走 guardAsync 兜底
      guardAsync(handleMigrateExecute(req, res), res, 'MIGRATE_FAILED', '缓存迁移失败');
      return true;
    case '/api/cleanup/execute':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      guardAsync(handleCleanupExecute(req, res), res, 'CLEANUP_FAILED', '清理执行失败');
      return true;
    case '/api/disk/volumes':
      handleDiskVolumes(query, res);
      return true;
    case '/api/disk/snapshot':
      handleDiskSnapshot(req, res);
      return true;
    case '/api/disk/junk':
      handleDiskJunk(req, res);
      return true;
    case '/api/disk/apps':
      handleDiskApps(req, res, query);
      return true;
    case '/api/disk/cleanup/plan':
      handleDiskCleanupPlan(req, res);
      return true;
    case '/api/disk/cleanup/execute':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      guardAsync(handleDiskCleanupExecute(req, res), res, 'DISK_CLEANUP_FAILED', '磁盘清理失败');
      return true;
    case '/api/privilege/status':
      handlePrivilegeStatus(query, res);
      return true;
    case '/api/privilege/elevate':
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '该接口只接受 POST');
        return true;
      }
      guardAsync(handlePrivilegeElevate(req, res), res, 'ELEVATE_FAILED', '提升权限失败');
      return true;
    default:
      return false;
  }
}

/**
 * GET /api/disk/volumes
 * 分区概览（Win32_LogicalDisk，毫秒级，不走任务）。
 */
function handleDiskVolumes(query, res) {
  try {
    sendJson(res, 200, diskVolumes());
  } catch (e) {
    sendError(res, 500, 'DISK_VOLUMES_FAILED', '读取分区信息失败', e.message);
  }
}

/**
 * GET /api/disk/snapshot
 * C/D 盘占用快照（一级目录 + 已知垃圾路径）。扫描约 30~60 秒。
 *
 * 长期-2：改为长任务。响应形状不变（仍 200 + 原 JSON），但扫描期间服务可响应，
 * 且可在 GET /api/jobs 看到进度、POST /api/jobs/:id/cancel 取消。
 */
function handleDiskSnapshot(req, res) {
  guardAsync(runTask(res, 'disk-snapshot', {
    kind: 'disk-snapshot', label: '磁盘占用快照', timeoutMs: 600000,
    failCode: 'DISK_SCAN_FAILED', failMessage: '磁盘扫描失败'
  }, (ctx) => diskSnapshot(ctx)), res, 'DISK_SCAN_FAILED', '磁盘扫描失败');
}

/**
 * GET /api/disk/junk
 * 按词典分类的可清理垃圾清单（已去重）。约 3 秒。
 */
function handleDiskJunk(req, res) {
  guardAsync(runTask(res, 'disk-junk', {
    kind: 'disk-junk', label: '垃圾清单', timeoutMs: 180000,
    failCode: 'JUNK_SCAN_FAILED', failMessage: '垃圾定位失败'
  }, (ctx) => locate(ctx)), res, 'JUNK_SCAN_FAILED', '垃圾定位失败');
}

/**
 * GET /api/disk/apps
 * C/D 盘按应用归类的空间占用。扫描约 30~60 秒。
 * 支持 ?limit=N&offset=N —— 分页口径与内存侧列表一致（见 pageOf）。
 */
function handleDiskApps(req, res, query) {
  guardAsync(runTask(res, 'disk-apps', {
    kind: 'disk-apps', label: '磁盘应用归类', timeoutMs: 600000,
    failCode: 'DISK_ANALYZE_FAILED', failMessage: '磁盘应用归类失败'
  }, async (ctx) => {
    const data = await analyze(ctx);
    const page = pageOf(data.apps || [], query);
    return Object.assign({}, data, {
      apps: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      count: page.count
    });
  }), res, 'DISK_ANALYZE_FAILED', '磁盘应用归类失败');
}

/**
 * GET /api/disk/cleanup/plan
 * 磁盘垃圾清理计划（dry-run）。内部要跑一次 robocopy 量算（数秒级），同样任务化。
 */
function handleDiskCleanupPlan(req, res) {
  guardAsync(runTask(res, 'disk-cleanup-plan', {
    kind: 'disk-cleanup-plan', label: '磁盘清理计划', timeoutMs: 180000,
    failCode: 'DISK_PLAN_FAILED', failMessage: '生成磁盘清理计划失败'
  }, (ctx) => diskPlan({}, ctx)), res, 'DISK_PLAN_FAILED', '生成磁盘清理计划失败');
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
  return runTask(res, 'disk-cleanup-execute', {
    kind: 'disk-cleanup', label: '删除磁盘垃圾', timeoutMs: 1800000,
    failCode: 'DISK_CLEANUP_FAILED', failMessage: '磁盘清理失败'
  }, (ctx) => diskExecute({
    ids: Array.isArray(body.ids) ? body.ids : undefined,
    dryRun: body.dryRun !== false,
    confirmed: body.confirmed === true
  }, ctx), (e) => {
    if (e.code === 'NOT_CONFIRMED' || e.code === 'CAUTION_NOT_EXPLICIT') {
      return sendError(res, 400, e.code, e.message);
    }
    sendError(res, 500, 'DISK_CLEANUP_FAILED', '磁盘清理失败', e.message);
  });
}

module.exports = { handleMemoryRoutes };
