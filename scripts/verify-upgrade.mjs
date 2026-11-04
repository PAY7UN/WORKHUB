/**
 * 自动升级的端到端验证。
 *
 * 升级是最容易把服务搞挂的功能——写错了不是「有个小 bug」，
 * 是「服务器上的服务起不来了」。所以这一段必须真跑一遍，不能只靠单测。
 *
 * 流程：
 *   1. 复制一份代码到临时目录（模拟服务器上的部署目录）
 *   2. 起一个真实的服务进程（独立端口、独立数据库）
 *   3. 打一个「新版本」的升级包
 *   4. 起一个本地 HTTP 服务当更新源
 *   5. 调升级接口，然后盯着服务：退出 → 换代码 → 重新起来 → 版本变了
 *   6. 再来一次「坏包」：服务起不来，看它能不能自动回滚
 *
 * 用法：node scripts/verify-upgrade.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OLD_VERSION = '0.0.1';
const NEW_VERSION = '9.9.9';

/** 本次验证用的端口。运行时才定，见 findFreePort。 */
let PORT = 0;

/** 部署目录与机器令牌：诊断时要用（服务日志在哪、能不能查版本） */
let appDirRef = '';
let tokenRef = '';

/**
 * 找一个空闲端口。
 *
 * 用固定端口有个大坑：上次跑剩下的进程还占着端口时，
 * 健康检查会答（应答的是那个旧进程），脚本以为「服务起来了」，
 * 后面全是在验一个自己没起过的进程——错得毫无察觉。
 * 随机端口 + 收尾清理，两个问题一起解决。
 */
async function findFreePort() {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePromise(port));
    });
  });
}

/** 把占着端口的进程赶走 */
function killPort(port) {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore' },
    );
  } catch {
    // 清不掉就靠最后的兜底
  }
}

let failures = 0;
let checks = 0;

function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(400);
  }
  console.log(`    （等不到：${label}）`);
  return false;
}

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 起一个静态文件服务当更新源 */
function startFileServer(dir) {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
      const file = join(dir, name);
      if (!file.startsWith(resolve(dir)) || !existsSync(file)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('content-type', 'application/octet-stream');
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({ server, port: server.address().port });
    });
  });
}

/** 发一把机器令牌到指定的库里 */
function issueToken(dbPath) {
  const output = execFileSync(
    process.execPath,
    [join(ROOT, 'server', 'manageToken.ts'), 'issue', '升级验证', '--json'],
    { env: { ...process.env, MDHUB_DB_V2: dbPath }, encoding: 'utf8' },
  );
  return JSON.parse(output).token;
}

/**
 * 进程快照：谁还活着。
 *
 * 排查「服务怎么没了」时，光看日志不够——日志只说「它停了」，
 * 不说「它是被谁弄停的」。这里把还活着的 node 进程连同命令行一起打出来，
 * 端口被谁占着也一并说明。
 */
function processSnapshot() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }`,
      ],
      { encoding: 'utf8' },
    );
    const rows = String(out)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!rows.length) return '（一个 node 进程都没有了）';
    return rows
      .map((row) => {
        const [pid, ppid, ...rest] = row.split('|');
        return `  pid=${pid} ppid=${ppid} ${rest.join('|').slice(0, 160)}`;
      })
      .join('\n');
  } catch (err) {
    return `（取不到进程快照：${err.message}）`;
  }
}

/** 更新器进程还在不在 */
function updaterAlive(work) {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*upgrade-apply.mjs*' -and $_.CommandLine -like '*${work}*' } | Measure-Object).Count`,
      ],
      { encoding: 'utf8' },
    );
    return Number(String(out).trim()) > 0;
  } catch {
    return false;
  }
}

/**
 * 发起一次请求，网络层失败时重试。
 *
 * 为什么要重试：升级会让服务换进程，本地连接池里那条 keep-alive 连接
 * 可能还连着一个已经死掉的进程。undici 把它再递出来时，POST 会直接报
 * "fetch failed"（GET 有时会自动重试，POST 不会）。第一次失败后连接池会把
 * 那条废连接丢掉，下一次就落在一条全新的连接上。
 */
async function request(url, options = {}, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastError;
}

/** 问服务现在是什么版本 */
async function status(token) {
  try {
    const response = await request(
      `http://127.0.0.1:${PORT}/api/manage/status`,
      {
        headers: { 'x-workhub-token': token },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * 发起升级请求。
 *
 * 两件事得在这儿说清楚：
 *
 * 1. 为什么要重试：上一次升级时服务换过进程，本地连接池里那条 keep-alive
 *    连接已经连着一个死掉的进程了。undici 把它再递出来时，POST 会直接报
 *    "fetch failed"（GET 会被自动重试，POST 不会）。第一次失败后连接池会把
 *    那条废连接丢掉，重试就落在一条全新的连接上。
 * 2. 为什么要打现场：请求打过去对面直接没了，客户端只看到一句没头没尾的
 *    "fetch failed"。不把「服务还在不在、还有哪些进程、服务最后说了什么」
 *    打出来，就只能靠猜。
 */
async function postUpdate(attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(
        `http://127.0.0.1:${PORT}/api/manage/update`,
        {
          method: 'POST',
          headers: { 'x-workhub-token': tokenRef },
        },
        attempts,
      );
      return { ok: response.ok, status: response.status, body: await response.json() };
    } catch (err) {
      lastError = err;
    }
  }
  console.log(`    （升级请求没打通：${lastError?.message}）`);
  console.log(`    健康检查：${(await health()) ? '通' : '不通'}`);
  console.log(`    当前版本：${(await status(tokenRef))?.version ?? '查不到'}`);
  console.log('    还活着的 node 进程：');
  console.log(processSnapshot());
  for (const [label, path] of [
    ['服务重启日志', join(appDirRef, 'logs', 'service-restart.log')],
    ['升级日志', join(appDirRef, 'logs', 'upgrade.log')],
  ]) {
    try {
      const text = readFileSync(path, 'utf8');
      console.log(`    ${label}（尾部）：\n${text.split(/\r?\n/).slice(-25).join('\n')}`);
    } catch {
      console.log(`    ${label}：没有`);
    }
  }
  return { ok: false, status: 0, body: { error: lastError?.message ?? '未知错误' } };
}

/** 读文本，读不到就返回空串（文件可能已经不在了） */
function readTextSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 服务入口约定（真源在 scripts/lib/service-entry.mjs）：
 * 编译产物 server/index.js 优先，其次源码 server/index.ts。
 */
function resolveEntry(appDir) {
  const compiled = join(appDir, 'server', 'index.js');
  if (existsSync(compiled)) return 'server/index.js';
  return 'server/index.ts';
}

/** 起一个服务进程 */
function startService(appDir, env) {
  // 跟真实部署一致：优先用目录里自带的运行时
  const bundled = join(appDir, 'runtime', 'node.exe');
  const nodeBin = existsSync(bundled) ? bundled : process.execPath;
  const proc = spawn(nodeBin, ['--env-file-if-exists=.env', resolveEntry(appDir)], {
    cwd: appDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  proc.stdout.on('data', (chunk) => chunks.push(String(chunk)));
  proc.stderr.on('data', (chunk) => chunks.push(String(chunk)));
  return { proc, chunks };
}

async function main() {
  PORT = await findFreePort();
  const work = mkdtempSync(join(tmpdir(), 'workhub-upgrade-verify-'));
  workRef = work;
  const appDir = join(work, 'app');
  const newAppDir = join(work, 'new');
  const pkgDir = join(work, 'pkg');
  const dbPath = join(work, 'verify.db');
  appDirRef = appDir;
  mkdirSync(appDir, { recursive: true });
  mkdirSync(newAppDir, { recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  console.log(`临时目录：${work}`);

  // ---- 1. 复制一份代码当部署目录 ----
  // 复制的是「升级包会带的那些东西」：少一样，验的就不是真实发布形态了
  for (const item of ['server', 'shared', 'scripts', 'package.json', '.env.example', 'README.md']) {
    cpSync(join(ROOT, item), join(appDir, item), { recursive: true });
    cpSync(join(ROOT, item), join(newAppDir, item), { recursive: true });
  }
  // dist 是前端构建产物：没有它打包会拒绝（升级包不能没有前端）
  mkdirSync(join(appDir, 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'dist', 'index.html'), '<!doctype html><title>verify</title>');
  mkdirSync(join(newAppDir, 'dist'), { recursive: true });
  writeFileSync(join(newAppDir, 'dist', 'index.html'), '<!doctype html><title>verify</title>');

  // node_modules 用目录联接指回原处：整个复制一遍太慢
  const originalModules = join(ROOT, 'node_modules');
  if (existsSync(originalModules)) {
    for (const dir of [appDir, newAppDir]) {
      execFileSync('cmd', ['/c', 'mklink', '/J', join(dir, 'node_modules'), originalModules], {
        stdio: 'ignore',
      });
    }
  }

  // 目标机上的「自带运行时」：复制一份 node.exe 过去。
  // 这不是装饰：服务就从它启动，它在运行期间被 Windows 锁着，
  // 升级时任何想拷贝/替换它的动作都会 EPERM。
  // 生产上「升级时备份自带运行时」踩的就是这个坑，验证里必须复现。
  const runtimeDir = join(appDir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  cpSync(process.execPath, join(runtimeDir, 'node.exe'));
  writeFileSync(join(runtimeDir, 'marker.txt'), '机器上的运行时\n');

  // 部署目录是老版本（0.0.1），新版本在另一个目录里。
  // 分开放是必须的：升级就是拿新目录的内容盖掉部署目录，
  // 两边共用一个 package.json 的话「当前版本」直接就变成新版本了，验的就不是升级。
  const pkgPath = join(appDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = OLD_VERSION;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  const newPkgPath = join(newAppDir, 'package.json');
  const newPkg = JSON.parse(readFileSync(newPkgPath, 'utf8'));
  newPkg.version = NEW_VERSION;
  writeFileSync(newPkgPath, JSON.stringify(newPkg, null, 2));
  // 在新代码里留个记号，用来确认跑起来的是新版本
  writeFileSync(join(newAppDir, 'server', 'upgrade-marker.txt'), 'new-version\n');

  const serviceEnv = {
    ...process.env,
    MDHUB_PORT: String(PORT),
    MDHUB_DB_V2: dbPath,
    // 服务端要求显式承认「这是开发环境」才肯用默认密钥。
    // 这是临时目录里的验证实例，不设它服务根本起不来。
    MDHUB_ALLOW_INSECURE_DEV: '1',
  };


  // ---- 2. 起服务 ----
  console.log('\n[1] 起一个真实的服务进程');
  let service = startService(appDir, serviceEnv);
  serviceRef = service;
  const serviceLog = service.chunks;
  const started = await waitFor(health, 40000, '服务起来');
  check('服务起来了', started);
  if (!started) {
    console.log(serviceLog.join('').slice(-2000));
    throw new Error('服务没起来，后面的没法验');
  }
  // 有应答还不够：得确认应答的是「刚起的这个」而不是哪个残留进程。
  // 库也是刚建的话才说明是新实例（残留进程用的是旧库）
  check('起来的是刚起的这个进程', existsSync(dbPath), '数据库没建，说明应答的是别的进程');

  // ---- 3. 发令牌 + 打升级包 ----
  console.log('\n[2] 准备升级包');
  const token = issueToken(dbPath);
  tokenRef = token;

  // 打包脚本要跑「新版本目录里那份」：它按自己所在位置找根目录，
  // 跑部署目录里那份的话打出来的是老版本，升了等于没升。
  // --skip-build：这里模拟的是服务器上的部署目录，没有前端源码也没有
  // 构建工具，dist/ 本来就是现成的产物。真实场景里升级包是在开发机或
  // CI 上打的（那里会重新构建前端），这一步验的是升级流程本身。
  // 这个包**带自带运行时**：目标机什么都不装的那套才是主场景，
  // 自带运行时的替换与备份规则得跟着它一起验。
  // MDHUB_NODE_DIR 指向本机的 Node 目录：离线打包，不用联网下载几十兆。
  execFileSync(process.execPath, [join(newAppDir, 'scripts', 'pack-server.mjs'), '--out', pkgDir, '--skip-build'], {
    cwd: newAppDir,
    stdio: 'inherit',
    env: { ...process.env, MDHUB_NODE_DIR: dirname(process.execPath) },
  });
  const zipName = `workhub-server-${NEW_VERSION}.zip`;
  check(`升级包打出来了（${zipName}）`, existsSync(join(pkgDir, zipName)));

  // ---- 4. 起更新源，重启服务指向它 ----
  console.log('\n[3] 重启服务并指向本地更新源');
  const fileServer = await startFileServer(pkgDir);
  fileServerRef = fileServer;
  const manifest = {
    version: NEW_VERSION,
    url: `http://127.0.0.1:${fileServer.port}/${zipName}`,
    sha256: '',
    notes: '验证用的新版本',
  };
  writeFileSync(join(pkgDir, 'manifest.json'), JSON.stringify(manifest));

  service.proc.kill();
  await waitFor(async () => !(await health()), 15000, '服务停下');
  service = startService(appDir, {
    ...serviceEnv,
    MDHUB_UPDATE_MANIFEST: `http://127.0.0.1:${fileServer.port}/manifest.json`,
  });
  serviceRef = service;
  const restarted = await waitFor(health, 40000, '服务重启');
  check('带更新源重启成功', restarted);

  // ---- 5. 查更新 ----
  console.log('\n[4] 查更新');
  const checkBody = await request(`http://127.0.0.1:${PORT}/api/manage/update`, {
    headers: { 'x-workhub-token': token },
  }).then((r) => r.json());
  check('查到了新版本', checkBody.updateAvailable === true, JSON.stringify(checkBody).slice(0, 200));
  check('版本号对得上', checkBody.latest?.version === NEW_VERSION);
  check(`当前版本报的是 ${OLD_VERSION}`, checkBody.currentVersion === OLD_VERSION);

  // ---- 6. 执行升级 ----
  console.log('\n[5] 执行升级');
  const upgradeRes = await postUpdate();
  const upgradeBody = upgradeRes?.body ?? {};
  check('升级接口返回成功', upgradeRes?.ok === true, JSON.stringify(upgradeBody).slice(0, 200));

  // 服务会退出，更新器接手换代码，再把服务拉起来。
  // 等的是「版本变成新版本」，不是「端口有应答」——升级期间旧服务还活着，
  // 端口照样有应答，那会儿查版本查到的还是旧版本。
  const upgraded = await waitFor(
    async () => (await status(token))?.version === NEW_VERSION,
    150000,
    '新版本上线',
  );
  check('升级后服务起来了，而且跑的是新版本', upgraded);
  if (upgraded) {
    check('跑起来的是新代码', existsSync(join(appDir, 'server', 'upgrade-marker.txt')));
    check('升级标记已撤销', !existsSync(join(appDir, '.upgrade-in-progress')));
    // 自带运行时不该被升级换掉：它正跑着服务（被 Windows 锁着），
    // 换它既换不动，也不该换——那台机器上只有这一份 Node，
    // 换了就等于把服务的后路断了。
    check(
      '自带运行时没被换掉',
      readTextSafe(join(appDir, 'runtime', 'marker.txt')) === '机器上的运行时\n',
      '升级把目标机上的自带运行时覆盖了',
    );
    // 更新器自己跑完了：它中途崩了的话，代码虽然换了，但健康检查和回滚都没人做。
    // 「跑完」有两种形态：正常退出（写完日志就退），或者还在跑（服务起得慢还没轮完）。
    // 只有「日志里没有下文、进程也不在了」才是真没了。
    const logText = () => {
      try {
        return readFileSync(join(appDir, 'logs', 'upgrade.log'), 'utf8');
      } catch {
        return '';
      }
    };
    const finished = await waitFor(() => logText().includes('升级完成'), 30000, '更新器写完成');
    const upgradeLog = logText();
    check(
      '更新器跑完了（没中途没了）',
      finished || updaterAlive(work),
      '更新器既没写完成、进程也不在了：它中途被弄死了，健康检查和回滚都没人做',
    );
    check(
      '更新器完整跑完（没中途崩）',
      upgradeLog.includes('升级完成'),
      `${upgradeLog.slice(-900)}\n--- 新服务的输出 ---\n${(() => {
        try {
          return readFileSync(join(appDir, 'logs', 'service-restart.log'), 'utf8').slice(-1500);
        } catch {
          return '(没有 service-restart.log)';
        }
      })()}`,
    );
    check(
      '升级结果已记给前端看',
      (() => {
        try {
          const record = JSON.parse(readFileSync(join(appDir, 'logs', '.last-upgrade.json'), 'utf8'));
          return record.status === 'success';
        } catch {
          return false;
        }
      })(),
      (() => {
        try {
          return readFileSync(join(appDir, 'logs', '.last-upgrade.json'), 'utf8');
        } catch {
          return '没有 .last-upgrade.json';
        }
      })(),
    );
  }

  // ---- 7. 坏包：起不来要能回滚 ----
  console.log('\n[6] 喂一个坏包，看能不能自动回滚');
  // 坏的是「新版本目录」：坏包要打成新内容，部署目录不能动
  //
  // 坏法要说清楚：升级前有预检（拿新代码在隔离目录起一个实例），
  // 预检都过不了的包压根换不上去，回滚也就无从谈起——那正是预检立功了。
  // 所以这里注入的坏，是「正式实例才犯」的坏：预检实例带着
  // MDHUB_PREFLIGHT 标记，正式实例没有。正式实例起不来 → 健康检查不过 → 回滚。
  const badEntry = resolveEntry(newAppDir);
  const badEntryPath = join(newAppDir, badEntry);
  writeFileSync(
    badEntryPath,
    `${readFileSync(badEntryPath, 'utf8')}\n// 验证用：预检实例放过，正式实例直接起不来\nif (!process.env.MDHUB_PREFLIGHT) { throw new Error('故意的：这版起不来'); }\n`,
  );
  // 坏包专属的记号：回滚后它应该消失（说明真的换回去了，不是残留）
  writeFileSync(join(newAppDir, 'server', 'broken-marker.txt'), 'broken\n');
  const badPkg = JSON.parse(readFileSync(newPkgPath, 'utf8'));
  badPkg.version = '9.9.10';
  writeFileSync(newPkgPath, JSON.stringify(badPkg, null, 2));
  execFileSync(process.execPath, [join(newAppDir, 'scripts', 'pack-server.mjs'), '--out', pkgDir, '--skip-build', '--no-runtime'], {
    cwd: newAppDir,
    stdio: 'inherit',
  });
  const badZipName = 'workhub-server-9.9.10.zip';
  writeFileSync(
    join(pkgDir, 'manifest.json'),
    JSON.stringify({
      version: '9.9.10',
      url: `http://127.0.0.1:${fileServer.port}/${badZipName}`,
      sha256: '',
      notes: '这版是坏的',
    }),
  );

  // 模拟「上一版包带过自带运行时」：旧清单里记着 runtime/marker.txt，
  // 而这个坏包没带 → 清理旧文件时也不该把目标机上的运行时删掉。
  // 那台机器上只有这一份 Node，删了它服务就再也起不来了。
  const appManifest = join(appDir, '.workhub-files.txt');
  writeFileSync(appManifest, `${readTextSafe(appManifest)}runtime/marker.txt\n`);

  const badRes = await postUpdate();
  const badBody = badRes?.body ?? {};
  check('坏包也接受了升级请求', badRes?.ok === true, JSON.stringify(badBody).slice(0, 200));

  // 升级 → 坏版本起不来 → 回滚 → 上一个可用版本回来。
  // 分两步等：先等坏代码真的放上去（否则「回滚成功」是假的——
  // 坏包压根没换上，也就没得回滚），再等它被换回去。
  const brokenInPlace = await waitFor(
    () => existsSync(join(appDir, 'server', 'broken-marker.txt')),
    120000,
    '坏代码就位',
  );
  check('坏版本确实换上去了', brokenInPlace);

  const rolledBack = await waitFor(
    async () =>
      (await status(token))?.version === NEW_VERSION &&
      !existsSync(join(appDir, 'server', 'broken-marker.txt')),
    200000,
    '回滚完成',
  );
  check('坏版本没能一直坏下去（回滚成功）', rolledBack);
  if (rolledBack) {
    check(
      '回滚后退回了上一个可用版本',
      (await status(token))?.version === NEW_VERSION,
      `实际：${(await status(token))?.version}`,
    );
    check(
      '坏版本的代码痕迹已清干净',
      !existsSync(join(appDir, 'server', 'broken-marker.txt')),
      '回滚后坏版本的专有文件还在，说明没真的换回去',
    );
    const upgradeLog = readFileSync(join(appDir, 'logs', 'upgrade.log'), 'utf8');
    check('日志里记着回滚了', upgradeLog.includes('回滚'));
  }
  // 清理旧文件时也不该碰自带运行时：新包没带运行时，不代表目标机上那份就该删。
  check(
    '自带运行时没被清理掉',
    readTextSafe(join(appDir, 'runtime', 'marker.txt')) === '机器上的运行时\n',
    '清理旧文件时把目标机上的自带运行时删了——那台机器上只有这一份 Node',
  );
  // 回滚之后跑着的已经不是原来那个服务进程了（是更新器重新拉起来的）。
  // 记一笔现在是谁在跑：后面服务要是又没了，得知道该找谁。
  console.log('    回滚后还活着的 node 进程：');
  console.log(processSnapshot());

  // ---- 8. 连预检都过不了的包：不该碰生产 ----
  console.log('\n[7] 喂一个连预检都过不了的包');
  // 这一版连「隔离目录里起一个实例」都起不来（语法就是坏的）。
  // 升级前预检就该把它挡下来：服务一秒都不用停，代码一秒都不用换。
  const brokenAppDir = join(work, 'broken');
  mkdirSync(brokenAppDir, { recursive: true });
  for (const item of ['server', 'shared', 'scripts', 'package.json', '.env.example', 'README.md']) {
    cpSync(join(ROOT, item), join(brokenAppDir, item), { recursive: true });
  }
  mkdirSync(join(brokenAppDir, 'dist'), { recursive: true });
  writeFileSync(join(brokenAppDir, 'dist', 'index.html'), '<!doctype html><title>verify</title>');
  if (existsSync(originalModules)) {
    execFileSync('cmd', ['/c', 'mklink', '/J', join(brokenAppDir, 'node_modules'), originalModules], {
      stdio: 'ignore',
    });
  }
  const brokenEntry = resolveEntry(brokenAppDir);
  writeFileSync(join(brokenAppDir, brokenEntry), '这不是合法的 JavaScript ((((\n');
  writeFileSync(join(brokenAppDir, 'server', 'preflight-marker.txt'), 'broken\n');
  const brokenPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  brokenPkg.version = '9.9.11';
  writeFileSync(join(brokenAppDir, 'package.json'), JSON.stringify(brokenPkg, null, 2));
  execFileSync(process.execPath, [join(brokenAppDir, 'scripts', 'pack-server.mjs'), '--out', pkgDir, '--skip-build', '--no-runtime'], {
    cwd: brokenAppDir,
    stdio: 'inherit',
  });
  const brokenZipName = 'workhub-server-9.9.11.zip';
  writeFileSync(
    join(pkgDir, 'manifest.json'),
    JSON.stringify({
      version: '9.9.11',
      url: `http://127.0.0.1:${fileServer.port}/${brokenZipName}`,
      sha256: '',
      notes: '这版连预检都过不了',
    }),
  );

  const brokenRes = await postUpdate();
  const brokenBody = brokenRes?.body ?? {};
  check('坏到极点的包也接受了升级请求', brokenRes?.ok === true, JSON.stringify(brokenBody).slice(0, 200));
  console.log('    发起升级请求后还活着的 node 进程：');
  console.log(processSnapshot());

  // 预检失败 → 更新器放弃 → 代码没换，但服务得被拉回来
  // （更新器是在服务退场前被拉起来的，放弃升级时它负责把服务叫醒）
  const stillAlive = await waitFor(async () => (await health()) === true, 60000, '服务回来');
  check('预检拦下后服务被拉回来了', stillAlive);
  check('版本没被换掉', (await status(token))?.version === NEW_VERSION, `实际：${(await status(token))?.version}`);
  check('坏代码没就位', !existsSync(join(appDir, 'server', 'preflight-marker.txt')));
  const rejected = await waitFor(
    () => {
      try {
        const record = JSON.parse(readFileSync(join(appDir, 'logs', '.last-upgrade.json'), 'utf8'));
        return record.status === 'failed';
      } catch {
        return false;
      }
    },
    60000,
    '更新器记下失败',
  );
  check('升级结果记为失败（不是成功）', rejected);
  const preflightLog = (() => {
    try {
      return readFileSync(join(appDir, 'logs', 'upgrade.log'), 'utf8');
    } catch {
      return '';
    }
  })();
  check('日志里写着预检没过', preflightLog.includes('预检'), preflightLog.slice(-500));

  console.log(`\n结果：${checks - failures}/${checks} 通过`);
  if (failures > 0) {
    console.log('--- 服务日志尾部 ---');
    console.log(serviceLog.join('').slice(-3000));
  }
  return failures;
}

/**
 * 收尾：不管成没成，进程和临时目录都得清掉。
 *
 * 留着不管的话，下次跑会撞端口：老进程还占着，新进程起不来，
 * 健康检查却答得挺好——于是脚本在验一个自己没起过的进程。
 */
async function cleanup() {
  try {
    fileServerRef?.server.close();
  } catch {
    // 没开过
  }
  try {
    serviceRef?.proc.kill();
  } catch {
    // 已经退了
  }
  await sleep(800);
  // 更新器自己拉起来的服务进程不归我们管，只能按端口收拾
  killPort(PORT);
  await sleep(300);
  if (workRef) {
    // 留一份日志在临时目录：临时目录会被删，日志删了就没了。
    // 更新器日志看的是「升级流程」，服务重启日志看的是「服务自己怎么说」，
    // 两份都要：服务起不来的时候，线索只在后者里。
    for (const [from, to] of [
      [join(workRef, 'app', 'logs', 'upgrade.log'), 'workhub-upgrade-last.log'],
      [join(workRef, 'app', 'logs', 'service-restart.log'), 'workhub-service-restart-last.log'],
    ]) {
      try {
        if (existsSync(from)) copyFileSync(from, join(tmpdir(), to));
      } catch {
        // 留不下就算了
      }
    }
    if (failures > 0) {
      // 有检查没过就别急着删现场：现场比猜测有用
      console.log(`\n临时目录保留着（有问题要看现场）：${workRef}`);
    } else {
      rmSync(workRef, { recursive: true, force: true });
    }
  }
}

let fileServerRef = null;
let serviceRef = null;
let workRef = null;

main()
  .then(async (failures) => {
    await cleanup();
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(`验证脚本出错：${err?.stack ?? err}`);
    await cleanup();
    process.exit(1);
  });
