/**
 * 离线重置管理员密码，不依赖任何登录态。
 *
 * 用法：
 *   npm run admin:password -- <新密码>     把管理员密码设为指定值
 *   npm run admin:password -- --generate  生成强随机密码并写入（仅打印一次）
 *
 * 为什么需要它：UI 里的「修改密码」要求先登录，而首次初始密码在未配置
 * MDHUB_ADMIN_PASSWORD 时是启动日志里打印一次就消失的随机串。一旦用户错过那行
 * 日志、或忘了自己当初设的值，就只能在「进不去」和「删库重建」之间二选一。
 * 这个脚本补上那条退路。
 *
 * 为什么刻意不 import db.ts / config.ts：那两个模块一旦加载就会校验 MDHUB_SECRET
 * 并可能直接终止进程，还顺带建表、灌种子。求救命令不该因为「另一个密钥没配好」
 * 而跑不起来，更不该产生副作用，所以这里自开一个最小连接。
 *
 * 安全性质：改密后所有旧令牌自动失效，无需额外通知或黑名单——令牌里带着密码指纹
 * （见 auth.ts），指纹一变，此前签发的令牌全部变成 stale。
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { MIN_PASSWORD_LENGTH, hashPassword, validateNewPassword } from './password.ts';
import { displayPath, logger } from './logger.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 要改的库必须和服务端在用的那个是同一个。
 *
 * v2 起服务端认的是 data/mdhub-v2.db（顺序：MDHUB_DB_V2 → MDHUB_DB → 默认 v2 路径）。
 * 这里原先写死 data/mdhub.db，改的是旧库——服务端压根不读它，
 * 于是「忘了密码」这条退路会显示「密码已更新」，用户却仍然登不进去。
 * 这条命令的全部价值就是救场，救不成的命令比没有更糟。
 */
const DB_PATH =
  process.env.MDHUB_DB_V2 ?? process.env.MDHUB_DB ?? resolve(HERE, '../data/mdhub-v2.db');

const USAGE = [
  '用法：',
  '  npm run admin:password -- <新密码>     将管理员密码设为指定值',
  '  npm run admin:password -- --generate  生成强随机密码并写入（仅打印一次）',
  '',
  `数据库：${displayPath(DB_PATH)}（可用环境变量 MDHUB_DB_V2 / MDHUB_DB 覆盖）`,
].join('\n');

/** 打印可操作的失败原因后退出。exit code 1 便于脚本或 CI 感知 */
function fail(title: string, details: string[] = []): never {
  // 失败走 stderr：stdout 只留命令本身的产出，便于 `npm run admin:password > out.txt` 存档
  const body = details.length ? `\n${details.map((line) => `  · ${line}`).join('\n')}` : '';
  logger.error(`${title}${body}`);
  process.exit(1);
}

/**
 * 解析参数。
 *
 * 只有 argv[0] 命中已知开关时才走分支，其余情况整段当作密码——密码本身可能以
 * 「-」开头、也可能含空格，任何猜测式解析都只会制造「明明填对了却被当参数」的坑。
 */
function parseArgs(argv: string[]): { plain: string; generated: boolean } {
  const head = argv[0];
  if (head === '--help' || head === '-h') {
    logger.notice(USAGE);
    process.exit(0);
  }
  if (head === '--generate') {
    if (argv.length > 1) fail('--generate 不能与显式密码同时使用', [USAGE]);
    return { plain: randomBytes(18).toString('base64url'), generated: true };
  }
  if (argv.length === 0) fail('未提供新密码', [USAGE]);
  return { plain: argv.join(' '), generated: false };
}

function main(): void {
  const { plain, generated } = parseArgs(process.argv.slice(2));

  const invalid = validateNewPassword(plain);
  if (invalid) fail(`密码不符合要求：${invalid}`, [`当前规则：至少 ${MIN_PASSWORD_LENGTH} 位。`]);

  if (!existsSync(DB_PATH)) {
    fail(`找不到数据库文件：${displayPath(DB_PATH)}`, ['该库尚未创建，请先运行一次 npm run server 完成初始化。']);
  }

  const db = new Database(DB_PATH);
  try {
    const hasUsers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get();
    if (!hasUsers) {
      fail('数据库中还没有 users 表', ['请先运行一次 npm run server 完成初始化。']);
    }

    // 同时清空明文列：留着它等于同时维护两份凭据，任一处泄露都足以登录
    const info = db
      .prepare("UPDATE users SET password_hash = ?, password = '' WHERE username = 'admin'")
      .run(hashPassword(plain));
    if (info.changes === 0) {
      fail('未找到 username = admin 的账号', [
        '数据库可能已被替换过，请确认 MDHUB_DB_V2 / MDHUB_DB 指向的是正在使用的那个文件。',
      ]);
    }
  } finally {
    db.close();
  }

  logger.info(`管理员密码已更新：${displayPath(DB_PATH)}`);
  if (generated) {
    // 密码是这条命令的交付物，不是日志：不随日志级别被静默
    logger.notice(`新密码：${plain}`);
    logger.notice('仅在此处显示这一次，请立即复制到密码管理器。');
  }
  logger.info('所有已登录设备会在下一次请求时因令牌指纹过期而被要求重新登录。');
}

main();
