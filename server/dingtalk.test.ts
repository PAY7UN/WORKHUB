/**
 * 钉钉接入层的单元测试。
 *
 * 覆盖的核心性质：
 *   1. 加签与钉钉规定的算法逐字一致（待签名串的换行、用哪个密钥、编码方式）
 *   2. 加签地址能原样还原签名（Base64 里的 + / = 不会被 query 解析坏）
 *   3. 重复规则按「原定时刻」顺延，而不是按自然日边界漂移
 *   4. 月末不溢出（1 月 31 日顺延到 2 月 28 日，而不是 3 月 3 日）
 *   5. 停机期间错过的重复提醒不补发（一次停机不响三遍）
 *   6. 推送文案带齐标题、正文、时间、关联文档与回跳链接
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import {
  buildWebhookUrl,
  computeNextFireAt,
  computeNextFutureFireAt,
  formatReminderText,
  signWebhook,
} from './dingtalk.ts';
import type { DingTalkConfig, Reminder } from '../shared/types.ts';

const WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=abc123';

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r1',
    title: '发布前检查清单',
    content: '确认文档已同步到钉钉',
    remindAt: new Date(2026, 0, 31, 9, 0, 0).getTime(),
    repeat: 'once',
    channel: 'webhook',
    status: 'pending',
    docId: 'doc-1',
    docName: '发布说明.md',
    createdAt: new Date(2026, 0, 1).getTime(),
    createdBy: 'u-admin',
    firedAt: null,
    doneAt: null,
    lastError: '',
    fireCount: 0,
    todoId: '',
    ...overrides,
  };
}

const CONFIG: DingTalkConfig = {
  enabled: true,
  channel: 'webhook',
  webhookUrl: WEBHOOK,
  webhookSecret: '',
  appKey: '',
  appSecret: '',
  robotCode: '',
  userIds: [],
  unionId: '',
  executorIds: [],
  todoBaseUrl: '',
};

test('加签按钉钉规定计算：待签名串是 timestamp + 换行 + secret', () => {
  const secret = 'SECabc123';
  const timestamp = 1598065300371;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`, 'utf8')
    .digest('base64');
  assert.equal(signWebhook(secret, timestamp), expected);

  // 换行必须是 \n：换成 \r\n 会被钉钉判为 sign not match，而钉钉不会告诉你差在哪
  const crlf = createHmac('sha256', secret)
    .update(`${timestamp}\r\n${secret}`, 'utf8')
    .digest('base64');
  assert.notEqual(signWebhook(secret, timestamp), crlf);
});

test('同一密钥不同时间戳的加签不同（钉钉按时间戳防重放）', () => {
  const secret = 'SECabc123';
  assert.notEqual(signWebhook(secret, 1598065300371), signWebhook(secret, 1598065300372));
});

test('加签地址带上 timestamp 与 sign，且签名能原样还原', () => {
  const secret = 'SECabc123';
  const url = buildWebhookUrl(WEBHOOK, secret, 1598065300371);
  const parsed = new URL(url);

  // 原有的 access_token 不能丢
  assert.equal(parsed.searchParams.get('access_token'), 'abc123');
  assert.equal(parsed.searchParams.get('timestamp'), '1598065300371');
  // Base64 里的 + / = 若被原样拼进 query 会被解析坏；用 URL 接口拼才能原样还原
  assert.equal(parsed.searchParams.get('sign'), signWebhook(secret, 1598065300371));
});

test('没配加签密钥时不带 timestamp 与 sign', () => {
  const url = buildWebhookUrl(WEBHOOK, '', 1598065300371);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('access_token'), 'abc123');
  assert.equal(parsed.searchParams.get('timestamp'), null);
  assert.equal(parsed.searchParams.get('sign'), null);
});

test('仅一次的提醒没有下一次', () => {
  const base = new Date(2026, 0, 31, 9, 0, 0).getTime();
  assert.equal(computeNextFireAt('once', base), null);
});

test('每天 / 每周按原定时刻顺延', () => {
  const base = new Date(2026, 0, 31, 9, 30, 0).getTime();
  assert.equal(computeNextFireAt('daily', base), new Date(2026, 1, 1, 9, 30, 0).getTime());
  assert.equal(computeNextFireAt('weekly', base), new Date(2026, 1, 7, 9, 30, 0).getTime());
});

test('每月的月末不溢出到下个月', () => {
  // 1 月 31 日 → 2 月 28 日（2026 非闰年），而不是 setMonth 直接溢出成 3 月 3 日
  const base = new Date(2026, 0, 31, 9, 0, 0).getTime();
  const next = computeNextFireAt('monthly', base);
  assert.ok(next !== null);
  const d = new Date(next);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 1);
  assert.equal(d.getDate(), 28);
  assert.equal(d.getHours(), 9);
});

test('停机期间错过的重复提醒不补发：一次只前推到未来', () => {
  const base = new Date(2026, 0, 31, 9, 0, 0).getTime();
  // 服务停了 3 天才回来
  const now = base + 3 * 24 * 60 * 60 * 1000;
  const next = computeNextFutureFireAt('daily', base, now);
  assert.ok(next !== null);
  assert.ok(next > now, '下一次触发时间必须落在现在之后');
  // 只跳过停机期间的那几次，不是一路跳到很久以后
  assert.ok(next <= base + 4 * 24 * 60 * 60 * 1000);
});

test('推送文案带齐标题、正文、时间、文档名与回跳链接', () => {
  const reminder = makeReminder();
  const { title, text } = formatReminderText(reminder, {
    ...CONFIG,
    todoBaseUrl: 'http://192.168.1.10:5173',
  });

  assert.equal(title, '发布前检查清单');
  assert.ok(text.includes('发布前检查清单'));
  assert.ok(text.includes('确认文档已同步到钉钉'));
  assert.ok(text.includes('2026-01-31 09:00'));
  assert.ok(text.includes('发布说明.md'));
  assert.ok(text.includes('http://192.168.1.10:5173/?doc=doc-1'));
});

test('没配跳转地址时文案里不含链接', () => {
  const { text } = formatReminderText(makeReminder(), CONFIG);
  assert.ok(!text.includes('打开文档'));
});
