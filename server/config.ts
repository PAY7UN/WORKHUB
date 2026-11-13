/**
 * 运行期配置：集中读取环境变量，并在模块加载期强制校验。
 *
 * 安全要点：JWT 签名密钥与 API Key 加密主密钥同源（WORKHUB_SECRET）。
 * 一旦它缺失、过弱，或是所有人共用的公开默认值，任何人都能自签管理员令牌
 * 接管全站文档，或直接解密库中的模型密钥。
 *
 * 所以这里**没有写死的密钥**：
 * - 密钥要么显式配置，要么由服务端本地生成一把随机密钥并落盘（见 localSecret.ts），
 *   两种来源都不会跟着发布包走，也不会有第二个人猜得到；
 * - 管理员密码按部署方的要求：初始部署密码就是 admin，登录后自行修改。
 *   想在部署时就定死自己的密码，照旧在 .env 里写 WORKHUB_ADMIN_PASSWORD。
 */
import { logger } from './logger.ts';
import { envFlag, envValue } from './env.ts';
import { applyEnvFileFallback } from './envFile.ts';
import { MIN_SECRET_LENGTH, loadOrCreateLocalSecret } from './localSecret.ts';

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

/**
 * 允许在开发态自动生成本地密钥的开关。
 *
 * 置 1 表示「本地没配 WORKHUB_SECRET 时，服务端自己生成一把随机密钥并保存到本地」。
 * 它管的是密钥，不是密码：密码有明确的初始值（见下方 loadAdminPassword）。
 */
const ALLOW_LOCAL_CREDENTIALS = envFlag('ALLOW_LOCAL_CREDENTIALS');

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

/** 密钥的来路，用于启动日志 */
export type SecretOrigin = 'env' | 'local';

interface LoadedSecret {
  secret: string;
  origin: SecretOrigin;
}

/**
 * 读取 JWT 签名与 API Key 加密共用的主密钥。
 * 已配置则校验强度；未配置时，生产环境直接拒绝启动，
 * 本地开发可显式要求「本地自动生成一把」（生成后落盘，重启不变）。
 */
function loadSecret(): LoadedSecret {
  const configured = envValue('SECRET');

  if (configured.length > 0) {
    if (configured.length < MIN_SECRET_LENGTH) {
      abortStartup(`WORKHUB_SECRET 过弱（当前 ${configured.length} 字符，至少 ${MIN_SECRET_LENGTH}）`, [
        '弱密钥可被离线爆破，请使用 32 字节随机值。',
        `生成方式：${GENERATE_HINT}`,
      ]);
    }
    return { secret: configured, origin: 'env' };
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

  if (ALLOW_LOCAL_CREDENTIALS) {
    // 本地自动生成一把：不是公开默认值，是这台机器自己的随机密钥。
    // 落盘是必须的——密钥每次都换的话，库里的密文下一次启动就全解不开了。
    const local = loadOrCreateLocalSecret();
    if (!local.ok) {
      abortStartup('本地自动生成的密钥不可用', [
        local.reason,
        `密钥文件：${local.path}`,
        '库里的密文（API Key、加密文档）都由这把密钥保护，换一把就再也解不开。',
        '请显式配置 WORKHUB_SECRET；确认数据可以舍弃的话，删掉该密钥文件与数据库再启动。',
      ]);
    }
    if (local.created) {
      logger.warn(`未配置 WORKHUB_SECRET：已在本地生成一把随机密钥并保存到 ${local.path}`);
      logger.warn('它保护着库里的密文（API Key、加密文档）：删掉它，那些内容将永久无法解密。');
    }
    return { secret: local.secret, origin: 'local' };
  }

  abortStartup('未配置 WORKHUB_SECRET', [
    '本地开发请二选一：',
    `  1) 在 app/.env 中设置 WORKHUB_SECRET（推荐）：${GENERATE_HINT}`,
    '  2) 设置 WORKHUB_ALLOW_LOCAL_CREDENTIALS=1，由服务端本地生成一把随机密钥（存在数据库旁边）',
  ]);
}

/** 显式配置的管理员密码（没配就是空串） */
const CONFIGURED_ADMIN_PASSWORD = envValue('ADMIN_PASSWORD');

/** 初始部署密码：部署方定的固定初始值，登录后自行修改 */
const DEFAULT_ADMIN_PASSWORD = 'admin';

/**
 * 读取管理员初始密码（仅首次建库时写入 users 表）。
 *
 * 显式配置的优先；没配置时用初始部署密码 admin——它必须好记，
 * 因为部署的人要立刻拿它登进去改密码。
 *
 * 生产环境不再拒绝启动：桌面安装版由托盘拉起（NODE_ENV=production），
 * 使用者装完即用，密码不该成为一道门槛。防线交给网页端——
 * 密码还是初始值时界面会一直提醒，改掉即消失。
 */
function loadAdminPassword(): string {
  if (CONFIGURED_ADMIN_PASSWORD.length > 0) return CONFIGURED_ADMIN_PASSWORD;

  if (IS_PRODUCTION) {
    logger.warn('未配置 WORKHUB_ADMIN_PASSWORD：初始密码为 admin，登录后请尽快修改');
    logger.warn('  密码还是初始值时，网页端会一直提醒；在「管理后台 → 账号安全」里改掉即可');
  }

  return DEFAULT_ADMIN_PASSWORD;
}

const loadedSecret = loadSecret();

/** JWT 签名与 API Key 加密主密钥（已通过强度校验） */
export const SECRET = loadedSecret.secret;

/** 密钥来路：'env' = 显式配置，'local' = 本地自动生成并落盘 */
export const SECRET_ORIGIN = loadedSecret.origin;

/** 管理员密码是否由使用者显式配置（false = 用的是初始部署密码 admin） */
export const ADMIN_PASSWORD_CONFIGURED = CONFIGURED_ADMIN_PASSWORD.length > 0;

/** 管理员初始密码（显式配置的，或初始部署密码 admin） */
export const ADMIN_PASSWORD = loadAdminPassword();
