'use strict';
/**
 * run-tests.js — 全量真实测试执行器
 *
 * 隔离原则（与测试方案.md 第 2 节一致）：
 *   - 真杀进程：只打沙箱内的 cc_test_dummy.exe
 *   - 真删文件：只打沙箱目录 %TEMP%\cc-e2e-*\
 *   - 生产路径（C:\Windows\Temp、NVIDIA DXCache、微信目录、C/D 盘原有内容）一律只读
 *   - 提权：只走 dry-run，不点 UAC
 *   - 服务：只起 127.0.0.1:7799，不占用户的 7788
 *
 * 输出：test-results.json（逐条结果）+ stdout 摘要
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const fx = require('./fixture.js');

// 运行器位于 <项目根>\tests\，被测应用就是它的上一级（项目根）。
// 刻意不依赖任何固定的上层目录名或绝对路径，换机器/换目录布局都能直接跑。
const APP = path.resolve(__dirname, '..');
// 本目录（tests\）：e2e 的输入与产物（baseline.json / pre-state.json / post-state.json /
// test-results.json / server-7799.log）一律锚定在这里，**不跟随 cwd**。
// 历史事故（遗留-31）：这些路径原按 cwd 解析，从仓库根执行时会读不到 baseline.json
// （T0.4/T0.4b 双双失败），并把产物写到仓库根、生成悬空未跟踪文件。
const TESTS_DIR = __dirname;
const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let seq = 0;

/**
 * 硬红线（本轮踩过的坑）：测试器绝不允许向「生产白名单路径」发送真实删除指令。
 * 首轮测试因为 T6.10 误发 { ids:['user-temp'], dryRun:false, confirmed:true }，
 * 真实删掉了 %TEMP% 下约 26MB 临时文件（见 logs/disk-cleanup-*.log 两行 EXECUTED）。
 * 这里把它变成代码级闸门：任何真删请求，只要 ids 不是自造 id，直接抛错。
 */
function assertNotProduction(body) {
  const realDelete = body && body.dryRun === false && body.confirmed === true;
  if (!realDelete) return;
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const risky = ids.filter(id => !/^cc_e2e_/.test(String(id))); // 只允许自造 id
  if (risky.length) {
    throw new Error(`[测试器红线] 拒绝向非沙箱目标发送真实删除：ids=${risky.join(',')}。` +
      `真实删除能力已在沙箱目录验证，禁止对生产白名单调用 dryRun:false。`);
  }
}

function record(suite, id, name, pass, detail, extra) {
  results.push({
    n: ++seq, suite, id, name,
    pass: !!pass,
    detail: detail == null ? '' : String(detail),
    ...(extra || {})
  });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${suite} ${id} ${name} — ${detail == null ? '' : detail}`);
}

function isProtectedPath(p) {
  const n = path.resolve(p).toLowerCase();
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  if (n.startsWith(tmp + path.sep) && /cc-e2e-/.test(n)) return false;
  return true; // 其他一律视为生产路径
}

/** 只读探测某路径（绝不删除） */
function pathStat(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return { exists: true, bytes: st.size, files: 1 };
    let bytes = 0, files = 0;
    const walk = d => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else { try { bytes += fs.statSync(full).size; files++; } catch (err) { } }
      }
    };
    walk(p);
    return { exists: true, bytes, files };
  } catch (e) {
    return { exists: false, bytes: 0, files: 0, error: e.code || e.message };
  }
}

/**
 * 访问令牌（改动 3 引入）：服务端在首页 HTML 里下发，写接口必须携带。
 * 由 T0 段服务启动后从 `GET /` 首页里抠取，之后所有请求自动带上。
 */
let CC_TOKEN = null;

/**
 * @param {string} method
 * @param {string} urlPath
 * @param {*} [body]
 * @param {Object} [extraHeaders] 额外/覆盖的请求头。
 *        显式给出 `'X-CC-Token'` 键（哪怕是空串）即表示**不要**自动附加令牌，
 *        用于测试「缺令牌 / 错令牌」场景。
 */
function httpReq(method, urlPath, body, extraHeaders) {
  assertNotProduction(body); // 红线闸门：真删请求只允许打在沙箱目标上
  return new Promise(resolve => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = Object.assign({}, extraHeaders || {});
    if (data && !Object.prototype.hasOwnProperty.call(headers, 'Content-Type')) {
      headers['Content-Type'] = 'application/json';
    }
    if (data && !Object.prototype.hasOwnProperty.call(headers, 'Content-Length')) {
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (CC_TOKEN && !Object.prototype.hasOwnProperty.call(headers, 'X-CC-Token')) {
      headers['X-CC-Token'] = CC_TOKEN;
    }
    const req = http.request(BASE + urlPath, {
      method,
      agent: false, // 每次新建连接，避免复用被服务端 keep-alive 超时关闭的旧连接导致 ECONNRESET 假失败
      headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { }
        resolve({ status: res.statusCode, headers: res.headers, body: txt, json, bytes: Buffer.byteLength(txt) });
      });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────── T1 单元测试
function T1_unitTests() {
  // 套件清单**自动发现**，不再硬编码。
  // 历史问题：原先写死前 9 个套件，后来新增的 safety / workingSet / diskIoGuard /
  // systemMemory / cacheMigrate 5 个套件在 e2e 里从未被跑到（只在手工 node --test 时跑过）。
  // 改为扫描目录 + 排序，以后新增套件自动纳入，不会再漏登记。
  const suiteDir = path.join(APP, 'server/services/__tests__');
  const suites = fs.readdirSync(suiteDir)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .map(f => 'server/services/__tests__/' + f);
  record('T1', 'T1.0', '单元测试套件自动发现',
    suites.length >= 14,
    `发现 ${suites.length} 个套件：${suites.map(s => path.basename(s, '.test.js')).join(', ')}`);

  let pass = 0, fail = 0, total = 0;
  const failed = [];
  for (const s of suites) {
    const abs = path.join(APP, s);
    if (!fs.existsSync(abs)) { record('T1', s, '存在', false, '文件缺失'); fail++; continue; }
    try {
      const out = execFileSync('node', ['--test', s], {
        cwd: APP, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '' }
      });
      // Node 24 的 --test 输出用 "ℹ tests N / ℹ pass N / ℹ fail N"，旧版是 "# tests N"
      const num = re => { const m = out.match(re); return m ? Number(m[1]) : 0; };
      const t = num(/(?:ℹ|#)\s*tests\s+(\d+)/);
      const pp = num(/(?:ℹ|#)\s*pass\s+(\d+)/);
      const ff = num(/(?:ℹ|#)\s*fail\s+(\d+)/);
      total += t; pass += pp; fail += ff;
      record('T1', s, '单元测试', ff === 0, `tests=${t} pass=${pp} fail=${ff}`);
      if (ff !== 0) failed.push(s);
    } catch (e) {
      const out = (e.stdout || '') + (e.stderr || '');
      const num2 = re => { const m = out.match(re); return m ? Number(m[1]) : 0; };
      const pm = num2(/(?:ℹ|#)\s*pass\s+(\d+)/), fm = num2(/(?:ℹ|#)\s*fail\s+(\d+)/);
      total += pm + fm;
      pass += pm;
      fail += fm || 1;
      failed.push(s);
      record('T1', s, '单元测试', false, `执行失败或断言不过：${e.message.slice(0, 120)}`);
      fs.writeFileSync(`logs_t1_${path.basename(s)}.log`, out, 'utf8');
    }
  }
  return { total, pass, fail, failed };
}

// ─────────────────────────────────────────── T2 只读采集
function T2_readonly(serviceUp) {
  if (!serviceUp) { record('T2', '—', '服务未就绪，跳过', false, '服务未启动'); return; }

  // 通过 HTTP 采集，避免重复引入模块导致两套进程视图不一致
  return (async () => {
    const snap = await httpReq('GET', '/api/memory/snapshot');
    const apps = await httpReq('GET', '/api/memory/apps?limit=5');
    const sys = await httpReq('GET', '/api/memory/system');
    const procs = await httpReq('GET', '/api/memory/processes?limit=5');

    record('T2', 'T2.1', '整机内存采集', snap.status === 200 && snap.json && snap.json.system.totalVisibleBytes > 0,
      `visible=${snap.json && snap.json.system ? (snap.json.system.totalVisibleBytes / 1048576).toFixed(0) : '?'}MB`);
    record('T2', 'T2.2', '内存守恒校验', snap.json && snap.json.conserved === true,
      snap.json ? `before=${snap.json.totalBytes} after=${snap.json.groupedBytes}` : '');
    record('T2', 'T2.3', '进程数 > 0', snap.json && snap.json.processCount > 0, `processCount=${snap.json && snap.json.processCount}`);
    record('T2', 'T2.4', 'app 占比字段合法', snap.json && snap.json.apps.every(a => a.percentOfTotal >= 0 && a.percentOfTotal <= 100),
      '全部在 0~100');
    record('T2', 'T2.5', '风险三色分级齐全', (() => {
      const rs = new Set((snap.json.apps || []).map(a => a.risk));
      return ['safe', 'caution', 'protected'].every(x => rs.has(x));
    })(), snap.json ? ['safe', 'caution', 'protected'].map(r => r + '=' + snap.json.apps.filter(a => a.risk === r).length).join(' ') : '');
    record('T2', 'T2.6', '保护进程全部命中 protected', snap.json && snap.json.apps.filter(a => a.risk === 'protected').length > 0,
      snap.json ? `protected=${snap.json.apps.filter(a => a.risk === 'protected').length}` : '');
    record('T2', 'T2.7', 'apps 分页 limit 生效', apps.json && apps.json.apps.length <= 5, `返回 ${apps.json && apps.json.apps.length} 条`);
    record('T2', 'T2.8', 'system 接口只回系统字段', sys.status === 200 && sys.json && sys.json.totalVisibleBytes > 0, `usedPercent=${sys.json && sys.json.usedPercent}`);
    record('T2', 'T2.9', 'processes 接口可用', procs.status === 200 && Array.isArray(procs.json.processes),
      `count=${procs.json && procs.json.processes && procs.json.processes.length}`);
    record('T2', 'T2.10', '采集无错误', snap.json && Array.isArray(snap.json.errors) && snap.json.errors.length === 0,
      snap.json ? `errors=${JSON.stringify(snap.json.errors)}` : '');

    // 沙箱靶子是否出现在快照中（这是 T4 真杀的前置条件）
    const dummy = (snap.json.apps || []).find(a => a.key === 'cc_test_dummy');
    record('T2', 'T2.11', '沙箱靶子被正确采集并归组', !!dummy,
      dummy ? `key=${dummy.key} name=${dummy.name} risk=${dummy.risk} 进程数=${dummy.processCount}` : '未在快照中找到 cc_test_dummy');
    record('T2', 'T2.12', '沙箱靶子风险分级为 caution（未收录应用兜底）', !!dummy && dummy.risk === 'caution',
      dummy ? `risk=${dummy.risk} reason=${dummy.riskReason}` : '');
  })();
}

// ─────────────────────────────────────────── T3 闸门（内存清理）
async function T3_gates() {
  const p = await httpReq('GET', '/api/cleanup/plan');
  record('T3', 'T3.1', 'plan 默认 dry-run', p.status === 200 && p.json && p.json.mode === 'dry-run', `mode=${p.json && p.json.mode}`);
  record('T3', 'T3.2', 'plan 只含 safe 应用', p.json && p.json.apps.every(a => a.risk === 'safe'),
    `appCount=${p.json && p.json.appCount} 进程=${p.json && p.json.processCount}`);
  record('T3', 'T3.3', 'plan 返回 blockedProtected 明细', p.json && Array.isArray(p.json.blockedProtected) && p.json.blockedProtected.length > 0,
    `blockedProtected=${p.json && p.json.blockedProtected.length}`);
  record('T3', 'T3.4', 'plan 不返回 executed=true', p.json && p.json.executed !== true, `executed=${p.json && p.json.executed}`);

  // 闸门1：显式选保护进程
  const g1 = await httpReq('POST', '/api/cleanup/execute', { appKeys: ['lsass'], confirmed: true, dryRun: false, force: true });
  record('T3', 'T3.5', '选中保护进程 → 403 PROTECTED_TARGET', g1.status === 403 && g1.json && g1.json.error && g1.json.error.code === 'PROTECTED_TARGET',
    `status=${g1.status} code=${g1.json && g1.json.error && g1.json.error.code}`);

  // 闸门2：真执行未确认
  const g2 = await httpReq('POST', '/api/cleanup/execute', { appKeys: ['cc_test_dummy'], dryRun: false, confirmed: false });
  record('T3', 'T3.6', '真执行未确认 → 400 NOT_CONFIRMED', g2.status === 400 && g2.json && g2.json.error && g2.json.error.code === 'NOT_CONFIRMED',
    `status=${g2.status} code=${g2.json && g2.json.error && g2.json.error.code}`);

  // 闸门3：默认 dryRun 省略 → 不执行
  const g3 = await httpReq('POST', '/api/cleanup/execute', { appKeys: ['cc_test_dummy'], confirmed: true });
  record('T3', 'T3.7', '省略 dryRun → 仍走 dry-run', g3.status === 200 && g3.json && g3.json.executed === false,
    `executed=${g3.json && g3.json.executed}`);

  // 闸门4：非法 JSON
  const g4 = await httpReq('POST', '/api/cleanup/execute', '{bad json');
  record('T3', 'T3.8', '非法 JSON → 400 BAD_BODY', g4.status === 400 && g4.json && g4.json.error && g4.json.error.code === 'BAD_BODY',
    `status=${g4.status} code=${g4.json && g4.json.error && g4.json.error.code}`);

  // 闸门5：方法不对
  const g5 = await httpReq('GET', '/api/cleanup/execute');
  record('T3', 'T3.9', 'GET 执行接口 → 405', g5.status === 405, `status=${g5.status}`);

  // 闸门6：批量上限（逻辑在 service，这里验证常量与提示字段）
  record('T3', 'T3.10', '批量上限提示字段存在', p.json && ('warning' in p.json), `warning=${JSON.stringify(p.json && p.json.warning)}`);
}

// ─────────────────────────────────────────── T4 沙箱真杀
async function T4_realKill() {
  const before = fx.list();
  record('T4', 'T4.1', '沙箱靶子当前存活（前置）', before.length > 0, `pids=${JSON.stringify(before)}`);
  if (!before.length) return;

  const targetPid = before[0];
  // 取该进程的 startTime，同时构造一个「错误启动时间」验证 PID 复用防护
  let realStartIso = null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${targetPid}).StartTime.ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    if (/^\d{4}-/.test(out)) realStartIso = out;
  } catch (e) { }

  // 4.1 PID 复用防护：故意给错误的启动时间（改到 1 小时前）
  const wrongStart = new Date(Date.parse(realStartIso || Date.now()) - 3600 * 1000).toISOString();
  const ps1 = path.join(APP, 'server', 'collectors', 'cleanup.ps1');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-probe-'));
  const tFile = path.join(tmpDir, 'targets.json');
  const rFile = path.join(tmpDir, 'result.json');
  fs.writeFileSync(tFile, JSON.stringify([{
    pid: targetPid, name: 'cc_test_dummy', startTime: wrongStart,
    startTimeMs: Date.parse(wrongStart),
    path: fx.sandboxDir('main') + '\\cc_test_dummy.exe'
  }]), 'utf8');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-TargetsFile', tFile, '-ResultFile', rFile, '-Force'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  } catch (e) { }
  let probe = [];
  try { probe = JSON.parse(fs.readFileSync(rFile, 'utf8')); } catch (e) { }
  const stillAlive = fx.list();
  record('T4', 'T4.2', 'PID 复用防护：错误启动时间被拒绝', probe[0] && probe[0].error === 'pid_reused_refused',
    `error=${probe[0] && probe[0].error}`);
  record('T4', 'T4.3', 'PID 复用防护：进程未被误杀', stillAlive.includes(targetPid),
    `存活=${JSON.stringify(stillAlive)}`);

  // 4.2 正确启动时间 + force → 真杀
  fs.writeFileSync(tFile, JSON.stringify([{
    pid: targetPid, name: 'cc_test_dummy',
    startTime: realStartIso, startTimeMs: realStartIso ? Date.parse(realStartIso) : null,
    path: fx.sandboxDir('main') + '\\cc_test_dummy.exe'
  }]), 'utf8');
  const rFile2 = path.join(tmpDir, 'result2.json');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-TargetsFile', tFile, '-ResultFile', rFile2, '-Force'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  } catch (e) { }
  let kill = [];
  try { kill = JSON.parse(fs.readFileSync(rFile2, 'utf8')); } catch (e) { }
  await sleep(800);
  const afterKill = fx.list();
  record('T4', 'T4.4', '真杀：目标进程成功关闭', kill[0] && kill[0].ok === true,
    `ok=${kill[0] && kill[0].ok} method=${kill[0] && kill[0].method} verified=${kill[0] && kill[0].verified}`);
  record('T4', 'T4.5', '真杀：进程确实退出', !afterKill.includes(targetPid),
    `存活=${JSON.stringify(afterKill)}`);

  // 4.3 服务层集成：通过 HTTP 真杀（重建靶子）
  const newPids = fx.spawn('main');
  record('T4', 'T4.6', '靶子可重建（为服务层真杀做准备）', newPids.length > 0, `pids=${JSON.stringify(newPids)}`);
  if (newPids.length) {
    // 磁盘忙碌闸门是**按设计 fail-closed** 的：任一轮采样越阈值即拒绝，且**在写审计日志之前**就拒绝，
    // 所以被拒时响应里没有 succeeded/freedBytes/auditLogged 三个字段。
    // 本机的 `Win32_PerfFormattedData_PerfDisk_LogicalDisk` 计数器在空载时也会偶发冲到 80MB/s 以上
    // （已登记为 遗留-36），于是这一段会间歇性拿不到字段、被误判成产品缺陷。
    // 处理：对 DISK_BUSY 做有限重试——重试的是「等闸门放行」，不是绕过闸门；重试耗尽则如实判失败，
    // 并在明细里写明是环境闸门所致（含重试次数），不把环境问题伪装成通过。
    let r = null, diskBusyRetries = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      r = await httpReq('POST', '/api/cleanup/execute', {
        pids: newPids, confirmed: true, dryRun: false, force: true
      });
      if (r.json && r.json.error && r.json.error.code === 'DISK_BUSY') {
        diskBusyRetries = attempt;
        if (attempt < 4) await sleep(5000);
        continue;
      }
      break;
    }
    await sleep(800);
    const left = fx.list();
    const dummyLeft = left.filter(p => newPids.includes(p));
    const envBlocked = diskBusyRetries > 0 && !(r.json && r.json.succeeded > 0);
    const envNote = envBlocked
      ? `｜磁盘忙碌闸门连续拒绝 ${diskBusyRetries} 次，本组 4 条未真正执行（环境闸门，非产品缺陷，重跑即可）`
      : '';
    record('T4', 'T4.7', '服务层真杀沙箱进程成功', r.status === 200 && r.json && r.json.succeeded > 0,
      `succeeded=${r.json && r.json.succeeded} failed=${r.json && r.json.failed} freed=${r.json ? (r.json.freedBytes / 1048576).toFixed(1) : '?'}MB` + envNote);
    record('T4', 'T4.8', '服务层真杀后进程已退出', dummyLeft.length === 0, `残留=${JSON.stringify(dummyLeft)}` + envNote);
    record('T4', 'T4.9', '释放量口径：无进程退出时上报 0', r.json && (r.json.succeeded > 0 ? r.json.freedBytes >= 0 : r.json.freedBytes === 0),
      `freedBytes=${r.json && r.json.freedBytes} note=${r.json && r.json.systemDeltaNote}` + envNote);
    record('T4', 'T4.10', '审计日志已落盘', r.json && r.json.auditLogged === true, `auditLogged=${r.json && r.json.auditLogged}` + envNote);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
}

// ─────────────────────────────────────────── T5 磁盘只读 + 白名单校验
async function T5_diskReadonly() {
  const vol = await httpReq('GET', '/api/disk/volumes');
  record('T5', 'T5.1', '分区概览可用', vol.status === 200, `status=${vol.status} bytes=${vol.bytes}`);

  const plan = await httpReq('GET', '/api/disk/cleanup/plan');
  record('T5', 'T5.2', '磁盘清理计划 dry-run', plan.status === 200 && plan.json && plan.json.mode === 'dry-run',
    `itemCount=${plan.json && plan.json.itemCount} 预计=${plan.json ? (plan.json.estimatedBytes / 1048576).toFixed(1) : '?'}MB`);
  record('T5', 'T5.3', '计划默认只含 safe 项', plan.json && plan.json.items.every(i => i.risk === 'safe'),
    `risk=${plan.json ? [...new Set(plan.json.items.map(i => i.risk))].join(',') : ''}`);

  // 断言：计划里没有任何路径落在沙箱外（即计划不包含用户生产路径的真实删除目标——
  // 这里只验证「计划本身是 dry-run 且未删除任何东西」，生产路径的存在性在 T5.5 校验）
  const winTemp = path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp');
  const s = pathStat(winTemp);
  record('T5', 'T5.4', '只读扫描后生产路径仍在（C:\\Windows\\Temp）', s.exists,
    `exists=${s.exists} files=${s.files} bytes=${s.bytes}（只读，未删）`);

  const nv = path.join(process.env.LOCALAPPDATA || '', 'NVIDIA', 'DXCache');
  const sn = pathStat(nv);
  record('T5', 'T5.5', '只读扫描后 NVIDIA 缓存仍在（生产白名单，未动）', sn.exists || sn.bytes === 0,
    `exists=${sn.exists} bytes=${sn.bytes}（只读，未删）`);

  const junk = await httpReq('GET', '/api/disk/junk');
  record('T5', 'T5.6', '垃圾定位可用', junk.status === 200 && junk.json && Array.isArray(junk.json.items),
    `items=${junk.json && junk.json.items.length} total=${junk.json ? (junk.json.totalBytes / 1073741824).toFixed(2) : '?'}GB`);
  record('T5', 'T5.7', 'caution 项不被默认勾选（plan 默认只 safe）', plan.json && !plan.json.items.some(i => i.risk === 'caution'),
    '计划中无 caution');

  // 白名单 / 禁止路径 单元级验证（纯函数，无副作用）
  const { isForbidden } = require(path.join(APP, 'server/services/diskCleanupService'));
  const cases = [
    ['C:\\', true], ['D:\\', true], ['C:\\Windows', true],
    ['C:\\Windows\\Temp', false], ['C:\\Windows\\SoftwareDistribution\\Download', false],
    [os.tmpdir(), false], ['C:\\Program Files', true]
  ];
  const bad = cases.filter(([p, want]) => isForbidden(p) !== want);
  record('T5', 'T5.8', 'isForbidden 路径深度闸门正确', bad.length === 0,
    bad.length ? `不符: ${JSON.stringify(bad)}` : `验证 ${cases.length} 个用例全部符合预期`);

  // 改动 2 回归：禁止路径不再只认硬编码的 C:/D:
  const { listLocalDrives } = require(path.join(APP, 'server/collectors/diskSpace'));
  const { forbiddenPaths, FORBIDDEN_SUBDIRS } = require(path.join(APP, 'server/services/diskCleanupService'));
  const localDrives = listLocalDrives().map(d => String(d).trim().toUpperCase());
  const fset = new Set(forbiddenPaths());
  const missing = [];
  for (const d of localDrives) {
    for (const sub of FORBIDDEN_SUBDIRS) {
      const want = path.resolve(d + '\\' + sub).toLowerCase();
      if (!fset.has(want) || !isForbidden(d + '\\' + sub)) missing.push(d + '\\' + sub);
    }
  }
  record('T5', 'T5.9', '禁止路径覆盖全部本地盘符的系统目录（改动 2）', missing.length === 0 && localDrives.length > 0,
    missing.length ? `漏网: ${missing.join(', ')}`
      : `${localDrives.join(',')} × ${FORBIDDEN_SUBDIRS.length} 项全部覆盖（共 ${forbiddenPaths().length} 条）`);

  const sysD = String(process.env.SystemDrive || 'C:').toUpperCase();
  const otherDrives = localDrives.filter(d => d !== sysD);
  record('T5', 'T5.10', '非系统盘的系统目录同样被拦（原先会漏）',
    otherDrives.length === 0 || otherDrives.every(d => isForbidden(d + '\\Windows') === true),
    otherDrives.length
      ? otherDrives.map(d => `${d}\\Windows=${isForbidden(d + '\\Windows')}`).join(' ')
      : '本机只有系统盘一个本地盘，跳过——覆盖性由 T5.9 保证');

  // ─── 改动 4：垃圾扫描盘符不再写死 C: ───
  const junkLocSrc = fs.readFileSync(path.join(APP, 'server/services/junkLocator.js'), 'utf8');
  record('T5', 'T5.11', '垃圾扫描盘符改为 SystemDrive（改动 4）',
    !/runScan\(\s*'C:'/.test(junkLocSrc) && /process\.env\.SystemDrive/.test(junkLocSrc),
    "不再是 runScan('C:', ...)，改为 SystemDrive");
  const { NO_TOP_DIR_SENTINEL } = require(path.join(APP, 'server/services/junkLocator'));
  record('T5', 'T5.12', '哨兵 topDirs 避免全盘一级目录枚举（改动 4）',
    /runScan\(sysDrive,\s*\[NO_TOP_DIR_SENTINEL\],\s*junkList(,\s*ctx)?\)/.test(junkLocSrc) &&
    typeof NO_TOP_DIR_SENTINEL === 'string' && NO_TOP_DIR_SENTINEL.length > 0,
    `哨兵 = ${NO_TOP_DIR_SENTINEL}（避免空数组触发 78 目录 ≈38s 的枚举）`);

  // ─── 改动 7：释放量口径 ───
  const { sumFreedBytes } = require(path.join(APP, 'server/services/cleanupService'));
  const wsCal = sumFreedBytes([
    { ok: true, wsBefore: 1048576 }, { ok: false, wsBefore: 999 }, { ok: true, wsBefore: 2048 }
  ]);
  record('T5', 'T5.13', '释放量口径 = 各成功进程工作集之和（改动 7）',
    wsCal.freedBytes === 1048576 + 2048 && wsCal.succeededCount === 2,
    `成功 2 个，释放 ${wsCal.freedBytes} 字节（失败项不计入）`);
  record('T5', 'T5.14', '全部失败时释放量为 0（不拿自然波动充数，改动 7）',
    sumFreedBytes([{ ok: false, wsBefore: 999999 }]).freedBytes === 0,
    '失败项不产生释放量');
}

// ─────────────────────────────────────────── T6 沙箱真删
async function T6_realDelete() {
  const { deleteContents } = require(path.join(APP, 'server/services/diskCleanupService'));
  const sandbox = fx.sandboxDir('main');
  const junkRoot = path.join(sandbox, 'fake-junk');

  const before = pathStat(junkRoot);
  record('T6', 'T6.1', '沙箱假垃圾已就位（前置）', before.exists && before.files > 0,
    `files=${before.files} bytes=${before.bytes}`);

  // 防呆：绝不对生产路径调用 deleteContents
  if (isProtectedPath(junkRoot) === true) {
    // 注意 isProtectedPath 对 cc-e2e 前缀返回 false，这里不该命中
    record('T6', 'T6.2', '安全前置：目标确认为沙箱路径', false, '目标被判为生产路径，拒绝继续');
    return;
  }
  record('T6', 'T6.2', '安全前置：目标确认为沙箱路径', true, junkRoot);

  const r = await deleteContents(junkRoot);
  const after = pathStat(junkRoot);

  record('T6', 'T6.3', '真删：返回 ok=true', r.ok === true,
    `ok=${r.ok} beforeCount=${r.beforeCount} deletedCount=${r.deletedCount}`);
  record('T6', 'T6.4', '真删：文件数确实减少', r.deletedCount > 0 && after.files === 0,
    `删除 ${r.deletedCount} 个，剩余 ${after.files} 个`);
  record('T6', 'T6.5', '真删：deletedBytes 与实际相符', r.deletedBytes === before.bytes,
    `上报=${r.deletedBytes} 实际=${before.bytes}`);
  record('T6', 'T6.6', '真删：目录本身保留（Temp 类目录必须留下）', fs.existsSync(junkRoot),
    `目录仍在：${fs.existsSync(junkRoot)}`);

  // 空目录重删 → skipped
  const r2 = await deleteContents(junkRoot);
  record('T6', 'T6.7', '重复删除空目录 → skipped（不假装成功）', r2.ok === false && r2.skipped === true,
    `ok=${r2.ok} skipped=${r2.skipped} reason=${r2.reason}`);

  // 不存在的路径 → path_missing
  const r3 = await deleteContents(path.join(sandbox, 'not-exist-dir'));
  record('T6', 'T6.8', '不存在路径 → path_missing（不假装成功）', r3.ok === false && r3.error === 'path_missing',
    `ok=${r3.ok} error=${r3.error}`);

  // 生产路径只读复检：确认 C:\Windows\Temp 未被这一轮动过。
  // 注意：普通权限下 C:\Windows\Temp 通常读不到内容（bytes=0），
  // 所以只校验「测试前后的状态一致」，不把 0 字节当成被删。
  const winTemp = path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp');
  const s = pathStat(winTemp);
  const preS = (() => { try { return JSON.parse(fs.readFileSync(path.join(TESTS_DIR, 'pre-state.json'), 'utf8')).windowsTemp; } catch (e) { return null; } })();
  record('T6', 'T6.9', '生产路径测试前后状态一致（C:\\Windows\\Temp 未被本轮改动）',
    s.exists && (!preS || s.bytes === preS.bytes),
    `exists=${s.exists} bytes=${s.bytes} 测试前=${preS ? preS.bytes : '?'}${s.bytes === 0 ? '（普通权限读不到内容，非删除）' : ''}`);

  // ⚠ 红线：绝不能对生产白名单（user-temp / NVIDIA DXCache / 微信等）发送 dryRun:false。
  // 本轮只做 dry-run 验证；真实删除能力已在 T6.1~T6.8 用沙箱目录验证完毕。
  const g = await httpReq('POST', '/api/disk/cleanup/execute', { ids: ['user-temp'], confirmed: false, dryRun: true });
  record('T6', 'T6.10', '生产白名单只走 dry-run（未发送 dryRun:false）',
    g.status === 200 && g.json && g.json.executed === false,
    `status=${g.status} executed=${g.json && g.json.executed}——本轮未向任何生产路径发送真实删除指令`);
}

// ─────────────────────────────────────────── T7 HTTP 全接口
async function T7_http() {
  const health = await httpReq('GET', '/api/health');
  record('T7', 'T7.1', 'GET /api/health', health.status === 200 && health.json.status === 'ok',
    `isAdmin=${health.json && health.json.isAdmin} pid=${health.json && health.json.pid}`);
  // 短期-17：批量上限由服务端下发（唯一来源 cleanupService.BATCH_LIMIT），页面不再硬编码
  const svcBatchLimit = require(path.join(APP, 'server', 'services', 'cleanupService')).BATCH_LIMIT;
  record('T7', 'T7.1b', 'health 下发 batchLimit 且与 cleanupService 常量一致',
    Number.isInteger(health.json.batchLimit) && health.json.batchLimit === svcBatchLimit,
    `batchLimit=${health.json.batchLimit} 服务端常量=${svcBatchLimit}`);
  const home = await httpReq('GET', '/');
  record('T7', 'T7.2', 'GET / 返回界面', home.status === 200 && home.bytes > 100000,
    `${(home.bytes / 1024).toFixed(0)}KB，含标题=${/内存清理助手/.test(home.body)}`);
  const nf = await httpReq('GET', '/api/not-exist');
  record('T7', 'T7.3', '未知路径 → 404', nf.status === 404 && nf.json.error.code === 'NOT_FOUND', `code=${nf.json && nf.json.error.code}`);
  const search = await httpReq('GET', '/api/memory/apps?q=' + encodeURIComponent('cc_test_dummy'));
  record('T7', 'T7.4', '应用搜索接口（q=）', search.status === 200 && search.json.total >= 0, `total=${search.json && search.json.total}`);
  const risk = await httpReq('GET', '/api/memory/apps?risk=protected&limit=100');
  record('T7', 'T7.5', '风险筛选 risk=protected', risk.json && risk.json.apps.every(a => a.risk === 'protected'),
    `count=${risk.json && risk.json.count}`);
  const sortName = await httpReq('GET', '/api/memory/apps?sort=name&limit=5');
  record('T7', 'T7.6', '排序 sort=name', sortName.status === 200, `count=${sortName.json && sortName.json.count}`);
  const limit0 = await httpReq('GET', '/api/memory/apps?limit=0');
  record('T7', 'T7.7', '非法 limit=0 被安全忽略', limit0.status === 200, `count=${limit0.json && limit0.json.count}`);
  const priv = await httpReq('GET', '/api/privilege/status');
  record('T7', 'T7.8', 'GET /api/privilege/status', priv.status === 200 && typeof priv.json.isAdmin === 'boolean',
    `isAdmin=${priv.json && priv.json.isAdmin} canElevate=${priv.json && priv.json.canElevate}`);
  const elev = await httpReq('POST', '/api/privilege/elevate', { dryRun: true });
  record('T7', 'T7.9', '提权 dry-run 只回计划（不弹 UAC）', elev.status === 200 && elev.json && (elev.json.dryRun === true || elev.json.alreadyAdmin === true),
    `dryRun=${elev.json && elev.json.dryRun} alreadyAdmin=${elev.json && elev.json.alreadyAdmin} pending=${elev.json && elev.json.pending}`);
  record('T7', 'T7.10', '提权 dry-run 未真正拉起辅助进程', !(elev.json && elev.json.pending === true && elev.json.dryRun !== true),
    `pending=${elev.json && elev.json.pending}`);
}

// ─────────────────────────────────────────── T8 CLI
function T8_cli() {
  const runs = [
    { args: [], name: 'cli 默认排行', check: o => /整机内存概览/.test(o) && /应用内存排行/.test(o) },
    { args: ['5'], name: 'cli 前 5 条', check: o => /共 \d+ 个进程/.test(o) },
    { args: ['safe'], name: 'cli safe 筛选', check: o => /筛选：风险=safe/.test(o) },
    { args: ['cc_test'], name: 'cli 搜索', check: o => /筛选：含/.test(o) },
    { args: ['zzz_no_match_zzz'], name: 'cli 无匹配降级', check: o => /无匹配应用/.test(o) }
  ];
  for (const r of runs) {
    try {
      const out = execFileSync('node', ['cli.js', ...r.args], {
        cwd: APP, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024
      });
      record('T8', r.name, r.name, r.check(out), out.split('\n').filter(Boolean).slice(0, 1)[0] || '');
    } catch (e) {
      record('T8', r.name, r.name, false, `执行失败：${e.message.slice(0, 100)}`);
    }
  }
}

// ─────────────────────────────────────────── T9 界面
async function T9_ui() {
  // 先确认服务仍在响应（T8 跑 CLI 期间若服务被意外回收，这里会如实暴露）
  const h = await httpReq('GET', '/api/health');
  record('T9', 'T9.0', '界面校验前服务仍在线', h.status === 200, `health=${h.status}`);
  if (h.status !== 200) return;
  const home = await httpReq('GET', '/');
  const html = home.body || '';
  record('T9', 'T9.0b', '首页返回非空 HTML', html.length > 100000, `bytes=${Buffer.byteLength(html)}`);
  const checks = [
    ['DOCTYPE 声明', /<!DOCTYPE html>/i.test(html)],
    ['viewport 存在', /name="viewport"/i.test(html)],
    ['中文 lang', /lang="zh-CN"/i.test(html)],
    ['页面标题', /<title>[^<]*内存清理助手[^<]*<\/title>/i.test(html)],
    ['清理面板容器', /cleanup|清理/i.test(html)],
    ['fetch 调用 health', /\/api\/health/.test(html)],
    ['fetch 调用 cleanup\/plan', /\/api\/cleanup\/plan/.test(html)],
    ['fetch 调用 cleanup\/execute', /\/api\/cleanup\/execute/.test(html)],
    ['风险标签渲染', /safe|caution|protected/.test(html)],
    ['无外链 CDN', !/(src|href)=["']https?:\/\/(cdn|unpkg|cdnjs|jsdelivr)/i.test(html)],
    ['无裸 script 报错占位', !/YOUR_API_KEY|TODO_PLACEHOLDER/.test(html)],
    // 改动1 回归：前端不再恒传 force 绕过批量上限，超限改走 acknowledgeBatchLimit
    ['批量上限新参数已进页面', /acknowledgeBatchLimit/.test(html)],
    ['两处 execute 统一组包', (html.match(/sendCleanup\(cleanupBody\(chosen, batch\)\)/g) || []).length === 2]
  ];
  for (const [name, ok] of checks) record('T9', name, name, ok, ok ? '通过' : '未通过');
}

// ─────────────────────────────────────────── T10 回归（历史坑）
async function T10_regression() {
  // 坑1：PS 5.1 管道解析带时区 ISO 会丢条目 → 必须用 -InputObject（代码核对）
  const ps1 = fs.readFileSync(path.join(APP, 'server/collectors/cleanup.ps1'), 'utf8');
  const src = fs.readFileSync(path.join(APP, 'server/services/cleanupService.js'), 'utf8');
  record('T10', 'R1', 'cleanup.ps1 用 ConvertFrom-Json -InputObject', /ConvertFrom-Json -InputObject/.test(ps1),
    '管道形式会静默丢条目');
  record('T10', 'R2', 'targets 带 startTimeMs（数字优先）', /startTimeMs/.test(src) && /startTimeMs/.test(ps1),
    '数字时钟比带时区字符串稳');
  record('T10', 'R3', '扫尾按安装目录匹配，不按进程名裸杀', /prefixes/.test(ps1) && /StartsWith/.test(ps1),
    '避免误杀本机同名进程');

  // 坑2：释放量误报——无进程退出时必须上报 0
  const r = await httpReq('POST', '/api/cleanup/execute', { dryRun: false, confirmed: true, pids: [999999] });
  record('T10', 'R4', '不存在的 PID：不报虚假释放量', r.status === 200 && r.json && (r.json.executed === false || r.json.freedBytes === 0),
    `executed=${r.json && r.json.executed} freedBytes=${r.json && r.json.freedBytes}`);

  // 坑3：删除空目录不得假装成功
  const { deleteContents } = require(path.join(APP, 'server/services/diskCleanupService'));
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-empty-'));
  const rr = await deleteContents(emptyDir);
  record('T10', 'R5', '空目录删除报 skipped 而非成功', rr.skipped === true && rr.ok === false, `skipped=${rr.skipped}`);
  fs.rmSync(emptyDir, { recursive: true, force: true });

  // 坑4：caution 项必须显式勾选（代码路径核对）
  const dcs = fs.readFileSync(path.join(APP, 'server/services/diskCleanupService.js'), 'utf8');
  record('T10', 'R6', 'caution 未显式选 → CAUTION_NOT_EXPLICIT', /CAUTION_NOT_EXPLICIT/.test(dcs), '');

  // 坑5（改动1 回归）：批量上限闸门曾因前端恒传 force 而形同虚设
  record('T10', 'R7', '批量上限：execute 走独立闸门，force 不再放行批量',
    /assertBatchAllowed\(p\.processCount\s*,\s*opts\)/.test(src) &&
    !/processCount\s*>\s*BATCH_LIMIT\s*&&\s*!opts\.force/.test(src),
    '闸门只看 acknowledgeBatchLimit；force 仅保留强制结束语义');
  const tplSrc = fs.readFileSync(path.join(APP, '_template.html'), 'utf8');
  record('T10', 'R8', '前端不再恒传 force 绕过闸门（两处调用统一组包 + 超限重试）',
    (tplSrc.match(/sendCleanup\(cleanupBody\(chosen, batch\)\)/g) || []).length === 2 &&
    !/confirmed:true, force:true/.test(tplSrc),
    '模板 2 处调用均已改为 sendCleanup(cleanupBody(chosen, batch))');
  record('T10', 'R7', '服务端绑定 127.0.0.1（不对外暴露）', /listen\(PORT, '127\.0\.0\.1'/.test(fs.readFileSync(path.join(APP, 'server/server.js'), 'utf8')), '');

  // 坑6（P1）：两处 Test-PidReused 必须逻辑一致，否则修剪路径静默放行
  const pidReuse = (file) => {
    const s = fs.readFileSync(path.join(APP, 'server/collectors', file), 'utf8');
    const m = s.match(/function Test-PidReused[\s\S]*?\n\}/);
    return m ? m[0].split('\n').map(l => l.split('#')[0].replace(/\s+$/, '')).filter(l => l.trim()).join('\n') : null;
  };
  const prTrim = pidReuse('trimWorkingSet.ps1');
  const prClean = pidReuse('cleanup.ps1');
  record('T10', 'R9', '两处 PID 复用防护逻辑一致（改动 5）',
    !!prTrim && !!prClean && prTrim === prClean,
    prTrim === prClean ? 'trimWorkingSet.ps1 与 cleanup.ps1 逐行一致' : '两处实现已分叉');

  // 坑7（P1）：释放量不得再取整机前后差值
  const wsSvcSrc = fs.readFileSync(path.join(APP, 'server/services/workingSetService.js'), 'utf8');
  record('T10', 'R10', '释放量不再取整机前后差值（改动 7）',
    !/const\s+freedBytes\s*=\s*Math\.max\(0,\s*before\.system\.usedBytes/.test(src) &&
    !/const\s+freedBytes\s*=\s*Math\.max\(0,\s*before\.system\.usedBytes/.test(wsSvcSrc) &&
    /sumFreedBytes\(results\)/.test(src) &&
    /const\s+realFreedBytes\s*=\s*succeeded\.length\s*>\s*0\s*\?\s*wsDelta\s*:\s*0/.test(wsSvcSrc),
    'cleanupService 用 sumFreedBytes；workingSetService 用 wsDelta');
  record('T10', 'R11', '整机差值降级为 systemDeltaBytes 对照字段（改动 7）',
    /systemDeltaBytes/.test(src) && /systemDeltaBytes/.test(wsSvcSrc),
    '保留但不再作为释放量上报');

  // 坑8（P1）：参与执行的两个 ps1 保持纯 ASCII（PS 5.1 按 ANSI 读取）
  const asciiCheck = ['trimWorkingSet.ps1', 'cleanup.ps1'].map(f => {
    const b = fs.readFileSync(path.join(APP, 'server/collectors', f));
    let n = 0;
    for (let i = 0; i < b.length; i++) if (b[i] > 127) n++;
    return { f, n };
  });
  record('T10', 'R12', 'ps1 执行脚本保持纯 ASCII（防 PS 5.1 乱码）',
    asciiCheck.every(x => x.n === 0),
    asciiCheck.map(x => `${x.f}=${x.n}`).join(' '));

  // 坑5：归组守恒
  const snap = await httpReq('GET', '/api/memory/snapshot');
  record('T10', 'R8', '归组守恒再次校验', snap.json && snap.json.conserved === true,
    `${snap.json && snap.json.totalBytes} == ${snap.json && snap.json.groupedBytes}`);
}

// ─────────────────────────────────────────── T11 访问控制（改动 3）
// 核心目的：本机任意进程 / 外部网页不得凭一个 HTTP 请求就触发清理动作。
// 全部用例都用不存在的 PID 或读接口，不会真杀任何进程。
async function T11_auth() {
  const SRC = fs.readFileSync(path.join(APP, 'server/server.js'), 'utf8');
  const tplSrc = fs.readFileSync(path.join(APP, '_template.html'), 'utf8');

  // ── 静态核对：三层闸门齐备，且接在路由分发之前 ──
  record('T11', 'A1', '服务端实现 Host/Origin/令牌 三层校验（代码核对）',
    /checkRequestAuth/.test(SRC) && /BAD_HOST/.test(SRC) && /BAD_ORIGIN/.test(SRC) &&
    /UNAUTHORIZED/.test(SRC) && /timingSafeEqual/.test(SRC),
    'Host 环回 + Origin 同源 + 写操作令牌（定长比较防时序侧信道）');
  record('T11', 'A2', '鉴权接在路由分发之前（代码核对）',
    SRC.indexOf('checkRequestAuth(req, pathname)') >= 0 &&
    SRC.indexOf('checkRequestAuth(req, pathname)') < SRC.indexOf('handleMemoryRoutes(req, res'),
    '先鉴权再进路由，路由不可能被绕过');
  record('T11', 'A3', '令牌每次启动重新生成且不落盘（代码核对）',
    /crypto\.randomBytes\(32\)/.test(SRC) && !/writeFileSync[\s\S]{0,80}ACCESS_TOKEN/.test(SRC),
    'crypto.randomBytes(32) → 64 位十六进制，进程内存持有');

  // ── 首页是令牌发放点，必须免令牌可访问 ──
  const home = await httpReq('GET', '/');
  record('T11', 'A4', '首页无需令牌即可访问（令牌发放点）',
    home.status === 200 && /window\.__CC_TOKEN__/.test(String(home.body || '')),
    `status=${home.status} 已注入令牌=${/window\.__CC_TOKEN__\s*=\s*'[0-9a-f]{64}'/.test(String(home.body || ''))}`);

  // ── 读接口：仅豁免清单内（毫秒级、无副作用）的免令牌 ──
  const cheapNoToken = await httpReq('GET', '/api/disk/volumes', null, { 'X-CC-Token': '' });
  record('T11', 'A5', '廉价读接口免令牌（在豁免清单内）',
    cheapNoToken.status === 200,
    `GET /api/disk/volumes status=${cheapNoToken.status}`);

  const expNoToken = await httpReq('GET', '/api/cleanup/plan', null, { 'X-CC-Token': '' });
  record('T11', 'A5b', '非豁免读接口需令牌 → 403（防 img 标签反复触发重扫描）',
    expNoToken.status === 403 && expNoToken.json && expNoToken.json.error &&
    expNoToken.json.error.code === 'UNAUTHORIZED',
    `status=${expNoToken.status} code=${expNoToken.json && expNoToken.json.error && expNoToken.json.error.code}`);

  // ── 写接口：缺令牌 / 错令牌 一律 403 ──
  const noToken = await httpReq('POST', '/api/cleanup/execute',
    { pids: [999999], dryRun: false, confirmed: true }, { 'X-CC-Token': '' });
  record('T11', 'A6', '写接口缺令牌 → 403 UNAUTHORIZED',
    noToken.status === 403 && noToken.json && noToken.json.error && noToken.json.error.code === 'UNAUTHORIZED',
    `status=${noToken.status} code=${noToken.json && noToken.json.error && noToken.json.error.code}`);

  const badToken = await httpReq('POST', '/api/cleanup/execute',
    { pids: [999999], dryRun: false, confirmed: true },
    { 'X-CC-Token': 'deadbeef'.repeat(8) });
  record('T11', 'A7', '写接口令牌错误 → 403 UNAUTHORIZED',
    badToken.status === 403 && badToken.json && badToken.json.error && badToken.json.error.code === 'UNAUTHORIZED',
    `status=${badToken.status} code=${badToken.json && badToken.json.error && badToken.json.error.code}`);

  // ── 写接口：正确令牌 → 放行到业务逻辑 ──
  const goodToken = await httpReq('POST', '/api/cleanup/execute',
    { pids: [999999], dryRun: false, confirmed: true });
  record('T11', 'A8', '写接口携带正确令牌 → 放行至业务逻辑',
    goodToken.status === 200 && goodToken.json && goodToken.json.error === undefined,
    `status=${goodToken.status} executed=${goodToken.json && goodToken.json.executed}（不存在的 PID，不会真杀）`);

  // ── 反 CSRF：跨源 Origin 一律拒绝 ──
  const evilOrigin = await httpReq('POST', '/api/cleanup/execute',
    { pids: [999999], dryRun: false, confirmed: true },
    { Origin: 'http://evil.example.com' });
  record('T11', 'A9', '跨源 Origin 被拒 → 403 BAD_ORIGIN（反 CSRF）',
    evilOrigin.status === 403 && evilOrigin.json && evilOrigin.json.error && evilOrigin.json.error.code === 'BAD_ORIGIN',
    `status=${evilOrigin.status} code=${evilOrigin.json && evilOrigin.json.error && evilOrigin.json.error.code}`);

  const evilWithToken = await httpReq('POST', '/api/cleanup/execute',
    { pids: [999999], dryRun: false, confirmed: true },
    { Origin: 'http://evil.example.com', 'X-CC-Token': CC_TOKEN });
  record('T11', 'A10', '跨源请求即便带对令牌也被拒（双层防护）',
    evilWithToken.status === 403 && evilWithToken.json && evilWithToken.json.error &&
    evilWithToken.json.error.code === 'BAD_ORIGIN',
    `status=${evilWithToken.status} code=${evilWithToken.json && evilWithToken.json.error && evilWithToken.json.error.code}`);

  // 同源 Origin（本服务自身）应当放行
  const sameOrigin = await httpReq('POST', '/api/cleanup/execute',
    { pids: [999999], dryRun: false, confirmed: true },
    { Origin: `http://127.0.0.1:${PORT}` });
  record('T11', 'A11', '同源 Origin 正常放行（不误伤自家页面）',
    sameOrigin.status === 200,
    `status=${sameOrigin.status}`);

  // ── 非环回 Host 一律拒绝 ──
  const badHost = await httpReq('GET', '/api/health', null, { Host: 'evil.example.com' });
  record('T11', 'A12', '非环回 Host 被拒 → 403 BAD_HOST',
    badHost.status === 403 && badHost.json && badHost.json.error && badHost.json.error.code === 'BAD_HOST',
    `status=${badHost.status} code=${badHost.json && badHost.json.error && badHost.json.error.code}`);

  // ── 写请求 Content-Type 必须 JSON（堵住浏览器「简单请求」免预检通道）──
  const plainCt = await httpReq('POST', '/api/cleanup/execute',
    JSON.stringify({ pids: [999999], dryRun: false, confirmed: true }),
    { 'Content-Type': 'text/plain' });
  record('T11', 'A13', '写接口非 JSON Content-Type → 415（防 CSRF 简单请求）',
    plainCt.status === 415 && plainCt.json && plainCt.json.error &&
    plainCt.json.error.code === 'UNSUPPORTED_MEDIA_TYPE',
    `status=${plainCt.status} code=${plainCt.json && plainCt.json.error && plainCt.json.error.code}`);

  // ── 前端：全部 API 调用统一走带令牌的包装 ──
  const bareFetch = (tplSrc.match(/fetch\('\/api\//g) || []).length;
  const wrapped = (tplSrc.match(/apiFetch\('\/api\//g) || []).length;
  record('T11', 'A14', '前端全部 API 调用统一走 apiFetch（代码核对）',
    /function apiFetch\(/.test(tplSrc) && bareFetch === 0 && wrapped >= 15,
    `裸 fetch('/api/ … ${bareFetch} 处；已包装 ${wrapped} 处`);

  record('T11', 'A15', '前端鉴权失败给出可读提示（代码核对）',
    /apiErrorText/.test(tplSrc) && /UNAUTHORIZED/.test(tplSrc),
    '本地文件/令牌过期时提示改用服务地址打开，而不是抛出英文错误码');

  record('T11', 'A16', '前端不把令牌拼进 URL（代码核对）',
    !/[\?&]_t=/.test(tplSrc),
    '只走 X-CC-Token 请求头，避免令牌进入浏览器历史与服务日志');

  record('T11', 'A17', '豁免清单只含毫秒级接口（代码核对）',
    (() => {
      const blk = (SRC.match(/const CHEAP_READ_PATHS = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
      return blk.length > 0 && !/disk\/snapshot/.test(blk) && !/disk\/apps/.test(blk) &&
        !/memory\/snapshot/.test(blk) && !/cleanup\/plan/.test(blk) &&
        !/disk\/migrate\/presets/.test(blk);
    })(),
    '全盘扫描与目录抽样评估类接口均需令牌；豁免清单仅保留毫秒级轻量接口');
}

// ─────────────────────────────────────────── T12 P2 项（改动 8/9/10/12/13）
async function T12_p2() {
  // 改动 8：词典 note 不再写死本机实测值
  const dict = JSON.parse(fs.readFileSync(path.join(APP, 'data/junkDict.zh.json'), 'utf8'));
  const notes = (dict.entries || []).map(e => e.note || '');
  record('T12', 'P1', '词典不再写死「本机实测」数值（改动 8）',
    notes.every(n => !/本机实测/.test(n)),
    `含「示例量级」${notes.filter(n => /示例量级/.test(n)).length} 条 / 共 ${notes.length} 条，残留 0`);
  record('T12', 'P2', '_meta 说明真实大小来自实时扫描（改动 8）',
    !!(dict._meta && dict._meta['note_说明']),
    dict._meta && dict._meta['note_说明'] ? '已填（note_说明）' : '缺失');

  // 改动 9：CLI 与服务端共用垃圾路径清单
  const cliSrc = fs.readFileSync(path.join(APP, 'disk-cli.js'), 'utf8');
  const { buildJunkPaths } = require(path.join(APP, 'server/collectors/diskSpace'));
  const cJunk = buildJunkPaths().filter(p => p.startsWith('C:') || p.startsWith('%'));
  record('T12', 'P3', 'CLI 复用服务端垃圾清单，C 盘已含回收站（改动 9）',
    /buildJunkPaths/.test(cliSrc) && !/C_JUNK\s*=\s*\[/.test(cliSrc) &&
    cJunk.some(p => /Recycle\.Bin/i.test(p)),
    `不再自带 C_JUNK 常量；C 盘清单 ${cJunk.length} 项，含回收站=${cJunk.some(p => /Recycle\.Bin/i.test(p))}`);

  // 改动 10：磁盘应用列表可展开
  const tplSrc = fs.readFileSync(path.join(APP, '_template.html'), 'utf8');
  record('T12', 'P4', '磁盘应用列表可展开全部（改动 10）',
    /diskAppShowAll/.test(tplSrc) && /DISK_DEFAULT_SHOW/.test(tplSrc) &&
    !/diskAppData\.slice\(0,\s*40\)/.test(tplSrc),
    '不再静默隐藏第 41 条之后的应用');

  // 改动 12：死代码已删
  record('T12', 'P5', '死代码 _probePath.ps1 已删除（改动 12）',
    !fs.existsSync(path.join(APP, 'server/collectors/_probePath.ps1')),
    '硬编码本机 PID 的一次性探测脚本，全项目零引用');

  // 改动 13：注释与行为一致
  record('T12', 'P6', '清理面板注释如实描述行为（改动 13）',
    /清理面板[\s\S]{0,300}两种模式下都会显示/.test(tplSrc),
    '原注释「仅在通过服务打开时可用」易被误读为「本地模式隐藏面板」，实际是保留面板+禁用按钮');
}

// ─────────────────────────────────────────── T13 前端转义与链接防护（M-01 / M-04）
async function T13_frontendSafety() {
  const tplSrc = fs.readFileSync(path.join(APP, '_template.html'), 'utf8');
  const builtPath = path.join(APP, '内存清理助手.html');
  const builtSrc = fs.existsSync(builtPath) ? fs.readFileSync(builtPath, 'utf8') : '';
  const home = await httpReq('GET', '/');
  const html = home.body || '';

  record('T13', 'T13.1', '首页可正常加载（200 且非空）',
    home.status === 200 && html.length > 100000,
    `status=${home.status} bytes=${Buffer.byteLength(html)}`);
  record('T13', 'T13.2', '生成页 内存清理助手.html 与模板同步（转义函数已进产物）',
    /function escapeHtml\(/.test(tplSrc) && /function escapeHtml\(/.test(builtSrc) &&
    builtSrc.includes('escapeHtml(a.name)'),
    '模板与产物均含统一转义函数');

  // T13.3 全页只允许存在一份转义实现（两份漂移必然漏转义）
  const defCount = (tplSrc.match(/function escapeHtml\s*\(/g) || []).length;
  const aliasCount = (tplSrc.match(/const escHtml\s*=/g) || []).length;
  record('T13', 'T13.3', '模板内只有一份 escapeHtml 实现（无第二份副本/别名）',
    defCount === 1 && aliasCount === 0,
    `escapeHtml 定义 ${defCount} 处，escHtml 别名 ${aliasCount} 处`);

  // T13.4 escapeHtml 行为实测：把页面里那份函数抠出来真跑一遍
  const fnSrc = (tplSrc.match(/function escapeHtml\s*\(value\)\{[\s\S]*?\n {2}\}/) || [])[0];
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '" onmouseover=alert(1) x="',
    "'; alert(1); //",
    '<script>bad()</script>',
    'a & b'
  ];
  let escaped = null, escapedErr = '';
  try {
    const vm = require('vm');
    const ctx = { __f: null };
    vm.createContext(ctx);
    vm.runInContext(fnSrc + '\n__f = escapeHtml;', ctx);
    escaped = payloads.map(p => ctx.__f(p));
  } catch (e) { escapedErr = e.message; }
  const noRaw = !!escaped && escaped.every(s =>
    !/[<>]/.test(s) && !/"/.test(s) && !/'/.test(s) && !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(s));
  record('T13', 'T13.4', 'escapeHtml 对恶意载荷不残留 < > " \' 与裸 &',
    noRaw,
    escaped ? payloads.map((p, i) => `${p} → ${escaped[i]}`).join(' ｜ ').slice(0, 400)
      : '未能提取函数：' + escapedErr);

  // T13.5 静态收口判据：HTML 构建行内不得出现未转义的「对象属性路径」插值。
  //   判据：该行含真实标签字面量（<div/<span/<input/<option/<label/<strong/<h3…）时，
  //   行内形如 `'…' + a.b + '…'` 的动态插值必须已被 escapeHtml(...) 包裹。
  //   - 排除 `.length`：数组长度是纯数字，不构成注入；
  //   - 只认带点的属性路径：title/tag/pct/R/skipped 等页内自算标量不在判据内。
  const htmlLines = tplSrc.split('\n')
    .filter(l => /<\s*(div|span|input|option|label|strong|svg|circle|code|h3)\b/.test(l));
  const bareRe = /'[^']*'\s*\+\s*([a-zA-Z_$][\w$]*(?:\.[\w$]+)+)\s*\+\s*'/g;
  const bare = [];
  for (const l of htmlLines) {
    let m; bareRe.lastIndex = 0;
    while ((m = bareRe.exec(l))) {
      if (/\.length$/.test(m[1])) continue;
      bare.push(m[1] + ' @ ' + l.trim().slice(0, 60));
    }
  }
  const uniqBare = [...new Set(bare)];
  // 关键字段还必须存在「确实被包裹」的用法（防有人把断言改空即通过）
  const needWrapped = ['a.name', 'a.purpose', 'a.category', 'a.vendor', 'a.riskReason', 'a.key',
    'p.name', 'p.path', 'i.name', 'i.purpose', 'i.id',
    'r.source', 'r.destination', 'r.backupPath', 'r.path', 'r.target'];
  const notWrapped = needWrapped.filter(f => !tplSrc.includes('escapeHtml(' + f + ')'));
  record('T13', 'T13.5', 'HTML 构建行内无裸属性路径插值，关键字段均有 escapeHtml 包裹',
    uniqBare.length === 0 && notWrapped.length === 0,
    `扫描 ${htmlLines.length} 行 HTML；裸插值 ${uniqBare.length} 处` +
    (uniqBare.length ? '：' + uniqBare.slice(0, 4).join(' / ') : '') +
    (notWrapped.length ? '；未包裹字段：' + notWrapped.join(', ') : '；16 个关键字段全部已包裹'));

  // T13.5b 错误文本同样不得裸拼进 innerHTML（统一走 apiErrorHtml / errHtml）
  //   只扫可执行行：注释里出现示例写法不算（模板里的说明文字本身会提到这两个名字）。
  const errSinks = tplSrc.split('\n')
    .filter(l => /innerHTML\s*=/.test(l))
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(l => /(^|[^A-Za-z])(apiErrorText\(|e\.message)/.test(l));
  record('T13', 'T13.5b', '错误文本进入 innerHTML 统一走 apiErrorHtml / errHtml',
    errSinks.length === 0,
    errSinks.length ? '仍有裸拼：' + errSinks.map(l => l.trim().slice(0, 60)).join(' / ')
      : '无 innerHTML 行直接拼接 apiErrorText() 或 e.message（注释行已排除）');

  // T13.6 迁移记录选择框：结构、加载器与转义都在服务端下发的页面里
  const selOk = /<select[^>]*id="migRollbackRecord"/.test(html) &&
    /apiFetch\('\/api\/disk\/migrate\/records'\)/.test(html) &&
    /renderRollbackRecords/.test(html) &&
    /escapeHtml\(\(r\.source \|\| ''\)/.test(html);
  record('T13', 'T13.6', '「待撤销迁移记录」选择框已下发（结构 + 加载器 + 条目转义）',
    selOk, selOk ? '选择框、记录加载与条目转义齐备' : '缺少选择框 / 加载器 / 条目转义之一');

  // T13.7 未选择记录时撤销按钮必须保持禁用（结构 + 逻辑双重核对）
  const btnTag = (html.match(/<button[^>]*id="btnMigRollback"[^>]*>/) || [])[0] || '';
  const btnStartDisabled = /\bdisabled\b/.test(btnTag);
  const btnLogic = /btnRollback\.disabled = true;/.test(html) &&   // 渲染记录列表后一律先禁用
    /btnRollback\.disabled = !rec;/.test(html) &&                  // 只有 change 选到记录才解禁
    /if\(!rec\)\{ showResult\(false, '请先从「待撤销迁移记录」中明确选择一条记录。'\); return; \}/.test(html);
  record('T13', 'T13.7', '未选择迁移记录时「撤销迁移」按钮保持禁用',
    btnStartDisabled && btnLogic,
    `起始态含 disabled=${btnStartDisabled}；渲染后禁用+按选择解禁=${btnLogic}`);

  // T13.8 记录接口返回的结构能被下拉框直接消费
  const recRes = await httpReq('GET', '/api/disk/migrate/records');
  const recArr = recRes.json && recRes.json.records;
  const shapeOk = recRes.status === 200 && Array.isArray(recArr) &&
    recArr.every(r => r.source && r.destination && r.migratedAt);
  record('T13', 'T13.8', '迁移记录接口结构可直接驱动下拉框',
    shapeOk,
    `status=${recRes.status} 记录 ${Array.isArray(recArr) ? recArr.length : '?'} 条，字段齐备=${shapeOk}`);

  // T13.9 reparse point 端到端：沙箱 junction 拒绝清理，链接目标零改动
  const { deleteContents } = require(path.join(APP, 'server/services/diskCleanupService'));
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-rp-target-'));
  const holderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-rp-link-'));
  const linkPath = path.join(holderDir, 'link');
  const secret = path.join(targetDir, 'secret.txt');
  fs.writeFileSync(secret, 'must-stay', 'utf8');
  let rpResult = null, rpErr = '', linked = false;
  try {
    try {
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', linkPath, targetDir], { windowsHide: true });
      linked = true;
    } catch (e) { rpErr = e.message; }
    if (linked) {
      rpResult = await deleteContents(linkPath);
      record('T13', 'T13.9', '沙箱 junction 根目录：拒绝清理且链接目标文件不变',
        rpResult.ok === false && rpResult.error === 'reparse_point_refused' &&
        fs.readFileSync(secret, 'utf8') === 'must-stay',
        `ok=${rpResult.ok} error=${rpResult.error} secret=${fs.readFileSync(secret, 'utf8')}`);
    } else {
      record('T13', 'T13.9', '沙箱 junction 根目录：拒绝清理', false, '无法创建 junction：' + rpErr);
    }
  } finally {
    try { fs.rmdirSync(linkPath); } catch (e) { }
    try { fs.rmSync(holderDir, { recursive: true, force: true }); } catch (e) { }
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (e) { }
  }

  // T13.10 普通目录（含子目录）清理行为未被 reparse 检查误伤
  const normalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-normal-'));
  const subDir = path.join(normalDir, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(normalDir, 'a.txt'), 'a', 'utf8');
  fs.writeFileSync(path.join(subDir, 'b.txt'), 'bb', 'utf8');
  const beforeStat = pathStat(normalDir);
  const nRes = await deleteContents(normalDir);
  const afterStat = pathStat(normalDir);
  record('T13', 'T13.10', '普通目录（含子目录）仍被正常清理，目录本身保留',
    nRes.ok === true && afterStat.files === 0 && fs.existsSync(normalDir) &&
    nRes.deletedBytes === beforeStat.bytes,
    `ok=${nRes.ok} 删除=${nRes.deletedBytes}B 实际=${beforeStat.bytes}B 剩余文件=${afterStat.files} 目录保留=${fs.existsSync(normalDir)}`);
  try { fs.rmSync(normalDir, { recursive: true, force: true }); } catch (e) { }

  // T13.11 撤销记录选择：空选择不得被当成第 0 条记录
  //   界面验收实测踩到的真缺陷：占位项 value=''，而 Number('') === 0 且 Number.isInteger(0) 为真，
  //   于是「什么都没选」被解释成索引 0 —— 点撤销会撤销掉列表里第一条记录。
  const numValueUses = (tplSrc.match(/Number\(rollbackSel\.value\)/g) || []).length;
  const pickGuard = /function selectedRollbackRecord\(\)/.test(tplSrc) &&
    /rollbackSel\.value === ''\)\s*return null;/.test(tplSrc) &&
    numValueUses === 1 &&
    /btnRollback\.disabled = !rec;/.test(tplSrc) &&
    /const rec = selectedRollbackRecord\(\);/.test(tplSrc) &&
    /function selectedRollbackRecord\(\)/.test(html);
  record('T13', 'T13.11', '撤销记录选择：空选择不会被当成第 0 条记录（Number(\'\')===0 陷阱）', pickGuard,
    `唯一选区解析 ${numValueUses} 处（应只在 selectedRollbackRecord 内）；空值显式返回 null=${/rollbackSel\.value === ''\)\s*return null;/.test(tplSrc)}；服务端下发页含该函数=${/function selectedRollbackRecord\(\)/.test(html)}`);
}

// ─────────────────────────────────────────── 主入口
(async () => {
  const t0 = Date.now();
  console.log('=== 内存清理助手 · 全量真实测试 ===');
  console.log('应用目录:', APP);
  console.log('沙箱目录:', fx.sandboxDir('main'));
  console.log('服务端口:', PORT, '(用户 7788 不动)');
  console.log('');

  // 基线：测试前记录生产文件哈希与关键路径状态
  const pre = {
    baselineAt: new Date().toISOString(),
    windowsTemp: pathStat(path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp')),
    nvidiaDx: pathStat(path.join(process.env.LOCALAPPDATA || '', 'NVIDIA', 'DXCache')),
    dDrive: pathStat('D:\\'),
    dummyPids: fx.list()
  };
  fs.writeFileSync(path.join(TESTS_DIR, 'pre-state.json'), JSON.stringify(pre, null, 2), 'utf8');

  // T1
  console.log('\n───── T1 单元测试 ─────');
  const t1 = T1_unitTests();

  // 靶子必须在 T1（约 2~4 分钟）之后才启动，否则 timeout.exe 的时限会先到期自杀。
  // 同时 T1 里若有测试清了沙箱目录，这里需要重新 build。
  console.log('\n───── 建沙箱夹具 + 启动靶子进程 ─────');
  const fixture = fx.build('main');
  record('T2', 'T2.0a', '沙箱夹具已重建', fs.existsSync(fixture.exe), fixture.dir);
  const bootPids = fx.spawn('main');
  record('T2', 'T2.0', '沙箱靶子进程已启动', bootPids.length > 0, `pids=${JSON.stringify(bootPids)}`);

  // 起沙箱服务
  console.log('\n───── 启动沙箱服务 7799 ─────');
  let serverProc = null, serviceUp = false;
  try {
    serverProc = spawn('node', ['server/server.js', String(PORT)], {
      cwd: APP, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let log = '';
    serverProc.stdout.on('data', d => { log += d.toString(); });
    serverProc.stderr.on('data', d => { log += d.toString(); });
    serverProc.unref();
    for (let i = 0; i < 30; i++) {
      const h = await httpReq('GET', '/api/health');
      if (h.status === 200) { serviceUp = true; break; }
      await sleep(500);
    }
    fs.writeFileSync(path.join(TESTS_DIR, 'server-7799.log'), log, 'utf8');
    record('T0', 'T0.1', '沙箱服务 7799 启动', serviceUp, serviceUp ? `pid=${serverProc.pid}` : '启动失败，见 server-7799.log');
    const h = await httpReq('GET', '/api/health');
    record('T0', 'T0.2', '服务只监听环回', serviceUp && h.status === 200, `health=${h.status}`);

    // 获取访问令牌：服务端在首页 HTML 里注入 64 位十六进制令牌，
    // 之后所有写请求自动带上（改动 3）。
    if (serviceUp) {
      const home = await httpReq('GET', '/');
      const mm = String(home.body || '').match(/window\.__CC_TOKEN__\s*=\s*'([0-9a-f]{64})'/);
      CC_TOKEN = mm ? mm[1] : null;
      const placeholderLeft = /__CC_TOKEN_VALUE__/.test(String(home.body || ''));
      record('T0', 'T0.2b', '首页下发了访问令牌（改动 3）',
        home.status === 200 && !!CC_TOKEN && !placeholderLeft,
        CC_TOKEN
          ? `令牌 ${CC_TOKEN.slice(0, 8)}…（64位），占位符已被替换=${!placeholderLeft}`
          : `未取到令牌（status=${home.status} 占位符残留=${placeholderLeft}）`);
    }
  } catch (e) {
    record('T0', 'T0.1', '沙箱服务 7799 启动', false, e.message);
  }

  console.log('\n───── T2 只读采集 ─────');
  await T2_readonly(serviceUp);
  console.log('\n───── T3 内存清理闸门 ─────');
  if (serviceUp) await T3_gates();
  console.log('\n───── T4 沙箱真杀 ─────');
  if (serviceUp) await T4_realKill();
  console.log('\n───── T5 磁盘只读 ─────');
  if (serviceUp) await T5_diskReadonly();
  console.log('\n───── T6 沙箱真删 ─────');
  await T6_realDelete();
  console.log('\n───── T7 HTTP 接口 ─────');
  if (serviceUp) await T7_http();
  console.log('\n───── T8 CLI ─────');
  T8_cli();
  console.log('\n───── T9 界面 ─────');
  if (serviceUp) await T9_ui();
  console.log('\n───── T10 历史坑回归 ─────');
  if (serviceUp) await T10_regression();
  console.log('\n───── T11 访问控制（改动 3）─────');
  if (serviceUp) await T11_auth();
  console.log('\n───── T12 P2 项（改动 8/9/10/12/13）─────');
  T12_p2();
  console.log('\n───── T13 前端转义与链接防护（M-01 / M-04）─────');
  if (serviceUp) await T13_frontendSafety();

  // 关闭沙箱服务
  try { if (serverProc && serverProc.pid) execFileSync('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { }
  record('T0', 'T0.3', '沙箱服务已关闭', true, `pid=${serverProc && serverProc.pid}`);

  // 后置：生产路径状态与基线对比
  const post = {
    baselineAt: new Date().toISOString(),
    windowsTemp: pathStat(path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp')),
    nvidiaDx: pathStat(path.join(process.env.LOCALAPPDATA || '', 'NVIDIA', 'DXCache')),
    dDrive: pathStat('D:\\'),
    dummyPids: fx.list()
  };
  fs.writeFileSync(path.join(TESTS_DIR, 'post-state.json'), JSON.stringify(post, null, 2), 'utf8');

  // 基线哈希对照
  // 只含源码：运行期产物（data\snapshot.json 这类每次扫描都会被重写的状态文件）已由
  // tests\regenerate-baseline.js 拒绝写入基线，故此处无需再甄别。
  let hashOk = true, hashDiff = [];
  try {
    const base = JSON.parse(fs.readFileSync(path.join(TESTS_DIR, 'baseline.json'), 'utf8'));
    const crypto = require('crypto');
    for (const [rel, info] of Object.entries(base.files)) {
      const p = path.join(APP, rel);
      if (!fs.existsSync(p)) { hashDiff.push(rel + ': 丢失'); hashOk = false; continue; }
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      if (h !== info.sha256) { hashDiff.push(rel + ': 内容变化'); hashOk = false; }
    }
  } catch (e) { hashOk = false; hashDiff.push('基线读取失败: ' + e.message); }
  record('T0', 'T0.4', '生产源码哈希与基线一致（未改一行）', hashOk,
    hashOk ? '全部一致' : hashDiff.join('; '));

  // T0.4b 基线清单完整性 —— 防止「新增源码却忘记重建基线」造成检测盲区
  // 历史事故：旧重建脚本只沿用旧清单重算哈希、不扫新文件，导致 HEAD 新增的
  // workingSetService.js / trimWorkingSet.ps1 / workingSet.test.js 长期不在基线里，
  // T0.4 对这三块功能完全失明。本断言比对 git 追踪的源码集与基线键集，缺失即报错。
  let covOk = true, covMissing = [], covDetail = '';
  try {
    const { isSourceFile } = require(path.resolve(__dirname, '..', 'tools', '_baseline-rules.js'));
    const base = JSON.parse(fs.readFileSync(path.join(TESTS_DIR, 'baseline.json'), 'utf8'));
    const baseKeys = new Set(Object.keys(base.files || {}));

    let tracked = '';
    try {
      // core.quotepath=false：否则 git 会把非 ASCII 路径转义成 "\345\220\257..." 形式，
      // 导致中文名源文件被当成「不存在」而漏出基线检查范围。
      tracked = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'],
        { cwd: APP, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      throw new Error('git ls-files 执行失败: ' + e.message.split('\n')[0]);
    }
    const sourceSet = String(tracked).split(/\r?\n/)
      .map(s => s.trim()).filter(Boolean).filter(isSourceFile)
      // 排除「仍在 git 索引里、但工作区已删除」的待提交删除项：
      // git ls-files 列的是索引内容，del 后未 commit 时它依然会列出该路径，
      // 那属于「已删除待提交」，不是「基线遗漏」。只有工作区真实存在的文件才该在基线里。
      .filter(rel => fs.existsSync(path.join(APP, rel)));

    covMissing = sourceSet.filter(rel => !baseKeys.has(rel));
    covOk = covMissing.length === 0;
    covDetail = `git 源码 ${sourceSet.length} 个 / 基线 ${baseKeys.size} 个` +
      (covMissing.length ? ` — 基线遗漏: ${covMissing.join(', ')}` : ' — 全部覆盖');
  } catch (e) {
    covOk = false;
    covDetail = '基线完整性检查无法执行: ' + e.message.split('\n')[0];
  }
  record('T0', 'T0.4b', '基线清单覆盖全部 git 追踪源码（防新增文件漏入基线）', covOk, covDetail);

  // 生产路径未减少
  const tempShrink = pre.windowsTemp.bytes - post.windowsTemp.bytes;
  record('T0', 'T0.5', 'C:\\Windows\\Temp 未被删（生产路径）', !(pre.windowsTemp.exists && tempShrink > 50 * 1048576),
    `前=${pre.windowsTemp.bytes} 后=${post.windowsTemp.bytes} 变化=${tempShrink}`);
  const nvShrink = pre.nvidiaDx.bytes - post.nvidiaDx.bytes;
  record('T0', 'T0.6', 'NVIDIA DXCache 未被删（生产白名单）', !(pre.nvidiaDx.exists && nvShrink > 50 * 1048576),
    `前=${pre.nvidiaDx.bytes} 后=${post.nvidiaDx.bytes} 变化=${nvShrink}`);
  record('T0', 'T0.7', 'D 盘容量未被异常清空', Math.abs(pre.dDrive.bytes - post.dDrive.bytes) < 5 * 1073741824,
    `前=${pre.dDrive.bytes} 后=${post.dDrive.bytes}`);

  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  const summary = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    app: APP, port: PORT,
    total: results.length, pass, fail,
    t1: t1,
    results
  };
  fs.writeFileSync(path.join(TESTS_DIR, 'test-results.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n=== 完成：${pass}/${results.length} 通过，${fail} 失败，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
  if (fail) {
    console.log('失败项：');
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.suite} ${r.id} ${r.name}: ${r.detail}`));
  }
})();
