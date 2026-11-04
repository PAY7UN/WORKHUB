/**
 * 日志脱敏与路径展示。
 *
 * 脱敏是这套日志设施里唯一「出错会造成不可逆后果」的一环——密钥进了日志，
 * 就等于跟着日志一起公开了。因此这里逐条钉住容易漏的形态，而不是只测一个 happy path。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { redact } from '../shared/redact.ts';
import { displayPath, formatValue } from './logger.ts';

test('Authorization 头里的令牌被抹掉', () => {
  const out = redact('Authorization: Bearer abcdef1234567890');
  assert.ok(!out.includes('abcdef1234567890'), out);
  assert.match(out, /Bearer \*\*\*/);
});

test('JSON 形态的 apiKey 被抹掉', () => {
  const out = redact('{"apiKey":"sk-abcdefghijklmnop","model":"m1"}');
  assert.ok(!out.includes('abcdefghijklmnop'), out);
  assert.match(out, /"model":"m1"/);
});

test('query 形态的 password 被抹掉', () => {
  const out = redact('/reset?password=hunter2xxx&user=admin');
  assert.ok(!out.includes('hunter2xxx'), out);
  assert.match(out, /user=admin/);
});

test('裸露的 sk- 密钥被抹掉', () => {
  const out = redact('key is sk-abcdefghijklmnop here');
  assert.ok(!out.includes('abcdefghijklmnop'), out);
});

test('JWT 被抹掉', () => {
  const out = redact('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef');
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), out);
});

test('普通文本不被误伤', () => {
  const text = 'token 用量记录失败：数据库连接被拒绝';
  assert.equal(redact(text), text);
});

test('URL 里的 userinfo 密码被抹掉，用户名保留', () => {
  const out = redact('接口地址 https://alice:sup3rsecret@api.example.com/v1');
  assert.ok(!out.includes('sup3rsecret'), out);
  assert.match(out, /alice:\*\*\*@api\.example\.com/);
});

test('不含 userinfo 的 URL 不受影响', () => {
  const text = 'http://localhost:8787';
  assert.equal(redact(text), text);
});

test('错误对象格式化为「类型: 文案」', () => {
  assert.equal(formatValue(new TypeError('坏了')), 'TypeError: 坏了');
});

test('对象入参序列化后同样脱敏', () => {
  const out = formatValue({ apiKey: 'sk-abcdefghijklmnop', model: 'm1' });
  assert.ok(!out.includes('abcdefghijklmnop'), out);
});

test('仓库内路径给相对形式，不带本机用户名目录', () => {
  assert.equal(displayPath(resolve(import.meta.dirname, '../data/workhub-v2.db')), 'data/workhub-v2.db');
});
