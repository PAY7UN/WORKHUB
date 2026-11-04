/**
 * 「原件」与访问能力分级的测试。
 *
 * 这里守的是三件事：
 * 1. 上传一个 zip 只产生一个节点，不产生同名空笔记——文件不需要备注；
 * 2. 原件的字节原样存取，下载回来的东西与上传时一模一样；
 * 3. 访问能力默认只有「查看」，下载要显式授予；授权失效后立刻收口。
 *
 * 第 1 条一旦破了，树上就会长出「xxx.zip 的笔记」这种空壳，
 * 让人以为压缩包需要配一份说明才能用——这正是这次要消掉的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import db.ts 之前设好：db.ts 在模块顶层就打开数据库并建表
process.env.WORKHUB_SECRET ??= 'original-test-secret-not-for-production';
const workDir = mkdtempSync(join(tmpdir(), 'mdhub-original-'));
process.env.WORKHUB_DB = join(workDir, 'original.db');
// 原件字节落在 vault 里，测试必须指到临时目录，否则会污染真实的 data/vault
process.env.WORKHUB_VAULT_DIR = join(workDir, 'vault');

const {
  decryptBinaryDocRow,
  encryptBinaryDocRow,
  findActiveGrant,
  insertAccessGrant,
  insertAccessAudit,
  insertBinaryDoc,
  insertDoc,
  listAccessAudit,
  listAllDocs,
  parseCapabilities,
  readNodeBytes,
  readNodeRawBytes,
  serializeCapabilities,
} = await import('./db.ts');
const { createRepo } = await import('./repos.ts');
const { previewModeOf } = await import('../shared/files.ts');
const { MASTER_KEY } = await import('./db.ts');
const { decryptBytes, encryptBytes, unwrapDekWithMaster } = await import('./docCrypto.ts');

const repo = createRepo({ name: '原件测试仓库', createdBy: 'admin' });

/** 一个真实的 zip 头：PK\x03\x04，后面接几个字节 */
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x20, 0x41, 0x42]);

test('上传压缩包只产生一个原件节点，不生成同名笔记', () => {
  insertBinaryDoc({
    id: 'orig-zip',
    repoId: repo.id,
    name: '示例归档_20260101.zip',
    parentId: null,
    mime: 'application/zip',
    ext: '.zip',
    data: ZIP_BYTES,
    createdBy: 'admin',
  });

  const all = listAllDocs();
  const sameName = all.filter((d) => d.name === '示例归档_20260101.zip');
  assert.equal(sameName.length, 1, '同名节点应当只有一个：文件本身就是节点');

  const node = sameName[0];
  assert.equal(node.kind, 'file', '它必须是原件形态，而不是一篇笔记');
  assert.equal(node.ext, '.zip');
  assert.equal(node.mime, 'application/zip');
  assert.equal(node.size, ZIP_BYTES.length);
});

test('原件字节原样存取', () => {
  const bytes = readNodeBytes('orig-zip');
  assert.ok(bytes, '应当能读回原件字节');
  assert.deepEqual(bytes, ZIP_BYTES, '字节必须与上传时完全一致');
});

test('笔记节点不会被当成原件读出字节', () => {
  insertDoc({
    id: 'note-md',
    name: '说明.md',
    type: 'file',
    parentId: null,
    content: '# 正文',
    size: 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: 'admin',
    updatedBy: 'admin',
    tags: [],
    repoId: repo.id,
  });
  const note = listAllDocs().find((d) => d.id === 'note-md');
  assert.equal(note?.kind, 'note', '普通文档默认是笔记形态');
  assert.equal(readNodeBytes('note-md'), undefined, '笔记没有原件字节');
});

test('访问能力默认只有查看', () => {
  const grant = insertAccessGrant({
    id: 'g-default',
    docId: 'orig-zip',
    guestId: 'guest-a',
    guestName: '张三',
    grantedBy: 'admin',
    expiresAt: null,
  });
  assert.deepEqual(parseCapabilities(grant.capabilities), ['view'], '默认只给查看');
});

test('显式授予下载才会带上 download', () => {
  const grant = insertAccessGrant({
    id: 'g-download',
    docId: 'orig-zip',
    guestId: 'guest-b',
    guestName: '李四',
    grantedBy: 'admin',
    expiresAt: null,
    capabilities: ['view', 'download'],
  });
  assert.deepEqual(parseCapabilities(grant.capabilities), ['view', 'download']);
  const active = findActiveGrant('orig-zip', 'guest-b');
  assert.ok(active);
  assert.ok(parseCapabilities(active.capabilities).includes('download'));
});

test('能力值非法或缺失时降级为只读', () => {
  assert.deepEqual(parseCapabilities(null), ['view']);
  assert.deepEqual(parseCapabilities(''), ['view']);
  assert.deepEqual(parseCapabilities('not json'), ['view']);
  assert.deepEqual(parseCapabilities('[]'), ['view'], '一条都做不了的授权等于没有授权');
  assert.deepEqual(parseCapabilities('["delete"]'), ['view'], '不认的能力要丢掉');
  assert.deepEqual(parseCapabilities('["view","delete"]'), ['view']);
  // 存回去时也要清掉非法项
  assert.equal(serializeCapabilities(['view', 'delete' as never]), '["view"]');
  assert.equal(serializeCapabilities([]), '["view"]');
});

test('访问审计留痕，可按文档查询，新的在前', () => {
  insertAccessAudit({
    docId: 'orig-zip',
    action: 'request',
    actorId: 'guest-a',
    actorName: '张三',
    detail: '排查问题',
  });
  insertAccessAudit({
    docId: 'orig-zip',
    action: 'download',
    actorId: 'guest-a',
    actorName: '张三',
    detail: '下载原件',
  });
  insertAccessAudit({
    docId: 'note-md',
    action: 'open',
    actorId: 'guest-b',
    actorName: '李四',
  });

  const forZip = listAccessAudit('orig-zip');
  assert.equal(forZip.length, 2, '按文档过滤后只应有该文档的两条');
  assert.equal(forZip[0].action, 'download', '越近的越该排在前面');

  const all = listAccessAudit();
  assert.equal(all.length, 3);
  assert.ok(all.some((a) => a.doc_name), '流水应当带上文档名，便于直接读懂');
});

test('预览分档：图片/PDF/文本各走各的，其余给通用卡片', () => {
  assert.equal(previewModeOf('.png'), 'image');
  assert.equal(previewModeOf('.PDF'), 'pdf');
  assert.equal(previewModeOf('.md'), 'text');
  assert.equal(previewModeOf('.ts'), 'text');
  assert.equal(previewModeOf('.zip'), 'generic');
  assert.equal(previewModeOf('.docx'), 'generic', 'docx 是 zip 容器，不能当文本读');
});

test('加密原件：盘上不再有明文，解开后字节一模一样', () => {
  const material = encryptBytes(ZIP_BYTES, MASTER_KEY);
  assert.ok(encryptBinaryDocRow('orig-zip', material, 'admin'));

  // 盘上是密文：明文字节一个都搜不到
  const onDisk = readNodeRawBytes('orig-zip');
  assert.ok(onDisk);
  assert.ok(
    !onDisk.includes(ZIP_BYTES),
    '加密后的文件里不该还能找到明文字节——那只是给用户一个「它加密了」的错觉',
  );
  // 加密态下不能把盘上的东西当内容发出去
  assert.equal(readNodeBytes('orig-zip'), undefined, '加密态的原件不应被当成明文读出');

  // 解开后与原始字节完全一致
  const dek = unwrapDekWithMaster(material.masterWrappedDek, MASTER_KEY);
  assert.ok(dek);
  const plain = decryptBytes(onDisk.toString('utf8'), dek);
  assert.ok(plain);
  assert.deepEqual(plain, ZIP_BYTES);
});

test('取消加密：明文字节写回盘上，加密材料清空', () => {
  const material = encryptBytes(ZIP_BYTES, MASTER_KEY);
  encryptBinaryDocRow('orig-zip', material, 'admin');
  const onDisk = readNodeRawBytes('orig-zip');
  assert.ok(onDisk);
  const dek = unwrapDekWithMaster(material.masterWrappedDek, MASTER_KEY);
  assert.ok(dek);
  const plain = decryptBytes(onDisk.toString('utf8'), dek);
  assert.ok(plain);

  assert.ok(decryptBinaryDocRow('orig-zip', plain, 'admin'));
  assert.deepEqual(readNodeBytes('orig-zip'), ZIP_BYTES, '取消加密后应当能读回原始字节');
  const node = listAllDocs().find((d) => d.id === 'orig-zip');
  assert.equal(node?.encrypted, false);
});
