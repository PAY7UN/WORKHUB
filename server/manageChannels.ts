/**
 * 列出 / 停掉通道会话（不依赖浏览器）。
 *
 * 用法：
 *   npm run manage:channels -- list         列出所有通道
 *   npm run manage:channels -- stop <通道id> 停掉某个通道
 *   npm run manage:channels -- stop --all    停掉所有还在跑的通道
 *
 * 为什么需要它：通道是长驻资源，活在服务端，关掉页面不等于关掉通道。
 * 正常情况下在网页上点「停止」就行——但有一种情况网页上点不了：
 * 有人把网口监听开在了网页自己的端口上（比如开发态的前端端口 8080），
 * 浏览器发来的请求全被那个原始 TCP 监听接走，页面既读不到通道列表，
 * 也点不动「停止」——想关它，先得连得上服务端。
 *
 * 这条命令就是那个出口：它只认服务端在哪个端口，不经过浏览器。
 *
 * 刻意不 import db.ts / config.ts：那两个模块一旦加载就会校验 WORKHUB_SECRET
 * 并可能直接终止进程。这条命令的价值在于「随时能用」，
 * 不该因为「另一个密钥没配好」而跑不起来。
 */
import { DEFAULT_API_PORT } from '../shared/constants.ts';
import { envValue } from './env.ts';
import { logger } from './logger.ts';

/** 服务端在哪个端口：与 server/index.ts 取值一致 */
const API_PORT = Number(envValue('PORT') || DEFAULT_API_PORT);
const BASE = `http://127.0.0.1:${API_PORT}`;

const USAGE = [
  '用法：',
  '  npm run manage:channels -- list         列出所有通道',
  '  npm run manage:channels -- stop <通道id> 停掉某个通道',
  '  npm run manage:channels -- stop --all    停掉所有还在跑的通道',
  '',
  `服务端：${BASE}（可用环境变量 WORKHUB_PORT 覆盖）`,
].join('\n');

/** 一个通道会话（只取用得上的字段） */
interface SessionView {
  id: string;
  tool: string;
  name: string;
  status: string;
  startedAt: number;
  config: Record<string, string>;
}

/** 打印可操作的失败原因后退出。exit code 1 便于脚本或 CI 感知 */
function fail(title: string, details: string[] = []): never {
  const body = details.length ? `\n${details.map((line) => `  · ${line}`).join('\n')}` : '';
  logger.error(`${title}${body}`);
  process.exit(1);
}

/** 跟服务端说话；连不上就说清楚是「服务端没起来」还是「请求失败」 */
async function call(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (err) {
    fail(`连不上服务端（${BASE}）`, [
      err instanceof Error ? err.message : String(err),
      '服务端没在跑？先启动它：npm run dev:all（或 npm run server）。',
    ]);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error?: unknown }).error ?? '')
        : '';
    fail(`请求失败（HTTP ${res.status}）`, message ? [message] : []);
  }
  return body;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    logger.notice(USAGE);
    return;
  }

  if (command === 'list') {
    const body = (await call('/api/tools/sessions')) as { sessions?: SessionView[] };
    const sessions = body.sessions ?? [];
    if (sessions.length === 0) {
      logger.notice('现在没有通道。');
      return;
    }
    logger.info(`共 ${sessions.length} 个通道：`);
    for (const s of sessions) {
      logger.info(
        `  ${s.id}  ${s.status === 'running' ? '在跑' : '已停'}  ${s.name}` +
          `  ${s.tool}  ${JSON.stringify(s.config)}  起于 ${formatTime(s.startedAt)}`,
      );
    }
    return;
  }

  if (command === 'stop') {
    const target = rest[0];

    if (!target) {
      fail('要停哪个通道？', [USAGE, '先跑 list 看看通道 id。']);
    }

    if (target === '--all') {
      const body = (await call('/api/tools/sessions')) as { sessions?: SessionView[] };
      const running = (body.sessions ?? []).filter((s) => s.status === 'running');
      if (running.length === 0) {
        logger.notice('没有还在跑的通道。');
        return;
      }
      for (const s of running) {
        await call(`/api/tools/sessions/${s.id}`, { method: 'DELETE' });
        logger.info(`已停止：${s.name}（${s.id}）`);
      }
      return;
    }

    await call(`/api/tools/sessions/${target}`, { method: 'DELETE' });
    logger.info(`已停止通道 ${target}。`);
    return;
  }

  fail(`未知命令：${command}`, [USAGE]);
}

await main();
