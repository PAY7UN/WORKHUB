/**
 * 远端管理客户端的回归测试。
 *
 * 用一个真起在本机的 http 服务冒充远端服务器：
 * fetch 的行为（超时、错误状态码、非 JSON 响应）光靠 mock 测不准，
 * 而这些恰恰是运维最先撞上的地方。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { manageToken, callManageApi, fetchStatus, fetchLogs, restartServer } = require('./manage.cjs');

/** 起一个假服务器：按路径返回不同结果 */
function startFakeServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function closeFake(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('环境变量里的令牌优先于配置文件', () => {
  const original = process.env.WORKHUB_MANAGE_TOKEN;
  try {
    process.env.WORKHUB_MANAGE_TOKEN = 'mht_来自环境变量';
    assert.equal(manageToken({ token: 'mht_来自配置文件' }), 'mht_来自环境变量');
    delete process.env.WORKHUB_MANAGE_TOKEN;
    assert.equal(manageToken({ token: 'mht_来自配置文件' }), 'mht_来自配置文件');
    assert.equal(manageToken({}), '');
  } finally {
    if (original === undefined) delete process.env.WORKHUB_MANAGE_TOKEN;
    else process.env.WORKHUB_MANAGE_TOKEN = original;
  }
});

test('没令牌就直接报错，不去空跑一次请求', async () => {
  const original = process.env.WORKHUB_MANAGE_TOKEN;
  delete process.env.WORKHUB_MANAGE_TOKEN;
  try {
    await assert.rejects(
      () => callManageApi({ target: 'http://127.0.0.1:1', token: '' }, '/status'),
      /机器令牌/,
    );
  } finally {
    if (original !== undefined) process.env.WORKHUB_MANAGE_TOKEN = original;
  }
});

test('状态接口把令牌放进 x-workhub-token 头', async () => {
  const seen = {};
  const { server, base } = await startFakeServer((req, res) => {
    seen.token = req.headers['x-workhub-token'];
    seen.url = req.url;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
  });
  try {
    const info = await fetchStatus({ target: base, token: 'mht_test' });
    assert.equal(info.version, '0.1.0');
    assert.equal(seen.token, 'mht_test');
    assert.equal(seen.url, '/api/manage/status');
  } finally {
    await closeFake(server);
  }
});

test('服务器报错时把它的原话带出来', async () => {
  const { server, base } = await startFakeServer((req, res) => {
    res.statusCode = 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: '这个服务由托盘托管，请在托盘菜单里重启' }));
  });
  try {
    await assert.rejects(
      () => restartServer({ target: base, token: 'mht_test' }),
      /托盘托管/,
    );
  } finally {
    await closeFake(server);
  }
});

test('连不上时说的是「连不上」，不是一堆堆栈', async () => {
  await assert.rejects(
    () => callManageApi({ target: 'http://127.0.0.1:1', token: 'mht_test' }, '/status'),
    /连不上/,
  );
});

test('日志接口带上 tail 参数', async () => {
  let url = '';
  const { server, base } = await startFakeServer((req, res) => {
    url = req.url;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ lines: ['第一行', '第二行'] }));
  });
  try {
    const data = await fetchLogs({ target: base, token: 'mht_test' }, 30);
    assert.equal(url, '/api/manage/logs?tail=30');
    assert.deepEqual(data.lines, ['第一行', '第二行']);
  } finally {
    await closeFake(server);
  }
});
