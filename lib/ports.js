'use strict';
/**
 * ports.js — 端口与「端口没抢到」退出码的唯一来源（短期-8）。
 *
 * 为什么要有这个文件：默认端口 7788 原先在 launcher.js（常量）和 server.js
 * （argv 兜底）各写一份，两处靠人肉保持一致；启动器还硬编码 7788 去探测就绪，
 * 于是「服务实际听哪个端口」与「启动器在等哪个端口」是两份独立事实。
 * 现在统一为：显式参数 > 环境变量 CC_PORT > 默认值。
 *
 * 退出码契约（launcher ↔ server）：
 *   服务进程因端口被占用而无法 listen 时，必须以 EXIT_PORT_IN_USE 退出，
 *   启动器据此给出「谁占了端口、接下来怎么办」的可操作提示，而不是干等超时。
 */

const DEFAULT_PORT = 7788;

/** server.js 抢不到端口时的退出码；启动器按此识别失败原因。 */
const EXIT_PORT_IN_USE = 3;

/** 解析端口：非法值返回 0（调用方据此回退）。 */
function parsePort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 0;
  return n;
}

/**
 * 解析生效端口。
 * @param {*} [explicit] 命令行参数（server.js 的 argv[2]）
 * @returns {number}
 */
function resolvePort(explicit) {
  return parsePort(explicit) || parsePort(process.env.CC_PORT) || DEFAULT_PORT;
}

module.exports = { DEFAULT_PORT, EXIT_PORT_IN_USE, parsePort, resolvePort };
