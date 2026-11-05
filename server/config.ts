/**
 * 运行期配置：集中读取环境变量，并在模块加载期强制校验。
 *
 * 安全要点：JWT 签名密钥与 API Key 加密主密钥同源（WORKHUB_SECRET）。
 * 一旦它缺失、过弱或取到公开默认值，任何人都能自签管理员令牌接管全站
 * 文档，或直接解密库中的模型密钥。因此这里不在缺失时静默回退，而是
 * 打印可操作的修复指引并终止加载——让不安全配置「起不来」，
 * 而不是「起来了还悄悄降级」。
 */
import { randomBytes } from 'node:crypto';
import { logger } from './logger.ts';
import { envFlag, envValue } from './env.ts';
import { applyEnvFileFallback } from './envFile.ts';

/** 仅在显式设置 WORKHUB_ALLOW_INSECURE_DEV=1 时才允许使用的开发默认值 */
const DEV_FALLBACK_SECRET = 'workhub-dev-secret-change-me';
const DEV_FALLBACK_ADMIN_PASSWORD = 'admin123';

/** 签名密钥最小字符数，低于此值视为弱密钥 */
const MIN_SECRET_LENGTH = 32;

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * .env 带 BOM 时的兜底。
 *
 * Node 的 --env-file 不认 BOM，会把文件里的第一个变量静默丢掉——
 * 打包态下丢的通常是 WORKHUB_SECRET，于是这里报「生产环境未配置密钥」，
 * 而密钥明明就在 .env 里。详见 server/envFile.ts。
 *
 * 必须在读密钥之前做，所以放在模块加载期。
 */
const envFileRepair = applyEnvFileFallback();
if (envFileRepair.bomFixed) {
  logger.warn(
    `已去掉 ${envFileRepair.file} 开头的 BOM（原文件备份为 ${envFileRepair.backup}）` +
      (envFileRepair.applied.length
        ? `，并补齐 ${envFileRepair.applied.length} 个变量：${envFileRepair.applied.join('、')}`
        : ''),
  );
}

const ALLOW_DEV_FALLBACK = envFlag('ALLOW_INSECURE_DEV');

/** 生成强随机密钥的提示命令 */
const GENERATE_HINT =
  'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

/** 打印修复指引后终止加载（抛错使进程以非零码退出） */
function abortStartup(title: string, details: string[]): never {
  // 详情合并进一条消息：日志级别前缀只出现一次，读起来仍是一条完整的指引
  const body = details.length ? `\n${details.map((line) => `  · ${line}`).join('\n')}` : '';
  logger.error(`配置校验失败：${title}${body}`);
  throw new Error(`[workhub] 配置校验失败：${title}`);
}

/**
 * 读取 JWT 签名与 API Key 加密共用的主密钥。
 * 已配置则校验强度；未配置时，生产环境直接拒绝启动，
 * 本地开发需显式选择「写 .env」或「开启开发开关」之一。
 */
function loadSecret(): string {
  const configured = envValue('SECRET');

  if (configured.length > 0) {
    if (configured.length < MIN_SECRET_LENGTH) {
      abortStartup(`WORKHUB_SECRET 过弱（当前 ${configured.length} 字符，至少 ${MIN_SECRET_LENGTH}）`, [
        '弱密钥可被离线爆破，请使用 32 字节随机值。',
        `生成方式：${GENERATE_HINT}`,
      ]);
    }
    return configured;
  }

  if (IS_PRODUCTION) {
    abortStartup('生产环境未配置 WORKHUB_SECRET', [
      '该密钥同时用于 JWT 签名与 API Key 加密，缺失等同于全站权限失守。',
      '请在 .env 或系统环境变量中设置后再启动。',
      '若 .env 里明明写了却读不到：多半是文件开头带了 BOM 或首行格式不对，' +
        'Node 会静默丢掉第一个变量（用记事本保存容易带上 BOM）。',
      `生成方式：${GENERATE_HINT}`,
    ]);
  }

  if (ALLOW_DEV_FALLBACK) {
    logger.warn('警告：正在使用公开的开发默认密钥，严禁用于任何对外环境。');
    return DEV_FALLBACK_SECRET;
  }

  abortStartup('未配置 WORKHUB_SECRET', [
    '本地开发请二选一：',
    `  1) 在 app/.env 中设置 WORKHUB_SECRET（推荐）：${GENERATE_HINT}`,
    '  2) 设置 WORKHUB_ALLOW_INSECURE_DEV=1，显式承认这是开发环境',
  ]);
}

/**
 * 读取管理员初始密码（仅首次建库时写入 users 表）。
 * 生产环境缺失即拒绝启动；本地缺失时生成一次性随机密码，
 * 避免默认弱口令在开发环境里形成习惯。
 */
function loadAdminPassword(): string {
  const configured = envValue('ADMIN_PASSWORD');
  if (configured.length > 0) return configured;

  if (IS_PRODUCTION) {
    abortStartup('生产环境未配置 WORKHUB_ADMIN_PASSWORD', [
      '该密码会在首次初始化时写入 users 表，缺失将退化为公开弱口令。',
      '请先设置一个强密码再启动。',
    ]);
  }

  if (ALLOW_DEV_FALLBACK) return DEV_FALLBACK_ADMIN_PASSWORD;

  const generated = randomBytes(12).toString('base64url');
  // notice：密码是「交付」而不是「日志」，不随 WORKHUB_LOG_LEVEL 一起被静默
  logger.notice(`未配置 WORKHUB_ADMIN_PASSWORD，已生成一次性管理员密码：${generated}`);
  logger.notice('该密码仅在此处显示一次，请立即记录到密码管理器。');
  logger.notice('提醒：启动日志里含这行密码，转贴日志前请先把它删掉。');
  return generated;
}

/** JWT 签名与 API Key 加密主密钥（已通过强度校验） */
export const SECRET = loadSecret();

/** 管理员初始密码（已通过校验或安全生成） */
export const ADMIN_PASSWORD = loadAdminPassword();

/** 启动日志用：当前是否使用了开发兜底值 */
export const USING_DEV_FALLBACK = SECRET === DEV_FALLBACK_SECRET;

