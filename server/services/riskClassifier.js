'use strict';
/**
 * riskClassifier.js — 三色风险分级器
 * 输出每个应用的 risk（safe/caution/protected）与可解释的中文理由。
 *
 * 分级优先级：
 *   1. protectedProcesses.json（禁止结束名单）→ protected，理由取自名单
 *   2. 词典 entries[name].risk → 用词典判定
 *   3. 兜底 → caution（不默认放行，也不默认禁止）
 */

const path = require('path');
const fs = require('fs');

const PROTECTED_PATH = path.join(__dirname, '..', '..', 'data', 'protectedProcesses.json');
const DICT_PATH = path.join(__dirname, '..', '..', 'data', 'appDict.zh.json');

let _protectedMap = null;
let _dict = null;

function loadProtected() {
  if (_protectedMap) return _protectedMap;
  try {
    const data = JSON.parse(fs.readFileSync(PROTECTED_PATH, 'utf8'));
    _protectedMap = new Map((data.protected || []).map(e => [e.name, e]));
  } catch (e) {
    _protectedMap = new Map();
  }
  return _protectedMap;
}

function loadDict() {
  if (_dict) return _dict;
  try {
    _dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
  } catch (e) {
    _dict = { entries: {} };
  }
  return _dict;
}

const REASON_BY_RISK = {
  safe: '第三方应用，结束不会影响系统稳定性',
  caution: '结束可能影响当前使用或丢失未保存内容',
  protected: '系统关键进程，禁止结束'
};

/**
 * 对单个应用分级。
 * @param {Object} app  应用对象，至少含 key 字段（进程名或归组 key）
 * @returns {{risk:string, reason:string, source:string|null}}
 */
function classify(app) {
  const key = app.key || app.name || '';

  // 1. 禁止名单
  const pm = loadProtected();
  if (pm.has(key)) {
    const p = pm.get(key);
    return { risk: 'protected', reason: p.reason, source: p.source || null };
  }

  // 2. 词典
  const dict = loadDict();
  const entry = dict.entries && dict.entries[key];
  if (entry && entry.risk) {
    return { risk: entry.risk, reason: REASON_BY_RISK[entry.risk] || REASON_BY_RISK.caution, source: '本地词典' };
  }

  // 3. 兜底
  return { risk: 'caution', reason: '未知应用，请自行确认后再处理', source: null };
}

/**
 * 批量分级：给 apps 数组里每个应用附加 risk 与 riskReason。
 */
function classifyAll(apps) {
  for (const app of apps) {
    const c = classify(app);
    app.risk = c.risk;
    app.riskReason = c.reason;
    app.riskSource = c.source;
  }
  return apps;
}

module.exports = { classify, classifyAll, loadProtected, REASON_BY_RISK };
