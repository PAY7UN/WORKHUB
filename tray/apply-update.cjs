'use strict';
/**
 * 托盘的外部更新器：托盘退出之后，由它来换文件、回滚、重新拉起托盘。
 *
 * 为什么要单独一个进程：
 * Windows 上运行中的程序换不掉（WorkHub.exe 被占着，resources/app.asar 也被锁着）。
 * 要换就得先让托盘退出，而「退出之后继续把活干完」只能由一个独立于托盘的进程来做。
 *
 * 流程：
 *   1. 等托盘进程真的退出（最多 60 秒）
 *   2. 备份将被覆盖的内容
 *   3. 覆盖新文件，并删掉新版里已经没有的旧文件
 *   4. 重新拉起托盘
 *   5. 中途出错就回滚，再把托盘拉起来（宁可旧版本，也不能没有托盘）
 *
 * 这个脚本只依赖 Node 内置模块：它自己就站在被替换的代码目录边上，
 * 万一新版本有 bug，靠的是新版本之外的自己把它救回来。
 *
 * 用法：
 *   node apply-update.cjs --root <应用目录> --staging <暂存目录> --payload <解包出来的目录>
 *                         --version <版本> --pid <托盘 pid> --log <日志路径>
 *                         --exec <重新拉起用的可执行文件> [--exec-arg <参数>...]
 */
const { spawn } = require('node:child_process');
const {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

/* --------------------------------- 参数 --------------------------------- */

const args = {};
const execArgs = [];
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
      // --exec-arg 可以给多次（开发态要传应用路径）
      if (key === 'exec-arg') execArgs.push(next);
    }
  }
}

const ROOT = resolve(args.root ?? '.');
const STAGING = resolve(args.staging ?? join(ROOT, '.tray-update-staging'));
const PAYLOAD = resolve(args.payload ?? join(STAGING, 'payload'));
const VERSION = args.version ?? 'unknown';
const TRAY_PID = Number(args.pid ?? '0');
/** 等托盘退出最多等多久（毫秒）。默认 60 秒；测试里会调小。 */
const WAIT_TIMEOUT = Number(args['wait-timeout'] ?? '60000');
const LOG_PATH = resolve(args.log ?? join(ROOT, 'logs', 'tray-update.log'));
const EXEC = args.exec ?? '';
const BACKUP = join(STAGING, 'backup');

/**
 * 兜底日志：主日志写不进去时（目录没了、文件被锁住），至少还有一份在别处。
 * 没有它的话，「日志写失败」和「进程被杀了」在日志里长得一模一样。
 */
const FALLBACK_LOG = join(tmpdir(), 'workhub-tray-update-fallback.log');

/**
 * 这些目录/文件是数据，不是程序：更新时绝不能碰。
 *
 * 应用目录里一般不会有它们（数据都在用户目录），但保一道——
 * 这个脚本要是被人改了参数指错了目录，有一道保护就少一份事故。
 *
 * tray.config.json 尤其要保：使用者的远端地址、令牌、快捷键都在里面，
 * 换版本把它冲掉，等于把人的配置抹了。
 *
 * .env.bak 是 .env 的备份：.env 丢了的时候，库里的文档全靠这把密钥才能解开，
 * 冲掉它等于把恢复的路也断了。
 */
const PROTECTED = new Set(['data', 'logs', '.env', '.env.bak', '.git', 'tray.config.json']);

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

process.on('uncaughtException', (err) => {
  log('error', `更新器未捕获异常：${err?.stack ?? err}`);
  try {
    rollback();
  } catch {
    // 回滚也失败就只能靠日志了
  }
  process.exit(1);
});

/* --------------------------------- 日志 --------------------------------- */

function log(level, message) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${stamp}] [${level}] ${message}\n`;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    writeFileSync(LOG_PATH, line, { flag: 'a' });
  } catch {
    try {
      writeFileSync(FALLBACK_LOG, line, { flag: 'a' });
    } catch {
      // 连兜底都写不了，那真没辙了
    }
  }
  try {
    process.stdout.write(line);
  } catch {
    // 写不出去就算了，日志文件里已经有
  }
}

/* -------------------------------- 进程存活 -------------------------------- */

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

/**
 * 等托盘退出。
 *
 * 等不到就不能动它的文件：Windows 上正在运行的 exe 覆盖必然失败（EPERM），
 * 硬来只会得到一个半新半旧的程序目录——那种状态比没升级还糟。
 */
async function waitForTrayExit(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(TRAY_PID)) return true;
    await sleep(300);
  }
  return false;
}

/* --------------------------------- 文件 --------------------------------- */

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
  const names = topLevelNames(PAYLOAD).filter((name) => !PROTECTED.has(name));
  const skipped = [];
  for (const name of names) {
    const existing = join(ROOT, name);
    if (!existsSync(existing)) continue;
    if (isLink(existing)) {
      skipped.push(name);
      continue;
    }
    cpSync(existing, join(BACKUP, name), { recursive: true });
  }
  log('info', `已备份：${names.join('、') || '（无）'}`);
  if (skipped.length) {
    log('info', `跳过备份（是链接，抄不动也不该抄）：${skipped.join('、')}`);
  }
}

/**
 * 覆盖新文件。
 *
 * 整块替换而不是逐文件比对：新包是整个程序目录，逐文件比对没意义，
 * 还会把「文件被占用」这种错误拖到一半才暴露出来。
 */
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
  log('info', '新版本已就位');
}

/**
 * 删掉新版里已经没有的旧文件。
 *
 * 只看顶层项：Electron 的程序目录结构简单（exe、resources、locales…），
 * 逐文件清理的收益很小，风险（顺着链接删到别处）却很大。
 */
function removeStaleFiles() {
  const newNames = new Set(topLevelNames(PAYLOAD));
  const removed = [];
  for (const name of topLevelNames(ROOT)) {
    if (PROTECTED.has(name)) continue;
    if (newNames.has(name)) continue;
    const target = join(ROOT, name);
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      log('warn', `删不掉旧文件 ${name}：${err.message}`);
    }
  }
  if (removed.length) log('info', `已清理新版里没有的旧项：${removed.join('、')}`);
}

/** 回滚：把备份恢复回去 */
function rollback() {
  const names = topLevelNames(BACKUP);
  if (!names.length) return;
  log('warn', '开始回滚到更新前的版本');
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
  log('info', '已回滚到更新前的版本');
}

/* -------------------------------- 重新拉起 -------------------------------- */

/**
 * 把托盘重新拉起来。
 *
 * 拉不起来是最糟的结局：使用者的机器上从此没有托盘图标，
 * 而托盘又是本地版服务的守护者——服务也跟着一起没了。
 * 所以这里失败也要留下日志，并且由调用方决定要不要弹窗。
 */
function relaunch() {
  if (!EXEC) {
    log('error', '没有指定要拉起的可执行文件，托盘起不来了');
    return null;
  }
  try {
    // 托盘的父进程标记要清掉：新托盘不该再被上一个托盘管着。
    // 这里是「删掉」而不是「置空」——置空的话，下游读到的还是一个
    // 设过的空字符串，「有没有被托管」这件事就说不清了。
    const env = { ...process.env };
    delete env.WORKHUB_PARENT_PID;
    // 更新器自己是以纯 Node 模式跑的（ELECTRON_RUN_AS_NODE=1）。
    // 这个标记绝对不能传给新托盘：传过去它就变成 Node 进程，
    // 窗口和托盘图标都起不来——使用者看到的就是「更新完托盘没了」。
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(EXEC, execArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.unref();
    log('info', `已重新拉起托盘（pid=${child.pid}）`);
    return child.pid;
  } catch (err) {
    log('error', `拉起托盘失败：${err?.message ?? err}`);
    return null;
  }
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  log('info', `更新器启动：更新托盘到 ${VERSION}，目标目录 ${ROOT}`);

  const exited = await waitForTrayExit(WAIT_TIMEOUT);
  if (!exited) {
    log('error', `托盘进程 ${TRAY_PID} 一直没退出，不敢动它的文件，更新中止`);
    process.exit(1);
  }
  log('info', '托盘已退出，开始替换文件');

  try {
    backupPayload();
    applyPayload();
    removeStaleFiles();
  } catch (err) {
    log('error', `替换文件失败：${err?.stack ?? err}`);
    rollback();
    relaunch();
    process.exit(1);
  }

  const pid = relaunch();
  if (!pid) {
    process.exit(2);
  }

  // 暂存目录里还有备份。更新成功了就没用了，留着只会占地方；
  // 万一以后想回滚，得靠重新下载，不靠这份备份。
  try {
    rmSync(STAGING, { recursive: true, force: true });
  } catch {
    // 删不掉就让系统自己清 %TEMP%
  }
  log('info', `更新完成，当前版本 ${VERSION}`);
  process.exit(0);
}

main().catch((err) => {
  log('error', `更新器异常：${err?.stack ?? err}`);
  try {
    rollback();
  } catch {
    // 记不下来就算了
  }
  process.exit(1);
});
