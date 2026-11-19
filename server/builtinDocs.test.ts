/**
 * 记录区里内置说明书的落点。
 *
 * 「工具」目录下按接入方式分「串口」「网口」两个子目录：
 * 串口接的车载屏与网口接的定位终端不是一类东西，说明书混在一处翻起来费劲。
 * 各归各的目录，找的时候一眼就知道该翻哪边。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 库、vault 与旧导入目录的位置都在模块加载期定死了：先设好环境变量再动态 import
const workDir = mkdtempSync(join(tmpdir(), 'workhub-docs-test-'));
process.env.WORKHUB_SECRET = 'builtin-docs-test-secret-0123456789abcdef';
process.env.WORKHUB_DB_V2 = join(workDir, 'test.db');
process.env.WORKHUB_VAULT_DIR = join(workDir, 'vault');
process.env.PROTOCOL_DOCS_DIR = join(workDir, 'protocol-docs');

const { db } = await import('./db.ts');
const {
  ensureBuiltinDocs,
  builtinDocNodeIdFor,
  seedPluginDoc,
} = await import('./builtinDocs.ts');
const { builtinDocNodeId } = await import('./storage/v2/builtin.ts');

test.after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉就留着，不影响断言
  }
});

/** 某个节点的路径 */
function pathOf(nodeId: string): string {
  const row = db.prepare('SELECT path FROM nodes WHERE id = ?').get(nodeId) as
    | { path: string }
    | undefined;
  assert.ok(row, `节点不存在：${nodeId}`);
  return row.path;
}

test('工具目录下分出「串口」「网口」两个子目录', () => {
  ensureBuiltinDocs();

  const tools = db.prepare('SELECT id FROM nodes WHERE id = ?').get('builtin-tools');
  assert.ok(tools, '工具目录该在');

  for (const id of ['builtin-tools-serial', 'builtin-tools-tcp']) {
    const row = db.prepare('SELECT type, parent_id, path FROM nodes WHERE id = ?').get(id) as
      | { type: string; parent_id: string | null; path: string }
      | undefined;
    assert.ok(row, `子目录 ${id} 该在`);
    assert.equal(row.type, 'folder');
    assert.equal(row.parent_id, 'builtin-tools');
  }
});

test('只走串口的说明书落在「串口」下', () => {
  ensureBuiltinDocs();
  const nodeId = builtinDocNodeIdFor('tongda-led2');
  assert.ok(nodeId, '通达 LED2 的说明书该在');
  assert.match(pathOf(nodeId), /~builtin\/串口\//);
});

test('走网口的说明书落在「网口」下', () => {
  ensureBuiltinDocs();
  const nodeId = builtinDocNodeIdFor('jt-t808');
  assert.ok(nodeId, 'JT/T 808 的说明书该在');
  assert.match(pathOf(nodeId), /~builtin\/网口\//);
});

test('插件说明书按它声明的适用范围落位', () => {
  ensureBuiltinDocs();

  // 插件说了自己走网口 → 进「网口」
  seedPluginDoc('plug-tcp', '# 插件甲\n', '插件甲.md', ['tcp']);
  assert.match(pathOf(builtinDocNodeId('plug-tcp')), /~builtin\/网口\//);

  // 说了走串口 → 进「串口」
  seedPluginDoc('plug-serial', '# 插件乙\n', '插件乙.md', ['serial']);
  assert.match(pathOf(builtinDocNodeId('plug-serial')), /~builtin\/串口\//);

  // 两种口都能用 → 留在「工具」根下：塞进哪一边都不对
  seedPluginDoc('plug-both', '# 插件丙\n', '插件丙.md', ['serial', 'tcp']);
  assert.equal(pathOf(builtinDocNodeId('plug-both')), '~builtin/插件丙.md');
});

test('不挑口的说明书留在「工具」根下', () => {
  ensureBuiltinDocs();
  seedPluginDoc('plug-any', '# 插件丁\n', '插件丁.md');
  assert.equal(pathOf(builtinDocNodeId('plug-any')), '~builtin/插件丁.md');
});

test('老库里的说明书会被挪进子目录', () => {
  ensureBuiltinDocs();

  // 造一份「直接放在工具根下」的旧记录
  const nodeId = builtinDocNodeId('old-style');
  const now = Date.now();
  db.prepare(
    `INSERT INTO nodes (id, name, type, parent_id, path, size, content_hash, encrypted, enc_master_dek, acl, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 'file', 'builtin-tools', ?, 0, '', 0, NULL, '{}', ?, ?, 'u-admin', 'u-admin')`,
  ).run(nodeId, '老说明书.md', '~builtin/老说明书.md', now, now);

  // 同步一次：它该被挪到该去的子目录下
  seedPluginDoc('old-style', '# 老说明书\n', '老说明书.md', ['tcp']);
  assert.match(pathOf(nodeId), /~builtin\/网口\//);
});

test('说明书落位变了也不影响正文', () => {
  ensureBuiltinDocs();
  const nodeId = builtinDocNodeIdFor('jt-t808');
  assert.ok(nodeId);
  const row = db.prepare('SELECT content_hash, size FROM nodes WHERE id = ?').get(nodeId) as {
    content_hash: string;
    size: number;
  };
  assert.ok(row.size > 0, '说明书不该是空的');
  assert.ok(row.content_hash.length > 0);
});
