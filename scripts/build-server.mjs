#!/usr/bin/env node
// 编译服务端：node scripts/build-server.mjs
// 产物落在 server/ 下（与源码同名），发布包直接带走，不用目标机装工具链。
import { buildServer, ROOT } from './lib/server-build.mjs'
import { resolveServiceEntry } from './lib/service-entry.mjs'

const log = (msg) => console.log(`[build:server] ${msg}`)

await buildServer({ root: ROOT, log })

const entry = resolveServiceEntry(ROOT)
if (!entry) {
  console.error('[build:server] 编译完还是找不到服务入口')
  process.exit(1)
}
log(`服务入口：${entry}`)
