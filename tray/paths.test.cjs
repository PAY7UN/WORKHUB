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
const { dataPaths } = require('./paths.cjs');

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
