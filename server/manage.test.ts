/**
 * 机器令牌与重启策略的回归测试。
 *
 * 用临时库，不碰真实数据：真实库里的令牌是运维手上的钥匙，
 * 测试往里写一条又删掉，等于在真钥匙上做实验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'mdhub-manage-test-'));

const { openV2Db } = await import('./storage/v2/schema.ts');
const { issueManageToken, verifyManageToken, listManageTokens, revokeManageToken, revokeUnusedByLabel } =
  await import('./manageTokens.ts');
const { planRestart } = await import('./manage.ts');

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉就留着，不影响断言
  }
});

function freshDb() {
  return openV2Db(join(workDir, `t-${Math.random().toString(36).slice(2)}.db`));
}

test('发放的令牌能通过校验', () => {
  const db = freshDb();
  try {
    const issued = issueManageToken(db, '运维笔记本');
    assert.ok(issued.token.startsWith('mht_'), '令牌应带可识别的前缀');

    const verified = verifyManageToken(db, issued.token);
    assert.ok(verified, '刚发的令牌应当有效');
    assert.equal(verified?.id, issued.id);
    assert.equal(verified?.label, '运维笔记本');
  } finally {
    db.close();
  }
});

test('库里不存明文令牌', () => {
  const db = freshDb();
  try {
    const issued = issueManageToken(db, '只存哈希');
    const row = db
      .prepare('SELECT token_hash FROM manage_tokens WHERE id = ?')
      .get(issued.id) as { token_hash: string };
    assert.notEqual(row.token_hash, issued.token, '库里存的必须是哈希');
    assert.ok(!String(row.token_hash).includes(issued.token), '哈希里不应含明文');
  } finally {
    db.close();
  }
});

test('错令牌、撤销后的令牌都不通过', () => {
  const db = freshDb();
  try {
    const issued = issueManageToken(db, '待撤销');
    assert.equal(verifyManageToken(db, 'mht_根本没发过'), null, '没发过的令牌不能通过');
    assert.equal(verifyManageToken(db, ''), null, '空令牌不能通过');

    assert.equal(revokeManageToken(db, issued.id), true, '首次撤销应成功');
    assert.equal(verifyManageToken(db, issued.token), null, '撤销后立即失效');
    assert.equal(revokeManageToken(db, issued.id), false, '重复撤销应告知没变化');
  } finally {
    db.close();
  }
});

test('撤销是标记而不是删除：还能看出它存在过', () => {
  const db = freshDb();
  try {
    const issued = issueManageToken(db, '留痕');
    revokeManageToken(db, issued.id);
    const listed = listManageTokens(db);
    const row = listed.find((item) => item.id === issued.id);
    assert.ok(row, '撤销后这条记录仍应存在');
    assert.ok(row?.revoked_at, '撤销时间应被记下');
  } finally {
    db.close();
  }
});

test('校验会记下最近使用时间', () => {
  const db = freshDb();
  try {
    const issued = issueManageToken(db, '用过的');
    assert.equal(issued.last_used_at, null);
    const verified = verifyManageToken(db, issued.token);
    assert.ok(verified?.last_used_at, '用过之后应记下时间');
  } finally {
    db.close();
  }
});

test('重启策略：显式命令优先，其次守护进程，最后自己拉起', () => {
  // 1. 运维指定了命令 → 用命令
  assert.equal(planRestart({ MDHUB_RESTART_CMD: 'systemctl restart workhub' }).strategy, 'command');

  // 2. 认得出守护进程 → 退出即可，守护进程会接手
  assert.equal(planRestart({ INVOCATION_ID: 'abc' }).strategy, 'supervisor');
  assert.equal(planRestart({ PM2_HOME: '/root/.pm2' }).strategy, 'supervisor');

  // 3. 都没有 → 自己再起一个
  assert.equal(planRestart({}).strategy, 'self');
});

test('清理只动从未用过的令牌：用过的要人来确认', () => {
  const db = freshDb();
  try {
    const unused = issueManageToken(db, 'windows service');
    const used = issueManageToken(db, 'windows service');
    const other = issueManageToken(db, '别的用途');
    // 用过的那把：有 last_used_at
    verifyManageToken(db, used.token);

    const revoked = revokeUnusedByLabel(db, 'windows service');
    assert.deepEqual(revoked, [unused.id], '只该撤销同标签且从未用过的那把');

    assert.equal(verifyManageToken(db, unused.token), null, '没用过的应被撤销');
    assert.ok(verifyManageToken(db, used.token), '用过的不能顺手撤销');
    assert.ok(verifyManageToken(db, other.token), '别的标签不受影响');

    // 重复清理不应重复撤销
    assert.deepEqual(revokeUnusedByLabel(db, 'windows service'), [], '已撤销的不应再出现');
  } finally {
    db.close();
  }
});
