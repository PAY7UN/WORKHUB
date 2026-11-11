/**
 * 安装选项（数据目录 + 开机自启动）的回归测试。
 *
 * 这组用例盯的是「选了之后没用上」这类故障：
 * - 数据目录选了程序目录，更新时连库一起没了；
 * - 开机自启动写了但路径指错，登录 Windows 后什么也没发生；
 * - 开发态把 electron.exe 写进注册表，污染别人的机器。
 *
 * 开机自启动尤其要盯：它要等下次开机才现形，
 * 错了不会当场报错，只会让使用者以为「这软件坏了」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  checkDataDir,
  isAutoStartEnabled,
  isAutoStartSupported,
  isInsideDir,
  isSamePath,
  normalizeSetupChoice,
  setAutoStart,
} = require('./setup.cjs');

/** 临时目录 */
function tempDir(prefix = 'workhub-setup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 假扮 Electron 的 app：只实现用到的那几个方法 */
function fakeApp({ packaged = true, openAtLogin = false } = {}) {
  const calls = [];
  return {
    calls,
    isPackaged: packaged,
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: (settings) => {
      calls.push(settings);
    },
  };
}

test('空目录和相对路径都不行', () => {
  assert.equal(checkDataDir('').ok, false);
  assert.equal(checkDataDir('   ').ok, false);
  assert.equal(checkDataDir('WorkHub\\data').ok, false);
});

test('盘根目录不行', () => {
  const result = checkDataDir(path.parse(process.cwd()).root, { probeWrite: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /盘根/);
});

test('程序目录本身和它的子目录都不行', () => {
  const exeDir = tempDir();
  const atExe = checkDataDir(exeDir, { exeDir, probeWrite: false });
  assert.equal(atExe.ok, false);
  assert.match(atExe.reason, /程序目录/);

  const underExe = checkDataDir(path.join(exeDir, 'data'), { exeDir, probeWrite: false });
  assert.equal(underExe.ok, false);
  assert.match(underExe.reason, /程序目录/);
});

test('普通目录可用，而且当场建出来', () => {
  const base = tempDir();
  const target = path.join(base, 'WorkHub 数据');
  const result = checkDataDir(target, { exeDir: path.join(base, '程序') });
  assert.equal(result.ok, true, result.reason);
  assert.equal(fs.existsSync(target), true);
});

test('写不进去的位置要挡下来', () => {
  const base = tempDir();
  const file = path.join(base, 'not-a-dir');
  fs.writeFileSync(file, 'x', 'utf8');
  const result = checkDataDir(path.join(file, 'data'));
  assert.equal(result.ok, false);
});

test('同一个目录的两种写法要认出来', () => {
  assert.equal(isSamePath('D:\\WorkHub', 'D:\\WorkHub\\.'), true);
  assert.equal(isSamePath('d:\\workhub', 'D:\\WorkHub'), true);
  assert.equal(isSamePath('D:\\WorkHub', 'D:\\Other'), false);
  assert.equal(isSamePath('', 'D:\\WorkHub'), false);
});

test('子目录要认得出来（含大小写不同）', () => {
  assert.equal(isInsideDir('D:\\WorkHub\\data', 'D:\\WorkHub'), true);
  assert.equal(isInsideDir('d:\\workhub\\data', 'D:\\WorkHub'), true);
  assert.equal(isInsideDir('D:\\WorkHub', 'D:\\WorkHub'), true);
  assert.equal(isInsideDir('D:\\WorkHubOther', 'D:\\WorkHub'), false);
});

test('选项整理成绝对路径，尾斜杠去掉', () => {
  const result = normalizeSetupChoice({ dataDir: 'D:\\WorkHub\\数据\\', autoStart: 1 });
  assert.equal(result.dataDir, 'D:\\WorkHub\\数据');
  assert.equal(result.autoStart, true);
  assert.equal(normalizeSetupChoice({}).dataDir, '');
  assert.equal(normalizeSetupChoice({}).autoStart, false);
});

test('开发态不设开机自启动', () => {
  const app = fakeApp({ packaged: false });
  assert.equal(isAutoStartSupported(app), false);
  assert.equal(isAutoStartEnabled(app), false);

  const result = setAutoStart(app, true);
  assert.equal(result.ok, false);
  assert.equal(app.calls.length, 0, '开发态不该去写注册表');
});

test('打包态按开关设置开机自启动', () => {
  const app = fakeApp({ packaged: true });
  const result = setAutoStart(app, true);
  assert.equal(result.ok, true);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].openAtLogin, true);
  assert.equal(app.calls[0].path, process.execPath);
});

test('读的是系统里的真实状态，不是我们自己记的', () => {
  assert.equal(isAutoStartEnabled(fakeApp({ packaged: true, openAtLogin: true })), true);
  assert.equal(isAutoStartEnabled(fakeApp({ packaged: true, openAtLogin: false })), false);
});

test('问不到状态时当没开（宁可让用户再勾一次）', () => {
  const broken = {
    isPackaged: true,
    getLoginItemSettings: () => {
      throw new Error('问不了');
    },
  };
  assert.equal(isAutoStartEnabled(broken), false);
});
