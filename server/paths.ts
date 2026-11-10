/**
 * 路径的单一真源。
 *
 * 为什么单独一个文件，而不放进 config.ts：
 * config.ts 在模块加载期就校验密钥并可能直接终止进程，而 manageToken、
 * resetAdminPassword 这些离线工具只想读一个路径，不该被密钥校验拦下。
 * 也不放进 storage/v2/schema.ts：导入它就等于把库一起连上。
 *
 * 为什么值得单列：数据库路径的优先级（WORKHUB_DB_V2 → WORKHUB_DB → 默认）
 * 之前在四个文件里各写了一遍，其中一处还漏了 DB。改优先级要改四处，
 * 漏一处就指向错的库——而「重置管理员密码」「发机器令牌」这种事最不能指错库。
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envValueFrom } from './env.ts';

/** 项目根目录（server/ 的上一层） */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 现役数据库文件名 */
export const DB_FILENAME = 'workhub-v2.db';

/** 改名前的数据库文件名。磁盘上还有它时，库会被搬到新名字下 */
export const LEGACY_DB_FILENAME = 'mdhub-v2.db';

/** 默认数据库路径 */
export const DEFAULT_DB_PATH = join(APP_ROOT, 'data', DB_FILENAME);

/** 默认 vault 目录：文档正文与原件都住这儿，与库同在 data/ 下 */
export const DEFAULT_VAULT_DIR = join(APP_ROOT, 'data', 'vault');

/**
 * 解析数据库路径。
 *
 * 优先级固定：WORKHUB_DB_V2 → WORKHUB_DB → 默认路径。
 * 旧名 MDHUB_DB_V2 / MDHUB_DB 仍然认（见 server/env.ts）：
 * 改了名字的部署如果因此找不到库，是很难查的故障。
 *
 * 空串按「没配」处理：原来用的是 ??，只挡 undefined，空串会一路传下去，
 * 最后 dirname('') 变成 '.'，开库失败，报错还很难看懂。
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return envValueFrom(env, 'DB_V2') || envValueFrom(env, 'DB') || DEFAULT_DB_PATH;
}

/** 解析 vault 目录 */
export function resolveVaultDir(env: NodeJS.ProcessEnv = process.env): string {
  return envValueFrom(env, 'VAULT_DIR') || DEFAULT_VAULT_DIR;
}

/**
 * 解析运行期日志目录：升级日志、升级结果摘要都落这儿。
 *
 * 默认是代码目录下的 logs/，但那只是「没有更好的选择时」的位置：
 * 打包态（托盘拉起）里代码在安装目录下，Windows 上普通用户写不进去——
 * 于是升级日志写不出来，升级结果摘要也存不下来，界面上只能看到「升级失败」。
 *
 * 托盘知道哪个目录可写（工作目录），所以它会把这个位置用环境变量告诉服务端，
 * 于是升级记录跟服务日志待在一起：使用者只要看一个 logs 目录。
 *
 * 优先级跟其他路径一致：WORKHUB_LOG_DIR → MDHUB_LOG_DIR → 默认。
 */
export function resolveLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return envValueFrom(env, 'LOG_DIR') || join(APP_ROOT, 'logs');
}

export interface DbMigration {
  /** 迁移前的路径 */
  from: string;
  /** 迁移后的路径 */
  to: string;
}

/**
 * 内置能力目录：随代码发布的一份份能力（每份一个子目录）。
 *
 * 能力是「说明书 + 执行契约」，用户看得懂、模型读得懂，
 * 所以它就该躺在磁盘上，而不是写死在代码里等下一次发版。
 */
export const DEFAULT_SKILLS_DIR = join(APP_ROOT, 'skills');

/** 用户自建能力目录：往里丢一个目录就多一份能力，不用改代码 */
export const DEFAULT_USER_SKILLS_DIR = join(APP_ROOT, 'data', 'skills');

/**
 * 解析用户自建能力目录。
 *
 * 单独列一个函数：界面得告诉用户「往哪儿丢文件」，
 * 这句话不能靠猜，得是服务端算出来的那个真实路径。
 */
export function resolveUserSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return envValueFrom(env, 'USER_SKILLS_DIR') || DEFAULT_USER_SKILLS_DIR;
}

/**
 * 解析能力目录：内置在前、用户在后。
 *
 * 顺序有讲究：后加载的覆盖先加载的（同 id 时用户那份赢），
 * 所以用户可以拿自己的能力替换掉内置的那份，不用改代码。
 */
export function resolveSkillsDirs(env: NodeJS.ProcessEnv = process.env): Array<{ dir: string; source: 'builtin' | 'user' }> {
  return [
    { dir: envValueFrom(env, 'SKILLS_DIR') || DEFAULT_SKILLS_DIR, source: 'builtin' as const },
    { dir: resolveUserSkillsDir(env), source: 'user' as const },
  ];
}

/**
 * 数据库改名的迁移计划：磁盘上还是旧文件名时，该挪到新名字下。
 *
 * 为什么非做不可：库文件名从 mdhub-v2.db 换成 workhub-v2.db 之后，
 * 不做迁移的话，升级过的用户会发现「自己的库不见了」——服务建了个空库，
 * 而旧库还躺在 data/ 里没人管。从外面看像是数据被清了。
 *
 * 这里只**判断**该不该搬，不动手：动手在 db.ts 里做，因为那里的顺序讲究
 * （必须在开库之前搬，否则 SQLite 会拿旧 WAL 去开新库）。
 *
 * 三道限制，缺一个都可能搬错：
 *   - 只认默认文件名：用户自定义的库名（WORKHUB_DB_V2=/data/my.db）
 *     不该被牵走；
 *   - 目标已存在就不搬：说明已经迁过了，或者本来就是新库；
 *   - 旧文件不在就不搬：没什么可搬的。
 */
export function planDbMigration(dbPath: string): DbMigration | null {
  if (basename(dbPath) !== DB_FILENAME) return null;
  const legacy = join(dirname(dbPath), LEGACY_DB_FILENAME);
  if (legacy === dbPath) return null;
  if (existsSync(dbPath)) return null;
  if (!existsSync(legacy)) return null;
  return { from: legacy, to: dbPath };
}
