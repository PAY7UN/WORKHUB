/**
 * 外部更新器：服务退出之后，由它来换代码、拉起服务、验活、失败回滚。
 *
 * 为什么要单独一个进程：
 * Windows 上运行中的代码换不掉（node.exe 被占着，better-sqlite3 的 .node
 * 被 mmap 锁着）。要换代码就得先让服务退出，而「服务退出之后继续把活干完」
 * 只能由一个独立于服务进程的进程来做。
 *
 * 流程：
 *   1. 等服务进程真的退出（最多 60 秒）
 *   2. 备份将被覆盖的内容
 *   3. 覆盖新代码，并删掉新版里已经没有的旧文件
 *   4. 依赖变了就装依赖
 *   5. 撤掉升级标记 → 让宿主/托盘把服务拉起来
 *   6. 健康检查；不通就回滚，再拉一次
 *
 * 这个脚本只依赖 Node 内置模块：它自己就站在被替换的代码目录边上，
 * 万一新代码有 bug，靠的是新代码之外的自己把它救回来。
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
}

const ROOT = resolve(args.root ?? '.');
const STAGING = resolve(args.staging ?? join(ROOT, '.upgrade-staging'));
const PAYLOAD = resolve(args.payload ?? join(STAGING, 'payload'));
const VERSION = args.version ?? 'unknown';
const RESTART_MODE = args['restart-mode'] ?? 'self';
const RESTART_DETAIL = args['restart-detail'] ?? '';
const SERVICE_PID = Number(args.pid ?? '0');
const LOG_PATH = resolve(args.log ?? join(ROOT, 'logs', 'upgrade.log'));

const BACKUP = join(STAGING, 'backup');
const FLAG = join(ROOT, '.upgrade-in-progress');
const FILES_MANIFEST = '.workhub-files.txt';

/**
 * 兜底日志：主日志写不进去时（目录没了、文件被锁住），
 * 至少还有一份在别处。
 *
 * 没有它的话，「日志写失败」和「进程被杀了」在日志里长得一模一样——
 * 都是突然没了下文，排查时只能靠猜。
 */
const FALLBACK_LOG = join(tmpdir(), 'workhub-upgrade-fallback.log');

/** 这些目录/文件是数据，不是代码：升级时绝不能碰 */
const PROTECTED = new Set(['data', 'logs', 'node_modules', '.env', '.git']);

mkdirSync(dirname(LOG_PATH), { recursive: true });

// 服务端退出后 stdout 的管道读端就没了，之后往里写会报 EPIPE。
// 这个 error 事件没人接的话会变成 uncaught exception，把更新器带走——
// 而更新器一旦死了，代码换了一半没人收尾，服务就停在半死不活的状态。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// 死因记录：更新器要是没了，日志里总得留个话。
// 没有这些监听的话，「被谁弄死的」和「自己跑完了」在日志里长得一模一样——
// 都是突然没了下文。
process.on('uncaughtException', (err) => {
  log('error', `更新器未捕获异常：${err?.stack ?? err}`);
  try {
    writeResult('failed', `更新器异常：${err?.message ?? err}`);
  } catch {
    // 记不下来就算了
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', `更新器未处理的 Promise 拒绝：${reason?.stack ?? reason}`);
});
process.on('exit', (code) => {
  // 退出时的最后一句话。写失败也无所谓——写到哪算哪。
  try {
    writeFileSync(
      LOG_PATH,
      `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [info] 更新器进程退出（code=${code}）\n`,
      { flag: 'a' },
    );
  } catch {
    // 写不了就算了
  }
});

function log(level, message) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${stamp}] [${level}] ${message}\n`;
  try {
    writeFileSync(LOG_PATH, line, { flag: 'a' });
  } catch {
    // 主日志写不进去，退到兜底日志，别让排查断线
    try {
      writeFileSync(FALLBACK_LOG, line, { flag: 'a' });
    } catch {
      // 连兜底都写不了，那真没辙了
    }
  }
  // 往 stdout 写是给人看的补充，不是正事。
  // 服务端退出后这条管道的读端就没了，这时写会抛 EPIPE——
  // 一次没兜住的 EPIPE 能把整个更新器带崩：代码换了一半，
  // 健康检查没做，回滚也没做，服务就停在那儿半死不活。
  try {
    process.stdout.write(line);
  } catch {
    // 写不出去就算了，日志文件里已经有
  }
}

/** 进程还在不在（Windows 上 process.kill(pid, 0) 也能问这个问题） */
function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 说明进程在，只是我们没权限问
    return err.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等服务进程退出 */
async function waitForServiceExit(timeoutMs = 60000) {
  if (!SERVICE_PID) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(SERVICE_PID)) return true;
    await sleep(300);
  }
  return false;
}

/** 健康检查：服务活着没有 */
async function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '无响应';
  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err.message;
    }
    // 心跳：卡住和死掉在日志里长得一样（都没下文），
    // 有了心跳就能分清——有心跳是等不着，没心跳是压根没活到这儿
    if (Date.now() - lastBeat >= 10000) {
      lastBeat = Date.now();
      log('info', `等健康检查通过中…（端口 ${port}，${lastError}）`);
    }
    await sleep(1000);
  }
  log('error', `健康检查没通过：${lastError}`);
  return false;
}

/**
 * 找服务监听的端口。
 *
 * 端口找错的后果很严重：健康检查打错端口 → 以为新版本起不来 → 触发回滚，
 * 于是「升级其实成功了」被当成「升级失败」给回滚回去。
 * 所以这里多找几个地方，宁可多试一次也不误判。
 */
function resolvePort() {
  // 1. 环境变量最准：更新器是服务进程拉起来的，继承的就是服务自己在用的端口
  const fromEnv = Number(process.env.MDHUB_PORT ?? '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;

  // 2. .env 里也可能有（服务是用 --env-file 起的，端口写在那儿）
  try {
    const match = readFileSync(join(ROOT, '.env'), 'utf8').match(/^\s*MDHUB_PORT\s*=\s*(\d+)/m);
    if (match) return Number(match[1]);
  } catch {
    // 没有 .env
  }

  // 3. 服务配置文件（裸跑、任务计划模式下可能就在根目录）
  for (const candidate of [join(ROOT, 'service.conf'), join(ROOT, 'logs', 'service.conf')]) {
    try {
      const match = readFileSync(candidate, 'utf8').match(/^\s*port\s*=\s*(\d+)/m);
      if (match) return Number(match[1]);
    } catch {
      // 没有这个文件
    }
  }

  return 8787;
}

/** 目录下的顶层项名 */
function topLevelNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 备份将被覆盖的顶层项 */
function backupPayload() {
  mkdirSync(BACKUP, { recursive: true });
  const names = topLevelNames(PAYLOAD).filter((name) => !PROTECTED.has(name));
  for (const name of names) {
    const existing = join(ROOT, name);
    if (existsSync(existing)) {
      cpSync(existing, join(BACKUP, name), { recursive: true });
    }
  }
  // 旧版的文件清单也要留着：算「删哪些旧文件」时要用
  const oldManifest = join(ROOT, FILES_MANIFEST);
  if (existsSync(oldManifest)) {
    cpSync(oldManifest, join(BACKUP, FILES_MANIFEST));
  }
  log('info', `已备份：${names.join('、') || '（无）'}`);
}

/** 读文件清单（相对路径，一行一个） */
function readFileManifest(dir) {
  try {
    return readFileSync(join(dir, FILES_MANIFEST), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 删掉新版里已经没有的旧文件。
 *
 * 不删的话，旧版本的文件会留在目录里，改个文件名加个版本号的行为
 * 就永远改不掉——那种 bug 极难查。
 */
function removeStaleFiles() {
  const oldFiles = readFileManifest(BACKUP);
  const newFiles = new Set(readFileManifest(PAYLOAD));
  if (oldFiles.length === 0) return;
  const stale = oldFiles.filter((file) => !newFiles.has(file));
  let removed = 0;
  for (const file of stale) {
    const segments = file.split('/');
    if (segments.some((segment) => PROTECTED.has(segment))) continue;
    const target = join(ROOT, file);
    if (!existsSync(target)) continue;
    try {
      rmSync(target, { force: true });
      removed += 1;
    } catch (err) {
      log('warn', `删不掉旧文件 ${file}：${err.message}`);
    }
  }
  if (removed > 0) log('info', `已清理 ${removed} 个新版里不再有的旧文件`);
}

/** 覆盖新代码 */
function applyPayload() {
  const names = topLevelNames(PAYLOAD);
  for (const name of names) {
    if (PROTECTED.has(name)) continue;
    const from = join(PAYLOAD, name);
    const to = join(ROOT, name);
    try {
      rmSync(to, { recursive: true, force: true });
    } catch {
      // 删不掉就往下覆盖
    }
    cpSync(from, to, { recursive: true });
  }
  log('info', '新代码已就位');
}

/** 依赖变了就装依赖 */
function installDependenciesIfNeeded() {
  let before;
  let after;
  try {
    before = JSON.parse(readFileSync(join(BACKUP, 'package.json'), 'utf8'));
    after = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  } catch {
    return Promise.resolve(true); // 读不到就别乱动依赖
  }
  const same = JSON.stringify(before.dependencies ?? {}) === JSON.stringify(after.dependencies ?? {});
  if (same) {
    log('info', '依赖没变，跳过安装');
    return Promise.resolve(true);
  }
  log('info', '依赖有变化，开始安装（可能要几分钟）……');
  return new Promise((resolvePromise) => {
    const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', (err) => {
      log('error', `装依赖失败：${err.message}`);
      resolvePromise(false);
    });
    child.on('close', (code) => {
      if (code === 0) {
        log('info', '依赖安装完成');
        resolvePromise(true);
      } else {
        log('error', `装依赖失败（退出码 ${code}）：${out.slice(-500)}`);
        resolvePromise(false);
      }
    });
  });
}

/** 撤掉升级标记：宿主看门狗看到标记没了就会把服务拉起来 */
function releaseFlag() {
  try {
    rmSync(FLAG, { force: true });
  } catch {
    // 标记留着的话宿主不会拉起服务，比什么都糟
  }
}

/** 自己拉起服务（裸跑模式才用得上） */
function startSelf() {
  // 新服务的输出要留档：升级后新版本起不来时，唯一的线索就在它的输出里。
  // 丢进 stdio: 'ignore' 就等于什么线索都没有，只能靠猜。
  let out;
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    out = openSync(join(ROOT, 'logs', 'service-restart.log'), 'a');
  } catch {
    out = 'ignore';
  }
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.ts'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  log('info', `已拉起新服务进程（pid=${child.pid}）`);
}

/** 按托管方式把服务弄起来 */
function triggerRestart() {
  if (RESTART_MODE === 'host') {
    log('info', '等 Windows 服务宿主把服务拉起来');
    return;
  }
  if (RESTART_MODE === 'tray') {
    log('info', '等托盘把服务拉起来');
    return;
  }
  if (RESTART_MODE === 'supervisor') {
    log('info', `等 ${RESTART_DETAIL} 把服务拉起来`);
    return;
  }
  if (RESTART_MODE === 'command') {
    const parts = RESTART_DETAIL.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      startSelf();
      return;
    }
    const child = spawn(parts[0], parts.slice(1), { detached: true, stdio: 'ignore' });
    child.unref();
    log('info', `已执行重启命令：${RESTART_DETAIL}`);
    return;
  }
  startSelf();
}

/** 回滚：把备份恢复回去 */
function rollback() {
  log('warn', '开始回滚到升级前的版本');
  writeFileSync(FLAG, `${new Date().toISOString()} rollback\n`);
  const names = topLevelNames(BACKUP);
  for (const name of names) {
    if (PROTECTED.has(name)) continue;
    const from = join(BACKUP, name);
    const to = join(ROOT, name);
    try {
      rmSync(to, { recursive: true, force: true });
    } catch {
      // 往下走
    }
    if (existsSync(from)) {
      cpSync(from, to, { recursive: true });
    }
  }
  log('info', '已回滚到升级前的代码');
}

/** 记下这次升级的结果，给前端看 */
function writeResult(status, message) {
  try {
    const record = {
      version: VERSION,
      from: 'previous',
      status,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      message,
    };
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    writeFileSync(join(ROOT, 'logs', '.last-upgrade.json'), JSON.stringify(record, null, 2), 'utf8');
  } catch {
    // 记不下来就算了
  }
}

async function main() {
  log('info', `更新器启动：升级到 ${VERSION}，托管方式 ${RESTART_MODE}`);

  const exited = await waitForServiceExit(60000);
  if (!exited) {
    log('error', `服务进程 ${SERVICE_PID} 一直没退出，不敢动它的文件，升级中止`);
    writeResult('failed', '服务进程未能退出，升级中止');
    process.exit(1);
  }
  log('info', '服务已退出，开始替换代码');

  backupPayload();
  applyPayload();
  removeStaleFiles();

  const depsOk = await installDependenciesIfNeeded();
  if (!depsOk) {
    rollback();
    releaseFlag();
    triggerRestart();
    writeResult('rolled-back', '依赖安装失败，已回滚到升级前的版本');
    log('error', '依赖装不上，已回滚');
    process.exit(1);
  }

  // 撤标记 → 宿主/托盘/守护进程把服务拉起来
  releaseFlag();
  triggerRestart();

  const port = resolvePort();
  log('info', `开始健康检查（端口 ${port}）`);
  const healthy = await waitHealthy(port, 90000);
  if (!healthy) {
    log('warn', '升级后服务没能起来，回滚');
    rollback();
    releaseFlag();
    triggerRestart();
    const recovered = await waitHealthy(port, 60000);
    writeResult('rolled-back', recovered ? '升级后服务起不来，已自动回滚' : '升级后服务起不来，回滚后也没起来，需要人工看看');
    log('error', recovered ? '已回滚，服务恢复正常' : '回滚后服务仍不可用，需要人工介入');
    process.exit(recovered ? 1 : 2);
  }

  writeResult('success', `已升级到 ${VERSION}`);
  log('info', `升级完成，当前版本 ${VERSION}`);
  // 暂存目录里还有备份。升级成功了就没用了，留着只会占地方；
  // 万一以后想回滚，得靠重新下载，不靠这份备份。
  try {
    rmSync(STAGING, { recursive: true, force: true });
  } catch {
    // 删不掉就让系统自己清 %TEMP%
  }
  process.exit(0);
}

main().catch((err) => {
  log('error', `更新器异常：${err?.stack ?? err}`);
  writeResult('failed', String(err?.message ?? err));
  process.exit(1);
});
