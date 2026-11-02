/**
 * 登录限流的退避曲线与门禁判定。
 *
 * 这些是纯函数（只有文件末尾那组 API 包装涉及 Map），所以用注入的 now 穷举时间轴，
 * 不用 sleep——测试因此是确定性的，也不会拖慢套件。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearLoginFailures,
  evaluateGate,
  lockDurationMs,
  loginGate,
  nextRecord,
  noteLoginFailure,
  resetThrottleForTest,
} from './loginThrottle.ts';

test('前若干次失败不触发锁定', () => {
  assert.equal(lockDurationMs(0), 0);
  assert.equal(lockDurationMs(1), 0);
  assert.equal(lockDurationMs(5), 0);
});

test('超过阈值后锁定时长按指数增长', () => {
  // 第 6 次失败（阈值 5）首次锁定 2 秒，此后每多失败一次翻倍
  assert.equal(lockDurationMs(6), 2000);
  assert.equal(lockDurationMs(7), 4000);
  assert.equal(lockDurationMs(8), 8000);
  assert.equal(lockDurationMs(9), 16_000);
});

test('锁定时长封顶 5 分钟', () => {
  assert.equal(lockDurationMs(10), 32_000);
  assert.equal(lockDurationMs(50), 5 * 60 * 1000);
});

test('极端失败次数不溢出成 Infinity', () => {
  assert.equal(lockDurationMs(1000), 5 * 60 * 1000);
  assert.equal(lockDurationMs(Number.MAX_SAFE_INTEGER), 5 * 60 * 1000);
});

test('空记录始终放行', () => {
  assert.deepEqual(evaluateGate(undefined, 0), { allowed: true });
});

test('锁定期内拒绝并给出剩余秒数', () => {
  const record = { failures: 6, lastFailureAt: 1000, lockedUntil: 1000 + 4000 };
  const gate = evaluateGate(record, 2000);
  assert.equal(gate.allowed, false);
  assert.equal(gate.allowed === false && gate.retryAfterSeconds, 3);
});

test('剩余不足 1 秒时向上取整为 1，避免出现「还需 0 秒」却仍被拒', () => {
  const record = { failures: 6, lastFailureAt: 0, lockedUntil: 100 };
  const gate = evaluateGate(record, 99);
  assert.equal(gate.allowed, false);
  assert.equal(gate.allowed === false && gate.retryAfterSeconds, 1);
});

test('冷却结束后自动恢复放行', () => {
  const record = { failures: 6, lastFailureAt: 0, lockedUntil: 1000 };
  assert.equal(evaluateGate(record, 1000).allowed, true);
});

test('冷却结束后再失败从 1 重新计数，不累加旧账', () => {
  const afterLock = { failures: 6, lastFailureAt: 0, lockedUntil: 1000 };
  const fresh = nextRecord(afterLock, 5000);
  assert.equal(fresh.failures, 1);
  assert.equal(fresh.lockedUntil, 5000);
});

test('未冷却时失败次数持续累加', () => {
  let record = nextRecord(undefined, 0);
  assert.equal(record.failures, 1);
  record = nextRecord(record, 10);
  record = nextRecord(record, 20);
  assert.equal(record.failures, 3);
});

test('store 层：连续失败到阈值后同一 key 被拦截', () => {
  resetThrottleForTest();
  const key = '10.0.0.1';
  for (let i = 0; i < 5; i += 1) noteLoginFailure(key, 1000 + i);
  assert.equal(loginGate(key, 2000).allowed, true, '前 5 次不应锁定');
  noteLoginFailure(key, 2100);
  assert.equal(loginGate(key, 2200).allowed, false, '第 6 次后应锁定');
});

test('store 层：登录成功后失败计数被清空', () => {
  resetThrottleForTest();
  const key = '10.0.0.2';
  for (let i = 0; i < 6; i += 1) noteLoginFailure(key, 1000 + i);
  assert.equal(loginGate(key, 2000).allowed, false);
  clearLoginFailures(key);
  assert.equal(loginGate(key, 2000).allowed, true);
});

test('store 层：不同来源互不影响', () => {
  resetThrottleForTest();
  for (let i = 0; i < 6; i += 1) noteLoginFailure('10.0.0.3', 1000 + i);
  assert.equal(loginGate('10.0.0.3', 2000).allowed, false);
  assert.equal(loginGate('10.0.0.4', 2000).allowed, true);
});

test('store 层：长时间无失败后记录过期，不永久累积', () => {
  resetThrottleForTest();
  const key = '10.0.0.5';
  for (let i = 0; i < 6; i += 1) noteLoginFailure(key, 1000 + i);
  assert.equal(loginGate(key, 2000).allowed, false);
  // 超过 RECORD_TTL（30 分钟）后视为已遗忘
  assert.equal(loginGate(key, 2000 + 31 * 60 * 1000).allowed, true);
});
