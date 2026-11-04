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
 * 为什么刻意不 import db.ts / config.ts：那两个模块一旦加载就会校验 WORKHUB_SECRET
 * 并可能直接终止进程，还顺带建表、灌种子。这条命令的价值在于「随时能用」，
 * 不该因为「另一个密钥没配好」而跑不起来。schema.ts 是纯的（不含配置校验），
 * 直接用它开库即可。
 */
import { existsSync } from 'node:fs';
import { openV2Db } from './storage/v2/schema.ts';
import { issueManageToken, listManageTokens, revokeManageToken, revokeUnusedByLabel } from './manageTokens.ts';
import { displayPath, logger } from './logger.ts';
import { resolveDbPath } from './paths.ts';

/** 要操作的库必须和服务端在用的是同一个（顺序与服务端一致，见 paths.ts） */
const DB_PATH = resolveDbPath();

const USAGE = [
  '用法：',
  '  npm run manage:token -- issue [标签]     发放一把新令牌（明文仅打印一次）',
  '  npm run manage:token -- list             列出全部令牌',
  '  npm run manage:token -- revoke <令牌id>  撤销一把令牌',
  '  npm run manage:token -- cleanup [标签]   撤销该标签下从未使用过的令牌（默认 windows service）',
  '',
  `数据库：${displayPath(DB_PATH)}（可用环境变量 WORKHUB_DB_V2 / WORKHUB_DB 覆盖）`,
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
  const argv = process.argv.slice(2);
  // --json：只输出 JSON，不掺日志。
  // 给脚本用——日志行带时间戳和前缀，脚本去正则抠里面的值，
  // 哪天日志格式一改就悄悄抠错，错了还不报错。
  const asJson = argv.includes('--json');
  const [command, ...rest] = argv.filter((item) => item !== '--json');

  if (!command || command === '--help' || command === '-h') {
    if (asJson) {
      console.log(JSON.stringify({ ok: true, usage: USAGE.split('\n') }, null, 2));
    } else {
      logger.notice(USAGE);
    }
    process.exit(0);
  }

  if (!existsSync(DB_PATH)) {
    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: `找不到数据库文件：${displayPath(DB_PATH)}` }));
      process.exit(1);
    }
    fail(`找不到数据库文件：${displayPath(DB_PATH)}`, ['该库尚未创建，请先运行一次 npm run server 完成初始化。']);
  }

  const db = openV2Db(DB_PATH);
  try {
    if (command === 'issue') {
      const label = rest.join(' ').trim() || '未命名';
      const issued = issueManageToken(db, label);
      if (asJson) {
        console.log(JSON.stringify({ ok: true, id: issued.id, token: issued.token, label: issued.label }));
        return;
      }
      logger.info(`已发放机器令牌（id=${issued.id}，标签：${issued.label}）`);
      // 令牌是这条命令的交付物，不是日志：不随日志级别被静默
      logger.notice(`令牌：${issued.token}`);
      logger.notice('仅在此处显示这一次。填到托盘的 remote 模式里（tray.config.json 的 token 字段，或环境变量 WORKHUB_MANAGE_TOKEN）。');
      return;
    }

    if (command === 'list') {
      const tokens = listManageTokens(db);
      if (asJson) {
        console.log(JSON.stringify({ ok: true, tokens }, null, 2));
        return;
      }
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
      if (!id) {
        if (asJson) {
          console.log(JSON.stringify({ ok: false, error: '缺少令牌 id' }));
          process.exit(1);
        }
        fail('缺少令牌 id', [USAGE]);
      }
      const changed = revokeManageToken(db, id);
      if (!changed) {
        if (asJson) {
          console.log(JSON.stringify({ ok: false, id, error: '令牌不存在或已被撤销' }));
          process.exit(1);
        }
        fail(`没能撤销令牌 ${id}`, ['它可能不存在，或已经被撤销过。']);
      }
      if (asJson) {
        console.log(JSON.stringify({ ok: true, id }));
        return;
      }
      logger.info(`已撤销令牌 ${id}，它即刻失效。`);
      return;
    }

    if (command === 'cleanup') {
      // 清理装服务时留下的残骸：每次装服务都发一把新令牌，卸了也不回收，
      // 攒多了就是一堆没人知道却还能重启服务的钥匙。
      const label = rest.join(' ').trim() || 'windows service';
      const revoked = revokeUnusedByLabel(db, label);
      if (asJson) {
        console.log(JSON.stringify({ ok: true, revoked }));
        return;
      }
      if (revoked.length === 0) {
        logger.info(`没有找到标签为「${label}」且从未使用过的令牌（用过的要人来确认，不动）。`);
        return;
      }
      logger.info(`已撤销 ${revoked.length} 把标签为「${label}」且从未使用过的令牌：`);
      for (const id of revoked) logger.info(`  ${id}`);
      return;
    }

    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: `未知命令：${command}` }));
      process.exit(1);
    }
    fail(`未知命令：${command}`, [USAGE]);
  } finally {
    db.close();
  }
}

main();
