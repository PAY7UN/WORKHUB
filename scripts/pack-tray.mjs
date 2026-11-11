'use strict';
/**
 * 打包 Windows 托盘工具。
 *
 * 产物是一个安装程序 exe，里面装两样东西：
 * - 托盘本体（Electron 应用）
 * - 服务 payload：server/ + shared/ + dist/ + 服务端运行时依赖
 *
 * 打包态的目录分工（tray/main.cjs 的 resolvePaths 里是同一套逻辑）：
 *   安装目录（只读）：托盘 + payload
 *   用户目录（可写）：.env、数据库、vault、日志、tray.config.json
 *
 * 运行时只有一套：托盘的 Electron 本身就是 Node（ELECTRON_RUN_AS_NODE=1），
 * 服务跑在里面，自更新的更新器也在里面跑——所以 payload 里不再附带 node.exe。
 *
 * 用法：npm run pack:tray [-- --skip-build]
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensureFrontendBuilt } from './lib/frontend-build.mjs';
import { buildServer } from './lib/server-build.mjs';
import { zipDirectory, writeSha256 } from './lib/zip.mjs';
import { assertNoHardcodedCredentials } from './lib/package-credentials.mjs';
import {
  copyRuntimeDeps,
  pruneNativeDeps,
} from './lib/runtime-deps.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/**
 * 打包的中间产物放在临时目录，不放仓库里。
 *
 * electron-builder 解压 electron 发行包的最后一步是把 `win-unpacked.tmp`
 * 改名成 `win-unpacked`；在 IDE 打开的仓库里做目录改名会被安全删除钩子拦掉（EPERM），
 * 打包就会挂在最后一步。放临时目录绕开这个坑，最后只把安装包拷回仓库。
 */
const STAGE = join(tmpdir(), 'workhub-pack');
const PAYLOAD = join(STAGE, 'payload');
const OUT = join(STAGE, 'out');

/**
 * 服务端运行时真正需要的包。
 *
 * 不能把 node_modules 整个塞进去：前端依赖（react 那一坨）也在 dependencies 里，
 * 装进去白白多几十兆。服务端 import 的外部依赖就这几个，从它们出发算依赖闭包。
 */
const SERVER_RUNTIME_DEPS = ['express', 'better-sqlite3'];

/** 组装 payload：托盘要拉起的服务进程需要的一切 */
async function buildPayload() {
  rmSync(PAYLOAD, { recursive: true, force: true });
  mkdirSync(PAYLOAD, { recursive: true });

  // 服务端代码 + 共享层（测试文件不用带进去）
  cpSync(join(ROOT, 'server'), join(PAYLOAD, 'server'), {
    recursive: true,
    filter: (src) => !src.endsWith('.test.ts'),
  });
  cpSync(join(ROOT, 'shared'), join(PAYLOAD, 'shared'), { recursive: true });

  // package.json：管理接口要靠它报版本号（server/manage.ts 的 readVersion）
  cpSync(join(ROOT, 'package.json'), join(PAYLOAD, 'package.json'));

  // 前端构建产物：服务端要托管它，页面才能打开
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('没有 dist/，前端构建没成功');
  }
  cpSync(join(ROOT, 'dist'), join(PAYLOAD, 'dist'), { recursive: true });

  // 升级器脚本：打包态要能自我升级。
  // server/updater.ts 的 launchUpdater 找的是 <root>/scripts/upgrade-apply.mjs，
  // 少了它，打包态从网页点「升级」会直接报「找不到更新器脚本」。
  // 只带这一个文件，不带整个 scripts/：verify.mjs 之类的开发工具不该进安装包。
  const upgradeScript = join(ROOT, 'scripts', 'upgrade-apply.mjs');
  if (existsSync(upgradeScript)) {
    mkdirSync(join(PAYLOAD, 'scripts'), { recursive: true });
    cpSync(upgradeScript, join(PAYLOAD, 'scripts', 'upgrade-apply.mjs'));
  } else {
    console.warn('  ! 没有 scripts/upgrade-apply.mjs，打包态将无法自我升级');
  }

  // 服务进程的包装脚本（父进程没了就自己退出）
  cpSync(join(ROOT, 'tray', 'run-server.cjs'), join(PAYLOAD, 'run-server.cjs'));

  // 配置样例：使用者想改端口、密钥时有据可依
  if (existsSync(join(ROOT, '.env.example'))) {
    cpSync(join(ROOT, '.env.example'), join(PAYLOAD, '.env.example'));
  }

  // 运行时依赖：连 better-sqlite3 的原生二进制一起带上
  const deps = copyRuntimeDeps({
    root: ROOT,
    target: PAYLOAD,
    deps: SERVER_RUNTIME_DEPS,
    log: (msg) => console.log(`  ${msg}`),
  });
  console.log(`  运行时依赖 ${deps.length} 个`);

  // 这里不再自带一份 Node 运行时。
  //
  // 托盘本来就是 Electron——它的 exe 加上 ELECTRON_RUN_AS_NODE=1 就是一个
  // 完整的 Node。再塞一份 node.exe 进 payload，等于让使用者的机器上有两套
  // 运行环境：安装包凭空大 80 MB，免安装包也大 80 MB。
  //
  // 自更新的更新器要跑在托盘目录之外（它一跑起来就把那个目录锁住了，
  // 覆盖自己就变成了不可能）。解决办法是更新时把托盘 exe 旁边的运行时文件
  // （ICU 数据、V8 快照等）复制一份到临时目录，用它跑更新器——
  // 见 tray/update.cjs 的 prepareUpdaterRuntime。复制只在更新时发生。
  //
  // 服务进程也不需要它：服务跑在 Electron 的 node 模式里。
}

/**
 * 精简 better-sqlite3。
 *
 * 它带着 10MB 的 sqlite3 C 源码和 6 个别的平台的预编译二进制，
 * 而运行时只加载 `prebuilds/win32-x64.node`（见它的 lib/database.js）。
 * 白带 24MB 进安装包，使用者还得为它下载安装包。
 */

/**
 * 跑一次 electron-builder。
 *
 * 用子进程而不是库函数：一次失败后要换源重试，重试必须是干净的状态，
 * 同一个进程里再跑一遍 builder，缓存和临时目录都是上一轮留下的脏东西。
 *
 * 子进程的输出边转发边留一份尾巴：打包失败时把最后几十行打出来——
 * electron-builder 的报错都在输出末尾，不留尾巴的话，
 * 一份几百 MB 的下载失败在 CI 日志里就只剩一行「退出码 1」，谁也看不出是哪一步炸的。
 */
async function runBuilderOnce(configFile, { electron, binaries }) {
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  if (electron) env.ELECTRON_MIRROR = electron;
  else delete env.ELECTRON_MIRROR;
  if (binaries) env.ELECTRON_BUILDER_BINARIES_MIRROR = binaries;
  else delete env.ELECTRON_BUILDER_BINARIES_MIRROR;

  const cli = require.resolve('electron-builder/out/cli/cli.js');
  const child = spawn(
    process.execPath,
    [
      cli,
      '--config',
      configFile,
      // 必须显式说「不发布」。
      // electron-builder 26 有个隐式发布的行为：检出的是 tag（detached HEAD）时，
      // 它以为这一趟就是要发版，安装包打完了还要往 GitHub 上传一份——
      // 没有 token 就整步失败，包明明打好了也白搭。
      // 它的日志原话就是「Please use --publish explicitly」。
      // 发布包由发版流水线挂到 Release 上，用不着 electron-builder 自己发。
      '--publish',
      'never',
    ],
    {
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    },
  );
  const tail = [];
  const keep = (chunk) => {
    tail.push(chunk.toString('utf8'));
    // 只留最后 40 行，够看出是哪一步炸的
    while (tail.length > 40) tail.shift();
  };
  child.stdout.on('data', (d) => { process.stdout.write(d); keep(d); });
  child.stderr.on('data', (d) => { process.stderr.write(d); keep(d); });

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    const err = new Error(`electron-builder 退出码 ${code}`);
    err.detail = summarizeFailure(tail.join(''));
    throw err;
  }
}

/**
 * 从打包输出里挑出「能看出哪儿炸了」的那几行。
 *
 * electron-builder 末尾常跟着一长串 duplicate dependency references 告警：
 * 一行能有几万字符，把真正的错误（⨯ 开头那几行）整个盖住。
 * 摘要时先把噪音剔掉，不够行数了再退回原始尾部。
 */
const NOISE_LINE = /duplicate dependency references/;

function summarizeFailure(output) {
  const lines = output.split(/\r?\n/).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
  const meaningful = lines.filter((l) => l.trim() && !NOISE_LINE.test(l));
  const source = meaningful.length >= 6 ? meaningful : lines;
  return source.filter((l) => l.trim()).slice(-25).join('\n');
}

/** 国内镜像：electron 发行包与打包工具的国内分发站 */
const CN_MIRROR = 'https://npmmirror.com/mirrors/electron/';
const CN_BINARIES = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

/**
 * 调 electron-builder 出安装包。
 *
 * 配置以仓库里的 electron-builder.yml 为准（唯一真源），
 * 这里只改两个路径（输出目录、payload 源目录）后写成临时 JSON 交给它——
 * 打包配置不接受命令行覆盖，只能改文件。
 */
async function runBuilder() {
  const require = createRequire(import.meta.url);
  const yaml = require('js-yaml');
  const config = yaml.load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'));
  config.directories = { ...config.directories, output: OUT, buildResources: join(STAGE, 'build') };
  // 版本号以仓库根 package.json 为准。
  // 托盘应用自己的 package.json 里的版本号是手写的，改根版本时经常忘了改它——
  // 而托盘要靠版本号判断「有没有新版本」，版本号对不上就永远不会提示升级。
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  config.extraMetadata = { ...(config.extraMetadata ?? {}), version: pkg.version ?? '0.0.0' };
  // 生成 exe 图标（256×256），免得安装包和快捷方式都顶着 Electron 的默认图标
  const { makeIconIco } = require('../tray/icon.cjs');
  mkdirSync(join(STAGE, 'build'), { recursive: true });
  writeFileSync(join(STAGE, 'build', 'icon.ico'), makeIconIco());
  // 依赖要单独一条：electron-builder 的文件过滤器硬编码排除「复制源根部的 node_modules」，
  // 把源目录设成 node_modules 本身，内部的包就不是根目录下的那个了，照拷不误。
  //
  // yml 里声明的静态资源（更新器脚本）要留着：那份配置才是唯一真源，
  // 这里只把「payload 指向哪」换成临时目录里的实际位置。
  config.extraResources = [
    ...(config.extraResources ?? []).filter((item) => item?.to !== 'payload'),
    { from: PAYLOAD, to: 'payload' },
    { from: join(PAYLOAD, 'node_modules'), to: 'payload/node_modules' },
  ];
  const configFile = join(STAGE, 'builder.config.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

  // 打包源选谁：谁离得近用谁。
  //
  // 原来是无条件走国内镜像，那在本机是对的（官方源下不动），
  // 在 GitHub Actions 的 runner 上却靠不住：runner 在境外，
  // 镜像站要么连不上、要么慢到超时。
  //
  // 现在按环境挑：CI 用官方源，本地用镜像；
  // 用户显式设了 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR 就听用户的。
  //
  // 再兜两层：
  // 1）同一个源重试。打包要先下 electron 发行包（上百 MB）和 nsis 打包工具，
  //    下载超时、连接被重置这类抖动是常事，重试一次常常就成了。
  //    重试不是瞎试：electron 的下载缓存留在机器上，第二次能接着用。
  // 2）首选源实在不行就换另一个源。「换个源重试」总比「发不出去」强。
  const explicit = {
    electron: process.env.ELECTRON_MIRROR ?? null,
    binaries: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? null,
  };
  const official = { electron: null, binaries: null };
  const mirror = { electron: CN_MIRROR, binaries: CN_BINARIES };
  const plans = [];
  if (explicit.electron || explicit.binaries) {
    plans.push({ source: explicit, tries: 2 });
  } else if (process.env.CI) {
    plans.push({ source: official, tries: 3 }, { source: mirror, tries: 1 });
  } else {
    plans.push({ source: mirror, tries: 2 }, { source: official, tries: 1 });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastError = null;
  for (const plan of plans) {
    const label = plan.source.electron ? '国内镜像' : '官方源';
    for (let i = 1; i <= plan.tries; i += 1) {
      console.log(`  打包源：${label}（第 ${i}/${plan.tries} 次）`);
      try {
        await runBuilderOnce(configFile, plan.source);
        return;
      } catch (err) {
        lastError = err;
        console.warn(`  ${label} 第 ${i} 次打包失败：${err.message}`);
        if (err.detail) console.warn(`  失败时的输出末尾：\n${err.detail}`);
        if (i < plan.tries) {
          const wait = 10_000 * i;
          console.warn(`  ${wait / 1000} 秒后重试同一个源`);
          await sleep(wait);
        }
      }
    }
  }
  throw lastError ?? new Error('electron-builder 没能出包');
}

/** 把安装包拷回仓库的 release/，方便取用 */
function collectArtifacts() {
  const dest = join(ROOT, 'release');
  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const file of readdirSync(OUT)) {
    if (!file.endsWith('.exe')) continue;
    cpSync(join(OUT, file), join(dest, file));
    copied.push(file);
  }
  return copied;
}

/**
 * 打印 payload 摘要：装进去的东西对不对，一眼能看出来。
 *
 * 重点是那几个「缺了就跑不起来」的：
 * - dist/index.html：服务端要托管它，页面才打得开；
 * - scripts/upgrade-apply.mjs：缺了它，打包态点「升级」会报找不到更新器；
 * - node_modules：服务端的运行时依赖（express、better-sqlite3 等）。
 */
function printPayloadSummary() {
  const entries = readdirSync(PAYLOAD);
  const mustHave = [
    ['dist/index.html', '前端构建产物'],
    ['scripts/upgrade-apply.mjs', '升级器脚本'],
    ['server/index.js', '服务端入口（编译产物）'],
    ['shared', '共享层'],
    ['package.json', '版本号来源'],
  ];
  console.log('\npayload 内容：');
  for (const [rel, why] of mustHave) {
    const ok = existsSync(join(PAYLOAD, rel));
    console.log(`  ${ok ? 'OK  ' : '缺失'} ${rel}  （${why}）`);
  }
  const deps = join(PAYLOAD, 'node_modules');
  const depCount = existsSync(deps) ? readdirSync(deps).length : 0;
  console.log(`  顶层目录：${entries.join('、')}`);
  console.log(`  运行时依赖：${depCount} 个`);
}

/**
 * 打托盘的免安装包：workhub-tray-<版本>.zip
 *
 * 这就是「托盘更新」的原料：发布时把它挂到 tag 上，
 * 托盘的更新器按这个名字找到它、下载、解压、覆盖自己。
 *
 * 内容是 electron-builder 打出来的免安装目录（win-unpacked）。
 * 打包前把它改名为 workhub，于是 zip 里的顶层就是这一个目录：
 * 解压出来是「一个 workhub 文件夹」，双击里面的 WorkHub.exe 就能跑——
 * 像可执行程序一样用，不用装、不写注册表。想放到 U 盘里带走也行。
 *
 * 为什么非得收这一层：解压工具默认把包里的东西直接倒进当前目录，
 * 摊开的话使用者面对的是一堆 dll 和 resources/，认不出哪个才是入口。
 */
async function packPortableZip() {
  const unpacked = join(OUT, 'win-unpacked');
  if (!existsSync(unpacked)) {
    throw new Error(`免安装目录不存在：${unpacked}`);
  }
  const portableDir = join(OUT, 'workhub');
  rmSync(portableDir, { recursive: true, force: true });
  renameSync(unpacked, portableDir);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version ?? '0.0.0';
  const fileName = `workhub-tray-${version}.zip`;
  const dest = join(ROOT, 'release');
  mkdirSync(dest, { recursive: true });
  const zipPath = join(dest, fileName);
  rmSync(zipPath, { force: true });
  await zipDirectory(portableDir, zipPath, { baseName: 'workhub' });
  const sha256 = writeSha256(zipPath, fileName);
  const sizeMb = (readFileSync(zipPath).length / 1024 / 1024).toFixed(1);
  return { fileName, zipPath, sha256, sizeMb };
}

console.log('[1/6] 构建前端产物');
await ensureFrontendBuilt({
  root: ROOT,
  skip: process.argv.includes('--skip-build'),
  log: (msg) => console.log(msg),
});
console.log('[1.5/6] 编译服务端');
await buildServer({
  root: ROOT,
  log: (msg) => console.log(`  ${msg}`),
});
console.log('[2/6] 组装服务 payload');
await buildPayload();
pruneNativeDeps(join(PAYLOAD, 'node_modules'));

// 托盘包会把 payload 原封不动装进安装程序：里面也不许有写死的凭据
assertNoHardcodedCredentials(PAYLOAD);

// --payload-only：只组装 payload，不跑 electron-builder。
// 用来快速核对 payload 内容（CI 里断言「升级器在不在」这类事），
// 也省得为了看一眼目录去下载几百兆的 electron 发行包。
if (process.argv.includes('--payload-only')) {
  console.log(`\npayload 已就绪：${PAYLOAD}`);
  printPayloadSummary();
  process.exit(0);
}

console.log('[3/6] 调用 electron-builder 打包（首次会下载 electron 发行包与打包工具）');
await runBuilder();
console.log('[4/6] 把安装包拷回 release/');
const artifacts = collectArtifacts();
console.log('[5/6] 打托盘免安装包（workhub-tray-<版本>.zip）');
const portable = await packPortableZip();

console.log('\n打包完成：');
for (const file of artifacts) console.log(`  - release/${file}`);
console.log(`  - release/${portable.fileName}（免安装，${portable.sizeMb} MB，解压即用）`);
console.log(`  - 免安装目录：${join(OUT, 'workhub')}`);
console.log(`\n免安装包校验（sha256）：${portable.sha256}`);
console.log('把它挂到 GitHub Release（资产名保持 workhub-tray-<版本>.zip）就能被托盘自动更新认到。');

