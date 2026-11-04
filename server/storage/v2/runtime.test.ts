/**
 * 运行时行为测试：仓库化存储 + FTS5 检索。
 *
 * 这里测的不是「表建对没有」，而是「改了名字之后还找不找得到」
 * 「删掉之后有没有留下残骸」这类真会咬人的地方——
 * 存储模型的规矩最终要靠这些行为兑现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'workhub-rt-'));
process.env.WORKHUB_DB_V2 = join(workDir, 'test.db');
process.env.WORKHUB_VAULT_DIR = join(workDir, 'vault');
process.env.WORKHUB_SECRET = 'test-secret-for-runtime-cases-0123456789abcdef';

const { db, insertDoc, updateDocRow, detachSubtree, moveNodesToRepo, recallDocIds, recallAttachmentIds, searchDocs, listAllDocs, repoSlugOf, getDoc, encryptDocRow } = await import('../../db.ts');
const { createRepo, deleteRepo, getRepo } = await import('../../repos.ts');
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

/** 建一篇文档。归属仓库必填——这是 v2 的硬前提 */
function makeDoc(name: string, content: string, repoId: string, parentId: string | null = null) {
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
    repoId,
  });
}

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉不算失败
  }
});

test('每个文档都有仓库归属，库里没有「未归档」这种状态', () => {
  const repo = createRepo({ name: '归属测试仓库', createdBy: 'admin' });
  const doc = makeDoc('有主', '正文', repo.id);

  const row = db.prepare('SELECT repo_id FROM nodes WHERE id = ?').get(doc.id) as { repo_id: string };
  assert.equal(row.repo_id, repo.id);

  // repo_id 是 NOT NULL：不给归属的文档根本写不进去
  assert.throws(() => {
    db.prepare(
      `INSERT INTO nodes (id, repo_id, name, type, parent_id, path, size, content_hash, encrypted,
                          enc_master_dek, enc_locked_at, acl, tags, created_at, updated_at, created_by, updated_by)
       VALUES ('d-bad', NULL, 'x', 'file', NULL, 'x', 0, 'h', 0, NULL, NULL, '{}', NULL, 0, 0, 'u-admin', 'u-admin')`,
    ).run();
  });
});

test('改名字之后索引跟着改：按新名字搜得到，按旧名字搜不到', () => {
  const repo = createRepo({ name: '改名测试仓库', createdBy: 'admin' });
  const doc = makeDoc('旧名字', '正文里写的是真机调试流程', repo.id);

  assert.ok(searchDocs('旧名字').some((h) => h.id === doc.id), '改名前应能搜到');

  updateDocRow(doc.id, { name: '新名字' }, 'u-admin');

  assert.ok(searchDocs('新名字').some((h) => h.id === doc.id), '改名后应能按新名字搜到');
  assert.ok(
    !searchDocs('旧名字').some((h) => h.id === doc.id),
    '改名后不该再按旧名字搜到——索引里躺着旧名字就是脏数据',
  );
});

test('召回用「或」：只命中一部分词也能召回', () => {
  const repo = createRepo({ name: '召回测试仓库', createdBy: 'admin' });
  const doc = makeDoc('调试记录', '这里只提到了调试两个字', repo.id);

  // 精确匹配要求全部命中，这里查的词比正文多，精确匹配召不回
  const recalled = recallDocIds('真机调试');
  assert.ok(
    recalled.some((r) => r.id === doc.id),
    '召回应采用宽松匹配，不能因为少命中一个词就丢掉整篇',
  );
});

test('附件正文同样进索引，删附件后索引不留残骸', async () => {
  const repo = createRepo({ name: '附件索引仓库', createdBy: 'admin' });
  const doc = makeDoc('宿主文档', '宿主正文', repo.id);

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

test('跨仓库搬家后索引里的仓库归属跟着改', () => {
  const from = createRepo({ name: '来源仓库', createdBy: 'admin' });
  const to = createRepo({ name: '目标仓库', createdBy: 'admin' });
  const doc = makeDoc('搬家文档', '这里写的是支付对账', from.id);

  assert.ok(moveNodesToRepo([doc.id], to.id) === 1, '应搬动一篇');

  const row = db.prepare('SELECT repo_id FROM nodes WHERE id = ?').get(doc.id) as { repo_id: string };
  assert.equal(row.repo_id, to.id);

  const fts = db.prepare('SELECT repo_id FROM node_fts WHERE node_id = ?').get(doc.id) as
    | { repo_id: string }
    | undefined;
  assert.equal(fts?.repo_id, to.id, '索引里的仓库归属必须同步，否则按仓库检索会漏');
});

test('删除文档：正文文件与索引一起清掉，不留残骸', async () => {
  const repo = createRepo({ name: '删除测试仓库', createdBy: 'admin' });
  const doc = makeDoc('待删除', '这里写的是临时内容', repo.id);
  const row = db.prepare('SELECT path FROM nodes WHERE id = ?').get(doc.id) as { path: string };
  const bodyFile = bodyPath(repoSlugOf(repo.id), row.path, false);

  assert.ok(existsSync(bodyFile), '正文应已落到仓库目录里');

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
  const repo = createRepo({ name: '删目录测试仓库', createdBy: 'admin' });
  const folder = insertDoc({
    id: 'f-删目录',
    name: '待删目录',
    type: 'folder',
    parentId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    repoId: repo.id,
  });
  const child = makeDoc('子文档.md', '子文档的正文内容', repo.id, folder.id);

  const childRow = db.prepare('SELECT path FROM nodes WHERE id = ?').get(child.id) as { path: string };
  const childBody = bodyPath(repo.slug, childRow.path, false);
  const folderDir = folderDirs(repo.slug, '待删目录')[0];
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
  const repo = createRepo({ name: '目录改名仓库', createdBy: 'admin' });
  const folder = insertDoc({
    id: 'f-目录改名',
    name: '旧目录',
    type: 'folder',
    parentId: null,
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    repoId: repo.id,
  });
  const child = makeDoc('子文档.md', '子文档的正文内容', repo.id, folder.id);

  updateDocRow(folder.id, { name: '新目录' }, 'u-admin');

  const row = db.prepare('SELECT path FROM nodes WHERE id = ?').get(child.id) as { path: string };
  assert.equal(row.path, '新目录/子文档.md', '子文档路径应跟着前缀一起变');

  const body = bodyPath(repo.slug, row.path, false);
  assert.ok(existsSync(body), '子文档的正文文件应搬到新路径下——文件留在原地，打开就是空正文');
  assert.equal(readFileSafe(body), '子文档的正文内容');
});

test('跨仓库搬家：正文与附件都落到目标仓库的目录里', async () => {
  const from = createRepo({ name: '搬家源仓库', createdBy: 'admin' });
  const to = createRepo({ name: '搬入目标仓库', createdBy: 'admin' });
  const doc = makeDoc('搬家带附件.md', '搬家的正文', from.id);

  await addAttachment({
    docId: doc.id,
    name: '随行附件.txt',
    data: Buffer.from('附件的正文内容', 'utf8'),
    createdBy: 'u-admin',
  });

  moveNodesToRepo([doc.id], to.id);

  const body = bodyPath(to.slug, '搬家带附件.md', false);
  assert.ok(existsSync(body), '正文应落在目标仓库的目录里，而不是留在源仓库');

  const att = db.prepare('SELECT storage_key FROM attachments WHERE doc_id = ?').get(doc.id) as {
    storage_key: string;
  };
  assert.ok(
    att.storage_key.startsWith(`${to.slug}/assets/`),
    `附件的位置应指向目标仓库，实际是 ${att.storage_key}`,
  );
  assert.ok(
    existsSync(join(process.env.WORKHUB_VAULT_DIR!, att.storage_key)),
    '附件文件应落在目标仓库的目录里',
  );
});

test('搬走的文档不受原仓库删除的影响', () => {
  const from = createRepo({ name: '会被删掉的源仓库', createdBy: 'admin' });
  const to = createRepo({ name: '长期存在仓库', createdBy: 'admin' });
  const doc = makeDoc('独立文档.md', '搬过去之后还在', from.id);

  moveNodesToRepo([doc.id], to.id);
  deleteRepo(from.id);

  const after = getDoc(doc.id);
  assert.ok(after, '文档应仍在库里');
  assert.equal(after!.content, '搬过去之后还在', '原仓库删掉后，搬走的文档正文不该跟着消失');
});

test('单篇文档接口给正文，清单接口只给元数据', () => {
  const repo = createRepo({ name: '正文取用仓库', createdBy: 'admin' });
  const doc = makeDoc('要取正文的文档.md', '这里就是正文', repo.id);

  const listed = listAllDocs();
  const listedDoc = listed.find((d) => d.id === doc.id);
  assert.ok(listedDoc, '清单里应有这篇文档');
  assert.equal(
    listedDoc!.content,
    undefined,
    '清单不该带正文——一次列全站就等于把整个仓库读一遍',
  );

  const single = getDoc(doc.id);
  assert.ok(single, '单篇接口应取得到这篇文档');
  assert.equal(single!.content, '这里就是正文', '单篇接口应给出正文');
});

test('加密文档：接口里绝不能出现密文', () => {
  const repo = createRepo({ name: '加密文档仓库', createdBy: 'admin' });
  const doc = makeDoc('加密的文档.md', '加密前的明文', repo.id);
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

test('删仓库：目录删不掉时不能只删一半', () => {
  const repo = createRepo({ name: '删不掉的仓库', createdBy: 'admin' });
  makeDoc('目录删不掉时的文档', '正文内容', repo.id);
  const repoDir = join(process.env.WORKHUB_VAULT_DIR!, repo.slug);
  const bodyFile = bodyPath(repo.slug, '目录删不掉时的文档', false);
  assert.ok(existsSync(bodyFile));

  // 占住正文文件：Windows 上还开着的文件删不掉
  const fd = openSync(bodyFile, 'r');
  let failed = false;
  try {
    deleteRepo(repo.id);
  } catch {
    failed = true;
  } finally {
    closeSync(fd);
  }

  if (!failed) {
    // 平台允许删掉打开着的文件，这条分支在本地模拟不出来
    assert.equal(getRepo(repo.id), undefined, '删成功时仓库行就该没了');
    return;
  }

  assert.ok(getRepo(repo.id), '目录删不掉时仓库行必须留下——只删一半最糟：既查不到，也没法重试');
  assert.ok(existsSync(repoDir), '目录还在就不该把仓库行删了');

  // 收拾干净：文件不占着了，这次该删得掉
  deleteRepo(repo.id);
  assert.equal(getRepo(repo.id), undefined);
  assert.ok(!existsSync(repoDir), '目录删得掉时就不该留下残骸');
});

test('删仓库：目录整个清掉，索引一并清空', async () => {
  const repo = createRepo({ name: '待删仓库', createdBy: 'admin' });
  const doc = makeDoc('仓库里的文档', '这里写的是仓库级内容', repo.id);
  await addAttachment({
    docId: doc.id,
    name: '附件.txt',
    data: Buffer.from('附件里的文字', 'utf8'),
    createdBy: 'u-admin',
  });

  const repoDir = join(process.env.WORKHUB_VAULT_DIR!, repo.slug);
  assert.ok(existsSync(repoDir), '仓库目录应已建立');

  const res = deleteRepo(repo.id);

  assert.equal(res.removed, true);
  assert.equal(res.docs, 1);
  assert.equal(res.attachments, 1);
  assert.equal(getRepo(repo.id), undefined, '仓库本身应已删除');
  assert.ok(!existsSync(repoDir), '仓库目录应整个删掉——留在盘上就是没人认领的残骸');
  assert.ok(
    !db.prepare('SELECT 1 FROM node_fts WHERE repo_id = ?').get(repo.id),
    '索引里不该还留着这个仓库的条目',
  );
  assert.ok(
    !db.prepare('SELECT 1 FROM attachment_fts WHERE repo_id = ?').get(repo.id),
    '附件索引里不该还留着这个仓库的条目',
  );
});
