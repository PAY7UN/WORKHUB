/**
 * 路径的单一真源。
 *
 * 为什么单独一个文件，而不放进 config.ts：
 * config.ts 在模块加载期就校验密钥并可能直接终止进程，而 manageToken、
 * resetAdminPassword 这些离线工具只想读一个路径，不该被密钥校验拦下。
 * 也不放进 storage/v2/schema.ts：导入它就等于把库一起连上。
 *
 * 为什么值得单列：数据库路径的优先级（MDHUB_DB_V2 → MDHUB_DB → 默认）
 * 之前在四个文件里各写了一遍，其中一处还漏了 MDHUB_DB。改优先级要改四处，
 * 漏一处就指向错的库——而「重置管理员密码」「发机器令牌」这种事最不能指错库。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（server/ 的上一层） */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认数据库路径 */
export const DEFAULT_DB_PATH = join(APP_ROOT, 'data', 'mdhub-v2.db');

/** 默认 vault 目录：文档正文与原件都住这儿，与库同在 data/ 下 */
export const DEFAULT_VAULT_DIR = join(APP_ROOT, 'data', 'vault');

/**
 * 解析数据库路径。
 *
 * 优先级固定：MDHUB_DB_V2 → MDHUB_DB → 默认路径。
 *
 * 空串按「没配」处理：原来用的是 ??，只挡 undefined，空串会一路传下去，
 * 最后 dirname('') 变成 '.'，开库失败，报错还很难看懂。
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MDHUB_DB_V2?.trim() || env.MDHUB_DB?.trim() || DEFAULT_DB_PATH;
}

/** 解析 vault 目录 */
export function resolveVaultDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MDHUB_VAULT_DIR?.trim() || DEFAULT_VAULT_DIR;
}
