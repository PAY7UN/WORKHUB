/**
 * 日志级别的开关行为。
 *
 * 单独一个测试文件：WORKHUB_LOG_LEVEL 在模块加载时读取一次，
 * 改环境变量必须发生在 import 之前，所以这里用动态 import 而不是静态 import。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.WORKHUB_LOG_LEVEL = 'silent';
const { logger } = await import('./logger.ts');

/** 捕获 console 输出，返回打印出来的所有行 */
function capture(run: () => void): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => {
    lines.push(String(msg));
  };
  console.error = (msg: string) => {
    lines.push(String(msg));
  };
  try {
    run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines;
}

test('silent 级别下 info 与 error 都不打印', () => {
  const lines = capture(() => {
    logger.info('普通信息');
    logger.error('普通错误');
  });
  assert.equal(lines.length, 0);
});

test('silent 级别下 notice 与 fatal 仍打印', () => {
  const lines = capture(() => {
    logger.notice('凭证必须出现');
    logger.fatal('致命必须出现');
  });
  assert.ok(lines.some((l) => l.includes('凭证必须出现')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('致命必须出现')), lines.join('\n'));
});

test('notice 逐字输出，不被脱敏规则改写', () => {
  const lines = capture(() => {
    logger.notice('新密码：sk-abcdefghijklmnop');
  });
  assert.ok(lines[0].includes('sk-abcdefghijklmnop'), lines[0]);
});
