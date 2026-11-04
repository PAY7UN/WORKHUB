// 服务入口约定的唯一真源（Node 侧）。
//
// 约定（按优先级）：
//   1. <root>/.workhub-entry 里写的相对路径 —— 可选，允许运维手工指定
//   2. <root>/server/index.js —— 编译产物，发布包里用这一份
//   3. <root>/server/index.ts —— 源码直跑，仓库/开发态用这一份
//
// 为什么要统一：服务端既能被「node server/index.ts」直跑，也能被编译成
// 「node server/index.js」发布；托盘、Windows 服务宿主、升级器三方都要拉起它，
// 入口只要有一处没对齐，就会出现「升级完服务起不来」这类事故。
//
// 注意：scripts/install-service.ps1 与 scripts/service/WorkHubService.cs 各自
// 内联了同一套判定（PowerShell / C# 里读不到这个 .mjs）。规则有改动时三处要同步。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 可选的手工指定文件：里面写一行相对路径，例如 server/index.js */
export const ENTRY_MANIFEST = '.workhub-entry'

/** 约定顺序：编译产物优先于源码 */
export const ENTRY_CANDIDATES = ['server/index.js', 'server/index.ts']

/**
 * 解析服务入口，返回相对 root 的路径（如 server/index.js）。
 * 找不到可用入口时返回 null。
 */
export function resolveServiceEntry(root) {
  const manifest = join(root, ENTRY_MANIFEST)
  if (existsSync(manifest)) {
    const line = readFileSync(manifest, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
    if (line) {
      const rel = line.replace(/\\/g, '/')
      if (existsSync(join(root, rel))) return rel
    }
  }
  for (const rel of ENTRY_CANDIDATES) {
    if (existsSync(join(root, rel))) return rel
  }
  return null
}

/**
 * 拼出拉起服务用的 node 参数行。
 * 前置参数（如 --env-file-if-exists=.env）由配置给出，入口由约定解析。
 */
export function serviceArgs(root, extraArgs = []) {
  const entry = resolveServiceEntry(root)
  if (!entry) return null
  return [...extraArgs, entry]
}
