/**
 * 数据目录搬迁的回归测试。
 *
 * 这组用例盯的是「搬了一半」这类故障：搬的时候数据库过去了、密钥没过去，
 * 或者位置没记住，下次启动又回到老目录。
 * 症状都是不报错——服务照旧起来，看着一切正常，直到换机器、换盘、
 * 或者使用者去翻文档才发现东西没了。这类事只能靠测试兜底。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isSameDir,
  canWrite,
  hasExistingData,
  migrateData,
  pickConfigTarget,
  writeConfigPatch,
} = require('./datadir.cjs');

/** 临时目录 */
function tempDir(prefix = 'workhub-datadir-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个像样的工作目录：.env + data + logs */
function seedWorkDir() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, '.env'), 'WORKHUB_SECRET=abc\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'workhub-v2.db'), 'sqlite', 'utf8');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'service.log'), 'log\n', 'utf8');
  return dir;
}

test('同一个目录的两种写法要认出来', () => {
  // 不认重就会「把目录搬进它自己」：递归复制自己，磁盘能撑爆。
  assert.equal(isSameDir('D:\\WorkHub', 'D:\\WorkHub\\.'), true);
  assert.equal(isSameDir('D:\\WorkHub', 'D:\\WorkHub'), true);
  assert.equal(isSameDir('D:\\WorkHub', 'D:\\Other'), false);
  assert.equal(isSameDir('', 'D:\\WorkHub'), false);
});

test('迁移：密钥、库、日志一起过去', () => {
  const from = seedWorkDir();
  const to = tempDir();
  try {
    const result = migrateData(from, to);
    assert.deepEqual(result.errors, []);
    assert.ok(result.copied.includes('.env'), '.env 要跟着走（密钥跟库分家就解不开文档）');
    assert.ok(result.copied.includes('data'), '数据库要跟着走');
    assert.ok(result.copied.includes('logs'), '日志要跟着走');
    assert.ok(fs.existsSync(path.join(to, '.env')));
    assert.ok(fs.existsSync(path.join(to, 'data', 'workhub-v2.db')));
    assert.ok(fs.existsSync(path.join(to, 'logs', 'service.log')));
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test('迁移是「搬」不是「移」：旧目录还在，数据没丢', () => {
  const from = seedWorkDir();
  const to = tempDir();
  try {
    migrateData(from, to);
    assert.ok(fs.existsSync(path.join(from, 'data', 'workhub-v2.db')), '旧数据不能被删掉');
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test('目标目录已有数据时不闷头覆盖', () => {
  // 目标可能是用户正在用的另一套 WorkHub：冲掉它的库等于删别人资料。
  const from = seedWorkDir();
  const to = seedWorkDir();
  try {
    fs.writeFileSync(path.join(to, 'data', 'workhub-v2.db'), '别人的库', 'utf8');
    const result = migrateData(from, to);
    assert.ok(result.skipped.includes('data'), '已有的库要跳过');
    assert.equal(
      fs.readFileSync(path.join(to, 'data', 'workhub-v2.db'), 'utf8'),
      '别人的库',
      '别人的库不能被覆盖',
    );
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test('确认覆盖时先把旧的挪开备份', () => {
  const from = seedWorkDir();
  const to = seedWorkDir();
  try {
    fs.writeFileSync(path.join(to, 'data', 'workhub-v2.db'), '别人的库', 'utf8');
    const result = migrateData(from, to, { overwrite: true });
    assert.deepEqual(result.errors, []);
    assert.equal(
      fs.readFileSync(path.join(to, 'data', 'workhub-v2.db'), 'utf8'),
      'sqlite',
      '覆盖后应该是新搬过去的库',
    );
    // 备份是按顶层项挪开的（data 整个目录挪成 data.replaced-…），
    // 挨着目标目录放着，出了事一眼就能看见。
    const backups = fs.readdirSync(to).filter((n) => n.includes('.replaced-'));
    assert.ok(backups.length >= 1, '旧目录要留一份备份，不能直接删');
    const dataBackup = backups.find((n) => n.startsWith('data.replaced-'));
    assert.ok(dataBackup, 'data 目录的备份要在');
    assert.ok(
      fs.existsSync(path.join(to, dataBackup, 'workhub-v2.db')),
      '备份里应该有原来那份库',
    );
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test('搬到自己身上等于什么都没做', () => {
  const dir = seedWorkDir();
  try {
    const result = migrateData(dir, dir);
    assert.deepEqual(result.copied, []);
    assert.deepEqual(result.errors, []);
    assert.ok(fs.existsSync(path.join(dir, 'data', 'workhub-v2.db')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('认得出目标目录里已经有一份数据', () => {
  const dir = seedWorkDir();
  const empty = tempDir();
  try {
    assert.equal(hasExistingData(dir), true);
    assert.equal(hasExistingData(empty), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('目录写不了就说不写', () => {
  const dir = tempDir();
  try {
    assert.equal(canWrite(dir), true);
    assert.equal(canWrite('Z:\\不存在\\的\\盘\\目录'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配置锚点：exe 旁边能写就用它（便携部署的写法）', () => {
  const exeDir = tempDir();
  const fallback = tempDir();
  try {
    const target = pickConfigTarget({ exeDir, fallbackDir: fallback });
    assert.equal(target, path.join(exeDir, 'tray.config.json'));
  } finally {
    fs.rmSync(exeDir, { recursive: true, force: true });
    fs.rmSync(fallback, { recursive: true, force: true });
  }
});

test('配置锚点：exe 旁边写不了就退到默认数据目录', () => {
  // 装到 Program Files 的用户写不了程序目录，这时配置得有地方放，
  // 否则「数据搬到哪儿了」这条记录就丢了。
  const fallback = tempDir();
  try {
    const target = pickConfigTarget({
      exeDir: 'Z:\\不存在的盘\\Program Files\\WorkHub',
      fallbackDir: fallback,
    });
    assert.equal(target, path.join(fallback, 'tray.config.json'));
  } finally {
    fs.rmSync(fallback, { recursive: true, force: true });
  }
});

test('写配置只改一个字段，别的不动', () => {
  // 覆盖式的写法会把远端地址、令牌、快捷键全冲掉——等于把人的配置抹了。
  const dir = tempDir();
  const file = path.join(dir, 'tray.config.json');
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ mode: 'remote', target: 'http://x:1', token: 'secret', appDir: 'D:\\old' }),
      'utf8',
    );
    const result = writeConfigPatch(file, { appDir: 'D:\\new' });
    assert.equal(result.ok, true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.appDir, 'D:\\new');
    assert.equal(written.token, 'secret', '令牌不能被冲掉');
    assert.equal(written.target, 'http://x:1', '远端地址不能被冲掉');
    assert.equal(written.mode, 'remote');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写配置：文件不存在就新建', () => {
  const dir = tempDir();
  const file = path.join(dir, 'tray.config.json');
  try {
    const result = writeConfigPatch(file, { appDir: 'D:\\new' });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).appDir, 'D:\\new');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写配置：文件读坏了就不动它', () => {
  // 读坏了还照写，等于把里面那些字段（令牌之类）全丢了。
  const dir = tempDir();
  const file = path.join(dir, 'tray.config.json');
  try {
    const broken = '{ 这不是 JSON';
    fs.writeFileSync(file, broken, 'utf8');
    const result = writeConfigPatch(file, { appDir: 'D:\\new' });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), broken, '坏文件要原样留着，不能被覆盖');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
