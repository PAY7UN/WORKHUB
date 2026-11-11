'use strict';
/**
 * 把单元测试的失败摘要写成 GitHub 注解。
 *
 * 为什么要有这个脚本：CI 日志动辄几百 MB，翻目录找「哪条用例挂了」很累；
 * 而 GitHub 注解在 API 里是公开可读的（不用登录也能取），
 * 一眼就能看见失败用例和它的错误。
 *
 * 用法：node scripts/ci/test-failure-summary.mjs <测试日志路径>
 *
 * 输出的就是一行 GitHub 工作流命令：
 *   ::error title=单元测试失败::<内容>
 */
import { readFileSync } from 'node:fs';

const logPath = process.argv[2];
if (!logPath) {
  console.error('用法：node scripts/ci/test-failure-summary.mjs <测试日志路径>');
  process.exit(2);
}

let log = '';
try {
  log = readFileSync(logPath, 'utf8');
} catch (err) {
  console.error(`读不到测试日志：${logPath}（${err?.message ?? err}）`);
  process.exit(2);
}

const lines = log.split(/\r?\n/);

/**
 * 挑出失败用例及其后面的十几行。
 *
 * node --test 的两种输出格式都认：
 * - spec 格式（默认）：失败行以 '✖' 开头
 * - TAP 格式：失败行以 'not ok' 开头
 */
const picked = [];
for (let i = 0; i < lines.length; i += 1) {
  if (/^(not ok|✖)/.test(lines[i])) {
    picked.push(...lines.slice(i, i + 14), '---');
  }
}

if (picked.length === 0) {
  // 没认出失败行：宁可把日志尾巴给出去，也别让人对着空注解猜
  picked.push(...lines.slice(-40));
}

const message = picked
  .slice(0, 160)
  .join('\n')
  .replaceAll('%', '%25')
  .replaceAll('\r', '')
  .replaceAll('\n', '%0A');

console.log(`::error title=单元测试失败::${message}`);
