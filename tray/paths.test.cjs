/**
 * 工作目录派生路径的回归测试。
 *
 * 这组用例盯的是一个真出过的 bug：配置了 appDir（便携部署换目录），
 * 代码只改了 dataDir，envFile 与 logsDir 还指着旧目录。
 * 后果不报错——数据库写进新目录，密钥从旧目录读，
 * 服务照样起来，看着一切正常，直到换个机器或换个用户就露馅。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { dataPaths, dataEnvOverrides, logDirEnv } = require('./paths.cjs');

test('工作目录换了，.env 与日志都跟着换', () => {
  const p = dataPaths('D:\\WorkHub');
  assert.equal(p.dataDir, 'D:\\WorkHub');
  assert.equal(p.envFile, path.join('D:\\WorkHub', '.env'));
  assert.equal(p.logsDir, path.join('D:\\WorkHub', 'logs'));
});

test('派生路径一律落在工作目录里', () => {
  // 核心承诺：.env 与日志不会跑到工作目录外面去。
  // 跑到外面去就意味着「换了部署目录，配置还在老地方」——
  // 两份配置分家，症状是部署目录里的数据认了另一套密钥。
  //
  // 比较前先 path.resolve 规范化：Windows 上 path.join 出来的是反斜杠，
  // 直接拿 startsWith 比原始字符串会误判（'/tmp/x' 与 '\tmp\x' 不是一回事）。
  for (const dir of ['D:\\WorkHub', 'C:\\Users\\x\\AppData\\Local\\WorkHub', '/tmp/workhub']) {
    const p = dataPaths(dir);
    const root = path.resolve(p.dataDir);
    assert.ok(
      path.resolve(p.envFile).startsWith(root + path.sep),
      `envFile 跑出了工作目录：${p.envFile}`,
    );
    assert.ok(
      path.resolve(p.logsDir).startsWith(root + path.sep),
      `logsDir 跑出了工作目录：${p.logsDir}`,
    );
  }
});

test('换工作目录时，三处路径是一起换的', () => {
  // 回归点：以前只改 dataDir，envFile/logsDir 纹丝不动。
  const before = dataPaths('C:\\old');
  const after = dataPaths('D:\\new');
  assert.notEqual(after.envFile, before.envFile);
  assert.notEqual(after.logsDir, before.logsDir);
  assert.equal(after.envFile, path.join('D:\\new', '.env'));
  assert.equal(after.logsDir, path.join('D:\\new', 'logs'));
});

test('打包态：数据库与 vault 都掰到工作目录', () => {
  // 服务端默认按代码目录定位数据库与 vault（server/paths.ts）。
  // 打包后代码在安装目录里（只读），不掰过去服务一起来就报错。
  const env = dataEnvOverrides({ codeDir: 'C:\\Program Files\\WorkHub', dataDir: 'D:\\WorkHub', packaged: true });
  assert.equal(env.WORKHUB_DB_V2, path.join('D:\\WorkHub', 'data', 'workhub-v2.db'));
  assert.equal(env.WORKHUB_VAULT_DIR, path.join('D:\\WorkHub', 'data', 'vault'));
  assert.equal(env.NODE_ENV, 'production');
});

test('开发态指定 appDir：数据库也得跟着走', () => {
  // 回归点：以前只有打包态才掰，开发态把 .env 与日志搬走了、库还留在仓库里——
  // 半生效。看起来正常，实际是两份配置拼起来的部署，换台机器就露馅。
  const env = dataEnvOverrides({ codeDir: 'D:\\repo', dataDir: 'D:\\app', packaged: false });
  assert.equal(env.WORKHUB_DB_V2, path.join('D:\\app', 'data', 'workhub-v2.db'));
  assert.equal(env.WORKHUB_VAULT_DIR, path.join('D:\\app', 'data', 'vault'));
  // 开发态不改成生产模式：那是打包态的事
  assert.equal(env.NODE_ENV, undefined);
});

test('开发态里开发者显式设过的数据库位置不抢', () => {
  const env = dataEnvOverrides(
    { codeDir: 'D:\\repo', dataDir: 'D:\\app', packaged: false },
    { WORKHUB_DB_V2: 'D:\\test\\test.db' },
  );
  assert.equal(env.WORKHUB_DB_V2, undefined);
  // vault 没设过，照样掰到工作目录
  assert.equal(env.WORKHUB_VAULT_DIR, path.join('D:\\app', 'data', 'vault'));
});

test('运行期日志目录要告诉服务端', () => {
  // 升级日志、升级结果摘要都落这儿。打包态下代码目录在安装目录里，
  // 普通用户写不进去——落在那儿等于没落。
  const env = logDirEnv({ logsDir: 'D:\\WorkHub\\logs' });
  assert.equal(env.WORKHUB_LOG_DIR, 'D:\\WorkHub\\logs');
});
