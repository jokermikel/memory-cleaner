'use strict';
/**
 * auditLog.js — 审计日志的唯一写入点（短期-11）
 *
 * 原先五个服务各写一份 audit()，内容几乎逐字相同：
 *   建目录 → 取当天 YYYYMMDD → 追加一行 `[ISO 时间] 正文` 到 logs/<渠道>-<日期>.log
 * 差别只在文件名前缀（以及工作集修剪多一个 "TRIM " 前缀）。重复的不只是代码：
 * 想改格式或加轮转（短期-12）就得改五遍，而且极容易漏一处。
 * 现在统一到这里；各服务只保留一个转调用的本地 audit()，调用点不用动。
 *
 * 渠道与文件的对应（沿用既有文件名，不改变已有日志的归档方式）：
 *   cleanup       进程清理 + 工作集修剪共用（两者本来就写同一个文件）
 *   disk-cleanup  按目录删除磁盘垃圾
 *   cache-migrate 目录迁移 / 回滚
 *   privilege     提权
 *
 * 轮转与保留（短期-12，S7）：
 *   - 单个文件超过 MAX_BYTES 就改名成 <名字>.1 并另起一个（单代轮转）。每天一个
 *     文件的策略下，正常用法一天到不了上限；但「刷屏式」调用或异常循环会，
 *     有上限总比把磁盘写满好。
 *   - 超过 KEEP_DAYS 天的日志在写入时顺带清理，且每 SWEEP_INTERVAL_MS 最多扫一次，
 *     不额外占常驻开销。
 *   - 只清理本模块产出的文件名（<渠道>-<8位日期>.log[.N]），logs/ 里别的东西不动。
 *
 * 写入失败一律吞掉：审计是旁路记录，不能反过来让已经成功的动作报错。
 */

const fs = require('fs');
const path = require('path');
const { ROOT, LOG_DIR } = require('./paths');

/** 单文件上限（超过即轮转） */
const MAX_BYTES = 4 * 1024 * 1024;
/** 保留天数（超过即清理） */
const KEEP_DAYS = 14;
/** 清理扫描的最小间隔，避免每次写日志都 readdir */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 只清理自己产出的文件：<渠道>-<8位日期>.log，可带轮转后缀 .1 */
const AUDIT_FILE_RE = /^[a-z][a-z0-9-]*-\d{8}\.log(\.\d+)?$/;

/** 目录 -> 上次清理时刻（按目录分别节流，测试用临时目录时互不干扰） */
const lastSweepMs = new Map();

/** 渠道名 → 日志文件名，未知渠道直接以渠道名作前缀 */
function fileNameOf(channel, now) {
  const d = now instanceof Date ? now : new Date();
  const ymd = d.getFullYear()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
  return `${channel}-${ymd}.log`;
}

/**
 * 追加一条审计记录。
 * @param {string} channel 渠道名（cleanup / disk-cleanup / cache-migrate / privilege）
 * @param {string} line    正文（调用方自行带上下文前缀，如 "TRIM "）
 * @param {{dir?:string, now?:Date}} [opts] 仅测试用：覆盖目录与时间
 * @returns {string} 实际写入的文件路径（即使写入失败也返回，便于排查）
 */
function appendAudit(channel, line, opts = {}) {
  const dir = opts.dir || LOG_DIR;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const file = path.join(dir, fileNameOf(channel, now));
  const text = `[${now.toISOString()}] ${line}\n`;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 目录已存在或无权限，交由下面的写入暴露 */ }
  rotateIfNeeded(file, Buffer.byteLength(text, 'utf8'));
  try { fs.appendFileSync(file, text, 'utf8'); } catch (e) { /* 见文件头：审计失败不得影响主流程 */ }
  maybeSweep(dir, now);
  return file;
}

/**
 * 单文件写满就轮转：当前文件改名成 <名字>.1，由本次写入另起一个新文件。
 * 只保留一代（覆盖旧的 .1）：审计日志的价值在「最近发生了什么」，
 * 多代旧档既占地方又没人看。
 */
function rotateIfNeeded(file, incomingBytes) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (e) {
    return; // 文件还不存在：本次写入即创建，无需轮转
  }
  if (size + incomingBytes <= MAX_BYTES) return;
  const archived = file + '.1';
  try { fs.rmSync(archived, { force: true }); } catch (e) { /* Windows 上 rename 不能覆盖已存在文件 */ }
  try { fs.renameSync(file, archived); } catch (e) { /* 轮转失败就继续往原文件追加，不影响写入 */ }
}

/**
 * 清理超过 KEEP_DAYS 天的审计日志。
 * 只认自己产出的文件名，logs/ 里的其它文件（比如用户的截图）不动。
 * @returns {{removed:string[], scanned:number}}
 */
function sweepAuditLogs(opts = {}) {
  const dir = opts.dir || LOG_DIR;
  const nowMs = opts.now instanceof Date ? opts.now.getTime()
    : (Number.isFinite(opts.now) ? opts.now : Date.now());
  const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : KEEP_DAYS;
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { removed, scanned: 0 }; }
  for (const name of names) {
    if (!AUDIT_FILE_RE.test(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (nowMs - st.mtimeMs <= keepDays * 86400000) continue;
    try { fs.rmSync(p, { force: true }); removed.push(name); } catch (e) { /* 占用中则下次再说 */ }
  }
  return { removed, scanned: names.length };
}

/** 清理按间隔节流：写日志是热路径，不能每次都 readdir */
function maybeSweep(dir, now) {
  const nowMs = now.getTime();
  if (nowMs - (lastSweepMs.get(dir) || 0) < SWEEP_INTERVAL_MS) return;
  lastSweepMs.set(dir, nowMs);
  try { sweepAuditLogs({ dir, now: nowMs }); } catch (e) { /* 清理失败不影响写入 */ }
}

module.exports = {
  appendAudit,
  fileNameOf,
  sweepAuditLogs,
  LOG_DIR,
  ROOT,
  MAX_BYTES,
  KEEP_DAYS,
  SWEEP_INTERVAL_MS
};
