/**
 * .env 生命周期的回归测试。
 *
 * 这组用例守的是使用者的密钥。出错的代价不是「服务起不来」，
 * 而是「库里的文档永久解不开」——还不能靠报错发现（解出来是乱码，
 * 使用者只会以为文档坏了）。所以只能靠测试盯着。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureEnvFile, backupPathOf } = require('./envfile.cjs');

/** 建一个临时工作目录 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workhub-tray-'));
}

/** 造一份「一定会被调用」的凭证 */
function credentials() {
  return { secret: 'secret-value', password: 'password-value' };
}

test('首次运行生成 .env，并顺手留一份备份', () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  const result = ensureEnvFile({ envFile, dbPath: path.join(dir, 'data', 'db.sqlite'), port: 8787, makeCredentials: credentials });

  assert.equal(result.error, null);
  assert.equal(result.created, true);
  assert.equal(result.password, 'password-value');

  const text = fs.readFileSync(envFile, 'utf8');
  assert.match(text, /WORKHUB_SECRET=secret-value/);
  assert.match(text, /WORKHUB_ADMIN_PASSWORD=password-value/);
  assert.match(text, /WORKHUB_PORT=8787/);
  // 备份留着：.env 丢了还能把密钥找回来
  assert.ok(fs.existsSync(backupPathOf(envFile)), '应当留下 .env.bak');
});

test('.env 没了、库还在：不重新生成密钥，把话说明白', () => {
  // 回归点：以前会直接生成一把新密钥，库里的文档从此解不开，
  // 而且不报错——使用者只会以为「文档坏了」。
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  const dbPath = path.join(dir, 'data', 'workhub-v2.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, 'not really a db');

  let called = false;
  const result = ensureEnvFile({
    envFile,
    dbPath,
    port: 8787,
    makeCredentials: () => {
      called = true;
      return credentials();
    },
  });

  assert.equal(called, false, '不该再造密钥');
  assert.equal(result.password, null);
  assert.ok(result.error, '应当说明为什么没生成');
  assert.match(result.error, /无法解密|解密/);
  assert.equal(fs.existsSync(envFile), false, '不该写出一个新的 .env');
});

test('.env 没了、备份还在：从备份恢复，不重新生成密钥', () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  const dbPath = path.join(dir, 'data', 'workhub-v2.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, 'not really a db');
  fs.writeFileSync(backupPathOf(envFile), 'WORKHUB_SECRET=from-backup\n');

  let called = false;
  const result = ensureEnvFile({
    envFile,
    dbPath,
    port: 8787,
    makeCredentials: () => {
      called = true;
      return credentials();
    },
  });

  assert.equal(called, false);
  assert.equal(result.error, null);
  assert.match(fs.readFileSync(envFile, 'utf8'), /WORKHUB_SECRET=from-backup/);
});

test('.env 带 BOM 时把 BOM 去掉', () => {
  // Node 的 --env-file 不认 BOM，会静默丢掉第一个变量（多半就是密钥），
  // 服务端于是判定「生产环境未配置密钥」直接拒绝启动。
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, '\uFEFFWORKHUB_SECRET=abc\nWORKHUB_PORT=8787\n', 'utf8');

  ensureEnvFile({ envFile, dbPath: path.join(dir, 'nope.db'), port: 8787, makeCredentials: credentials });

  const text = fs.readFileSync(envFile, 'utf8');
  assert.ok(!text.startsWith('\uFEFF'), 'BOM 应当被去掉');
  assert.match(text, /WORKHUB_SECRET=abc/);
});

test('备份跟着 .env 走，内容没变就不重写', () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'WORKHUB_SECRET=abc\n', 'utf8');

  ensureEnvFile({ envFile, dbPath: path.join(dir, 'nope.db'), port: 8787, makeCredentials: credentials });
  const first = fs.statSync(backupPathOf(envFile)).mtimeMs;

  // 同一份内容再来一次：备份不该被重写（时间戳不变）
  ensureEnvFile({ envFile, dbPath: path.join(dir, 'nope.db'), port: 8787, makeCredentials: credentials });
  assert.equal(fs.statSync(backupPathOf(envFile)).mtimeMs, first);

  // 使用者改了 .env：备份要跟上，改坏了还能回到上一版
  fs.writeFileSync(envFile, 'WORKHUB_SECRET=changed\n', 'utf8');
  ensureEnvFile({ envFile, dbPath: path.join(dir, 'nope.db'), port: 8787, makeCredentials: credentials });
  assert.match(fs.readFileSync(backupPathOf(envFile), 'utf8'), /changed/);
});
