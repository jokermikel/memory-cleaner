'use strict';
/**
 * lib/ports.js —— 端口唯一来源与「端口没抢到」退出码契约（短期-8）
 * 运行：node --test server/services/__tests__/ports.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ws = process.cwd();
const { DEFAULT_PORT, EXIT_PORT_IN_USE, parsePort, resolvePort } = require(path.join(ws, 'lib/ports'));

test('端口解析：非法值一律返回 0，由调用方回退', () => {
  assert.strictEqual(parsePort('8899'), 8899);
  assert.strictEqual(parsePort(8899), 8899);
  assert.strictEqual(parsePort('0'), 0);
  assert.strictEqual(parsePort('70000'), 0);
  assert.strictEqual(parsePort('-1'), 0);
  assert.strictEqual(parsePort('abc'), 0);
  assert.strictEqual(parsePort(undefined), 0);
  assert.strictEqual(parsePort(''), 0);
});

test('解析顺序：显式参数 > CC_PORT > 默认值', () => {
  const old = process.env.CC_PORT;
  try {
    delete process.env.CC_PORT;
    assert.strictEqual(resolvePort(), DEFAULT_PORT, '无任何输入时用默认值');
    assert.strictEqual(resolvePort('8899'), 8899);

    process.env.CC_PORT = '8900';
    assert.strictEqual(resolvePort(), 8900, '环境变量应生效');
    assert.strictEqual(resolvePort('8899'), 8899, '显式参数优先级最高');
    assert.strictEqual(resolvePort('bad'), 8900, '显式参数非法时回退到环境变量');
  } finally {
    if (old === undefined) delete process.env.CC_PORT;
    else process.env.CC_PORT = old;
  }
});

test('端口只有一个来源：launcher 与 server 都不再硬编码 7788', () => {
  const launcher = fs.readFileSync(path.join(ws, 'launcher.js'), 'utf8');
  const server = fs.readFileSync(path.join(ws, 'server/server.js'), 'utf8');
  assert.ok(!/const PORT = 7788\s*;/.test(launcher), 'launcher 不应硬编码端口常量');
  assert.ok(/require\('\.\/lib\/ports'\)/.test(launcher), 'launcher 应引用 lib/ports');
  assert.ok(!/Number\(process\.argv\[2\]\) \|\| 7788/.test(server), 'server 不应自带端口兜底');
  assert.ok(/require\('\.\.\/lib\/ports'\)/.test(server), 'server 应引用 lib/ports');
});

test('端口被占用：server 用专门退出码，launcher 给可操作提示', () => {
  const server = fs.readFileSync(path.join(ws, 'server/server.js'), 'utf8');
  assert.ok(/EADDRINUSE/.test(server), 'server 应识别 EADDRINUSE');
  assert.ok(/process\.exit\(EXIT_PORT_IN_USE\)/.test(server), 'server 应以专门退出码退出');

  const launcher = fs.readFileSync(path.join(ws, 'launcher.js'), 'utf8');
  assert.ok(/function probePort/.test(launcher), 'launcher 应做端口占用预检');
  assert.ok(/logPortBusyHint/.test(launcher), 'launcher 应打印可操作提示');
  assert.ok(/EXIT_PORT_IN_USE/.test(launcher), 'launcher 应识别该退出码');

  assert.strictEqual(EXIT_PORT_IN_USE, 3, '退出码契约：3 = 端口被占用');
});
