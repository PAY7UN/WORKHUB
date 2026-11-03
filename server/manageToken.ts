/**
 * 发放 / 查看 / 撤销机器令牌（运维面板用），不依赖任何登录态。
 *
 * 用法：
 *   npm run manage:token -- issue [标签]     发放一把新令牌（明文仅打印一次）
 *   npm run manage:token -- list             列出全部令牌
 *   npm run manage:token -- revoke <令牌id>  撤销一把令牌
 *
 * 为什么需要它：机器令牌是给「另一台机器上的托盘」用的，
 * 那台机器上没有人登录过服务端，自然也没有管理员会话可用。
 * 发放这把钥匙的动作必须能在这台服务器上离线完成。
 *
 * 为什么刻意不 import db.ts / config.ts：那两个模块一旦加载就会校验 MDHUB_SECRET
 * 并可能直接终止进程，还顺带建表、灌种子。这条命令的价值在于「随时能用」，
 * 不该因为「另一个密钥没配好」而跑不起来。schema.ts 是纯的（不含配置校验），
 * 直接用它开库即可。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openV2Db } from './storage/v2/schema.ts';
import { issueManageToken, listManageTokens, revokeManageToken } from './manageTokens.ts';
import { displayPath, logger } from './logger.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 要操作的库必须和服务端在用的是同一个（顺序与服务端一致） */
const DB_PATH =
  process.env.MDHUB_DB_V2 ?? process.env.MDHUB_DB ?? resolve(HERE, '../data/mdhub-v2.db');

const USAGE = [
  '用法：',
  '  npm run manage:token -- issue [标签]     发放一把新令牌（明文仅打印一次）',
  '  npm run manage:token -- list             列出全部令牌',
  '  npm run manage:token -- revoke <令牌id>  撤销一把令牌',
  '',
  `数据库：${displayPath(DB_PATH)}（可用环境变量 MDHUB_DB_V2 / MDHUB_DB 覆盖）`,
].join('\n');

/** 打印可操作的失败原因后退出。exit code 1 便于脚本或 CI 感知 */
function fail(title: string, details: string[] = []): never {
  const body = details.length ? `\n${details.map((line) => `  · ${line}`).join('\n')}` : '';
  logger.error(`${title}${body}`);
  process.exit(1);
}

function formatTime(ms: number | null): string {
  if (!ms) return '从未';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    logger.notice(USAGE);
    process.exit(0);
  }

  if (!existsSync(DB_PATH)) {
    fail(`找不到数据库文件：${displayPath(DB_PATH)}`, ['该库尚未创建，请先运行一次 npm run server 完成初始化。']);
  }

  const db = openV2Db(DB_PATH);
  try {
    if (command === 'issue') {
      const label = rest.join(' ').trim() || '未命名';
      const issued = issueManageToken(db, label);
      logger.info(`已发放机器令牌（id=${issued.id}，标签：${issued.label}）`);
      // 令牌是这条命令的交付物，不是日志：不随日志级别被静默
      logger.notice(`令牌：${issued.token}`);
      logger.notice('仅在此处显示这一次。填到托盘的 remote 模式里（tray.config.json 的 token 字段，或环境变量 WORKHUB_MANAGE_TOKEN）。');
      return;
    }

    if (command === 'list') {
      const tokens = listManageTokens(db);
      if (tokens.length === 0) {
        logger.notice('还没有发放过任何令牌。');
        return;
      }
      logger.info(`共 ${tokens.length} 把令牌：`);
      for (const item of tokens) {
        const state = item.revoked_at ? `已于 ${formatTime(item.revoked_at)} 撤销` : `最近使用 ${formatTime(item.last_used_at)}`;
        logger.info(`  ${item.id}  ${item.label || '(无标签)'}  发放于 ${formatTime(item.created_at)}  ${state}`);
      }
      return;
    }

    if (command === 'revoke') {
      const id = rest[0];
      if (!id) fail('缺少令牌 id', [USAGE]);
      const changed = revokeManageToken(db, id);
      if (!changed) {
        fail(`没能撤销令牌 ${id}`, ['它可能不存在，或已经被撤销过。']);
      }
      logger.info(`已撤销令牌 ${id}，它即刻失效。`);
      return;
    }

    fail(`未知命令：${command}`, [USAGE]);
  } finally {
    db.close();
  }
}

main();
