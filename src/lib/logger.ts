/**
 * 前端日志出口。
 *
 * 与服务端日志的分工：服务端日志面向运维，需要分级、脱敏、可关停；
 * 前端日志面向使用者，它的价值只有一个——出问题时有据可查。
 *
 * 生产构建只保留 error：
 * - info / warn 属于内部状态变化（导入完成、服务端不可达等），对访客没有可操作性，
 *   留在控制台只会淹没真正的报错；
 * - error 必须留着：它是用户向维护者反馈问题时会附上的第一份材料。
 *
 * 打印前同样过一遍脱敏，避免把接口地址、令牌这类内部信息甩到访客眼前。
 */
import { redact } from '../../shared/redact';

type Level = 'error' | 'warn' | 'info' | 'debug';

/** 开发期全开，生产构建只留 error */
const isDev = import.meta.env.DEV;

function formatValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return redact(value);
  if (value === null || value === undefined) return String(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? redact(String(value)) : redact(json);
  } catch {
    return redact(String(value));
  }
}

function emit(level: Level, message: string, args: unknown[]): void {
  const parts = [`[workhub][${level}]`, redact(message)];
  for (const arg of args) parts.push(formatValue(arg));
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  error: (message: string, ...args: unknown[]): void => emit('error', message, args),
  warn: (message: string, ...args: unknown[]): void => {
    if (isDev) emit('warn', message, args);
  },
  info: (message: string, ...args: unknown[]): void => {
    if (isDev) emit('info', message, args);
  },
  debug: (message: string, ...args: unknown[]): void => {
    if (isDev) emit('debug', message, args);
  },
};
