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
 * 用法：npm run pack:tray
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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

/** 按 Node 的解析规则找包：先当前目录的 node_modules，再逐级往上 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 算依赖闭包：服务端直接依赖 + 它们的传递依赖 */
function collectRuntimeDeps() {
  const found = new Set();
  const queue = SERVER_RUNTIME_DEPS.map((name) => ({ name, from: ROOT }));
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const dir = resolvePackageDir(name, from);
    if (!dir) {
      console.warn(`  ! 找不到依赖 ${name}，跳过（服务起来会报缺模块）`);
      continue;
    }
    if (found.has(dir)) continue;
    found.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dep, from: dir });
    }
  }
  return [...found];
}

/** 组装 payload：托盘要拉起的服务进程需要的一切 */
function buildPayload() {
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
    throw new Error('没有 dist/，先执行 npm run build 再打包');
  }
  cpSync(join(ROOT, 'dist'), join(PAYLOAD, 'dist'), { recursive: true });

  // 服务进程的包装脚本（父进程没了就自己退出）
  cpSync(join(ROOT, 'tray', 'run-server.cjs'), join(PAYLOAD, 'run-server.cjs'));

  // 配置样例：使用者想改端口、密钥时有据可依
  if (existsSync(join(ROOT, '.env.example'))) {
    cpSync(join(ROOT, '.env.example'), join(PAYLOAD, '.env.example'));
  }

  // 运行时依赖：连 better-sqlite3 的原生二进制一起带上
  const deps = collectRuntimeDeps();
  const nodeModules = join(PAYLOAD, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  for (const dir of deps) {
    const rel = relative(join(ROOT, 'node_modules'), dir);
    const dest = join(nodeModules, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(dir, dest, { recursive: true });
  }
  console.log(`  运行时依赖 ${deps.length} 个`);
}

/**
 * 精简 better-sqlite3。
 *
 * 它带着 10MB 的 sqlite3 C 源码和 6 个别的平台的预编译二进制，
 * 而运行时只加载 `prebuilds/win32-x64.node`（见它的 lib/database.js）。
 * 白带 24MB 进安装包，使用者还得为它下载安装包。
 */
function pruneNativeDeps() {
  const pkgDir = join(PAYLOAD, 'node_modules', 'better-sqlite3');
  if (!existsSync(pkgDir)) return;
  rmSync(join(pkgDir, 'deps'), { recursive: true, force: true });
  rmSync(join(pkgDir, 'src'), { recursive: true, force: true });
  const prebuilds = join(pkgDir, 'prebuilds');
  if (!existsSync(prebuilds)) return;
  for (const file of readdirSync(prebuilds)) {
    if (file !== 'win32-x64.node') rmSync(join(prebuilds, file), { force: true });
  }
}

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

console.log('[1/3] 组装服务 payload');
buildPayload();
pruneNativeDeps();
console.log('[2/3] 调用 electron-builder 打包（首次会下载 electron 发行包与打包工具）');
await runBuilder();
console.log('[3/3] 把安装包拷回 release/');
const artifacts = collectArtifacts();

console.log('\n打包完成：');
for (const file of artifacts) console.log(`  - release/${file}`);
console.log(`  - 免安装目录：${join(OUT, 'win-unpacked')}`);

