'use strict';
/**
 * WorkHub 托盘工具（Electron 主进程）
 *
 * 只有一个图标 + 一个菜单，不做完整界面。
 *
 * 一套代码两种模式，靠配置切换：
 * - local：托盘自己拉起并守护本机的 WorkHub 服务进程（使用者本地版）；
 * - remote：托盘只通过 HTTP 跟远端服务器说话（运维管理面板）。
 *
 * 为什么用 Electron 而不是原生托盘库：
 * Electron 自带 Node 运行时，`ELECTRON_RUN_AS_NODE=1` 能让托盘自己把服务进程拉起来，
 * 于是使用者机器上**不需要另外装 Node**——这是托盘工具能不能给非技术用户用的关键。
 * 代价是安装包大（带一个 chromium），本地版可以接受，服务器上则不必装托盘。
 */
const { app, Tray, Menu, nativeImage, shell, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeTrayImages } = require('./icon.cjs');

const DEFAULT_PORT = 8787;
/** 连续崩溃多少次后不再自动重启——服务起不来时反复重启只会刷日志、占 CPU */
const MAX_RESTARTS = 3;
/** 崩溃重启的间隔 */
const RESTART_DELAY_MS = 2000;

const DEFAULTS = {
  mode: 'local', // 'local' | 'remote'
  target: '', // 留空则本地模式按 .env 的 MDHUB_PORT 推 127.0.0.1
  appDir: '', // 本地模式的服务代码目录，留空则取托盘所在仓库的根目录
  entry: 'server/index.ts', // 服务入口（相对 appDir）
  token: '', // remote 模式的机器令牌
};

let config = null;
let tray = null;
/** 当前拉起的服务进程（remote 模式恒为 null） */
let child = null;
/** 用户主动点的「停止服务」——这种退出不该被当成崩溃而拉起来 */
let stoppingByUser = false;
/** 连续崩溃次数 */
let restarts = 0;
/** 'running' | 'stopped' */
let status = 'stopped';

/* --------------------------------- 配置 --------------------------------- */

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  try {
    const dir = path.join(config.appDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'tray.log'), line);
  } catch {
    // 日志写不进去也不能影响主流程
  }
}

/**
 * 找配置文件。按「离用户最近的优先」排：
 * 托盘目录 → 可执行文件旁边（打包后）→ 用户配置目录。
 */
function loadConfig() {
  const candidates = [
    path.join(app.getAppPath(), 'tray.config.json'),
    path.join(path.dirname(process.execPath), 'tray.config.json'),
    path.join(process.env.APPDATA || '', 'WorkHub', 'tray.config.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const merged = { ...DEFAULTS, ...parsed };
      merged.configFile = file;
      return merged;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      log(`配置文件 ${file} 解析失败，改用默认值：${err.message}`);
    }
  }
  return { ...DEFAULTS, configFile: '' };
}

/**
 * 读服务端口。
 *
 * 优先级跟 Node 的 `--env-file` 一致：**进程环境变量优先于 .env 文件**。
 * 托盘启动时若环境里已经带着 MDHUB_PORT，服务端（子进程继承同一份环境）
 * 听的就是那个端口，托盘也得跟着它走，否则托盘指向的地址和服务实际监听的地址对不上，
 * 表现是「菜单显示已停止，可服务明明在跑」。
 */
function readPortFromEnv(appDir) {
  if (process.env.MDHUB_PORT) {
    const fromEnv = Number(process.env.MDHUB_PORT);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  }
  try {
    const raw = fs.readFileSync(path.join(appDir, '.env'), 'utf8');
    const match = raw.match(/^\s*MDHUB_PORT\s*=\s*(\d+)/m);
    return match ? Number(match[1]) : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** 本地模式下服务代码目录：默认是托盘目录的上一级（仓库根） */
function resolveAppDir(cfg) {
  if (cfg.appDir) return path.resolve(cfg.appDir);
  return path.resolve(app.getAppPath(), '..');
}

/** 服务入口的绝对路径 */
function resolveEntry(cfg) {
  return path.isAbsolute(cfg.entry) ? cfg.entry : path.join(cfg.appDir, cfg.entry);
}

/* -------------------------------- 状态探测 -------------------------------- */

/** 探一次健康检查端点：通 = 服务活着 */
async function probe() {
  try {
    const res = await fetch(`${config.target}/api/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------ 服务进程管理 ------------------------------ */

/**
 * `--env-file-if-exists` 需要 Node 22.9+。
 * Electron 自带的 Node 版本不一定够，所以先看版本再决定用哪个参数：
 * 够就用 if-exists（没有 .env 也不报错），不够就退回 --env-file（仅在文件存在时传）。
 */
function envFileArgs(appDir) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 9)) return ['--env-file-if-exists=.env'];
  return fs.existsSync(path.join(appDir, '.env')) ? ['--env-file=.env'] : [];
}

function startService() {
  if (child) return;
  stoppingByUser = false;

  const entry = resolveEntry(config);
  if (!fs.existsSync(entry)) {
    log(`服务入口不存在：${entry}（检查配置里的 appDir / entry）`);
    return;
  }

  const logDir = path.join(config.appDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, 'service.log'), { flags: 'a' });

  // ELECTRON_RUN_AS_NODE=1 让 electron.exe 以纯 Node 模式运行：
  // 使用者机器上不用装 Node，托盘自带运行时就够了。
  // 入口前面套一层 run-server.cjs：托盘被强杀时，服务进程会跟着退出（见该文件注释）。
  child = spawn(
    process.execPath,
    [...envFileArgs(config.appDir), path.join(__dirname, 'run-server.cjs'), entry],
    {
      cwd: config.appDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKHUB_PARENT_PID: String(process.pid) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  log(`已拉起服务进程 pid=${child.pid} entry=${entry}`);
  child.on('exit', (code, signal) => {
    child = null;
    log(`服务进程退出（code=${code} signal=${signal}）`);
    if (stoppingByUser) {
      log('是用户主动停的，不自动拉起');
      return;
    }
    if (restarts >= MAX_RESTARTS) {
      log(`已连续崩溃 ${restarts} 次，不再自动重启。请看 logs/service.log`);
      return;
    }
    restarts += 1;
    log(`${RESTART_DELAY_MS / 1000} 秒后第 ${restarts} 次尝试拉起`);
    setTimeout(startService, RESTART_DELAY_MS);
  });
}

/**
 * 停服务。
 *
 * Windows 上没有 SIGTERM，kill 走的是 TerminateProcess：正在处理的请求会被打断。
 * 数据不会坏——SQLite 开着 WAL，被强杀的进程下次打开时会自己恢复。
 */
function stopService() {
  if (!child) return;
  stoppingByUser = true;
  log(`停止服务进程 pid=${child.pid}`);
  child.kill();
}

/* --------------------------------- 菜单 --------------------------------- */

function statusLabel() {
  if (config.mode === 'remote') return `WorkHub（远程 ${config.target}）`;
  return status === 'running' ? 'WorkHub（运行中）' : 'WorkHub（已停止）';
}

function refreshMenu() {
  if (!tray) return;
  const running = status === 'running';
  const template = [
    { label: statusLabel(), enabled: false },
    { type: 'separator' },
    {
      label: '打开网页',
      click: () => {
        shell.openExternal(config.target);
      },
    },
  ];
  if (config.mode === 'local') {
    template.push(
      { type: 'separator' },
      {
        label: '启动服务',
        enabled: !running && !child,
        click: startService,
      },
      {
        label: '停止服务',
        enabled: running && Boolean(child),
        click: stopService,
      },
    );
  }
  template.push({ type: 'separator' }, { label: '退出', click: quit });
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(statusLabel());
}

function quit() {
  stoppingByUser = true;
  if (child) child.kill();
  app.quit();
}

/* --------------------------------- 启动 --------------------------------- */

app.setAppUserModelId('com.workhub.tray');

app.whenReady().then(() => {
  config = loadConfig();
  config.appDir = resolveAppDir(config);

  if (config.mode === 'remote') {
    if (!config.target) {
      log('remote 模式必须在配置里写 target（服务器地址）');
      app.quit();
      return;
    }
  } else if (!config.target) {
    config.target = `http://127.0.0.1:${readPortFromEnv(config.appDir)}`;
  }
  log(`模式=${config.mode} target=${config.target} appDir=${config.appDir}`);
  if (config.configFile) log(`配置文件=${config.configFile}`);

  const images = makeTrayImages();
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const buffer = scale >= 1.5 ? images.large : images.small;
  tray = new Tray(nativeImage.createFromBuffer(buffer));
  // 左键点图标＝打开网页，这是托盘应用最常用的动作
  tray.on('click', () => shell.openExternal(config.target));
  refreshMenu();

  // 状态轮询：菜单上的「运行中/已停止」要跟着实际情况变
  setInterval(async () => {
    const alive = await probe();
    const next = alive ? 'running' : 'stopped';
    if (next === status) return;
    status = next;
    if (alive) restarts = 0; // 活过一次就说明这次不是崩溃循环
    refreshMenu();
  }, 3000);

  // 自动化验证用的钩子：菜单动作没法在无人值守下点，测试时用环境变量触发同一条路径。
  // 只在显式设置时生效，正常运行不碰。
  const testAction = process.env.WORKHUB_TRAY_TEST;
  if (testAction === 'stop' || testAction === 'quit') {
    setTimeout(() => {
      log(`测试钩子触发：${testAction}`);
      if (testAction === 'stop') stopService();
      else quit();
    }, 5000);
  }

  // 本地版：托盘启动时服务没在跑就把它拉起来
  if (config.mode === 'local') {
    probe().then((alive) => {
      status = alive ? 'running' : 'stopped';
      refreshMenu();
      if (!alive) startService();
    });
  }
});

// 托盘应用没有窗口：关掉所有窗口不该退出程序
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  stoppingByUser = true;
  if (child) child.kill();
});
