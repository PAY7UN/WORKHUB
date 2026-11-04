/**
 * 宿主环境的单测：版本号与「谁在管着这个进程」。
 *
 * 这个判断以前在 manage.ts 和 updater.ts 里各写了一份。
 * 两边答案不一致的后果只有两种，都很难查：起两个进程抢同一个端口，
 * 或者一个都不起（服务就这么没了）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentVersion, detectSupervisor, isSupervisedByTray } from './host.ts';

test('版本号：读 package.json', () => {
  const version = currentVersion();
  assert.notEqual(version, 'unknown');
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test('版本号：读不到就报 unknown，不抛错', () => {
  // 版本号是给人看的（升级界面、状态接口），读不到不影响功能，
  // 不该因为它把整个状态接口带崩
  assert.equal(currentVersion('/nonexistent-path-for-test'), 'unknown');
});

test('托管方式：认得出 systemd 与 pm2', () => {
  assert.equal(detectSupervisor({ INVOCATION_ID: 'abc' }), 'systemd');
  assert.equal(detectSupervisor({ PM2_HOME: '/root/.pm2' }), 'pm2');
  assert.equal(detectSupervisor({ pm_id: '3' }), 'pm2');
});

test('托管方式：没人管就是 null', () => {
  assert.equal(detectSupervisor({}), null);
});

test('托管方式：systemd 优先于 pm2', () => {
  // 两个都可能同时成立，按固定顺序取，结果才稳定
  assert.equal(detectSupervisor({ INVOCATION_ID: 'abc', PM2_HOME: '/root/.pm2' }), 'systemd');
});

test('托盘托管：看 WORKHUB_PARENT_PID', () => {
  assert.equal(isSupervisedByTray({ WORKHUB_PARENT_PID: '1234' }), true);
  assert.equal(isSupervisedByTray({}), false);
});
