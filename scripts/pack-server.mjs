/**
 * 打服务端升级包：workhub-server-<版本>.zip
 *
 * 这个包是「自动升级」的原料——更新器下载它、解开、替换掉正在跑的代码；
 * 同时它也是「首次部署」的原料——解压、起服务，不用装任何环境。
 * 所以打包时要守住几条：
 *
 * - 代码进包，数据不进包：data/、logs/、.env 一律不带。
 *   把数据打进包里，等于每次升级都拿旧数据盖掉新数据（或者反过来）。
 * - 依赖进包：node_modules 只带服务端运行时真正需要的那几个包（见
 *   scripts/lib/runtime-deps.mjs）。这样目标机不需要 npm、不需要联网，
 *   升级时也不用在生产机上跑 npm install。
 * - 运行时进包：runtime/node.exe 是一份自带 Node，目标机连 Node 都不用装。
 * - 带一份文件清单（.workhub-files.txt）：升级时靠它算出「新版里已经
 *   没有的旧文件」并删掉。不删的话，改名加版本号的老文件会永远留在
 *   目录里，那种 bug 极难查。
 * - 顶层只有一个目录：解压出来是「一个 workhub 文件夹」，
 *   而不是 server、shared、dist、node_modules 一股脑摊在解压目录根部。
 * - 附带 sha256：更新器下载后要核对，传输损坏或半截文件不能直接用。
 *
 * 打包前会自动重建前端产物（dist/）并编译服务端（server/*.js）：
 * dist 是拷贝进包的，不是现场构建的，漏构建一次就会把上一版的前端发出去，
 * 而这种错没有任何机制能发现；服务端同理，漏编译就会退回去直跑 .ts。
 * 已经构建好的流水线可以用 --skip-build 跳过。
 *
 * 用法：node scripts/pack-server.mjs [--out <目录>] [--skip-build]
 *                                 [--no-runtime] [--no-deps]
 */
import { spawn } from 'node:child_process';
import { ensureFrontendBuilt } from './lib/frontend-build.mjs';
import { buildServer } from './lib/server-build.mjs';
import { copyRuntimeDeps, pruneNativeDeps } from './lib/runtime-deps.mjs';
import { ensureNodeRuntime } from './lib/node-runtime.mjs';
import { zipDirectory } from './lib/zip.mjs';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * 打进包里的东西。
 *
 * shared/ 一定要在：服务端到处从 ../shared/ 导入（类型、检索、附件、密码策略…），
 * 漏了它升级上去的服务直接起不来。
 * 数据目录（data/）不在里面：升级换的是代码，不是数据。
 */
const INCLUDE = ['server', 'shared', 'dist', 'scripts', 'package.json', '.env.example', 'README.md'];

/** 永远不进包的东西 */
const EXCLUDE_DIRS = new Set(['node_modules', 'data', 'logs', '.git', 'release', 'coverage', '.vite']);
const EXCLUDE_FILES = new Set(['.env', '.workhub-files.txt']);

/**
 * 测试文件不进包。
 *
 * 测试代码对目标机毫无用处（还会在包里带上一堆跑测试的脚本），
 * 而且包内容与文件清单必须严格一致——多带一个文件，清单里就多一条，
 * 升级时的「删掉新版里已经没有的旧文件」就多一条判断。
 */
const TEST_FILE_RE = /\.test\.[cm]?[jt]s$/;

function parseArgs(argv) {
  const args = { skipBuild: false, runtime: true, deps: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--skip-build') {
      args.skipBuild = true;
    } else if (argv[i] === '--no-runtime') {
      args.runtime = false;
    } else if (argv[i] === '--no-deps') {
      args.deps = false;
    }
  }
  return args;
}

/** 递归列出目录下的所有文件（相对路径，斜杠分隔） */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...listFiles(join(dir, entry.name), base));
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      if (TEST_FILE_RE.test(entry.name)) continue;
      out.push(relative(base, join(dir, entry.name)).split('\\').join('/'));
    }
  }
  return out;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => rejectPromise(new Error(`${command} 启动失败：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} 退出码 ${code}：${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * 包里那层顶层目录的名字。
 *
 * 解压出来是一个文件夹，而不是一堆文件摊在解压目录根部——
 * 使用者面对的是「一个 WorkHub」，双击里面的东西就能用；
 * 升级时新旧两版也不会混在同一个目录里。
 */
const PACKAGE_DIR = 'workhub';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(ROOT, args.out ?? 'release');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version ?? '0.0.0';

  // 先重建前端。dist/ 是拷贝进包的，不在这里重建就可能把上一版的前端发出去。
  await ensureFrontendBuilt({
    root: ROOT,
    skip: args.skipBuild,
    log: (msg) => console.log(msg),
  });

  // 再编译服务端。server/*.js 是发布态真正被执行的入口，
  // 不编译就等于把「需要高版本 Node 的 .ts 直跑」又带回了目标机。
  if (!args.skipBuild) {
    console.log('编译服务端…');
    await buildServer({ root: ROOT, log: (msg) => console.log(`  ${msg}`) });
  }

  const missing = INCLUDE.filter((name) => !existsSync(join(ROOT, name)));
  if (missing.length > 0) {
    console.error(`以下内容不存在，打不了包：${missing.join('、')}`);
    process.exit(1);
  }

  let staging = join(outDir, `.pack-staging-${version}`);
  // 上一次没清干净的暂存目录：清不掉就换个名字重来，
  // 不能因为一个残留目录就打不成包。
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    staging = join(outDir, `.pack-staging-${version}-${Date.now()}`);
    console.log('  （上次的暂存目录清不掉，换个名字重来）');
  }
  mkdirSync(staging, { recursive: true });
  // 包内容统一放在 staging/workhub/ 下：打出来的 zip 顶层就是这一个目录
  const pkgRoot = join(staging, PACKAGE_DIR);
  mkdirSync(pkgRoot, { recursive: true });

  const files = [];
  for (const name of INCLUDE) {
    const from = join(ROOT, name);
    const to = join(pkgRoot, name);
    if (!statSync(from).isDirectory()) {
      copyFileSync(from, to);
      files.push(name);
      continue;
    }
    // 逐个文件复制，不用 cpSync 整棵树：
    // cpSync 会把 node_modules、.env 之类一起带走（体积暴涨，还可能把
    // 服务器上的密钥打进公开的 Release），而 EXCLUDE_* 的排除只对清单生效，
    // 对实际内容不生效——包内容和清单对不上，升级时的清理就全乱了
    mkdirSync(to, { recursive: true });
    for (const rel of listFiles(from)) {
      const src = join(from, rel);
      const dst = join(to, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      files.push(`${name}/${rel}`);
    }
  }

  // 运行时依赖：服务端跑起来真正需要的那几个包，跟着包走。
  // 目标机因此不需要 npm、不需要联网，升级时也不必在生产机上装依赖。
  if (args.deps) {
    console.log('收集运行时依赖…');
    copyRuntimeDeps({
      root: ROOT,
      target: pkgRoot,
      log: (msg) => console.log(`  ${msg}`),
    });
    pruneNativeDeps(join(pkgRoot, 'node_modules'));
    for (const rel of listFiles(join(pkgRoot, 'node_modules'))) {
      files.push(`node_modules/${rel}`);
    }
  } else {
    console.log('  按要求不带依赖（目标机需要自行 npm install）');
  }

  // 自带 Node 运行时：目标机连 Node 都不用装。
  // 升级时不会覆盖它（跑着的 exe 换不掉），它只在首次部署时派上用场。
  if (args.runtime) {
    console.log('准备自带 Node 运行时…');
    const exe = await ensureNodeRuntime({
      target: join(pkgRoot, 'runtime'),
      log: (msg) => console.log(`  ${msg}`),
    });
    if (exe) {
      for (const rel of listFiles(join(pkgRoot, 'runtime'))) {
        files.push(`runtime/${rel}`);
      }
    }
  } else {
    console.log('  按要求不带自带运行时（目标机需要自行安装 Node）');
  }

  // 文件清单：升级时靠它清理新版里已经没有的旧文件
  const manifest = [...files].sort().join('\n');
  writeFileSync(join(pkgRoot, '.workhub-files.txt'), `${manifest}\n`, 'utf8');

  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `workhub-server-${version}.zip`);
  rmSync(zipPath, { force: true });
  await zipDirectory(pkgRoot, zipPath, { baseName: PACKAGE_DIR });

  const hash = createHash('sha256');
  hash.update(readFileSync(zipPath));
  const sha256 = hash.digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha256}  workhub-server-${version}.zip\n`, 'utf8');

  // 暂存目录清不掉也不能算打包失败：包已经打出来了。
  // 真实原因通常是 Windows 上有杀毒软件正拿着某个文件，或者权限不足——
  // 这时候留个暂存目录，远比把一次成功的打包报成失败强。
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch (err) {
    console.log(`  （暂存目录没清掉，留着了：${err?.message ?? err}）`);
  }

  const sizeMb = (readFileSync(zipPath).length / 1024 / 1024).toFixed(1);
  console.log(`已打出升级包：${zipPath}`);
  console.log(`  版本：${version}`);
  console.log(`  大小：${sizeMb} MB`);
  console.log(`  文件：${files.length} 个`);
  console.log(`  校验：${sha256}`);
  console.log('');
  console.log('把它挂到 GitHub Release（资产名保持 workhub-server-<版本>.zip）就能被自动升级认到。');
}

main().catch((err) => {
  console.error(`打包失败：${err?.stack ?? err}`);
  process.exit(1);
});
