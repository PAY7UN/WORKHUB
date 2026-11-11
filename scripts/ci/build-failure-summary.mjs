'use strict';
/**
 * 把打包失败的日志摘要写成 GitHub 注解。
 *
 * 用法：node scripts/ci/build-failure-summary.mjs <日志路径> [标题]
 *
 * 为什么要有这个脚本：
 * - 注解在 API 里公开可读（不用登录），比翻几百 MB 的 CI 日志省事得多；
 * - 注解有格式要求：换行要写成 %0A、% 要写成 %25，超长会被整条丢掉，
 *   手写转义十有八九会踩坑（上一版就是这样，注解发不出去，失败原因全黑）；
 * - electron-builder 末尾常跟着一长串 duplicate dependency references 告警，
 *   一行几万字符，把真正的错误整个盖住——摘要时要先把噪音剔掉。
 */
import { readFileSync } from 'node:fs';

const logPath = process.argv[2];
const title = process.argv[3] ?? '打包失败';
if (!logPath) {
  console.error('用法：node scripts/ci/build-failure-summary.mjs <日志路径> [标题]');
  process.exit(2);
}

let log = '';
try {
  log = readFileSync(logPath, 'utf8');
} catch (err) {
  console.error(`读不到构建日志：${logPath}（${err?.message ?? err}）`);
  process.exit(2);
}

/** 噪音行：重复依赖告警，一行极长 */
const NOISE = /duplicate dependency references/;

const lines = log.split(/\r?\n/).map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
const meaningful = lines.filter((line) => line.trim() && !NOISE.test(line));

/** 真正的错误行优先：electron-builder 的失败信息都以 ⨯ 开头 */
const errors = meaningful.filter((line) => /⨯|error|ERR!/.test(line));
const source = errors.length >= 3 ? [...errors, ...meaningful] : meaningful.length >= 6 ? meaningful : lines;

const body = source
  .filter((line) => line.trim())
  .slice(-25)
  .join('\n');

/**
 * GitHub 注解的转义：
 * 换行 %0A、百分号 %25、回车 %0D，冒号与逗号在消息体里不必转义。
 * 整条注解还有长度上限（65536 字符），超了整条会被丢掉——
 * 所以这里自己截断，别指望 GitHub 帮忙截。
 */
const encoded = body
  .replaceAll('%', '%25')
  .replaceAll('\r', '%0D')
  .replaceAll('\n', '%0A')
  .slice(0, 60_000);

console.log(`::error title=${title}::${encoded}`);
