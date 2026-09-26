'use strict';
/**
 * tasks.js — 长任务注册表（长期-2 / 遗留-1）
 *
 * 为什么需要它：磁盘扫描要 30~60 秒、磁盘垃圾清理要数分钟，原先这些活儿都在
 * 请求线程上用 execFileSync 同步跑完 —— 事件循环被占满，期间连 GET /api/health
 * 都不响应，界面按钮全部失效且没有任何办法中止。更糟的是 Node 的
 * server.headersTimeout（60 秒，从连接建立时起算）会在阻塞期间把**已排队到达**的
 * 第二个请求直接掐断，客户端拿到的是连接被重置而不是任何 HTTP 状态码。
 *
 * 本模块把这类活儿统一收口成一个「任务」：
 *   - 进度：任务自己调 ctx.progress(percent, message)，外部轮询 GET /api/jobs/:id
 *   - 取消：ctx.signal 是 AbortSignal，传给 execFile({signal}) 即可连带杀掉
 *           PowerShell 子进程；循环里的多步任务用 ctx.throwIfAborted() 在步间退出
 *   - 超时：构造任务时给 timeoutMs，到点自动 abort，状态记为 timed_out
 *   - 单飞：startExclusive(key, ...) 同一 key 只允许一个在飞任务，其余立刻拿到
 *           TASK_BUSY（对应 HTTP 409）。这就是 短期-2 的终解 —— 有了真异步，
 *           「在飞」状态对后到的请求终于可见，不再需要 routes 里那个 1 秒冷却窗。
 *   - 失败恢复：任何 runner 异常都被收进任务对象（state=failed + error），
 *           不会变成游离的 Promise 拒绝把整个服务拖崩。
 *
 * 进度上报方式定为**轮询**（不是 SSE）：服务端是零依赖内置 http，轮询实现更小、
 * 断线重连天然无害，前端也已有轮询习惯；任务数是个位数，轮询开销可忽略。
 *
 * 传输契约（三条都写死在这里，调用方不得各自解释）：
 *   - 超时       → 抛 code='TASK_TIMEOUT'，路由转 504
 *   - 被取消     → 抛 code='TASK_CANCELLED'，路由转 409
 *   - 同 key 在飞 → 抛 code='TASK_BUSY'，路由转 409
 */

const { randomUUID } = require('crypto');

/** 任务状态。除 RUNNING 外都是终态。 */
const STATE = {
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out'
};

/** 已完成任务保留条数（够前端轮询取回结果与展示最近记录，又不至于无限增长） */
const MAX_HISTORY = 20;

/** key -> job：单飞锚点，只放 RUNNING 的任务 */
const running = new Map();
/** id -> job：全部（含最近完成的） */
const jobs = new Map();
/** 完成顺序（id），用于淘汰最老的已完成任务 */
const finishedOrder = [];

/** 可序列化的任务视图（外部只能拿到它，拿不到 AbortController 等内部字段） */
function snapshot(job) {
  return {
    id: job.id,
    key: job.key,
    kind: job.kind,
    label: job.label,
    state: job.state,
    percent: job.percent,
    message: job.message,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - job.startedAtMs,
    error: job.error
  };
}

/** 查询：单个任务 */
function get(id) {
  const job = jobs.get(String(id));
  return job ? snapshot(job) : null;
}

/** 查询：全部任务，在飞的排在前面，其余按完成时间倒序 */
function list() {
  const all = Array.from(jobs.values());
  all.sort((a, b) => {
    const ar = a.state === STATE.RUNNING ? 0 : 1;
    const br = b.state === STATE.RUNNING ? 0 : 1;
    if (ar !== br) return ar - br;
    return (b.finishedAtMs || b.startedAtMs) - (a.finishedAtMs || a.startedAtMs);
  });
  return all.map(snapshot);
}

/** 取消：只对在飞任务生效 */
function cancel(id) {
  const job = jobs.get(String(id));
  if (!job) {
    const e = new Error('任务不存在或已超出保留范围');
    e.code = 'TASK_NOT_FOUND';
    throw e;
  }
  if (job.state !== STATE.RUNNING) {
    const e = new Error('任务已结束，无法取消');
    e.code = 'TASK_NOT_RUNNING';
    e.job = snapshot(job);
    throw e;
  }
  job.cancelled = true;
  job.controller.abort();
  return snapshot(job);
}

/** 某 key 是否在飞（路由据此给出 409 提示） */
function busy(key) {
  const job = running.get(key);
  return job ? snapshot(job) : null;
}

function evict() {
  while (finishedOrder.length > MAX_HISTORY) {
    const id = finishedOrder.shift();
    jobs.delete(id);
  }
}

function finish(job, state, err, result) {
  job.state = state;
  job.finishedAt = new Date().toISOString();
  job.finishedAtMs = Date.now();
  job.error = err
    ? { code: (err && err.code) || 'TASK_FAILED', message: (err && err.message) || String(err) }
    : null;
  job.result = result;
  job.percent = state === STATE.DONE ? 100 : job.percent;
  finishedOrder.push(job.id);
  evict();
}

/** 按终态把异常翻译成调用方约定好的三个错误码之一（见文件头「传输契约」） */
function translate(job, e) {
  let out;
  if (job.timedOut) {
    out = new Error(`任务超时：${job.label}（超过 ${job.timeoutMs}ms）`);
    out.code = 'TASK_TIMEOUT';
  } else if (job.cancelled) {
    out = new Error(`任务已取消：${job.label}`);
    out.code = 'TASK_CANCELLED';
  } else {
    out = e instanceof Error ? e : new Error(String(e));
  }
  out.job = snapshot(job);
  return out;
}

/**
 * 启动一个任务。
 * @param {string} key          单飞键（同一 key 同时只允许一个任务）
 * @param {Function} runner     async (ctx) => result；ctx = { job, signal, progress, throwIfAborted }
 * @param {Object} [opts]
 * @param {string} [opts.kind]  任务类别（默认同 key），仅用于展示
 * @param {string} [opts.label] 人类可读名称，出错信息里会带
 * @param {number} [opts.timeoutMs] 超时毫秒；0/不传表示不设超时
 * @returns {Promise<*>} runner 的结果；失败按「传输契约」抛错
 */
function start(key, runner, opts = {}) {
  const id = randomUUID();
  const job = {
    id,
    key,
    kind: opts.kind || key,
    label: opts.label || key,
    state: STATE.RUNNING,
    percent: 0,
    message: '已开始',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    finishedAt: null,
    finishedAtMs: 0,
    timeoutMs: opts.timeoutMs > 0 ? opts.timeoutMs : 0,
    timedOut: false,
    cancelled: false,
    error: null,
    result: undefined,
    controller: new AbortController()
  };

  jobs.set(id, job);
  running.set(key, job);

  let timer = null;
  if (job.timeoutMs > 0) {
    timer = setTimeout(() => {
      job.timedOut = true;
      job.controller.abort();
    }, job.timeoutMs);
    // 不因一个待超时的定时器拖住进程退出
    if (typeof timer.unref === 'function') timer.unref();
  }

  const ctx = {
    job: id,
    signal: job.controller.signal,
    /** 上报进度：percent 会被夹到 0~100，message 可为空 */
    progress(percent, message) {
      if (job.state !== STATE.RUNNING) return;
      if (Number.isFinite(percent)) {
        job.percent = Math.max(0, Math.min(100, Math.round(percent)));
      }
      if (message != null && message !== '') job.message = String(message);
    },
    /** 多步任务在每一步之间调用：已取消/超时时立刻退出，不再往下做破坏性操作 */
    throwIfAborted() {
      if (!job.controller.signal.aborted) return;
      const e = new Error('任务已中止');
      e.code = 'ABORT_ERR';
      e.name = 'AbortError';
      throw e;
    }
  };

  return Promise.resolve()
    .then(() => runner(ctx))
    .then(
      (result) => {
        finish(job, STATE.DONE, null, result);
        return result;
      },
      (e) => {
        const state = job.timedOut
          ? STATE.TIMED_OUT
          : (job.cancelled ? STATE.CANCELLED : STATE.FAILED);
        finish(job, state, e, undefined);
        throw translate(job, e);
      }
    )
    .finally(() => {
      if (timer) clearTimeout(timer);
      // 只有自己仍是该 key 的锚点时才摘除（防御未来可能出现的嵌套启动）
      if (running.get(key) === job) running.delete(key);
    });
}

/**
 * 单飞启动：同 key 已有在飞任务时**不排队**，直接以 TASK_BUSY 拒绝。
 * 排队只会把「点 N 次 = N 次全盘扫描」往后推，切断叠加才是这里的目的。
 */
function startExclusive(key, runner, opts = {}) {
  const existing = running.get(key);
  if (existing) {
    const e = new Error(`「${opts.label || key}」仍在进行中，为避免重复占用已拒绝，请等待完成或先取消`);
    e.code = 'TASK_BUSY';
    e.job = snapshot(existing);
    return Promise.reject(e);
  }
  return start(key, runner, opts);
}

module.exports = { start, startExclusive, get, list, cancel, busy, snapshot, STATE, MAX_HISTORY };
