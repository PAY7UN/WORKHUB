// 服务端编译：把 TS 源码打成可以直接 `node xxx.js` 跑的 ESM 产物。
//
// 为什么要有这一步：
//   - 直跑 .ts 依赖 Node 原生类型剥离，要求 Node ≥ 22.18，目标机门槛偏高；
//     编译成 .js 后只要 Node ≥ 22（better-sqlite3 v13 的下限）即可。
//   - 目标机不需要装 TypeScript 工具链，也不需要联网装依赖。
//
// 产物与源码同目录同名（server/index.ts → server/index.js）：这样
// import.meta.url 推导出的 APP_ROOT / DIST_DIR 与直跑 .ts 完全一致，
// 数据目录、静态资源目录都不会跑偏。
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..')

/** 产物名 → 源码入口。产物路径决定 import.meta.url 的位置，别乱改。 */
export const SERVER_ENTRIES = {
  'server/index': 'server/index.ts',
  'server/manageToken': 'server/manageToken.ts',
  'server/resetAdminPassword': 'server/resetAdminPassword.ts',
  'server/janitor': 'server/storage/v2/janitor.ts',
}

/**
 * 编译服务端。
 * @param {{root?: string, log?: (msg: string) => void}} opts
 */
export async function buildServer({ root = ROOT, log = () => {} } = {}) {
  const entryPoints = {}
  for (const [out, src] of Object.entries(SERVER_ENTRIES)) {
    const abs = resolve(root, src)
    if (!existsSync(abs)) {
      log(`跳过 ${src}（不存在）`)
      continue
    }
    entryPoints[out] = abs
  }
  if (!Object.keys(entryPoints).length) throw new Error('找不到任何服务端入口，无法编译')

  await build({
    entryPoints,
    outdir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // 原生模块（better-sqlite3）与第三方包一律外部化：包里会带 node_modules，
    // 内联反而会把 .node 二进制搞坏。
    packages: 'external',
    sourcemap: false,
    legalComments: 'none',
    banner: { js: '// 由 scripts/lib/server-build.mjs 自动生成，请勿手改' },
    logLevel: 'warning',
  })

  const built = Object.keys(entryPoints).map((out) => `${out}.js`)
  log(`服务端已编译：${built.join('、')}`)
  return built
}
