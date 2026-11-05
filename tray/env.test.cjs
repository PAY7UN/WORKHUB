/**
 * 端口判定的回归测试。
 *
 * 这组用例盯的是「托盘与服务端指向不同端口」这个毛病。
 * 症状特别难查：菜单上写着「已停止」，浏览器里服务却好好地跑着——
 * 因为托盘在找 A 端口，服务在 B 端口。
 *
 * 判定规则必须跟服务端看到的完全一致（server/env.ts + server/envFile.ts）：
 * 按 Node 的 --env-file 那套规则合并进程环境与 .env，再新名优先、旧名兜底地取 PORT。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { envValue, parseEnvFile, resolvePort } = require('./env.cjs');

const DEFAULT = 8787;

test('进程环境里的端口优先于 .env', () => {
  const port = resolvePort({ WORKHUB_PORT: '9000' }, 'WORKHUB_PORT=8888\n', DEFAULT);
  assert.equal(port, 9000);
});

test('旧名 MDHUB_PORT 也认', () => {
  // 回归点：以前写的是 process.env.WORKHUB_PORT || process.env.WORKHUB_PORT，
  // 等于旧名永远读不到。改名过渡期机器上还留着 MDHUB_PORT 是常事，
  // 服务端认它（server/env.ts），托盘不认就两边错开。
  const port = resolvePort({ MDHUB_PORT: '8000' }, '', DEFAULT);
  assert.equal(port, 8000);
});

test('新名与旧名同时存在时取新名', () => {
  const port = resolvePort({ WORKHUB_PORT: '9000', MDHUB_PORT: '8000' }, '', DEFAULT);
  assert.equal(port, 9000);
});

test('.env 里的端口认得（引号、注释、空格都算）', () => {
  assert.equal(resolvePort({}, 'WORKHUB_PORT=9001\n', DEFAULT), 9001);
  assert.equal(resolvePort({}, 'WORKHUB_PORT="9002"\n', DEFAULT), 9002);
  assert.equal(resolvePort({}, "WORKHUB_PORT='9003'\n", DEFAULT), 9003);
  assert.equal(resolvePort({}, 'WORKHUB_PORT=9004 # 端口\n', DEFAULT), 9004);
  assert.equal(resolvePort({}, 'WORKHUB_PORT= 9005 \n', DEFAULT), 9005);
});

test('.env 带 BOM 也能读出端口', () => {
  // Node 的 --env-file 碰到 BOM 会静默丢掉第一个变量。
  // 托盘这边必须读得出来，否则托盘和服务端口就对不上了。
  assert.equal(resolvePort({}, '\uFEFFWORKHUB_PORT=9006\n', DEFAULT), 9006);
});

test('.env 里的旧名也认', () => {
  assert.equal(resolvePort({}, 'MDHUB_PORT=9007\n', DEFAULT), 9007);
});

test('合并按变量名来，不是按后缀', () => {
  // .env 里是 WORKHUB_PORT=9000，系统环境里留着旧名 MDHUB_PORT=8000。
  // Node 的规则是「同名才不覆盖」，所以 .env 的 WORKHUB_PORT 照样生效；
  // 服务端取端口是新名优先 → 9000。
  // 托盘若按后缀一刀切取到 8000，就跟服务端错开了。
  const port = resolvePort({ MDHUB_PORT: '8000' }, 'WORKHUB_PORT=9000\n', DEFAULT);
  assert.equal(port, 9000);
});

test('同一个键写多次，后写的赢', () => {
  assert.equal(resolvePort({}, 'WORKHUB_PORT=9008\nWORKHUB_PORT=9009\n', DEFAULT), 9009);
});

test('什么都没有时用默认端口', () => {
  assert.equal(resolvePort({}, '', DEFAULT), DEFAULT);
  assert.equal(resolvePort({}, 'WORKHUB_PORT=\n', DEFAULT), DEFAULT);
  assert.equal(resolvePort({}, 'WORKHUB_PORT=abc\n', DEFAULT), DEFAULT);
});

test('非法端口不生效', () => {
  assert.equal(resolvePort({ WORKHUB_PORT: '0' }, '', DEFAULT), DEFAULT);
  assert.equal(resolvePort({ WORKHUB_PORT: '99999' }, '', DEFAULT), DEFAULT);
  assert.equal(resolvePort({ WORKHUB_PORT: 'abc' }, '', DEFAULT), DEFAULT);
});

test('envValue 按新名优先、旧名兜底取变量', () => {
  const env = { WORKHUB_SECRET: 'new', MDHUB_SECRET: 'old' };
  assert.equal(envValue(env, 'SECRET'), 'new');
  assert.equal(envValue({ MDHUB_SECRET: 'old' }, 'SECRET'), 'old');
  assert.equal(envValue({}, 'SECRET'), '');
  // 空串不算数：托盘与服务端都要能把「没配」和「配成空」分清
  assert.equal(envValue({ WORKHUB_SECRET: '', MDHUB_SECRET: 'old' }, 'SECRET'), 'old');
});

test('解析 .env 时注释与引号都按 Node 的规矩来', () => {
  const parsed = parseEnvFile(
    [
      '# 这是注释',
      'WORKHUB_SECRET=abc123',
      'WORKHUB_PORT="9000" # 行尾注释',
      'WORKHUB_ADMIN_PASSWORD=',
      "QUOTED='值里有 # 号'",
    ].join('\n'),
  );
  assert.equal(parsed.WORKHUB_SECRET, 'abc123');
  assert.equal(parsed.WORKHUB_PORT, '9000');
  assert.equal(parsed.WORKHUB_ADMIN_PASSWORD, '');
  assert.equal(parsed.QUOTED, '值里有 # 号');
});
