'use strict';
/**
 * errorMapping.test.js —— 「错误码 → 用户文案」映射的回归防线（短期-13 / U3）
 *
 * 缺陷现场：服务端的 500 只带一个结论式 message（「磁盘扫描失败」「缓存迁移失败」），
 * 前端直接把 message 丢给用户 —— 非技术用户看完仍不知道该做什么。更糟的是有几处
 * message 是**接口契约用语**（必须传 confirmed=true），等于把实现细节上屏。
 *
 * 修复方式：在模板里建立 ERR_TEXT（主句）/ ERR_HINT（处理建议）两张表，并统一从
 * apiErrorText → apiErrorHtml / errHtml 这两个出口出去。
 *
 * 这组断言保证：① 已知的面向用户错误码都有中文文案且不回显原始码；
 * ② 服务端已经说清问题的码不被通用话术覆盖；③ 错误文本仍全部经过 escapeHtml。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const TPL = path.join(ws, '_template.html');

function tpl() {
  return fs.readFileSync(TPL, 'utf8');
}

/**
 * 从模板里取出「错误文案」这一段（escapeHtml → errHtml）单独求值。
 * 这一段不依赖 window / DOM / 令牌，因此可以脱离浏览器直接跑真实函数，
 * 而不是只对着源码做正则核对。
 */
function loadErrors() {
  const s = tpl();
  const start = s.indexOf('function escapeHtml(value){');
  const end = s.indexOf('async function apiJson(');
  assert.ok(start > 0 && end > start, '模板里应能定位到错误文案段落');
  const src = s.slice(start, end);
  const factory = new Function(src + '\n;return { apiErrorText, apiErrorHtml, errHtml, translateThrowable, ERR_TEXT, ERR_HINT };');
  return factory();
}

/** 服务端会出现、且要面向用户展示的全部错误码（见 server.js / routes/memory.js / services/*） */
const USER_FACING_CODES = [
  // 访问控制
  'UNAUTHORIZED', 'BAD_ORIGIN', 'BAD_HOST', 'UNSUPPORTED_MEDIA_TYPE', 'BAD_URL', 'PAGE_NOT_FOUND', 'PAGE_ERROR', 'NOT_FOUND',
  // 内存 / 清理
  'SCAN_BUSY', 'TASK_BUSY', 'TASK_CANCELLED', 'TASK_TIMEOUT',
  'DISK_BUSY', 'BATCH_LIMIT', 'PROTECTED_TARGET', 'NOT_CONFIRMED', 'METHOD_NOT_ALLOWED', 'BAD_BODY', 'BAD_PATH',
  'DISK_SCAN_FAILED', 'SNAPSHOT_FAILED', 'SYSTEM_FAILED', 'APPS_FAILED', 'PROCESSES_FAILED', 'PLAN_FAILED',
  'CLEANUP_FAILED', 'TRIM_PLAN_FAILED', 'TRIM_FAILED', 'IO_SAMPLE_FAILED',
  'DISK_VOLUMES_FAILED', 'DISK_PLAN_FAILED', 'DISK_CLEANUP_FAILED', 'CAUTION_NOT_EXPLICIT',
  // 缓存迁移
  'ASSESS_BUSY', 'MIGRATION_BUSY', 'MIGRATE_PRESETS_FAILED', 'INSPECT_FAILED', 'MIGRATE_RECORDS_FAILED', 'PRECHECK_FAILED',
  'MIGRATE_FAILED', 'ROLLBACK_FAILED', 'CRITICAL_PATH', 'SYSTEM_MANAGED', 'NOT_ASSESSED',
  'BAD_SOURCE', 'STATE_CORRUPTED', 'STATE_WRITE_FAILED', 'PROBE_FAILED', 'COPY_MISMATCH', 'SOURCE_IN_USE',
  'LINK_FAILED', 'LINK_NOT_DETECTED', 'SOURCE_NOT_EXIST', 'SOURCE_MISSING', 'SOURCE_NOT_DIR', 'SOURCE_IS_LINK',
  'SOURCE_UNREADABLE', 'SOURCE_LOCKED', 'SOURCE_TOO_LARGE', 'SAME_PATH', 'DEST_INSIDE_SOURCE', 'SOURCE_INSIDE_DEST',
  'VOLUME_UNKNOWN', 'DISK_FULL', 'DEST_EXISTS', 'NOT_MIGRATED', 'NOT_A_LINK', 'DEST_MISSING', 'UNLINK_FAILED',
  'RESTORE_FAILED', 'RESTORE_MISMATCH',
  // 权限
  'PRIVILEGE_STATUS_FAILED', 'ELEVATE_FAILED', 'WSCRIPT_NOT_FOUND', 'UNSUPPORTED_PLATFORM',
  'LAUNCHER_NOT_FOUND', 'ELEVATE_VBS_NOT_FOUND'
];

/**
 * 豁免清单：这些码不需要在映射表里登记，理由必须写在注释里。
 * 两类：① 整段文案由 apiErrorText 的分支直接返回；② 服务端 message 本身
 * 已带具体原因与下一步（迁移预检的 issue 码，服务端会把多条 message 拼成一句）。
 * 新增错误码若既不在映射表、也不在豁免清单，测试会失败 —— 以此强制「要么写文案，要么写明理由」。
 */
const EXEMPT = new Map([
  ['UNAUTHORIZED', '整段文案（含改用服务地址打开的指引）在 apiErrorText 分支里'],
  ['BAD_ORIGIN', '同上，整段文案在分支里'],
  ['BAD_HOST', '同上，整段文案在分支里'],
  ['ASSESS_BUSY', '同上，整段文案已说明「等 2~3 秒再点」'],
  ['CRITICAL_PATH', '服务端 message 给出具体路径与原因（系统关键路径，禁止迁移）'],
  ['SYSTEM_MANAGED', '服务端 message 说明该目录由系统或安装程序托管'],
  ['SOURCE_NOT_EXIST', '服务端 message 已给出「目录不存在（环境或软件未安装？）」'],
  ['SOURCE_MISSING', '服务端 message 已带具体路径（原路径不存在：…）'],
  ['SOURCE_NOT_DIR', '服务端 message 已说明源路径不是目录'],
  ['SOURCE_UNREADABLE', '服务端 message 已区分「检测失败」与「权限或独占占用」'],
  ['SAME_PATH', '服务端 message 已说明「目标路径不能与源路径相同」'],
  ['DEST_INSIDE_SOURCE', '服务端 message 已说明「目标路径不能位于源目录内部」'],
  ['SOURCE_INSIDE_DEST', '服务端 message 已说明「源路径不能位于目标目录内部」'],
  ['VOLUME_UNKNOWN', '服务端 message 已说明「无法识别盘符，junction 仅限本地卷」'],
  ['LINK_FAILED', '服务端 message 含失败原因，并指出 junction 无需管理员'],
  ['LINK_NOT_DETECTED', '服务端 message 已说明「链接创建后未能识别为 junction/symlink」']
]);

const CJK = /[\u4e00-\u9fa5]/;

test('每个面向用户的错误码都能给出中文文案，且不回显原始错误码', () => {
  const { apiErrorText } = loadErrors();
  for (const code of USER_FACING_CODES) {
    const text = apiErrorText({ error: { code, message: '服务端给出的具体说明' } }, '');
    assert.ok(text && text.trim(), code + ' 必须有文案');
    assert.ok(CJK.test(text), code + ' 的文案必须是中文，实测：' + text);
    assert.ok(!text.includes(code), code + ' 的文案不得包含原始错误码，实测：' + text);
  }
});

test('「服务端只说结论」的错误码必须登记文案（新增码需登记或列入豁免清单）', () => {
  const { ERR_TEXT, ERR_HINT } = loadErrors();
  for (const code of USER_FACING_CODES) {
    const registered = !!(ERR_TEXT[code] || ERR_HINT[code]);
    assert.ok(registered || EXEMPT.has(code),
      code + ' 既没有文案映射、也不在豁免清单：请补 ERR_TEXT/ERR_HINT，或写明豁免理由');
  }
});

test('泛化 500（只说结论、message 无信息量）由前端补主句 + 处理建议', () => {
  const { ERR_TEXT, ERR_HINT, apiErrorText } = loadErrors();
  const conclusionOnly = ['DISK_SCAN_FAILED', 'SNAPSHOT_FAILED', 'CLEANUP_FAILED', 'MIGRATE_FAILED', 'PRECHECK_FAILED', 'ROLLBACK_FAILED'];
  for (const code of conclusionOnly) {
    assert.ok(ERR_TEXT[code], code + ' 必须有前端主句，否则用户只看到「XX失败」');
    assert.ok(ERR_HINT[code], code + ' 必须有处理建议');
    // message 只是结论时，最终文案里出现的应是前端主句 + 建议
    const text = apiErrorText({ error: { code, message: '扫描失败' } });
    assert.ok(text.includes(ERR_TEXT[code]), code + ' 应采用前端主句');
    assert.ok(text.includes('处理建议'), code + ' 应带上处理建议');
  }
});

test('接口契约用语不上屏（confirmed=true / acknowledgeBatchLimit=true）', () => {
  const { apiErrorText } = loadErrors();
  const cases = [
    { code: 'NOT_CONFIRMED', message: '未确认：真实清理必须传 confirmed=true' },
    { code: 'BATCH_LIMIT', message: '超过批量上限 20，需显式传 acknowledgeBatchLimit=true 表示知悉' }
  ];
  for (const c of cases) {
    const text = apiErrorText({ error: c });
    assert.ok(!/confirmed=true|acknowledgeBatchLimit=true/.test(text),
      c.code + ' 不得把调用参数写进用户文案，实测：' + text);
    assert.ok(CJK.test(text), c.code + ' 应是中文文案');
  }
});

test('服务端已说清问题的码保留原始细节，不被通用话术覆盖', () => {
  const { apiErrorText } = loadErrors();
  const cases = [
    ['DEST_EXISTS', '目标目录已存在且非空，拒绝覆盖'],
    ['SAME_PATH', '目标路径不能与源路径相同'],
    ['CAUTION_NOT_EXPLICIT', '谨慎项必须显式勾选：系统日志'],
    ['SOURCE_IN_USE', '原目录被占用，无法改名备份。请关闭占用该目录的程序后重试。']
  ];
  for (const [code, message] of cases) {
    const text = apiErrorText({ error: { code, message } });
    assert.ok(text.includes(message), code + ' 的具体原因必须保留，实测：' + text);
  }
});

test('鉴权类整段文案不退化成通用兜底（本地文件模式下的操作指引）', () => {
  const { apiErrorText } = loadErrors();
  const u = apiErrorText({ error: { code: 'UNAUTHORIZED', message: '缺少访问令牌' } });
  assert.ok(u.includes('127.0.0.1:7788'), '应告诉用户改用服务地址打开');
  const c = apiErrorText({ error: { code: 'STATE_CORRUPTED', message: 'Unexpected token' } });
  assert.ok(c.includes('cache-migrations.json'), '应告诉用户先备份哪个文件');
  assert.ok(c.includes('处理建议：'), '应带处理建议');
});

test('没有错误对象时退回 fallback，不返回 undefined/原始码', () => {
  const { apiErrorText } = loadErrors();
  assert.strictEqual(apiErrorText(null), '请求失败');
  assert.strictEqual(apiErrorText({}), '请求失败');
  assert.strictEqual(apiErrorText(null, '生成计划失败'), '生成计划失败');
  assert.strictEqual(apiErrorText({ error: null }, '扫描失败'), '扫描失败');
});

test('未知错误码退回服务端 message，而不是把码名当文案', () => {
  const { apiErrorText } = loadErrors();
  const text = apiErrorText({ error: { code: 'SOME_NEW_CODE', message: '新接口返回的中文说明' } });
  assert.strictEqual(text, '新接口返回的中文说明');
  // 没有 message 的未知码只退到 fallback
  assert.strictEqual(apiErrorText({ error: { code: 'SOME_NEW_CODE' } }, '操作失败'), '操作失败');
});

test('浏览器英文网络异常被译成中文并可操作', () => {
  const { errHtml } = loadErrors();
  for (const raw of ['Failed to fetch', 'TypeError: Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
    const html = errHtml(new Error(raw));
    assert.ok(html.includes('连不上本地服务'), raw + ' 应被译成中文，实测：' + html);
    assert.ok(!/failed to fetch|load failed|networkerror/i.test(html), raw + ' 不应回显英文原文');
  }
});

test('已是中文的异常文本原样透出（不被网络文案误伤）', () => {
  const { errHtml } = loadErrors();
  assert.strictEqual(errHtml(new Error('生成计划失败')), '生成计划失败');
  assert.strictEqual(errHtml('字符串异常'), '字符串异常');
});

test('错误出口仍是 escapeHtml 唯一收口（接口数据不落进 innerHTML）', () => {
  const { apiErrorHtml, errHtml } = loadErrors();
  const payload = { error: { code: 'DEST_EXISTS', message: '<img src=x onerror=alert(1)>', detail: '"' } };
  const html = apiErrorHtml(payload);
  assert.ok(!html.includes('<img'), 'apiErrorHtml 必须转义尖括号，实测：' + html);
  assert.ok(html.includes('&lt;img'), '应转义为实体');
  assert.ok(!errHtml(new Error('<script>bad</script>')).includes('<script'), 'errHtml 必须转义');
});

test('模板里不存在绕过映射表直接回显 e.message 的错误出口', () => {
  const s = tpl();
  // 这两个函数必须仍然经由 apiErrorText / translateThrowable
  assert.ok(/function apiErrorHtml\(r, fallback\)\{ return escapeHtml\(apiErrorText\(r, fallback\)\); \}/.test(s),
    'apiErrorHtml 必须仍为 escapeHtml(apiErrorText(...))');
  assert.ok(/return escapeHtml\(translateThrowable\(raw\)\);/.test(s),
    'errHtml 必须仍经由 translateThrowable');
});

/**
 * 反向扫描（遗留-33）：上面那组断言的防线是「清单里有的码都有文案」，但清单本身靠人更新——
 * 服务端新增一个码、而 USER_FACING_CODES 没跟上时，防线不会自己发现。
 * 这里从服务端源码抓出所有 `code: 'X'` / `err.code = 'X'` 字面量，与清单做差集并断言为空，
 * 把「漏登记」从人肉检查变成一条会红的测试。
 *
 * 只扫字面量，因此「码由变量决定」（如 `code: err.code`）的地方天然不在射程内——
 * 那些位置本就不可能靠静态清单覆盖。
 */
test('反向扫描：服务端出现的错误码字面量都已登记，或已写明豁免理由', () => {
  const root = path.join(ws, 'server');
  const SKIP_DIRS = new Set(['__tests__', 'node_modules']);
  const found = new Map(); // code -> ["相对路径:行号", ...]

  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(ws, abs).split(path.sep).join('/');
      fs.readFileSync(abs, 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(/(?:code\s*:\s*|\.code\s*=\s*)'([A-Z][A-Z0-9_]*)'/g)) {
          if (!found.has(m[1])) found.set(m[1], []);
          found.get(m[1]).push(rel + ':' + (i + 1));
        }
      });
    }
  };
  walk(root);

  // 扫描规则自身的守护：正则一旦因代码风格变化而失配，下面的「差集为空」就会变成空断言。
  assert.ok(found.size >= 25,
    `反向扫描只抓到 ${found.size} 个错误码字面量，规则可能已失效（预期 ≥25）`);

  const unregistered = [...found.keys()]
    .filter(c => !USER_FACING_CODES.includes(c) && !EXEMPT.has(c));
  assert.deepStrictEqual(unregistered, [],
    '以下错误码出现在服务端，却既未登记文案、也不在豁免清单：' +
    unregistered.map(c => `${c} @ ${found.get(c)[0]}`).join('; '));
});
