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
const { app, Tray, Menu, nativeImage, shell, screen, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { makeTrayImages } = require('./icon.cjs');
const { fetchStatus, fetchLogs, restartServer, manageToken } = require('./manage.cjs');

const DEFAULT_PORT = 8787;
/** 连续崩溃多少次后不再自动重启——服务起不来时反复重启只会刷日志、占 CPU */
const MAX_RESTARTS = 3;
/** 崩溃重启的间隔 */
const RESTART_DELAY_MS = 2000;

const DEFAULTS = {
  mode: 'local', // 'local' | 'remote'
  target: '', // 留空则本地模式按 .env 的 MDHUB_PORT 推 127.0.0.1
  appDir: '', // 工作目录（.env / 数据库 / 日志）；留空则按运行形态取默认
  entry: 'server/index.ts', // 服务入口（相对代码目录）
  token: '', // remote 模式的机器令牌
};

let config = null;
/** 运行路径：开发态与打包态的差别全在这里 */
let paths = null;
let tray = null;
/** remote 模式：最近一次从服务器拿到的状态，给菜单显示用 */
let remoteInfo = null;
/** remote 模式：上次拉状态的时间，用来限流 */
let remoteFetchAt = 0;
/** 当前拉起的服务进程（remote 模式恒为 null） */
let child = null;
/** 用户主动点的「停止服务」——这种退出不该被当成崩溃而拉起来 */
let stoppingByUser = false;
/** 连续崩溃次数 */
let restarts = 0;
/** 'running' | 'stopped' */
let status = 'stopped';

/* --------------------------------- 路径 --------------------------------- */

/**
 * 算出这次运行各处路径。
 *
 * 打包态最要紧的一条：**代码在安装目录（只读），数据与密钥在用户目录（可写）**。
 * 服务端是按代码目录定位数据库和 vault 的（`DB_V2_PATH` 相对代码目录算），
 * 所以打包态必须把这两个路径用环境变量掰到用户目录去——
 * 否则数据库会被写进 Program Files，普通用户写不进去，服务一起来就报错。
 */
function resolvePaths() {
  if (app.isPackaged) {
    // 安装目录：代码 + 前端产物 + 依赖，只读
    const codeDir = path.join(process.resourcesPath, 'payload');
    // 用户目录：.env / 数据库 / vault / 日志，可写
    const dataDir = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'WorkHub');
    return {
      codeDir,
      dataDir,
      entry: path.join(codeDir, 'server', 'index.ts'),
      runner: path.join(codeDir, 'run-server.cjs'),
      envFile: path.join(dataDir, '.env'),
      logsDir: path.join(dataDir, 'logs'),
      packaged: true,
    };
  }
  // 开发态：仓库根既是代码目录也是工作目录
  const repoRoot = path.resolve(app.getAppPath(), '..');
  return {
    codeDir: repoRoot,
    dataDir: repoRoot,
    entry: path.join(repoRoot, 'server', 'index.ts'),
    runner: path.join(__dirname, 'run-server.cjs'),
    envFile: path.join(repoRoot, '.env'),
    logsDir: path.join(repoRoot, 'logs'),
    packaged: false,
  };
}

/* --------------------------------- 配置 --------------------------------- */

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  if (!paths) return;
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    fs.appendFileSync(path.join(paths.logsDir, 'tray.log'), line);
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
      // 去掉 BOM：Windows 上记事本、PowerShell 写出来的 UTF-8 文件都带 BOM，
      // 而 JSON.parse 不认它。一个 BOM 不该让托盘悄悄退回默认模式——
      // 退回意味着 remote 变成本地，看起来像是「连不上服务器」。
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
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
function readPortFromEnv(envFile) {
  if (process.env.MDHUB_PORT) {
    const fromEnv = Number(process.env.MDHUB_PORT);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  }
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    const match = raw.match(/^\s*MDHUB_PORT\s*=\s*(\d+)/m);
    return match ? Number(match[1]) : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/* ------------------------------ 首次运行初始化 ------------------------------ */

/**
 * 打包态首次运行时生成 .env。
 *
 * 服务端在生产模式下没有 MDHUB_SECRET / MDHUB_ADMIN_PASSWORD 就拒绝启动
 * （这是故意的：密钥缺失等于全站权限失守，不能悄悄降级成默认弱口令）。
 * 使用者装完即用，就意味着这两个值得由托盘替他们准备好：
 * 随机密钥 + 随机密码，密码当面告诉他一次。
 */
async function ensureEnvFile() {
  if (!paths.packaged) return { password: null };
  if (fs.existsSync(paths.envFile)) return { password: null };

  const secret = randomBytes(32).toString('hex');
  const password = randomBytes(9).toString('base64url');
  const port = await pickFreePort(DEFAULT_PORT);
  fs.mkdirSync(path.dirname(paths.envFile), { recursive: true });
  fs.writeFileSync(
    paths.envFile,
    [
      '# WorkHub 本地版配置（首次启动自动生成）',
      '# 主密钥：用于 JWT 签名与 API Key 加密，切勿泄露或分享',
      `MDHUB_SECRET=${secret}`,
      '# 管理员初始密码：仅首次建库时写入账号，之后改这里不会改密码',
      `MDHUB_ADMIN_PASSWORD=${password}`,
      '# 监听端口（托盘按它拼出「打开网页」的地址）',
      `MDHUB_PORT=${port}`,
      '',
    ].join('\n'),
    'utf8',
  );
  return { password, port };
}

/** 端口有没有被占着 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 找一个没人用的端口。
 *
 * 默认端口被别的程序占了的话，服务起来就崩，使用者看到的却是「托盘转圈」——
 * 这种问题没人查得出来，所以第一次生成配置时就避让掉。
 */
async function pickFreePort(preferred) {
  for (let port = preferred; port < preferred + 20; port += 1) {
    if (await isPortFree(port)) return port;
  }
  return preferred;
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
function envFileArgs() {
  if (paths.packaged) {
    // 打包态的 .env 由 ensureEnvFile 保证存在
    return [`--env-file=${paths.envFile}`];
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 9)) return ['--env-file-if-exists=.env'];
  return fs.existsSync(paths.envFile) ? [`--env-file=${paths.envFile}`] : [];
}

/**
 * 子进程的环境变量。
 *
 * 打包态要显式把数据库和 vault 掰到用户目录：服务端默认是按代码目录定位它们的，
 * 而打包后代码在安装目录里（只读），普通用户写不进去。
 */
function childEnv() {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    WORKHUB_PARENT_PID: String(process.pid),
  };
  if (paths.packaged) {
    env.NODE_ENV = 'production';
    env.MDHUB_DB_V2 = path.join(paths.dataDir, 'data', 'mdhub-v2.db');
    env.MDHUB_VAULT_DIR = path.join(paths.dataDir, 'data', 'vault');
  }
  return env;
}

async function startService() {
  if (child) return;
  stoppingByUser = false;

  // 端口被占着就别硬拉了：多半是已经有一个 WorkHub 在跑（或别的程序占了端口）。
  // 不探这一下的话，服务会反复 EADDRINUSE 崩掉，日志里只剩一堆看不懂的堆栈。
  const port = Number(new URL(config.target).port || DEFAULT_PORT);
  if (!(await isPortFree(port))) {
    log(`端口 ${port} 已被占用，不再拉起服务（可能已经有一个 WorkHub 在运行）`);
    refreshMenu();
    return;
  }

  const entry = paths.entry;
  if (!fs.existsSync(entry)) {
    log(`服务入口不存在：${entry}（检查配置里的 appDir / entry）`);
    return;
  }

  fs.mkdirSync(paths.logsDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(paths.logsDir, 'service.log'), { flags: 'a' });

  // ELECTRON_RUN_AS_NODE=1 让 electron.exe 以纯 Node 模式运行：
  // 使用者机器上不用装 Node，托盘自带运行时就够了。
  // 入口前面套一层 run-server.cjs：托盘被强杀时，服务进程会跟着退出（见该文件注释）。
  child = spawn(process.execPath, [...envFileArgs(), paths.runner, entry], {
    cwd: paths.dataDir,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    // 正在升级：先别拉。
    // 升级器要替换代码目录里的文件，这时候拉起来的是旧代码，
    // 等它换完再启动新代码就会撞端口。升级器换完会撤掉标记。
    const upgradeFlag = path.join(paths.codeDir, '.upgrade-in-progress');
    if (fs.existsSync(upgradeFlag)) {
      log('检测到升级标记，等升级完成后再拉起服务');
      waitUpgradeThenStart(upgradeFlag);
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
 * 等升级换完代码，再把服务拉起来。
 *
 * 升级器换完代码会撤掉标记。撤掉之后拉起来的才是新版本——
 * 提前拉起来的话，拉的是旧代码，还会占着端口跟升级器抢。
 */
function waitUpgradeThenStart(flag) {
  const deadline = Date.now() + 10 * 60 * 1000;
  const timer = setInterval(() => {
    if (!fs.existsSync(flag)) {
      clearInterval(timer);
      log('升级完成，拉起新版本服务');
      restarts = 0;
      startService();
      return;
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      log('升级标记 10 分钟没消失（升级多半失败了），自己拉起来');
      startService();
    }
  }, 1000);
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

/** 把秒数说成人话 */
function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${total % 60} 秒`;
  return `${total} 秒`;
}

/** 字节数说成人话 */
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function statusLabel() {
  if (config.mode === 'remote') {
    // 远端模式显示的是「那台服务器」的状态，不是本机的
    const detail = !remoteInfo
      ? '连接中'
      : remoteInfo.online
        ? `运行中${remoteInfo.version ? ` v${remoteInfo.version}` : ''}`
        : '离线';
    return `WorkHub（远程 ${config.target} · ${detail}）`;
  }
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
  } else {
    // remote 模式：这一组是「管那台服务器」的动作
    template.push(
      { type: 'separator' },
      { label: '查看服务器状态', click: showRemoteStatus },
      { label: '查看最近日志', click: showRemoteLogs },
      { label: '重启服务器', click: confirmRemoteRestart },
    );
  }
  template.push({ type: 'separator' }, { label: '退出', click: quit });
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(statusLabel());
}

/* ------------------------------ 远端管理动作 ------------------------------ */

/** 把远端调用失败原样告诉使用者，别让错误消失在控制台里 */
function reportRemoteError(title, err) {
  log(`${title}失败：${err?.message ?? err}`);
  dialog.showMessageBox({
    type: 'error',
    title,
    message: `${title}失败`,
    detail: String(err?.message ?? err),
    buttons: ['好'],
  });
}

/** 服务器状态详情 */
async function showRemoteStatus() {
  try {
    const info = await fetchStatus(config);
    const counts = info.counts ?? {};
    const supervisor = info.supervisor?.detected
      ? `${info.supervisor.detected}${info.supervisor.managedByTray ? '（托盘托管）' : ''}`
      : '无（裸跑）';
    dialog.showMessageBox({
      type: 'info',
      title: '服务器状态',
      message: `${config.target} · v${info.version ?? '未知'}`,
      detail: [
        `运行时长：${formatUptime(info.uptime)}`,
        `进程：pid ${info.pid} · ${info.runtime?.node ?? '?'} · ${info.runtime?.platform ?? '?'}`,
        `内存：${formatBytes(info.memory?.rss)}（堆 ${formatBytes(info.memory?.heapUsed)}）`,
        `数据库：${info.database?.path ?? '?'}（${formatBytes(info.database?.sizeBytes)}）`,
        `内容：仓库 ${counts.repos ?? '?'} 个 · 节点 ${counts.nodes ?? '?'} 条 · 用户 ${counts.users ?? '?'} 个`,
        `托管方式：${supervisor}`,
      ].join('\n'),
      buttons: ['好'],
    });
  } catch (err) {
    reportRemoteError('查看服务器状态', err);
  }
}

/** 最近日志 */
async function showRemoteLogs() {
  try {
    const data = await fetchLogs(config, 60);
    const lines = Array.isArray(data.lines) ? data.lines : [];
    dialog.showMessageBox({
      type: 'info',
      title: '服务器最近日志',
      message: lines.length ? `最近 ${lines.length} 行` : '（暂时没有日志）',
      detail: lines.length ? lines.join('\n') : '（空）',
      buttons: ['好'],
    });
  } catch (err) {
    reportRemoteError('查看最近日志', err);
  }
}

/** 重启服务器（先问一句——这一步会短暂中断服务） */
async function confirmRemoteRestart() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: '重启服务器',
    message: '确定要重启这台服务器吗？',
    detail: '重启期间服务会短暂不可用。已经在跑的请求会被中断。',
    buttons: ['取消', '重启'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return;
  try {
    const result = await restartServer(config);
    log(`已请求重启服务器：${result.strategy}（${result.detail}）`);
    dialog.showMessageBox({
      type: 'info',
      title: '重启服务器',
      message: '已发出重启请求',
      detail: `${result.strategy}：${result.detail}`,
      buttons: ['好'],
    });
  } catch (err) {
    reportRemoteError('重启服务器', err);
  }
}

/**
 * 拉一次远端状态，给菜单显示用。
 *
 * 限流到 15 秒一次：菜单上的信息不需要秒级新鲜，
 * 而服务器那边可能是个跑在树莓派上的小机器。
 */
async function refreshRemoteInfo() {
  if (!manageToken(config)) return;
  const now = Date.now();
  if (now - remoteFetchAt < 15000) return;
  remoteFetchAt = now;
  const wasOnline = remoteInfo?.online;
  try {
    const info = await fetchStatus(config);
    remoteInfo = { ...info, online: true };
    if (wasOnline !== true) {
      log(`远端在线：${config.target} v${info.version ?? '?'}，已运行 ${formatUptime(info.uptime)}`);
    }
  } catch (err) {
    remoteInfo = { online: false };
    // 只在状态翻转时记：每 15 秒一条同样的话会把真正的异常淹掉
    if (wasOnline !== false) log(`远端连不上：${config.target}（${err?.message ?? err}）`);
  }
  refreshMenu();
}

function quit() {
  stoppingByUser = true;
  if (child) child.kill();
  app.quit();
}

/* --------------------------------- 启动 --------------------------------- */

app.setAppUserModelId('com.workhub.tray');

app.whenReady().then(async () => {
  paths = resolvePaths();
  config = loadConfig();
  // 工作目录可配（便携运行、测试都可能用到），默认按运行形态取
  if (config.appDir) paths.dataDir = path.resolve(config.appDir);
  // 服务入口：相对路径按代码目录拼，绝对路径直接用
  paths.entry = path.isAbsolute(config.entry)
    ? config.entry
    : path.join(paths.codeDir, config.entry);

  // 首次运行：生成 .env（打包态），并把初始密码当面告诉使用者。
  // 放在算 target 前面——端口是刚写进 .env 的，得按它来拼地址。
  const { password } = await ensureEnvFile();
  if (password) {
    log('首次运行：已生成 .env');
    dialog.showMessageBox({
      type: 'info',
      title: 'WorkHub 首次启动',
      message: '管理员账号：admin',
      detail:
        `初始密码：${password}\n\n` +
        '这个密码只显示这一次，请抄进密码管理器。\n' +
        '之后要改密码，请到「设置 → 账号」里改。',
      buttons: ['我记下了'],
    });
  }

  if (config.mode === 'remote') {
    if (!config.target) {
      log('remote 模式必须在配置里写 target（服务器地址）');
      app.quit();
      return;
    }
  } else if (!config.target) {
    config.target = `http://127.0.0.1:${readPortFromEnv(paths.envFile)}`;
  }
  log(`模式=${config.mode} target=${config.target}`);
  log(`代码目录=${paths.codeDir} 工作目录=${paths.dataDir}`);
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
    const changed = next !== status;
    status = next;
    if (alive) restarts = 0; // 活过一次就说明这次不是崩溃循环
    if (changed) refreshMenu();
    // remote 模式：顺带拉一次服务器详情，让菜单能显示版本与运行时长
    if (config.mode === 'remote') void refreshRemoteInfo();
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
  // remote 模式的动作同理：走的是同一套客户端，只是不弹窗，把结果记进日志
  if (testAction && testAction.startsWith('manage-')) {
    setTimeout(async () => {
      log(`测试钩子触发：${testAction}`);
      try {
        if (testAction === 'manage-status') log(`状态：${JSON.stringify(await fetchStatus(config))}`);
        else if (testAction === 'manage-logs') log(`日志：${JSON.stringify(await fetchLogs(config, 5))}`);
        else log(`重启：${JSON.stringify(await restartServer(config))}`);
      } catch (err) {
        log(`远端调用失败：${err?.message ?? err}`);
      }
      quit();
    }, 4000);
  }

  // 本地版：托盘启动时服务没在跑就把它拉起来
  if (config.mode === 'local') {
    probe().then((alive) => {
      status = alive ? 'running' : 'stopped';
      refreshMenu();
      if (alive) {
        log('服务已经在运行，托盘只做监控（不再拉起第二个）');
        return;
      }
      startService();
    });
  }
});

// 托盘应用没有窗口：关掉所有窗口不该退出程序
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  stoppingByUser = true;
  if (child) child.kill();
});
