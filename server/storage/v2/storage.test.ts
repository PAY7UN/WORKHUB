/**
 * v2 存储层的回归测试。
 *
 * 测试自己造一个旧库，而不是拿真实数据跑：
 * 真实数据会随使用变化，断言写死了就会莫名其妙地红。
 * 造库能把每条边界都摆到明面上——未归档文档、加密文档、同名路径、路径穿越。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

type DatabaseInstance = Database.Database;

// vault 的根目录在模块加载时就定死了，
// 所以必须先设好环境变量再动态 import——静态 import 会提前求值。
const workDir = mkdtempSync(join(tmpdir(), 'workhub-v2-test-'));
process.env.WORKHUB_VAULT_DIR = join(workDir, 'vault');

const { bodyFileName, safeRelPath, slugify } = await import('./vault.ts');
const { migrate, toMatchQuery, verify } = await import('./migrate.ts');
const { openV2Db } = await import('./schema.ts');

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉就留着，不影响断言
  }
});

/** 造一个最小旧库：字段与迁移器读取的列一致 */
function makeOldDb(path: string, opts: { withUnassigned?: boolean } = {}): DatabaseInstance {
  const db = new Database(path);
  db.exec(`
    create table repos (
      id text primary key, name text, description text, color text,
      allowed_exts text, max_file_size integer, rag_enabled integer,
      created_at integer, updated_at integer, created_by text, deleted_at integer
    );
    create table docs (
      id text primary key, name text, type text, parent_id text, content text,
      size integer, created_at integer, updated_at integer, created_by text,
      updated_by text, encrypted integer default 0, enc_cipher text,
      enc_master_dek text, deleted_at integer, repo_id text
    );
  `);
  const now = Date.now();
  db.prepare(
    'insert into repos values (?,?,?,?,?,?,?,?,?,?,?)',
  ).run('r-1', '样例项目', '', '#6366f1', '[]', 104857600, 1, now, now, 'u-admin', null);
  db.prepare(
    'insert into docs values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    'd-1',
    '样例笔记.md',
    'file',
    null,
    '# 样例\n真机调试 adb install\n',
    30,
    now,
    now,
    'u-admin',
    'u-admin',
    0,
    null,
    null,
    null,
    opts.withUnassigned ? null : 'r-1',
  );
  db.prepare(
    'insert into docs values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    'd-2',
    '密文样例.md',
    'file',
    null,
    null,
    0,
    now,
    now,
    'u-admin',
    'u-admin',
    1,
    'v1:iv:tag:ciphertext',
    'v1:wrapped-dek',
    null,
    opts.withUnassigned ? null : 'r-1',
  );
  db.prepare(
    'insert into docs values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    'd-3',
    '子目录',
    'folder',
    null,
    null,
    0,
    now,
    now,
    'u-admin',
    'u-admin',
    0,
    null,
    null,
    null,
    opts.withUnassigned ? null : 'r-1',
  );
  db.prepare(
    'insert into docs values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    'd-4',
    '笔记.md',
    'file',
    'd-3',
    '内部笔记内容\n',
    18,
    now,
    now,
    'u-admin',
    'u-admin',
    0,
    null,
    null,
    null,
    opts.withUnassigned ? null : 'r-1',
  );
  return db;
}

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

test('迁移：正文落文件、仓库归属正确、校验通过', () => {
  const oldPath = join(workDir, 'old.db');
  const newPath = join(workDir, 'new.db');
  const oldDb = makeOldDb(oldPath);
  oldDb.close();

  const report = migrate(oldPath, newPath);
  assert.equal(report.nodes, 4);
  assert.equal(report.warnings.length, 0);
  assert.equal(report.adoptedIntoDefault, 0, '有仓库归属的文档不该进默认仓库');

  const v = verify(oldPath, newPath);
  assert.equal(v.ok, true, v.mismatches.join('; '));
  assert.equal(v.checked, 3, '三个文件型文档都要逐字比对');

  const db = openV2Db(newPath);
  const node = db.prepare('select * from nodes where id=?').get('d-1') as Record<string, unknown>;
  assert.equal(node.repo_id, 'r-1');
  assert.equal(node.name, '样例笔记.md');
  assert.equal(node.path, '样例笔记.md');

  // 子节点路径带上父目录
  const child = db.prepare('select * from nodes where id=?').get('d-4') as Record<string, unknown>;
  assert.equal(child.path, '子目录/笔记.md');

  // 正文文件确实存在且内容一致
  const repo = db.prepare('select slug from repos where id=?').get('r-1') as { slug: string };
  const body = readFileSync(
    join(process.env.WORKHUB_VAULT_DIR!, repo.slug, 'docs', '样例笔记.md'),
    'utf8',
  );
  assert.equal(body, '# 样例\n真机调试 adb install\n');

  // 加密文档写成 .md.enc
  const enc = readFileSync(
    join(process.env.WORKHUB_VAULT_DIR!, repo.slug, 'docs', '密文样例.md.enc'),
    'utf8',
  );
  assert.equal(enc, 'v1:iv:tag:ciphertext');

  db.close();
});

test('迁移：未归档文档被归入默认仓库', () => {
  const oldPath = join(workDir, 'old-unassigned.db');
  const newPath = join(workDir, 'new-unassigned.db');
  const oldDb = makeOldDb(oldPath, { withUnassigned: true });
  oldDb.close();

  const report = migrate(oldPath, newPath);
  assert.equal(report.adoptedIntoDefault, 4);

  const db = openV2Db(newPath);
  const repos = db.prepare('select * from repos').all() as Array<{ id: string; slug: string }>;
  const defaultRepo = repos.find((r) => r.id === 'r-default');
  assert.ok(defaultRepo, '应该自动建出默认仓库');
  const orphan = db.prepare('select count(*) c from nodes where repo_id is null').get() as {
    c: number;
  };
  assert.equal(orphan.c, 0, '新模型里不允许没有归属的节点');
  db.close();
});

test('老库缺列时开库自动补上：不然写文档就报 no such column', () => {
  const path = join(workDir, 'legacy-schema.db');
  // 造一个「旧版本结构」的库：nodes 少了后来才加的列
  const legacy = new Database(path);
  legacy.exec(`
    create table repos (
      id text primary key, slug text, name text, description text, color text,
      allowed_exts text, max_file_size integer, rag_enabled integer, acl text,
      created_at integer, updated_at integer, created_by text
    );
    create table nodes (
      id text primary key, repo_id text, name text, type text, parent_id text,
      path text, size integer, content_hash text, revision integer default 1,
      encrypted integer default 0, enc_master_dek text, acl text default '{}',
      created_at integer, updated_at integer, created_by text, updated_by text,
      deleted_at integer
    );
  `);
  legacy.close();

  const db = openV2Db(path);
  const cols = (
    db.prepare("select name from pragma_table_info('nodes')").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(cols.includes('enc_locked_at'), '后来新增的 enc_locked_at 列应被补上');
  assert.ok(cols.includes('tags'), '后来新增的 tags 列应被补上');

  // 补完列就能正常写入——这才是重点：补列失败的话，错误会推迟到写入那一刻才炸
  db.prepare(
    `insert into nodes (id, repo_id, name, type, parent_id, path, size, content_hash,
       encrypted, enc_master_dek, enc_locked_at, acl, tags,
       created_at, updated_at, created_by, updated_by)
     values ('d-x','r-1','补列测试.md','file',null,'补列测试.md',0,'h',0,null,null,'{}',null,0,0,'u','u')`,
  ).run();
  const row = db.prepare('select enc_locked_at, tags from nodes where id=?').get('d-x') as {
    enc_locked_at: number | null;
    tags: string | null;
  };
  assert.equal(row.enc_locked_at, null, '新补的列对老行应为 NULL');
  assert.equal(row.tags, null);
  db.close();
});

test('补列是幂等的：结构已是最新时不会重复加', () => {
  const path = join(workDir, 'idempotent-schema.db');
  const first = openV2Db(path);
  first.close();
  const second = openV2Db(path);
  const cols = (
    second.prepare("select name from pragma_table_info('nodes')").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(cols.includes('enc_locked_at'));
  assert.ok(cols.includes('tags'));
  second.close();
});

test('迁移可以重复执行且结果一致', () => {
  const oldPath = join(workDir, 'old.db');
  const newPath = join(workDir, 'new.db');
  const first = migrate(oldPath, newPath);
  const second = migrate(oldPath, newPath);
  assert.deepEqual(second, first, '迁移必须是幂等的');

  const db = openV2Db(newPath);
  const count = db.prepare('select count(*) c from nodes').get() as { c: number };
  assert.equal(count.c, 4, '重复迁移不该产生重复节点');
  db.close();
});

test('全文索引：中文能命中，且密文不进索引', () => {
  const oldPath = join(workDir, 'old.db');
  const newPath = join(workDir, 'new.db');
  migrate(oldPath, newPath);

  const db = openV2Db(newPath);
  const hits = db
    .prepare('select node_id from node_fts where node_fts match ?')
    .all(toMatchQuery('调试')) as Array<{ node_id: string }>;
  const ids = hits.map((h) => h.node_id);
  assert.ok(ids.includes('d-1'), '「样例笔记.md」正文里有「调试」，应该命中');

  // 加密文档的正文与名字都不该进索引
  const encHits = db
    .prepare('select node_id from node_fts where node_fts match ?')
    .all(toMatchQuery('密文')) as Array<{ node_id: string }>;
  assert.ok(
    !encHits.map((h) => h.node_id).includes('d-2'),
    '加密文档不能进检索索引，否则等于把密文喂给模型',
  );

  // 索引按仓库过滤
  const scoped = db
    .prepare('select node_id from node_fts where node_fts match ? and repo_id = ?')
    .all(toMatchQuery('调试'), 'r-1') as Array<{ node_id: string }>;
  assert.ok(scoped.length > 0);
  db.close();
});
