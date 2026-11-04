/**
 * 服务端日志出口：统一格式、分级可控、写入前强制脱敏。
 *
 * 为什么不让各处直接 console.log：
 * 1. 格式统一——一律 `[workhub][级别]` 前缀，grep `[workhub][error]` 就能捞出全部错误；
 * 2. 分级可控——WORKHUB_LOG_LEVEL=silent 可在 CI / 容器里彻底静音，debug 用于排查；
 * 3. 强制脱敏——所有入参都过一遍 shared/redact.ts，密钥不会因为某次
 *    「顺手把整个错误对象打出来」而进日志；
 * 4. 流向正确——error / warn 走 stderr，info / debug 走 stdout，
 *    这样 `npm run server > out.log` 时错误不会被混进正常输出。
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../shared/redact.ts';
import { envValue } from './env.ts';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** 级别权重：数值越大越啰嗦，打印条件为「本级别权重 ≤ 当前级别权重」 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function readLogLevel(): LogLevel {
  const raw = envValue('LOG_LEVEL').toLowerCase();
  return raw in LEVEL_WEIGHT ? (raw as LogLevel) : 'info';
}

/** 当前生效的日志级别（由 WORKHUB_LOG_LEVEL 覆盖，默认 info） */
export const LOG_LEVEL = readLogLevel();

/**
 * 最近日志的内存环形缓冲。
 *
 * 服务端日志只往 stdout/stderr 写，不落盘——运维在另一台机器上想看
 * 「刚才报了什么错」，总不能 SSH 上去 tail 一把。所以这里留一份最近的行，
 * 供 /api/manage/logs 取用（见 server/manage.ts）。
 *
 * 只留 500 行：够看清一次故障的前因后果，又不至于让长跑进程的内存无界增长。
 * 缓冲里的行已经过脱敏（emit 里 redact 过），不会把密钥带出去。
 *
 * `notice` 走的是另一条路（不经 emit），因此不进缓冲——
 * 那条通道用来交付一次性密码，不能让它在接口里躺着。
 */
const RING_SIZE = 500;
const recentLines: string[] = [];

/** 取最近若干行日志（默认 200，最多不超过缓冲长度） */
export function recentLogLines(limit = 200): string[] {
  const count = Math.max(0, Math.min(limit, recentLines.length));
  return recentLines.slice(-count);
}

/**
 * 把任意入参格式化成一行文本。
 *
 * Error 只取 name: message——堆栈在 info 级是噪音，在 debug 级才是定位线索；
 * 其余类型按值序列化，序列化失败（循环引用等）再退回 String()。
 */
export function formatValue(value: unknown): string {
  if (value instanceof Error) {
    return LOG_LEVEL === 'debug' && value.stack ? value.stack : `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return redact(value);
  if (value === null || value === undefined) return String(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? redact(String(value)) : redact(json);
  } catch {
    return redact(String(value));
  }
}

/** 可打印的级别：fatal 不在开关档位里，它是「进程即将终止」这一事实的标记 */
type EmitLevel = Exclude<LogLevel, 'silent'> | 'fatal';

function emit(level: EmitLevel, message: string, args: unknown[]): void {
  // fatal 是最后一条消息：进程马上就要没了，日志级别再严也不能让它消失，
  // 否则一次静默启动只会得到一个「毫无痕迹的退出」
  if (level !== 'fatal' && LEVEL_WEIGHT[level] > LEVEL_WEIGHT[LOG_LEVEL]) return;
  const parts = [`[workhub][${level}]`, redact(message)];
  for (const arg of args) parts.push(formatValue(arg));
  const line = parts.join(' ');
  // warn / error / fatal 走 stderr，info / debug 走 stdout：管道里两者可分别重定向
  if (level === 'error' || level === 'fatal') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  // 留一份在内存里，供运维接口读取（已脱敏，可安全外发）
  recentLines.push(line);
  if (recentLines.length > RING_SIZE) recentLines.shift();
}

export const logger = {
  error: (message: string, ...args: unknown[]): void => emit('error', message, args),
  warn: (message: string, ...args: unknown[]): void => emit('warn', message, args),
  info: (message: string, ...args: unknown[]): void => emit('info', message, args),
  debug: (message: string, ...args: unknown[]): void => emit('debug', message, args),

  /**
   * 致命错误：进程即将终止，这是最后一条消息。
   *
   * 与 notice 的区别是它**照样脱敏**（堆栈里也可能带出路径与参数），
   * 但同样**不受级别开关影响**——服务崩了却什么都不打印，等于没有日志。
   */
  fatal: (message: string, ...args: unknown[]): void => emit('fatal', message, args),

  /**
   * 关键信息：不受日志级别影响，永远打印，且**逐字输出、不过脱敏**。
   *
   * 目前只有一处用它——一次性管理员密码的交付。
   *
   * 为什么不过脱敏：脱敏规则会改写「长得像密钥」的文本（`sk-…`、JWT 等），
   * 而随机密码里恰好出现 `sk-` 的概率虽小却真实存在——一旦被改写，
   * 用户拿到的是一把开不了门的钥匙，且完全看不出哪里不对。
   * 既然这个通道的用途就是「把内容原样交给用户」，就不该再动它的字符。
   *
   * 为什么不受级别影响：那行字不是「日志」而是「凭证」。被 WORKHUB_LOG_LEVEL=silent
   * 静默掉的话，用户会拿着一个自己没见过的密码去登录，然后被挡在门外却查不到原因。
   * 代价是它必然出现在启动日志里，所以调用处必须同时提醒「别公开分享这段日志」。
   */
  notice: (message: string): void => {
    console.log(`[workhub][notice] ${message}`);
  },
};

/** 项目根目录：server/ 的上一级 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 日志里展示路径时优先给相对路径。
 *
 * 绝对路径会带出操作系统用户名目录（Windows 上是 C:\Users\xxx），
 * 而启动日志往往被原样贴进 issue 或公开仓库，等于顺带公开了本机目录结构。
 * 仓库内的路径给相对形式；仓库外的路径把家目录替换成 ~，其余原样保留
 * （用户显式指定了 WORKHUB_DB=/data/workhub-v2.db 这种路径时，他需要看到它才能找得到）。
 */
export function displayPath(target: string): string {
  const rel = relative(ROOT, target);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  const home = homedir();
  if (home && target.startsWith(home)) return `~${target.slice(home.length)}`;
  return target;
}
