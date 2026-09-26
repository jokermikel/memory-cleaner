'use strict';
/**
 * dictCache.js — 词典 / 映射表的热路径缓存（短期-10）
 *
 * 背景：appDict.zh.json、junkDict.zh.json、diskAppMap.json 原先每次调用都
 * 重新 readFileSync + JSON.parse。而这三个文件出现在「刷新快照」「扫描垃圾」
 * 这类会被反复触发的热路径上，运行期又几乎不变 —— 属于纯重复的 I/O 与解析开销。
 * 其中 appDict 条目最多，重复解析的代价也最大。
 *
 * 做法：以 (mtimeMs + size) 为缓存键，键相同直接返回上次解析结果。
 * 同时用 mtime 与 size 两个维度，是因为：某些编辑器/同步盘写回后 mtime 可能
 * 不变（或时间戳精度不够），而 size 变化能兜住；反之只改 mtime 不 size 的情况
 * 也存在。两者都不变才认为文件没被动过。
 *
 * 语义约定：
 *   - **失败不缓存**：文件缺失或 JSON 损坏时每次如实抛出，修好文件无需重启进程。
 *   - 返回的是**同一个对象实例**，调用方只读；需要改写请自行拷贝，
 *     否则会污染后续所有调用方（本文件只被三个只读消费方使用）。
 */

const fs = require('fs');

/** @type {Map<string, {key: string, value: any}>} 文件路径 -> 缓存项 */
const CACHE = new Map();

/** 状态键：mtime 与 size 任一变化都视为文件已更新 */
function statKeyOf(file) {
  const st = fs.statSync(file);
  return st.mtimeMs + ':' + st.size;
}

/**
 * 读取并解析 JSON，按文件状态缓存。
 * @param {string} file 绝对路径
 * @returns {any} 解析结果（同一文件同一状态返回同一对象）
 */
function loadJsonCached(file) {
  const key = statKeyOf(file);
  const hit = CACHE.get(file);
  if (hit && hit.key === key) return hit.value;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  CACHE.set(file, { key, value });
  return value;
}

/** 仅供测试：清空缓存，模拟进程重启 */
function clearDictCache() {
  CACHE.clear();
}

module.exports = { loadJsonCached, clearDictCache };
