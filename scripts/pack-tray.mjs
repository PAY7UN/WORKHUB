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
 *   用户目录（可写）：.env、数据库、vault、日志
 *
 * 用法：npm run pack:tray [-- --skip-build]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensureFrontendBuilt } from './lib/frontend-build.mjs';
import { buildServer } from './lib/server-build.mjs';
import { ensureNodeRuntime } from './lib/node-runtime.mjs';
import { zipDirectory, writeSha256 } from './lib/zip.mjs';
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

  // 自带一份 Node 运行时：托盘自更新的更新器要用它。
  //
  // 更新器必须跑在托盘目录之外——它一跑起来就把那个目录里的文件锁住了，
  // 覆盖自己就变成了不可能。而托盘自己的 exe 不能单独复制出去用：
  // Electron 的 exe 旁边还散着一堆运行时文件（快照、ICU 数据、各类 dll），
  // 少一个都起不来。纯 node.exe 复制过去就能跑，还不用改打包结构。
  //
  // 服务本身不用它（服务跑在 Electron 的 node 模式里），但缺了它托盘就没法自更新。
  const runtimeExe = await ensureNodeRuntime({
    target: join(PAYLOAD, 'runtime'),
    log: (msg) => console.log(`  ${msg}`),
  });
  if (!runtimeExe) {
    console.warn('  ! 没有自带运行时，托盘将无法自动更新（可用 MDHUB_NODE_DIR 指定本机 Node）');
  }
}

/**
 * 精简 better-sqlite3。
 *
 * 它带着 10MB 的 sqlite3 C 源码和 6 个别的平台的预编译二进制，
 * 而运行时只加载 `prebuilds/win32-x64.node`（见它的 lib/database.js）。
 * 白带 24MB 进安装包，使用者还得为它下载安装包。
 */

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
  config.extraResources = [
    { from: PAYLOAD, to: 'payload' },
    { from: join(PAYLOAD, 'node_modules'), to: 'payload/node_modules' },
  ];
  const configFile = join(STAGE, 'builder.config.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

  // 国内网络下从镜像拉 electron 发行包与打包工具（可用环境变量覆盖）
  process.env.ELECTRON_MIRROR =
    process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/';
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
    'https://npmmirror.com/mirrors/electron-builder-binaries/';

  const { build } = await import('electron-builder');
  await build({ config: configFile });
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
 * - runtime/node.exe：缺了它，托盘没法自动更新；
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
  const runtimeOk = existsSync(join(PAYLOAD, 'runtime', 'node.exe'));
  console.log(
    `  ${runtimeOk ? 'OK  ' : '缺失'} runtime/node.exe  （托盘自动更新用的更新器运行时）`,
  );
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
 * 内容是 electron-builder 打出来的免安装目录（win-unpacked）：
 * 解压出来就是一个 WorkHub.exe，双击就能跑——像可执行程序一样用，
 * 不用装、不写注册表。想放到 U 盘里带走也行。
 */
async function packPortableZip() {
  const portableDir = join(OUT, 'win-unpacked');
  if (!existsSync(portableDir)) {
    throw new Error(`免安装目录不存在：${portableDir}`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version ?? '0.0.0';
  const fileName = `workhub-tray-${version}.zip`;
  const dest = join(ROOT, 'release');
  mkdirSync(dest, { recursive: true });
  const zipPath = join(dest, fileName);
  rmSync(zipPath, { force: true });
  await zipDirectory(portableDir, zipPath);
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
console.log(`  - 免安装目录：${join(OUT, 'win-unpacked')}`);
console.log(`\n免安装包校验（sha256）：${portable.sha256}`);
console.log('把它挂到 GitHub Release（资产名保持 workhub-tray-<版本>.zip）就能被托盘自动更新认到。');

