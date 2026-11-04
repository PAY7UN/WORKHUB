'use strict';
/**
 * 托盘外部更新器的端到端测试。
 *
 * 这一段是整套自更新里最不能出错的地方：
 * 它要在托盘退出之后替换整个程序目录，错了就是「托盘没了」。
 *
 * 测的是真实行为（真起进程、真换文件），不涉及网络和 Electron：
 * 造一个假的程序目录和一份新版本，让更新器去换，然后看结果对不对。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UPDATER = path.join(__dirname, 'apply-update.cjs');

/** 造一份假的程序目录：像真的那样，有 exe、有 resources */
function makeFakeApp(base, version) {
  fs.mkdirSync(path.join(base, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(base, 'WorkHub.exe'), `exe-${version}`);
  fs.writeFileSync(path.join(base, 'resources', 'app.asar'), `asar-${version}`);
  fs.writeFileSync(path.join(base, 'resources', 'extra.txt'), `extra-${version}`);
  return base;
}

/** 跑一次更新器 */
function runUpdater(base, appDir, payload, extraArgs = []) {
  const staging = path.join(base, `staging-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(staging, { recursive: true });
  return spawnSync(
    process.execPath,
    [
      UPDATER,
      '--root',
      appDir,
      '--staging',
      staging,
      '--payload',
      payload,
      '--version',
      '9.9.9',
      '--pid',
      '0', // 0 表示「没有托盘在跑」，不用等
      '--log',
      path.join(base, 'update.log'),
      // 拉起一个啥也不干的进程，代替「把托盘拉起来」那一步
      '--exec',
      process.execPath,
      '--exec-arg',
      '-e',
      '--exec-arg',
      'process.exit(0)',
      ...extraArgs,
    ],
    { encoding: 'utf8' },
  );
}

test('更新器：新版本覆盖到位，新版里没有的旧文件被清掉', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workhub-apply-'));
  try {
    const appDir = makeFakeApp(path.join(base, 'app'), 'old');
    // 旧版本多一个目录，新版本没有
    fs.mkdirSync(path.join(appDir, 'obsolete'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'obsolete', 'old-only.txt'), '过时的东西');

    const payload = makeFakeApp(path.join(base, 'payload'), 'new');
    fs.writeFileSync(path.join(payload, 'resources', 'new-only.txt'), '新增的东西');

    const result = runUpdater(base, appDir, payload);
    assert.equal(result.status, 0, `更新器不该失败：\n${result.stdout}\n${result.stderr}`);

    // 新版本的文件到位了
    assert.equal(fs.readFileSync(path.join(appDir, 'WorkHub.exe'), 'utf8'), 'exe-new');
    assert.equal(fs.readFileSync(path.join(appDir, 'resources', 'app.asar'), 'utf8'), 'asar-new');
    assert.ok(fs.existsSync(path.join(appDir, 'resources', 'new-only.txt')), '新版新增的文件应该在');

    // 新版里没有的旧文件被清掉了
    assert.ok(!fs.existsSync(path.join(appDir, 'obsolete')), '新版里没有的旧目录应该被清掉');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('更新器：数据目录不能被动', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workhub-apply-data-'));
  try {
    const appDir = makeFakeApp(path.join(base, 'app'), 'old');
    fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'data', 'db.sqlite'), '数据');
    fs.writeFileSync(path.join(appDir, '.env'), 'KEY=1');

    const payload = makeFakeApp(path.join(base, 'payload'), 'new');
    const result = runUpdater(base, appDir, payload);
    assert.equal(result.status, 0);

    assert.ok(fs.existsSync(path.join(appDir, 'data', 'db.sqlite')), '数据目录不能被更新动到');
    assert.ok(fs.existsSync(path.join(appDir, '.env')), '.env 不能被更新动到');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('更新器：托盘还在跑就不动它的文件（宁可这次不更新）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workhub-apply-busy-'));
  try {
    const appDir = makeFakeApp(path.join(base, 'app'), 'old');
    const payload = makeFakeApp(path.join(base, 'payload'), 'new');

    // 用自己的 pid 当「托盘 pid」：这个进程确实还活着
    const result = runUpdater(base, appDir, payload, ['--pid', String(process.pid), '--wait-timeout', '1000']);
    assert.notEqual(result.status, 0, '托盘还在跑时不该更新成功');
    assert.equal(
      fs.readFileSync(path.join(appDir, 'WorkHub.exe'), 'utf8'),
      'exe-old',
      '托盘还在跑的时候，一个字节都不该动',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
