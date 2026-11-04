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
const { app, Tray, Menu, nativeImage, shell, screen, dialog, globalShortcut } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { makeTrayImages } = require('./icon.cjs');
const {
  fetchStatus,
  fetchLogs,
  fetchUpdate,
  restartServer,
  manageToken,
  startUpdate,
} = require('./manage.cjs');
const { applyTrayUpdate, checkTrayUpdate } = require('./update.cjs');

// 默认端口。托盘应用目录里没有 shared/（shared/ 在服务 payload 里，路径不通），
// 所以这里是镜像值。真源在 shared/constants.ts 的 DEFAULT_API_PORT，改端口时一起改。
const DEFAULT_PORT = 8787;
/** 连续崩溃多少次后不再自动重启——服务起不来时反复重启只会刷日志、占 CPU */
const MAX_RESTARTS = 3;
/** 崩溃重启的间隔 */
const RESTART_DELAY_MS = 2000;

const DEFAULTS = {
  mode: 'local', // 'local' | 'remote'
  target: '', // 留空则本地模式按 .env 的 WORKHUB_PORT 推 127.0.0.1
  appDir: '', // 工作目录（.env / 数据库 / 日志）；留空则按运行形态取默认
  entry: '', // 服务入口（相对代码目录）；留空则按约定自动探测
  token: '', // remote 模式的机器令牌
  hotkey: 'Control+Alt+W', // 全局快捷键：按一下就打开网页
  update: {}, // 托盘自更新源（manifest / url / repo），留空则走 GitHub Releases
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
/**
 * 服务入口约定（真源在 scripts/lib/service-entry.mjs，规则改动要同步）：
 *   1. .workhub-entry 里写的相对路径（可选）
 *   2. server/index.js —— 编译产物，发布包里用这一份
 *   3. server/index.ts —— 源码直跑，仓库形态用这一份
 *
 * 打包态跑的是编译产物：不依赖 Node 的类型剥离，Node 版本要求更低，
 * 启动也快一截。
 */
function resolveEntry(codeDir) {
  try {
    const manifest = path.join(codeDir, '.workhub-entry');
    if (fs.existsSync(manifest)) {
      const line = fs
        .readFileSync(manifest, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (line) {
        const rel = line.replace(/\\/g, '/');
        const abs = path.join(codeDir, rel);
        if (fs.existsSync(abs)) return abs;
      }
    }
  } catch {
    // 清单读不了就按约定往下找
  }
  const compiled = path.join(codeDir, 'server', 'index.js');
  if (fs.existsSync(compiled)) return compiled;
  return path.join(codeDir, 'server', 'index.ts');
}

function resolvePaths() {
  if (app.isPackaged) {
    // 安装目录：代码 + 前端产物 + 依赖，只读
    const codeDir = path.join(process.resourcesPath, 'payload');
    // 用户目录：.env / 数据库 / vault / 日志，可写
    const dataDir = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'WorkHub');
    return {
      codeDir,
      dataDir,
      entry: resolveEntry(codeDir),
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
    entry: resolveEntry(repoRoot),
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
 * 托盘启动时若环境里已经带着 WORKHUB_PORT，服务端（子进程继承同一份环境）
 * 听的就是那个端口，托盘也得跟着它走，否则托盘指向的地址和服务实际监听的地址对不上，
 * 表现是「菜单显示已停止，可服务明明在跑」。
 *
 * 旧名 WORKHUB_PORT 也认（见 server/env.ts 的说明）。
 */
function readPortFromEnv(envFile) {
  const fromEnv = Number(process.env.WORKHUB_PORT || process.env.WORKHUB_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    const match = raw.match(/^\s*(?:WORKHUB|MDHUB)_PORT\s*=\s*(\d+)/m);
    return match ? Number(match[1]) : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/* ------------------------------ 首次运行初始化 ------------------------------ */

/**
 * 打包态首次运行时生成 .env。
 *
 * 服务端在生产模式下没有 WORKHUB_SECRET / WORKHUB_ADMIN_PASSWORD 就拒绝启动
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
      `WORKHUB_SECRET=${secret}`,
      '# 管理员初始密码：仅首次建库时写入账号，之后改这里不会改密码',
      `WORKHUB_ADMIN_PASSWORD=${password}`,
      '# 监听端口（托盘按它拼出「打开网页」的地址）',
      `WORKHUB_PORT=${port}`,
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
    env.WORKHUB_DB_V2 = path.join(paths.dataDir, 'data', 'workhub-v2.db');
    env.WORKHUB_VAULT_DIR = path.join(paths.dataDir, 'data', 'vault');
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
      click: openTarget,
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
      { type: 'separator' },
      { label: '检查更新', click: () => void checkForUpdates() },
    );
    // 查到新版本后才多出这一条：没新版本时点「立即更新」没意义
    if (trayUpdate) {
      template.push({
        label: `立即更新到 v${trayUpdate.version}`,
        click: () => void runTrayUpdate(),
      });
    }
  } else {
    // remote 模式：这一组是「管那台服务器」的动作
    template.push(
      { type: 'separator' },
      { label: '查看服务器状态', click: showRemoteStatus },
      { label: '查看最近日志', click: showRemoteLogs },
      { label: '重启服务器', click: confirmRemoteRestart },
      { type: 'separator' },
      { label: '检查服务器更新', click: () => void showRemoteUpdate() },
      { label: '升级服务器', click: () => void confirmRemoteUpdate() },
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

/** 查远端服务器有没有新版本 */
async function showRemoteUpdate() {
  try {
    const info = await fetchUpdate(config);
    if (info.error) {
      dialog.showMessageBox({
        type: 'warning',
        title: '检查服务器更新',
        message: '查不到新版本',
        detail: `${info.error}\n\n服务器当前版本 ${info.currentVersion ?? '未知'}，不影响使用。`,
        buttons: ['好'],
      });
      return;
    }
    if (!info.updateAvailable) {
      dialog.showMessageBox({
        type: 'info',
        title: '检查服务器更新',
        message: `服务器已是最新版本（${info.currentVersion ?? '未知'}）`,
        buttons: ['好'],
      });
      return;
    }
    dialog.showMessageBox({
      type: 'info',
      title: '服务器有新版本',
      message: `发现新版本 v${info.latest?.version ?? '?'}`,
      detail: [
        `当前版本：${info.currentVersion ?? '未知'}`,
        `新版本：v${info.latest?.version ?? '?'}`,
        info.latest?.notes ? `\n${info.latest.notes}` : '',
        '\n在「升级服务器」里执行。',
      ].join('\n'),
      buttons: ['好'],
    });
  } catch (err) {
    reportRemoteError('检查服务器更新', err);
  }
}

/** 让远端服务器升级（先问一句——这一步会短暂中断服务） */
async function confirmRemoteUpdate() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: '升级服务器',
    message: '确定要升级这台服务器吗？',
    detail: '升级期间服务会短暂不可用。服务器会自己下载并解压新的压缩包，然后重启。',
    buttons: ['取消', '升级'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return;
  try {
    const result = await startUpdate(config);
    log(`已请求升级服务器：${JSON.stringify(result)}`);
    dialog.showMessageBox({
      type: 'info',
      title: '升级服务器',
      message: '已发出升级请求',
      detail: result.detail ?? '服务器正在换代码，换完会自动起来。',
      buttons: ['好'],
    });
  } catch (err) {
    reportRemoteError('升级服务器', err);
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

/* --------------------------- 打开网页 / 全局快捷键 --------------------------- */

/** 打开网页。托盘最常用的动作，统一走这里 */
function openTarget() {
  if (!config?.target) return;
  shell.openExternal(config.target);
}

/**
 * 注册全局快捷键。
 *
 * 有了它，托盘就是个「随时能叫出来的东西」：不用找图标，
 * 按一下快捷键网页就开了。快捷方式、开机启动这些也都能配合它用。
 *
 * 注册不上是常事（别的程序先注册了同一组合键），这时候只记日志、不罢工——
 * 快捷键没了顶多少一个入口，托盘起不来才是大事。
 */
function registerHotkey() {
  const accelerator = String(config.hotkey ?? '').trim();
  if (!accelerator) {
    log('没配快捷键，不注册');
    return;
  }
  try {
    const ok = globalShortcut.register(accelerator, () => {
      log(`快捷键 ${accelerator} 被按下`);
      openTarget();
    });
    if (!ok) {
      log(`快捷键 ${accelerator} 注册失败：多半已经被别的程序占着了（可在配置里换一个）`);
    } else {
      log(`已注册全局快捷键 ${accelerator}`);
    }
  } catch (err) {
    log(`快捷键 ${accelerator} 注册失败：${err?.message ?? err}`);
  }
}

/* -------------------------------- 托盘自更新 -------------------------------- */

/** 最近一次查到的更新信息，给菜单用 */
let trayUpdate = null;

/** 当前版本 */
function currentVersion() {
  if (app.isPackaged) return app.getVersion();
  try {
    const repoRoot = path.resolve(app.getAppPath(), '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * 自更新能不能做。
 *
 * 开发态不行：托盘跑在仓库里，程序目录是 node_modules/electron，
 * 「更新」意味着把整个 Electron 装一份新的进去——那不是更新，那是搞破坏。
 */
function selfUpdateBlockedReason() {
  if (!app.isPackaged) return '开发态不支持自更新（要更新请下载新版本重新安装）';
  const nodeExe = path.join(paths.codeDir, 'runtime', 'node.exe');
  if (!fs.existsSync(nodeExe)) {
    return '这个安装包里没有自带 Node 运行时，自动更新用不了，请手动下载新版本';
  }
  return null;
}

/** 查更新（有新版本就问要不要现在更） */
async function checkForUpdates() {
  const version = currentVersion();
  log(`检查更新：当前版本 ${version}`);
  const result = await checkTrayUpdate({ config, currentVersion: version });
  if (result.error) {
    log(`检查更新失败：${result.error}`);
    dialog.showMessageBox({
      type: 'warning',
      title: '检查更新',
      message: '查不到新版本',
      detail: `${result.error}\n\n当前版本 ${version}，不影响使用。`,
      buttons: ['好'],
    });
    return;
  }
  if (!result.updateAvailable) {
    log('已是最新版本');
    // 顺手把菜单里那条「立即更新到 vX」撤掉：它已经过期了
    trayUpdate = null;
    refreshMenu();
    dialog.showMessageBox({
      type: 'info',
      title: '检查更新',
      message: `已是最新版本（${version}）`,
      buttons: ['好'],
    });
    return;
  }
  trayUpdate = result.latest;
  refreshMenu();
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '有新版本',
    message: `发现新版本 v${result.latest.version}`,
    detail: [
      `当前版本：${version}`,
      `新版本：v${result.latest.version}`,
      result.latest.notes ? `\n${result.latest.notes}` : '',
      '\n现在更新的话，托盘会退出几十秒（Windows 上换程序目录必须这样），换完自动回来。',
    ].join('\n'),
    buttons: ['以后再说', '现在更新'],
    defaultId: 1,
    cancelId: 0,
  });
  if (response === 1) {
    await runTrayUpdate();
  }
}

/**
 * 执行托盘自更新。
 *
 * 顺序不能乱：
 * 1. 先下载解压（这期间服务照常跑，使用者没感觉）
 * 2. 再停本地服务（服务占着 payload 里的文件，不停就换不掉）
 * 3. 最后退托盘——更新器在等托盘退出，它退出后才动手
 * 4. 更新器换完文件，再把托盘拉起来
 */
async function runTrayUpdate() {
  const blocked = selfUpdateBlockedReason();
  if (blocked) {
    dialog.showMessageBox({ type: 'warning', title: '更新', message: blocked, buttons: ['好'] });
    return;
  }
  if (app.isPackaged) {
    const serverUpgrading = path.join(paths.codeDir, '.upgrade-in-progress');
    if (fs.existsSync(serverUpgrading)) {
      dialog.showMessageBox({
        type: 'warning',
        title: '更新',
        message: '服务器正在升级',
        detail: '检测到服务端的升级还没结束，等它结束了再来更新托盘。',
        buttons: ['好'],
      });
      return;
    }
  }

  const appDir = path.dirname(process.execPath);
  const scriptPath = fs.existsSync(path.join(appDir, 'apply-update.cjs'))
    ? path.join(appDir, 'apply-update.cjs')
    : path.join(__dirname, 'apply-update.cjs');

  log(`开始更新托盘：${currentVersion()} → ${trayUpdate?.version ?? '最新'}`);
  try {
    const result = await applyTrayUpdate({
      appDir,
      execPath: process.execPath,
      execArgs: [],
      scriptPath,
      nodeExePath: path.join(paths.codeDir, 'runtime', 'node.exe'),
      logPath: path.join(paths.logsDir, 'tray-update.log'),
      currentVersion: currentVersion(),
      config,
    });
    log(`更新包已就位（v${result.version}），更新器 pid=${result.updaterPid}`);
    await stopServiceAndWait();
    trayUpdate = null;
    refreshMenu();
    // 更新器在等托盘退出，它接手之后会把新托盘拉起来
    app.quit();
  } catch (err) {
    log(`更新失败：${err?.message ?? err}`);
    dialog.showMessageBox({
      type: 'error',
      title: '更新失败',
      message: '更新没能完成',
      detail: `${err?.message ?? err}\n\n托盘还在正常运行，可以稍后再试。`,
      buttons: ['好'],
    });
  }
}

/**
 * 停服务并等它真的退出。
 *
 * 光 kill 不够：进程还在的话，payload 里的文件（尤其 better-sqlite3 的原生模块）
 * 还被占着，更新器去覆盖就会失败。
 */
function stopServiceAndWait() {
  if (!child) return Promise.resolve();
  const pid = child.pid;
  stoppingByUser = true;
  log(`停止服务进程 pid=${pid}（更新前必须让它退出）`);
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      if (!child || Date.now() > deadline) {
        clearInterval(timer);
        resolvePromise();
        return;
      }
      try {
        child.kill();
      } catch {
        // 已经退出了
      }
    }, 300);
  });
}

function quit() {
  stoppingByUser = true;
  if (child) child.kill();
  app.quit();
}

/* --------------------------------- 启动 --------------------------------- */

/**
 * 单实例锁。
 *
 * 托盘是常驻程序：使用者从快捷方式、快捷键、开机启动再拉它一次，
 * 不该起出第二个托盘图标、第二个服务进程（第二个会抢端口，然后两个互相打架）。
 * 所以第二个实例只把「打开网页」的活儿交给已有实例，自己退出。
 *
 * 这一条是「托盘像可执行程序一样好调用」的前提：
 * 快捷键、快捷方式、命令行反复调它，都只会得到一个托盘。
 */
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  // 已经有实例在跑：安静退出，别弹窗抢戏
  app.exit(0);
}
app.on('second-instance', () => {
  log('又启动了一次，把打开网页的活儿交给已有实例');
  openTarget();
});

app.setAppUserModelId('com.workhub.tray');

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  paths = resolvePaths();
  config = loadConfig();
  // 工作目录可配（便携运行、测试都可能用到），默认按运行形态取
  if (config.appDir) paths.dataDir = path.resolve(config.appDir);
  // 服务入口：配置里写了就用配置的；没写（或写的那个不存在）按约定探测
  if (config.entry) {
    const configured = path.isAbsolute(config.entry)
      ? config.entry
      : path.join(paths.codeDir, config.entry);
    if (fs.existsSync(configured)) {
      paths.entry = configured;
    } else {
      log(`配置里的入口不存在（${config.entry}），改用自动探测的 ${paths.entry}`);
    }
  }

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
  tray.on('click', openTarget);
  refreshMenu();

  // 全局快捷键：按一下就打开网页，不用找图标
  registerHotkey();

  // 命令行 --open：直接开网页。桌面快捷方式就指着这个参数配，
  // 于是「双击快捷方式」＝「打开 WorkHub 网页」。
  if (process.argv.includes('--open')) {
    log('命令行带了 --open，直接打开网页');
    openTarget();
  }

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
  // 注销全局快捷键：留着会占着组合键，下次启动就注册不上了
  globalShortcut.unregisterAll();
  if (child) child.kill();
});
