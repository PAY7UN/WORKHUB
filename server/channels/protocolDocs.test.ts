import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  isValidProtocolId,
  listBuiltinProtocolDocIds,
  readBuiltinProtocolDoc,
} from './protocolDocs.ts';

/** 起一个干净的临时环境：内置目录指到临时地方 */
function tempEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'protocol-docs-'));
  return {
    env: {
      ...process.env,
      BUILTIN_PROTOCOL_DOCS_DIR: join(root, 'builtin'),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('协议 id 不合法的一律拒绝——它会拼进文件路径', () => {
  assert.equal(isValidProtocolId('tongda-led2'), true);
  assert.equal(isValidProtocolId('demo.vendor_line-2'), true);
  assert.equal(isValidProtocolId('../escape'), false);
  assert.equal(isValidProtocolId('a/b'), false);
  assert.equal(isValidProtocolId(''), false);
});

test('读得出仓库里那份说明书，标题取第一行', () => {
  const { env, cleanup } = tempEnv();
  try {
    mkdirSync(env.BUILTIN_PROTOCOL_DOCS_DIR as string, { recursive: true });
    writeFileSync(
      join(env.BUILTIN_PROTOCOL_DOCS_DIR as string, 'demo.md'),
      '# 演示协议\n\n正文。',
      'utf8',
    );
    const doc = readBuiltinProtocolDoc('demo', env);
    assert.ok(doc);
    assert.equal(doc.title, '演示协议');
    assert.match(doc.markdown, /正文。/);
  } finally {
    cleanup();
  }
});

test('没有文档就返回空，不报错', () => {
  const { env, cleanup } = tempEnv();
  try {
    assert.equal(readBuiltinProtocolDoc('nothing', env), undefined);
    assert.deepEqual(listBuiltinProtocolDocIds(env), []);
  } finally {
    cleanup();
  }
});

test('非法 id 连读都不给读', () => {
  const { env, cleanup } = tempEnv();
  try {
    assert.equal(readBuiltinProtocolDoc('../escape', env), undefined);
  } finally {
    cleanup();
  }
});

test('仓库里有几份就列几份', () => {
  const { env, cleanup } = tempEnv();
  try {
    const dir = env.BUILTIN_PROTOCOL_DOCS_DIR as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), '# A', 'utf8');
    writeFileSync(join(dir, 'b.md'), '# B', 'utf8');
    writeFileSync(join(dir, 'c.txt'), '不是文档', 'utf8');
    assert.deepEqual(listBuiltinProtocolDocIds(env), ['a', 'b']);
  } finally {
    cleanup();
  }
});
