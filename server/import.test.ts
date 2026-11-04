/**
 * 覆盖式导入的安全性测试。
 *
 * 导入是「全量替换」：整个资料库被换成导入的这一批。
 * 所以它必须全有或全无——中途失败绝不能留下一个「库空了」的残局。
 *
 * 这里锁的是三条底线：
 *   1. 载荷不合格就地退回，一个字节都不碰；
 *   2. 插入中途炸了，库回滚到原来那份；
 *   3. 盘上的正文文件也跟着回来，不是「库是旧的、盘是空的」。
 *
 * 第 3 条最容易被漏掉：文件写盘不受事务保护，
 * 数据库能回滚，磁盘上的文件不会自己长回来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'mdhub-import-'));
process.env.MDHUB_DB_V2 = join(workDir, 'test.db');
process.env.MDHUB_VAULT_DIR = join(workDir, 'vault');
process.env.MDHUB_SECRET = 'test-secret-for-import-cases-0123456789abcdef';

const {
  db,
  insertDoc,
  listAllDocs,
  findImportProblems,
  normalizeImportDocs,
  replaceAllDocs,
} = await import('./db.ts');
const { createRepo } = await import('./repos.ts');
const { bodyPath, readFileSafe, parkedRepoDirs } = await import('./storage/v2/vault.ts');

const now = Date.now();

/** 整理导入载荷，只取文档数组 */
const normalize = (raw: unknown[]) => normalizeImportDocs(raw).docs;

/** 造一篇字段齐全的导入载荷 */function payload(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `p-${Math.random().toString(36).slice(2, 10)}`,
    name: '导入文档.md',
    type: 'file',
    parentId: null,
    content: '导入正文',
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    ...partial,
  };
}

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉不算失败
  }
});

/* ------------------------------ 载荷校验 ------------------------------ */

test('载荷不合格就地退回：挑得出毛病，且不碰库也不碰盘', () => {
  const repo = createRepo({ name: '校验测试仓库', createdBy: 'u-admin' });
  const existing = insertDoc({
    id: 'd-校验留存',
    name: '留存文档.md',
    type: 'file',
    parentId: null,
    content: '留存正文',
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    repoId: repo.id,
  });

  const problems = findImportProblems([
    payload({ id: 'bad-1' }), // 正常
    payload({ id: '', name: '没 id.md' }), // 缺 id
    payload({ id: 'bad-3', name: '' }), // 缺名字
    payload({ id: 'bad-4', name: '斜杠/名字.md' }), // 名字不能当路径段
    payload({ id: 'bad-5', type: 'dir' }), // 类型非法
    payload({ id: 'bad-6', createdAt: '昨天' }), // 时间戳不是数字
    payload({ id: 'bad-7', parentId: '不存在的父节点' }), // 父节点不在这一批里
    payload({ id: 'dup' }),
    payload({ id: 'dup' }), // id 重复
  ]);

  // 7 处毛病：缺 id、缺名字、名字含斜杠、类型非法、时间戳不是数字、父节点不在这一批、id 重复
  assert.equal(problems.length, 7, `应挑出 7 处毛病，实际 ${problems.length} 处`);
  const reasons = problems.map((p) => p.reason).join(' | ');
  assert.match(reasons, /缺少 id/);
  assert.match(reasons, /缺少名字/);
  assert.match(reasons, /路径段/);
  assert.match(reasons, /file 或 folder/);
  assert.match(reasons, /时间戳/);
  assert.match(reasons, /父节点/);
  assert.match(reasons, /重复/);

  // 校验本身不碰任何东西：库里那篇还在
  assert.ok(listAllDocs().some((d) => d.id === existing.id), '校验不该动库');
});

test('父子成环也挑得出来：这种树没法按「父在前」插进去', () => {
  const problems = findImportProblems([
    payload({ id: 'cyc-1', parentId: 'cyc-2' }),
    payload({ id: 'cyc-2', parentId: 'cyc-1' }),
  ]);
  assert.ok(
    problems.some((p) => p.reason.includes('成环')),
    `应挑出成环，实际：${problems.map((p) => p.reason).join(' | ')}`,
  );
});

/* ------------------------------ 中途失败 ------------------------------ */

test('插入中途炸了：库回滚到原来那份，原有文档一篇不少', () => {
  const repo = createRepo({ name: '回滚测试仓库', createdBy: 'u-admin' });
  const existing = insertDoc({
    id: 'd-回滚留存',
    name: '回滚前.md',
    type: 'file',
    parentId: null,
    content: '回滚前的正文',
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    repoId: repo.id,
  });

  const before = listAllDocs().map((d) => d.id).sort();
  assert.ok(before.includes(existing.id));

  // 父子成环：校验能拦下，但直接调 replaceAllDocs 时会插到一半炸掉
  //（外键指向还没插进去的父节点）
  assert.throws(
    () =>
      replaceAllDocs(
        normalize([
          payload({ id: 'cyc-a', name: '甲.md', parentId: 'cyc-b' }),
          payload({ id: 'cyc-b', name: '乙.md', parentId: 'cyc-a' }),
        ]),
      ),
    /FOREIGN KEY|constraint/i,
  );

  // 库：回滚了，原来那批一篇不少
  const after = listAllDocs().map((d) => d.id).sort();
  assert.deepEqual(after, before, '插入失败后库应回到原来那份');
  assert.ok(after.includes(existing.id), '原有文档不该消失');
});

test('插入中途炸了：盘上的正文文件也得回来，不能只剩一个空库', () => {
  const repo = createRepo({ name: '盘上回滚仓库', createdBy: 'u-admin' });
  const existing = insertDoc({
    id: 'd-盘上留存',
    name: '盘上留存.md',
    type: 'file',
    parentId: null,
    content: '盘上留存的正文',
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    repoId: repo.id,
  });

  const row = db.prepare('SELECT path FROM nodes WHERE id = ?').get(existing.id) as { path: string };
  const bodyAbs = bodyPath(repo.slug, row.path, false);
  assert.ok(existsSync(bodyAbs), '正文应已落到仓库目录里');

  assert.throws(() =>
    replaceAllDocs(
      normalize([
        payload({ id: 'cyc-c', name: '丙.md', parentId: 'cyc-d' }),
        payload({ id: 'cyc-d', name: '丁.md', parentId: 'cyc-c' }),
      ]),
    ),
  );

  assert.ok(existsSync(bodyAbs), '导入失败后原正文文件必须还在——文件写盘不受事务保护');
  assert.equal(readFileSafe(bodyAbs), '盘上留存的正文', '正文内容不该被这次失败的导入动过');
  assert.deepEqual(parkedRepoDirs(), [], '回滚后不该留下暂存目录');
});

/* ------------------------------ 正常导入 ------------------------------ */

test('合法载荷：库被整体替换，正文能读回', () => {
  const repo = createRepo({ name: '正常导入仓库', createdBy: 'u-admin' });
  insertDoc({
    id: 'd-将被替换',
    name: '旧文档.md',
    type: 'file',
    parentId: null,
    content: '旧正文',
    createdAt: now,
    updatedAt: now,
    createdBy: 'u-admin',
    updatedBy: 'u-admin',
    repoId: repo.id,
  });

  const imported = replaceAllDocs(
    normalize([
      payload({ id: 'new-1', name: '新文档甲.md', content: '新正文甲', repoId: repo.id }),
      payload({ id: 'new-2', name: '新文档乙.md', content: '新正文乙', repoId: repo.id }),
    ]),
  );
  assert.equal(imported, 2);

  const names = listAllDocs().map((d) => d.name);
  assert.ok(names.includes('新文档甲.md') && names.includes('新文档乙.md'));
  assert.ok(!names.includes('旧文档.md'), '导入是全量替换，旧文档不该还在');

  const row = db.prepare('SELECT path FROM nodes WHERE id = ?').get('new-1') as { path: string };
  const abs = bodyPath(repo.slug, row.path, false);
  assert.equal(readFileSafe(abs), '新正文甲', '导入的正文要真的落在盘上');
});

test('嵌套文件夹：父先于子插入，子节点的路径带上前缀', () => {
  const repo = createRepo({ name: '嵌套导入仓库', createdBy: 'u-admin' });

  // 子在前、父在后：排序不对的话子节点会落成平级
  replaceAllDocs(
    normalize([
      payload({ id: 'n-child', name: '子文档.md', type: 'file', parentId: 'n-folder', repoId: repo.id }),
      payload({ id: 'n-folder', name: '父目录', type: 'folder', parentId: null, repoId: repo.id }),
    ]),
  );

  const row = db.prepare('SELECT path FROM nodes WHERE id = ?').get('n-child') as { path: string };
  assert.equal(row.path, '父目录/子文档.md', '子节点的路径应带上前缀');
  assert.ok(
    existsSync(bodyPath(repo.slug, row.path, false)),
    '子节点的正文应落在嵌套目录里',
  );
});

test('加密文档不带走明文：快照里没有密文，别在盘上留明文副本', () => {
  const repo = createRepo({ name: '加密导入仓库', createdBy: 'u-admin' });

  replaceAllDocs(
    normalize([
      payload({
        id: 'enc-1',
        name: '加密文档.md',
        content: '这段是明文，不该落盘',
        encrypted: true,
        repoId: repo.id,
      }),
    ]),
  );

  const row = db.prepare('SELECT path, encrypted FROM nodes WHERE id = ?').get('enc-1') as {
    path: string;
    encrypted: number;
  };
  assert.equal(row.encrypted, 1, '导入后仍应是加密态');

  const encAbs = bodyPath(repo.slug, row.path, true);
  const body = readFileSafe(encAbs) ?? '';
  assert.ok(!body.includes('这段是明文'), '明文绝不能被写进 .enc 文件');
});

test('归属仓库不存在时落到默认仓库：内容比归属重要', () => {
  const normalized = normalize([
    payload({ id: 'r-1', repoId: 'r-demo' }), // 快照里的仓库在服务端不存在
  ]);
  assert.ok(normalized[0].repoId, '总得有个归属，否则文档无处安放');
  assert.notEqual(normalized[0].repoId, 'r-demo');
});

test('兜底补齐的地方要报出来：迁移完「谁写的」不能查无对证', () => {
  const { docs, defaulted } = normalizeImportDocs([
    payload({ id: 'd-1' }), // 字段齐全
    payload({
      id: 'd-2',
      createdAt: undefined,
      updatedAt: undefined,
      createdBy: undefined,
      updatedBy: undefined,
      repoId: 'r-demo', // 服务端没这个仓库
    }),
  ]);

  assert.equal(defaulted.timestamps, 1, '缺时间戳的篇数应报出来');
  assert.equal(defaulted.authors, 1, '缺作者的篇数应报出来');
  assert.equal(defaulted.repos, 1, '换了仓库的篇数应报出来');

  // 补齐的值要真的落进文档里
  assert.ok(docs[1].createdBy, '缺作者时得记上导入人');
  assert.equal(docs[1].createdBy, docs[1].updatedBy);
  assert.ok(docs[1].createdAt > 0, '缺时间戳时得补上当前时间');
});
