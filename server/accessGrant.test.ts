/**
 * 访问授权的判定规则测试。
 *
 * 这里守的是两条安全性质：**撤销即刻生效**、**到期自动失效**。
 * 任何一条被破坏，后果都是「我已经收回了权限，他还能继续看」——
 * 所以它们必须有回归测试，而不是只靠界面上的按钮看着像在工作。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import db.ts 之前设好：db.ts 在模块顶层就打开数据库并建表
process.env.WORKHUB_SECRET ??= 'grant-test-secret-not-for-production';
const workDir = mkdtempSync(join(tmpdir(), 'mdhub-grant-'));
process.env.WORKHUB_DB = join(workDir, 'grant.db');
// 正文落在 vault 里，测试必须指到临时目录，否则会污染真实的 data/vault
process.env.WORKHUB_VAULT_DIR = join(workDir, 'vault');

const {
  clearDocAccess,
  decideAccessRequest,
  findActiveGrant,
  findLatestRequest,
  findPendingRequest,
  insertAccessGrant,
  insertAccessRequest,
  insertDoc,
  listAccessGrants,
  revokeAccessGrant,
} = await import('./db.ts');
const { createRepo } = await import('./repos.ts');

const DOC_ID = 'doc-grant-test';

/** 文档必须有归属：先建一个仓库，文档才有地方放 */
const repo = createRepo({ name: '授权测试仓库', createdBy: 'admin' });

function ensureDoc() {
  insertDoc({
    id: DOC_ID,
    name: '授权测试文档',
    type: 'file',
    parentId: null,
    content: '正文',
    size: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: 'admin',
    updatedBy: 'admin',
    tags: [],
    repoId: repo.id,
  });
}

test('有效授权可被查到，撤销后立刻查不到', () => {
  ensureDoc();
  const grant = insertAccessGrant({
    id: 'g1',
    docId: DOC_ID,
    guestId: 'guest-a',
    guestName: '张三',
    grantedBy: 'admin',
    expiresAt: null,
  });
  assert.ok(findActiveGrant(DOC_ID, 'guest-a'), '有效期内的授权应当找得到');

  assert.equal(revokeAccessGrant(grant.id), true);
  assert.equal(findActiveGrant(DOC_ID, 'guest-a'), undefined, '撤销后必须立刻失效');
  assert.equal(revokeAccessGrant(grant.id), false, '重复撤销应当无事发生');
});

test('过期授权自动失效', () => {
  insertAccessGrant({
    id: 'g2',
    docId: DOC_ID,
    guestId: 'guest-b',
    guestName: '李四',
    grantedBy: 'admin',
    expiresAt: Date.now() - 1000,
  });
  assert.equal(findActiveGrant(DOC_ID, 'guest-b'), undefined, '过了期的授权不能算数');
});

test('授权只对本人有效', () => {
  insertAccessGrant({
    id: 'g3',
    docId: DOC_ID,
    guestId: 'guest-c',
    guestName: '王五',
    grantedBy: 'admin',
    expiresAt: null,
  });
  assert.ok(findActiveGrant(DOC_ID, 'guest-c'));
  assert.equal(findActiveGrant(DOC_ID, 'guest-d'), undefined, '别人的授权拿不到');
});

test('未决申请可识别，审批后不再算未决', () => {
  const req = insertAccessRequest({
    id: 'r1',
    docId: DOC_ID,
    guestId: 'guest-e',
    guestName: '赵六',
    reason: '排查问题',
  });
  assert.equal(findPendingRequest(DOC_ID, 'guest-e')?.id, req.id);
  assert.equal(findLatestRequest(DOC_ID, 'guest-e')?.status, 'pending');

  decideAccessRequest(req.id, 'approved', 'admin', null);
  assert.equal(findPendingRequest(DOC_ID, 'guest-e'), undefined, '批完就不该再挡着重复申请');
  assert.equal(findLatestRequest(DOC_ID, 'guest-e')?.status, 'approved');
});

test('取消加密后清空该文档的申请与授权', () => {
  insertAccessRequest({
    id: 'r2',
    docId: DOC_ID,
    guestId: 'guest-f',
    guestName: '孙七',
    reason: '',
  });
  insertAccessGrant({
    id: 'g4',
    docId: DOC_ID,
    guestId: 'guest-f',
    guestName: '孙七',
    grantedBy: 'admin',
    expiresAt: null,
  });
  assert.ok(listAccessGrants(DOC_ID).length > 0);

  clearDocAccess(DOC_ID);
  assert.equal(listAccessGrants(DOC_ID).length, 0, '授权应被清空');
  assert.equal(findPendingRequest(DOC_ID, 'guest-f'), undefined, '申请应被清空');
});
