/**
 * v2 存储层的回归测试。
 *
 * 这里只测「现役结构」的行为：路径规范化、仓库 slug、检索索引。
 * 旧库迁移、补列这类兼容逻辑已经整体下线，不再有测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// vault 的根目录在模块加载时就定死了，
// 所以必须先设好环境变量再动态 import——静态 import 会提前求值。
const workDir = mkdtempSync(join(tmpdir(), 'workhub-v2-test-'));
process.env.WORKHUB_VAULT_DIR = join(workDir, 'vault');

const { bodyFileName, safeRelPath, slugify } = await import('./vault.ts');
const { openV2Db } = await import('./schema.ts');
const { toMatchQuery, toSearchText } = await import('./search.ts');

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉就留着，不影响断言
  }
});

test('safeRelPath 拒绝越界与非法路径', () => {
  assert.equal(safeRelPath('正常/路径.md'), '正常/路径.md');
  assert.equal(safeRelPath('../越界'), null);
  assert.equal(safeRelPath('a/../../b'), null);
  assert.equal(safeRelPath('/绝对/路径'), '绝对/路径');
  assert.equal(safeRelPath('bad:name'), null);
  assert.equal(safeRelPath(''), null);
});

test('slugify 保留中文且同名不同 id 不冲突', () => {
  const a = slugify('样例项目', 'r-abd674b1');
  const b = slugify('样例项目', 'r-abd674b2');
  assert.notEqual(a, b);
  assert.match(a, /样例项目/);
  assert.doesNotMatch(slugify('a/b:c', 'r-1'), /[/:]/);
});

test('bodyFileName 不产生双扩展名', () => {
  assert.equal(bodyFileName('常用设备命令.md', false), '常用设备命令.md');
  assert.equal(bodyFileName('说明', false), '说明.md');
  assert.equal(bodyFileName('密文样例.md', true), '密文样例.md.enc');
});

test('新库的结构就是 SCHEMA：表与列一次到位', () => {
  // 以前这里还测「老库缺列时自动补上」——兼容逻辑下线后，库只有一种来源：
  // 直接由 SCHEMA 建出来。结构对不上就是建库出了问题，应该在开库那一刻就看见。
  const path = join(workDir, 'schema.db');
  const db = openV2Db(path);
  const cols = (
    db.prepare("select name from pragma_table_info('nodes')").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(cols.includes('enc_locked_at'));
  assert.ok(cols.includes('tags'));
  assert.ok(cols.includes('repo_id'));

  // users 表只有密码哈希，没有明文列
  const userCols = (
    db.prepare("select name from pragma_table_info('users')").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(userCols.includes('password_hash'));
  assert.ok(!userCols.includes('password'), '明文密码列不该存在');
  db.close();
});

test('旧结构留下的库会被明确挡下，而不是等写入时才炸', () => {
  // 旧版建的 users 表带一列明文密码：NOT NULL 且没有默认值。
  // 现役代码不再写这一列，于是 INSERT 会撞「NOT NULL constraint failed」。
  // 症状是开库正常、登录时才炸，报错里半个字都没提「你的库是旧版」。
  // 所以结构闸门必须在开库那一刻就说清楚。
  const path = join(workDir, 'legacy.db');
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      avatar TEXT NOT NULL,
      color TEXT NOT NULL,
      password TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT ''
    );
  `);
  legacy.close();

  assert.throws(
    () => openV2Db(path),
    (err: Error) => {
      assert.match(err.message, /users 多出一列 password/);
      assert.match(err.message, /备份/, '报错要给出下一步该做什么');
      return true;
    },
  );
});

test('多出来的可空旧列不拦启动', () => {
  // 可空列挡不住写入，为了它去重建表是得不偿失——
  // 重建表正是我们要避免的那类迁移动作。
  const path = join(workDir, 'extra-col.db');
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      avatar TEXT NOT NULL,
      color TEXT NOT NULL,
      deleted_at TEXT,
      password_hash TEXT NOT NULL DEFAULT ''
    );
  `);
  legacy.close();

  const db = openV2Db(path);
  const cols = (
    db.prepare("select name from pragma_table_info('users')").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(cols.includes('deleted_at'));
  db.close();
});

test('全文索引：中文能命中，且密文不进索引', () => {
  const path = join(workDir, 'fts.db');
  const db = openV2Db(path);
  const now = Date.now();
  db.prepare(
    `INSERT INTO repos (id, slug, name, description, color, allowed_exts, max_file_size, rag_enabled, acl, created_at, updated_at, created_by)
     VALUES ('r-1', 'sample', '样例', '', '#6366f1', '[]', 104857600, 1, '{}', ?, ?, 'u-admin')`,
  ).run(now, now);

  const insertNode = db.prepare(
    `INSERT INTO nodes (id, repo_id, name, type, parent_id, path, size, content_hash, encrypted, enc_master_dek, acl, created_at, updated_at, created_by, updated_by)
     VALUES (?, 'r-1', ?, ?, NULL, ?, 0, '', ?, NULL, '{}', ?, ?, 'u-admin', 'u-admin')`,
  );
  insertNode.run('d-1', '样例笔记.md', 'file', '样例笔记.md', 0, now, now);
  insertNode.run('d-2', '密文样例.md', 'file', '密文样例.md', 1, now, now);

  // 加密文档整条不进索引（连名字也不进）——db.ts 里加密成功后会 unindexNode。
  // 名字若还留在索引里，搜一下它的标题就能把它拽出来，等于绕过加密。
  db.prepare('insert into node_fts (repo_id, node_id, name, body) values (?, ?, ?, ?)').run(
    'r-1',
    'd-1',
    toSearchText('样例笔记.md'),
    toSearchText('真机调试 adb install'),
  );

  const hits = db
    .prepare('select node_id from node_fts where node_fts match ?')
    .all(toMatchQuery('调试')) as Array<{ node_id: string }>;
  assert.ok(hits.map((h) => h.node_id).includes('d-1'), '「样例笔记.md」正文里有「调试」，应该命中');

  const encRows = db
    .prepare('select node_id from node_fts where node_id = ?')
    .all('d-2') as Array<{ node_id: string }>;
  assert.equal(encRows.length, 0, '加密文档不能进检索索引，否则等于把密文喂给模型');

  const encHits = db
    .prepare('select node_id from node_fts where node_fts match ?')
    .all(toMatchQuery('密文')) as Array<{ node_id: string }>;
  assert.ok(
    !encHits.map((h) => h.node_id).includes('d-2'),
    '加密文档不能被搜出来',
  );

  // 索引按仓库过滤
  const scoped = db
    .prepare('select node_id from node_fts where node_fts match ? and repo_id = ?')
    .all(toMatchQuery('调试'), 'r-1') as Array<{ node_id: string }>;
  assert.ok(scoped.length > 0);
  db.close();
});
