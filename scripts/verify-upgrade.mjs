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

/** 问服务现在是什么版本 */
async function status(token) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/manage/status`, {
      headers: { 'x-workhub-token': token },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** 起一个服务进程 */
function startService(appDir, env) {
  const proc = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.ts'], {
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

  // 打包脚本要跑「新版本目录里那份」：它按自己所在位置找根目录，
  // 跑部署目录里那份的话打出来的是老版本，升了等于没升
  execFileSync(process.execPath, [join(newAppDir, 'scripts', 'pack-server.mjs'), '--out', pkgDir], {
    cwd: newAppDir,
    stdio: 'inherit',
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
  const checkBody = await fetch(`http://127.0.0.1:${PORT}/api/manage/update`, {
    headers: { 'x-workhub-token': token },
  }).then((r) => r.json());
  check('查到了新版本', checkBody.updateAvailable === true, JSON.stringify(checkBody).slice(0, 200));
  check('版本号对得上', checkBody.latest?.version === NEW_VERSION);
  check(`当前版本报的是 ${OLD_VERSION}`, checkBody.currentVersion === OLD_VERSION);

  // ---- 6. 执行升级 ----
  console.log('\n[5] 执行升级');
  const upgradeRes = await fetch(`http://127.0.0.1:${PORT}/api/manage/update`, {
    method: 'POST',
    headers: { 'x-workhub-token': token },
  });
  const upgradeBody = await upgradeRes.json();
  check('升级接口返回成功', upgradeRes.ok && upgradeBody.ok === true, JSON.stringify(upgradeBody).slice(0, 200));

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
  writeFileSync(
    join(newAppDir, 'server', 'index.ts'),
    `${readFileSync(join(newAppDir, 'server', 'index.ts'), 'utf8')}\nthrow new Error('故意的：这版起不来');\n`,
  );
  // 坏包专属的记号：回滚后它应该消失（说明真的换回去了，不是残留）
  writeFileSync(join(newAppDir, 'server', 'broken-marker.txt'), 'broken\n');
  const badPkg = JSON.parse(readFileSync(newPkgPath, 'utf8'));
  badPkg.version = '9.9.10';
  writeFileSync(newPkgPath, JSON.stringify(badPkg, null, 2));
  execFileSync(process.execPath, [join(newAppDir, 'scripts', 'pack-server.mjs'), '--out', pkgDir], {
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

  const badRes = await fetch(`http://127.0.0.1:${PORT}/api/manage/update`, {
    method: 'POST',
    headers: { 'x-workhub-token': token },
  });
  const badBody = await badRes.json();
  check('坏包也接受了升级请求', badRes.ok && badBody.ok === true, JSON.stringify(badBody).slice(0, 200));

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
    // 留一份升级日志在临时目录：临时目录会被删，日志删了就没了
    try {
      const logFile = join(workRef, 'app', 'logs', 'upgrade.log');
      if (existsSync(logFile)) {
        copyFileSync(logFile, join(tmpdir(), 'workhub-upgrade-last.log'));
      }
    } catch {
      // 留不下就算了
    }
    rmSync(workRef, { recursive: true, force: true });
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
