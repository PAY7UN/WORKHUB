/**
 * 运行时行为测试：vault 存储 + FTS5 检索。
 *
 * 这里测的不是「表建对没有」，而是「改了名字之后还找不找得到」
 * 「删掉之后有没有留下残骸」这类真会咬人的地方——
 * 存储模型的规矩最终要靠这些行为兑现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'workhub-rt-'));
process.env.WORKHUB_DB_V2 = join(workDir, 'test.db');
process.env.WORKHUB_VAULT_DIR = join(workDir, 'vault');
process.env.WORKHUB_SECRET = 'test-secret-for-runtime-cases-0123456789abcdef';

const { db, insertDoc, updateDocRow, detachSubtree, recallDocIds, recallAttachmentIds, searchDocs, listAllDocs, getDoc, encryptDocRow } = await import('../../db.ts');
const { addAttachment, removeAttachment, listAttachments } = await import('../../attachments.ts');
const { bodyPath, readFileSafe, stashFile, purgeStashed, folderDirs } = await import('./vault.ts');

/** 等文件真的被清掉：清道夫在别的线程上干活，得给它一点时间 */
async function waitGone(paths: string[], timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((p) => !existsSync(p))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`暂存文件没被清掉：${paths.join('、')}`);
}

const now = Date.now();

/** 建一篇文档 */
function makeDoc(name: string, content: string, parentId: string | null = null) {
  return insertDoc({
    id: `d-${name}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    type: 'file',
    parentId,
    content,
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
  });
}

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉不算失败
  }
});

test('文档路径全局唯一：同名文档在不同目录下互不覆盖', () => {
  const folder = insertDoc({
    id: 'f-同名',
    name: '同名目录',
    type: 'folder',
    parentId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
  });
  const a = makeDoc('同名.md', '第一篇的正文');
  const b = makeDoc('同名.md', '第二篇的正文', folder.id);

  const pathA = db.prepare('SELECT path FROM nodes WHERE id = ?').get(a.id) as { path: string };
  const pathB = db.prepare('SELECT path FROM nodes WHERE id = ?').get(b.id) as { path: string };
  assert.notEqual(pathA.path, pathB.path, '路径撞了就会互相覆盖正文');
  assert.ok(existsSync(bodyPath(pathA.path, false)));
  assert.ok(existsSync(bodyPath(pathB.path, false)));
});

test('改名字之后索引跟着改：按新名字搜得到，按旧名字搜不到', () => {
  const doc = makeDoc('旧名字', '正文里写的是真机调试流程');

  assert.ok(searchDocs('旧名字').some((h) => h.id === doc.id), '改名前应能搜到');

  updateDocRow(doc.id, { name: '新名字' }, 'u-admin');

  assert.ok(searchDocs('新名字').some((h) => h.id === doc.id), '改名后应能按新名字搜到');
  assert.ok(
    !searchDocs('旧名字').some((h) => h.id === doc.id),
    '改名后不该再按旧名字搜到——索引里躺着旧名字就是脏数据',
  );
});

test('召回用「或」：只命中一部分词也能召回', () => {
  const doc = makeDoc('调试记录', '这里只提到了调试两个字');

  // 精确匹配要求全部命中，这里查的词比正文多，精确匹配召不回
  const recalled = recallDocIds('真机调试');
  assert.ok(
    recalled.some((r) => r.id === doc.id),
    '召回应采用宽松匹配，不能因为少命中一个词就丢掉整篇',
  );
});

test('附件正文同样进索引，删附件后索引不留残骸', async () => {
  const doc = makeDoc('宿主文档', '宿主正文');

  const att = await addAttachment({
    docId: doc.id,
    name: '会议纪要.txt',
    data: Buffer.from('本次会议讨论了真机调试的排期安排', 'utf8'),
    createdBy: 'u-admin',
  });

  const recalled = recallAttachmentIds('真机调试');
  assert.ok(recalled.some((r) => r.id === att.id), '附件正文应能被召回');

  assert.equal(listAttachments(doc.id).length, 1);
  assert.ok(removeAttachment(att.id), '附件应被删除');
  assert.equal(listAttachments(doc.id).length, 0);
  assert.ok(
    !recallAttachmentIds('真机调试').some((r) => r.id === att.id),
    '附件删了，索引里不该还留着它的条目',
  );
});

test('删除文档：正文文件与索引一起清掉，不留残骸', async () => {
  const doc = makeDoc('待删除', '这里写的是临时内容');
  const row = db.prepare('SELECT path FROM nodes WHERE id = ?').get(doc.id) as { path: string };
  const bodyFile = bodyPath(row.path, false);

  assert.ok(existsSync(bodyFile), '正文应已落到 vault 里');

  // 走的正是接口那条路：摘库 → 改名进暂存区 → 清道夫线程去删
  const { removed, files } = detachSubtree(doc.id);
  const stashed = files.map(stashFile).filter((p): p is string => !!p);
  assert.equal(removed, 1, '应摘掉这一篇');
  assert.ok(!existsSync(bodyFile), '删除后正文文件不该还在原处');
  assert.ok(stashed.length > 0, '正文应被挪进暂存区');

  purgeStashed(stashed);
  await waitGone(stashed);

  assert.ok(
    !db.prepare('SELECT 1 FROM node_fts WHERE node_id = ?').get(doc.id),
    '删除后索引里不该还留着条目',
  );
  assert.ok(
    !listAllDocs().some((d) => d.id === doc.id),
    '删除后清单里不该还有它',
  );
});

test('删掉文件夹：文件没了，目录也不留空壳', async () => {
  const folder = insertDoc({
    id: 'f-删目录',
    name: '待删目录',
    type: 'folder',
    parentId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
  });
  const child = makeDoc('子文档.md', '子文档的正文内容', folder.id);

  const childRow = db.prepare('SELECT path FROM nodes WHERE id = ?').get(child.id) as { path: string };
  const childBody = bodyPath(childRow.path, false);
  const folderDir = folderDirs(childRow.path)[0];
  assert.ok(existsSync(childBody), '子文档的正文文件应已落盘');
  assert.ok(existsSync(folderDir), '目录应已建出来');

  const { removed, files, dirs } = detachSubtree(folder.id);
  const stashed = files.map(stashFile).filter((p): p is string => !!p);
  assert.equal(removed, 2, '目录连同子文档应一并摘掉');
  assert.ok(dirs.length > 0, '该记下要收拾的空目录');

  purgeStashed(stashed, dirs);
  await waitGone(stashed);
  // 目录得等文件删干净才摘得掉
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && existsSync(folderDir)) {
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.ok(!existsSync(folderDir), '删掉的目录不该在盘上留个空壳');
  assert.ok(!listAllDocs().some((d) => d.id === child.id), '子文档也不该还在清单里');
});

test('改名目录后，子文档的正文文件跟着搬家', () => {
  const folder = insertDoc({
    id: 'f-目录改名',
    name: '旧目录',
    type: 'folder',
    parentId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
  });
  const child = makeDoc('子文档.md', '子文档的正文内容', folder.id);

  updateDocRow(folder.id, { name: '新目录' }, 'u-admin');

  const row = db.prepare('SELECT path FROM nodes WHERE id = ?').get(child.id) as { path: string };
  assert.equal(row.path, '新目录/子文档.md', '子文档路径应跟着前缀一起变');

  const body = bodyPath(row.path, false);
  assert.ok(existsSync(body), '子文档的正文文件应搬到新路径下——文件留在原地，打开就是空正文');
  assert.equal(readFileSafe(body), '子文档的正文内容');
});

test('附件的位置跟着宿主文档走', async () => {
  const doc = makeDoc('带附件的文档.md', '正文');

  await addAttachment({
    docId: doc.id,
    name: '随行附件.txt',
    data: Buffer.from('附件的正文内容', 'utf8'),
    createdBy: 'u-admin',
  });

  const att = db.prepare('SELECT storage_key FROM attachments WHERE doc_id = ?').get(doc.id) as {
    storage_key: string;
  };
  assert.ok(
    att.storage_key.startsWith('assets/'),
    `附件的位置应指向 vault 的 assets，实际是 ${att.storage_key}`,
  );
  assert.ok(
    existsSync(join(process.env.WORKHUB_VAULT_DIR!, att.storage_key)),
    '附件文件应落在 vault 里',
  );
});

test('单篇文档接口给正文，清单接口只给元数据', () => {
  const doc = makeDoc('要取正文的文档.md', '这里就是正文');

  const listed = listAllDocs();
  const listedDoc = listed.find((d) => d.id === doc.id);
  assert.ok(listedDoc, '清单里应有这篇文档');
  assert.equal(
    listedDoc!.content,
    undefined,
    '清单不该带正文——一次列全站就等于把整个 vault 读一遍',
  );

  const single = getDoc(doc.id);
  assert.ok(single, '单篇接口应取得到这篇文档');
  assert.equal(single!.content, '这里就是正文', '单篇接口应给出正文');
});

test('加密文档：接口里绝不能出现密文', () => {
  const doc = makeDoc('加密的文档.md', '加密前的明文');
  const material = {
    cipher: 'BASE64密文占位',
    masterWrappedDek: 'wrapped-dek',
  };

  encryptDocRow(doc.id, material, 'u-admin');

  const single = getDoc(doc.id);
  assert.ok(single, '加密文档仍应取得到');
  assert.equal(single!.encrypted, true);
  assert.equal(
    single!.content,
    undefined,
    '加密文档不能带「正文」——密文不是正文，接口里塞它等于把密文发出去',
  );
  const listed = listAllDocs().find((d) => d.id === doc.id);
  assert.equal(listed?.content, undefined, '清单里同样不该出现密文');
});
