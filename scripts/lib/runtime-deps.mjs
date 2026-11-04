// 服务端运行时依赖的闭包计算、复制与裁剪。
//
// 为什么单独抽出来：托盘安装包（pack-tray.mjs）和服务端升级包（pack-server.mjs）
// 都要把「服务端跑起来真正需要的那几个包」带走。两边各算一份，
// 迟早会算错一处，表现为「装完起不来」或「升级后缺模块」。
//
// 不能把 node_modules 整个塞进去：前端依赖（react 那一坨）也在 dependencies 里，
// 装进去白白多几十兆。服务端 import 的外部依赖就下面这几个，从它们出发算闭包。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** 服务端直接依赖的外部包 */
export const SERVER_RUNTIME_DEPS = ['express', 'better-sqlite3'];

/** 按 Node 的解析规则找包：先当前目录的 node_modules，再逐级往上 */
export function resolvePackageDir(name, fromDir) {
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
export function collectRuntimeDeps({
  root,
  deps = SERVER_RUNTIME_DEPS,
  log = () => {},
}) {
  const found = new Set();
  const queue = deps.map((name) => ({ name, from: root }));
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const dir = resolvePackageDir(name, from);
    if (!dir) {
      log(`! 找不到依赖 ${name}，跳过（服务起来会报缺模块）`);
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

/**
 * 把依赖闭包复制到目标目录的 node_modules 下。
 * @param {{root: string, target: string, deps?: string[], log?: (msg: string) => void}} opts
 */
export function copyRuntimeDeps({ root, target, deps = SERVER_RUNTIME_DEPS, log = () => {} }) {
  const list = collectRuntimeDeps({ root, deps, log });
  const nodeModules = join(target, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  for (const dir of list) {
    const rel = relative(join(root, 'node_modules'), dir);
    const dest = join(nodeModules, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(dir, dest, { recursive: true });
  }
  log(`运行时依赖 ${list.length} 个`);
  return list;
}

/**
 * 精简 better-sqlite3。
 *
 * 它带着 10MB 的 sqlite3 C 源码和 6 个别的平台的预编译二进制，
 * 而运行时只加载 `prebuilds/win32-x64.node`（见它的 lib/database.js）。
 * 白带 24MB 进安装包，使用者还得为它下载安装包。
 */
export function pruneNativeDeps(nodeModulesDir) {
  const pkgDir = join(nodeModulesDir, 'better-sqlite3');
  if (!existsSync(pkgDir)) return;
  rmSync(join(pkgDir, 'deps'), { recursive: true, force: true });
  rmSync(join(pkgDir, 'src'), { recursive: true, force: true });
  const prebuilds = join(pkgDir, 'prebuilds');
  if (!existsSync(prebuilds)) return;
  for (const file of readdirSync(prebuilds)) {
    if (file !== 'win32-x64.node') rmSync(join(prebuilds, file), { force: true });
  }
}
