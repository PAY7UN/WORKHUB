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
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { envValue } from '../server/env.ts';
import { parseEnvFile } from '../server/envFile.ts';

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
/**
 * 运行期日志目录。
 *
 * 服务端会把这个位置告诉更新器（WORKHUB_LOG_DIR）：打包态的代码目录在安装目录里，
 * 普通用户写不进去，升级日志落在那儿等于没落。托盘知道哪个目录可写，
 * 由它指过来，日志就跟服务日志待在一起。
 */
const LOG_DIR = envValue('LOG_DIR') ? resolve(envValue('LOG_DIR')) : join(ROOT, 'logs');
const LOG_PATH = resolve(args.log ?? join(LOG_DIR, 'upgrade.log'));

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
const PROTECTED = new Set(['data', 'logs', '.env', '.git']);

/**
 * 自带的 Node 运行时：升级时不换。
 *
 * 不是懒，是换不了：正在跑的服务就是 runtime/node.exe 起的，
 * Windows 上这个文件被占着，覆盖必然失败（EPERM）。
 * 而且运行时大版本升级该由人工安排重启窗口，不该夹在一次普通更新里。
 */
const RUNTIME_DIR = 'runtime';

/**
 * 服务入口约定（真源在 scripts/lib/service-entry.mjs，规则改动要同步）。
 *
 *   1. .workhub-entry 里写的相对路径（可选）
 *   2. server/index.js —— 编译产物，发布包里用这一份
 *   3. server/index.ts —— 源码直跑，仓库形态用这一份
 *
 * 这里内联一份而不 import：更新器只依赖 Node 内置模块，
 * 万一新代码坏了，靠的是新代码之外的自己把它救回来。
 */
const ENTRY_MANIFEST = '.workhub-entry';
const ENTRY_CANDIDATES = ['server/index.js', 'server/index.ts'];

/** 解析服务入口（相对 dir），找不到返回 null */
function resolveEntry(dir) {
  try {
    const manifest = join(dir, ENTRY_MANIFEST);
    if (existsSync(manifest)) {
      const line = readFileSync(manifest, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (line) {
        const rel = line.replace(/\\/g, '/');
        if (existsSync(join(dir, rel))) return rel;
      }
    }
  } catch {
    // 清单读不了就按约定往下找
  }
  for (const rel of ENTRY_CANDIDATES) {
    if (existsSync(join(dir, rel))) return rel;
  }
  return null;
}

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

/** 探一次健康检查 */
async function probeHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return { ok: response.ok, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 健康检查：服务活着没有 */
async function waitHealthy(port, timeoutMs, label = '健康检查') {
  const deadline = Date.now() + timeoutMs;
  let lastError = '无响应';
  let lastBeat = Date.now();
  while (Date.now() < deadline) {
    const probe = await probeHealth(port);
    if (probe.ok) return true;
    lastError = probe.error;
    // 心跳：卡住和死掉在日志里长得一样（都没下文），
    // 有了心跳就能分清——有心跳是等不着，没心跳是压根没活到这儿
    if (Date.now() - lastBeat >= 10000) {
      lastBeat = Date.now();
      log('info', `等${label}通过中…（端口 ${port}，${lastError}）`);
    }
    await sleep(1000);
  }
  log('error', `${label}没通过：${lastError}`);
  return false;
}

/** 找一个空闲端口：预检实例要另起一个，不能跟生产服务抢 */
function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** 连根拔掉一个进程树：预检实例可能自己拉了子进程 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // 杀不掉就算了，它自己也会退出
  }
}

/**
 * 升级前预检：拿新代码单独起一个实例，确认它能起来。
 *
 * 为什么值得多花这几十秒：
 * 原来的升级是「换上去才知道起不来」，一失败就回滚——停机两次，最长三分钟，
 * 而失败的原因往往在换之前就已经写在代码里了。
 * 预检放在动代码之前：这时生产服务还在跑，一个字节都没改，
 * 预检不过就直接放弃升级，停机时间是零。
 *
 * 预检实例用临时数据库和临时 vault，不碰生产数据；
 * 但数据库迁移会在临时库上真跑一遍——这正是想验的东西。
 */
async function preflight() {
  const entry = resolveEntry(PAYLOAD);
  if (!entry) {
    log('error', '新包里找不到服务入口，预检不通过');
    return false;
  }
  const runtimeNode = join(PAYLOAD, RUNTIME_DIR, 'node.exe');
  const nodeBin = existsSync(runtimeNode) ? runtimeNode : process.execPath;

  const work = join(STAGING, 'preflight');
  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
  } catch {
    // 清不掉就往下走，临时目录而已
  }

  const port = await findFreePort();
  const env = {
    ...process.env,
    WORKHUB_PORT: String(port),
    WORKHUB_DB_V2: join(work, 'preflight.db'),
    WORKHUB_VAULT_DIR: join(work, 'vault'),
    WORKHUB_ADMIN_PASSWORD: randomBytes(12).toString('base64url'),
    WORKHUB_LOG_LEVEL: 'warn',
    // 标记：这是隔离的预检实例，别碰生产资源。
    // 服务端代码可以据此分辨「预检」和「正式运行」。
    WORKHUB_PREFLIGHT: '1',
  };

  log('info', `开始预检：在隔离目录里起一个 ${entry} 实例（端口 ${port}）`);
  const child = spawn(nodeBin, [entry], {
    cwd: PAYLOAD,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });

  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    log('error', `预检实例提前退出（退出码 ${code}）`);
  });

  try {
    const ok = await waitHealthy(port, 45000, '预检');
    if (!ok) {
      log('error', `预检输出：${output.slice(-800)}`);
      return false;
    }
    log('info', '预检通过：新版本能起来');
    return true;
  } finally {
    killTree(child.pid);
    if (!exited) {
      try {
        child.kill();
      } catch {
        // 已经没了
      }
    }
  }
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
  const fromEnv = Number(envValue('PORT') || '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;

  // 2. .env 里也可能有（服务是用 --env-file 起的，端口写在那儿）
  try {
    // 解析规则跟 Node 的 --env-file 一致（引号、行尾注释、BOM 都要认），
    // 见 server/envFile.ts。写错一个字符，端口就找不到了。
    const parsed = parseEnvFile(readFileSync(join(ROOT, '.env'), 'utf8'));
    const port = Number(parsed.WORKHUB_PORT || '');
    if (Number.isFinite(port) && port > 0) return port;
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

  // 兜底：默认端口。这里故意写死，不从 shared/constants.ts 取——
  // 升级器只依赖 Node 内置模块，必须独立于被替换的代码：
  // 万一新代码坏了，更新器也得还能跑，否则就没人能救场了。
  // 真源在 shared/constants.ts 的 DEFAULT_API_PORT，改端口时这里一起改。
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

/** 是不是链接（junction / 软链）。链接不能照着实体备份 */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 备份将被覆盖的顶层项 */
function backupPayload() {
  mkdirSync(BACKUP, { recursive: true });
  const names = topLevelNames(PAYLOAD).filter(
    (name) => !PROTECTED.has(name) && name !== RUNTIME_DIR,
  );
  const skipped = [];
  for (const name of names) {
    const existing = join(ROOT, name);
    if (!existsSync(existing)) continue;
    // 依赖目录如果是链接（junction / 软链），备份它等于去复制一个链接：
    // Windows 上没权限建链接就直接 EPERM，而且链接指向的多半是别处的共享目录，
    // 不该被抄一遍。跳过即可——依赖会随新包整块换上。
    if (isLink(existing)) {
      skipped.push(name);
      continue;
    }
    cpSync(existing, join(BACKUP, name), { recursive: true });
  }
  // 旧版的文件清单也要留着：算「删哪些旧文件」时要用
  const oldManifest = join(ROOT, FILES_MANIFEST);
  if (existsSync(oldManifest)) {
    cpSync(oldManifest, join(BACKUP, FILES_MANIFEST));
  }
  log('info', `已备份：${names.join('、') || '（无）'}`);
  if (skipped.length) {
    log('info', `跳过备份（是链接，抄不动也不该抄）：${skipped.join('、')}`);
  }
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
    // 依赖目录是整块替换的，不做逐文件清理：
    // 万一它是个链接，逐文件删会顺着链接把别处的文件删掉
    if (segments[0] === 'node_modules') continue;
    // 自带运行时也不逐文件清理：升级本来就刻意不换它（换不掉）。
    // 新包如果没带运行时（--no-runtime），照着清单删就会把目标机上
    // 唯一的 Node 删掉——那台机器上再没有第二个 Node 能起服务了。
    if (segments[0] === RUNTIME_DIR) continue;
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
    // 自带运行时不动：跑着的服务正占着它（见 RUNTIME_DIR 的说明）
    if (name === RUNTIME_DIR) {
      log('info', '保留现有的自带 Node 运行时（运行中的文件换不掉）');
      continue;
    }
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

/**
 * 依赖变了就装依赖。
 *
 * 新包自带运行时依赖时直接跳过：新包里的 node_modules 就是装好的那一份，
 * 目标机不需要 npm、不需要联网——这也是「升级失败的最大来源」被掐掉的地方。
 * 老包不带依赖时才退回 npm install（兼容老部署）。
 */
function installDependenciesIfNeeded() {
  if (existsSync(join(PAYLOAD, 'node_modules'))) {
    log('info', '新包自带运行时依赖，跳过依赖安装');
    return Promise.resolve(true);
  }
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
    mkdirSync(LOG_DIR, { recursive: true });
    out = openSync(join(LOG_DIR, 'service-restart.log'), 'a');
  } catch {
    out = 'ignore';
  }
  // 入口按约定探测：包里有编译产物就跑它（不需要高版本 Node 的类型剥离）
  const entry = resolveEntry(ROOT) ?? 'server/index.ts';
  // 有自带运行时就用它，目标机连 Node 都不用装
  const runtimeNode = join(ROOT, RUNTIME_DIR, 'node.exe');
  const nodeBin = existsSync(runtimeNode) ? runtimeNode : process.execPath;
  const child = spawn(nodeBin, ['--env-file-if-exists=.env', entry], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  log('info', `已拉起新服务进程（pid=${child.pid}，入口 ${entry}，node ${nodeBin}）`);
  return child.pid;
}

/**
 * 稳定期观察：健康检查通过 ≠ 服务活着。
 *
 * 服务可能起来几秒就挂（配置不对、迁移冲突、依赖缺失…）。
 * 健康检查那一刻它还活着，于是被判成「升级成功」，
 * 然后它自己退出了——这时候更新器已经收工，回滚也就没人做了。
 *
 * 所以通过之后再盯一会儿：进程还在、健康检查还在，才算真稳。
 * 这多花的十几秒，换的是「升级后服务悄悄挂掉」这种最难查的问题。
 */
async function watchStability(port, pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (pid && !isAlive(pid)) {
      log('error', `新服务进程 ${pid} 已经退出，升级不算成功`);
      return false;
    }
    const probe = await probeHealth(port);
    if (!probe.ok) {
      log('error', `稳定期内健康检查不通（${probe.error}），升级不算成功`);
      return false;
    }
  }
  return true;
}

/** 进程还在不在 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 按托管方式把服务弄起来。
 *
 * 返回新服务的 pid（拿得到时）：稳定期观察要靠它判断服务是不是又挂了。
 */
function triggerRestart() {
  if (RESTART_MODE === 'host') {
    log('info', '等 Windows 服务宿主把服务拉起来');
    return null;
  }
  if (RESTART_MODE === 'tray') {
    log('info', '等托盘把服务拉起来');
    return null;
  }
  if (RESTART_MODE === 'supervisor') {
    log('info', `等 ${RESTART_DETAIL} 把服务拉起来`);
    return null;
  }
  if (RESTART_MODE === 'command') {
    const parts = RESTART_DETAIL.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return startSelf();
    }
    const child = spawn(parts[0], parts.slice(1), { detached: true, stdio: 'ignore' });
    child.unref();
    log('info', `已执行重启命令：${RESTART_DETAIL}`);
    return null;
  }
  return startSelf();
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

  // 预检放在最前面：拿新代码在隔离目录起一个实例，确认它能起来。
  // 过不了就不用往下走了——省掉的是「换上去才发现起不来，再回滚」这一整轮折腾。
  const pre = await preflight();
  if (!pre) {
    // 服务进程这时可能正在退场（更新器是被服务退场前拉起来的），
    // 得等它确实退干净了再拉新的，否则两个实例抢同一个端口。
    await waitForServiceExit(60000);
    releaseFlag();
    triggerRestart();
    writeResult('failed', '新版本预检没通过，升级已放弃（代码未替换）');
    log('error', '预检没通过，放弃升级（代码没换过，服务已重新拉起）');
    process.exit(1);
  }

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
  const newPid = triggerRestart();

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

  // 健康检查过了不等于稳：再盯一会儿，
  // 确认它没有「起来几秒就自己退出」——那种情况一旦放过去，
  // 更新器就收工了，谁也不会再管它，坏版本会一直留在生产上。
  const stabilizeMs = Number(envValue('UPGRADE_STABILIZE_MS') || 15000);
  if (stabilizeMs > 0) {
    log('info', `进入稳定期观察（${Math.round(stabilizeMs / 1000)} 秒）`);
    const stable = await watchStability(port, newPid, stabilizeMs);
    if (!stable) {
      log('warn', '新版本没能稳住，回滚');
      rollback();
      releaseFlag();
      triggerRestart();
      const recovered = await waitHealthy(port, 60000);
      writeResult('rolled-back', recovered ? '新版本没能稳住，已自动回滚' : '新版本没能稳住，回滚后也没起来，需要人工看看');
      log('error', recovered ? '已回滚，服务恢复正常' : '回滚后服务仍不可用，需要人工介入');
      process.exit(recovered ? 1 : 2);
    }
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
