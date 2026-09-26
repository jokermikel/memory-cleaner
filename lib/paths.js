'use strict';
/**
 * paths.js — 仓库内「位置」的唯一来源（长期-3 / Q7、Q8）
 *
 * 为什么要有这个文件：`path.join(__dirname, '..', '..')` 这行相对路径原先在
 * 八个模块里各写一遍，`data/xxx.json` 在六个模块里各拼一次。相对层数写错不会
 * 报错，只会让某个模块悄悄读到另一个目录；而 `data/` 与 `logs/` 的归属一旦
 * 各说各话，「统一数据与配置布局」就无从谈起。
 * 现在所有位置只在此处声明一次，其余模块一律从这里取。
 *
 * 同时它也是测试脱敏的基础（长期-1）：测试只需 `require('lib/paths')` 的 ROOT，
 * 就能在任意工作目录下定位仓库，不必依赖 `process.cwd()` 恰好是仓库根。
 *
 * 注意：这里只放**位置**，不放任何业务常量（端口、上限、词典内容另有归属）。
 */

const path = require('path');
const os = require('os');

/** 仓库根（本文件位于 <root>/lib/） */
const ROOT = path.join(__dirname, '..');
/** 数据目录：词典、映射表、迁移记录等随仓库分发的数据 */
const DATA_DIR = path.join(ROOT, 'data');
/** 审计与启动日志目录 */
const LOG_DIR = path.join(ROOT, 'logs');
/** 服务端源码目录 */
const SERVER_DIR = path.join(ROOT, 'server');
/** PowerShell 采集/执行脚本目录 */
const COLLECTORS_DIR = path.join(SERVER_DIR, 'collectors');
/** 单文件界面（build.js 生成） */
const HTML_FILE = path.join(ROOT, '内存清理助手.html');
/** 界面模板（build.js 的输入） */
const TEMPLATE_FILE = path.join(ROOT, '_template.html');
/** 系统临时目录：所有一次性中间文件都落在这里，用完即删 */
const TMP_DIR = os.tmpdir();

/** data 目录下的一个文件/子目录 */
function data(...segments) { return path.join(DATA_DIR, ...segments); }
/** collectors 目录下的一个脚本 */
function collector(file) { return path.join(COLLECTORS_DIR, file); }
/** 系统临时目录下的一个一次性文件 */
function tmpFile(name) { return path.join(TMP_DIR, name); }

module.exports = {
  ROOT,
  DATA_DIR,
  LOG_DIR,
  SERVER_DIR,
  COLLECTORS_DIR,
  HTML_FILE,
  TEMPLATE_FILE,
  TMP_DIR,
  data,
  collector,
  tmpFile
};
