/**
 * 文档访问范围的安全边界测试。
 *
 * 「对访客隐藏」已下线，访客与管理员看到同一份文档清单，因此这里不再有
 * 「按身份裁剪清单」的用例；保留下来的都是**不能被放松**的那几条：
 * 加密文档绝不能进入模型上下文，请求的范围绝不能把全局范围放宽。
 *
 * 访问控制的实现方式变了，边界没变——这正是需要回归保护的地方。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocNode, RagScope } from '../shared/types.ts';
import { selectAgentCandidates, resolveAskScope } from './docAccess.ts';

/** 造一个字段齐全的 DocNode，避免每个用例重复填时间戳与作者 */
function doc(partial: Partial<DocNode> & Pick<DocNode, 'id' | 'name' | 'type'>): DocNode {
  return {
    id: partial.id,
    name: partial.name,
    type: partial.type,
    parentId: partial.parentId ?? null,
    content: partial.content,
    size: partial.size ?? 0,
    createdAt: partial.createdAt ?? 1,
    updatedAt: partial.updatedAt ?? 1,
    createdBy: partial.createdBy ?? 'u-admin',
    updatedBy: partial.updatedBy ?? 'u-admin',
    encrypted: partial.encrypted ?? false,
    lockedAt: partial.lockedAt,
  };
}

const docs: DocNode[] = [
  doc({ id: 'f1', name: '公开文档', type: 'file', content: '公开正文', size: 4 }),
  doc({ id: 'd1', name: '目录', type: 'folder' }),
  doc({ id: 'd1c', name: '目录下的文档', type: 'file', parentId: 'd1', content: '普通正文', size: 4 }),
  doc({ id: 'e1', name: '加密文档', type: 'file', content: undefined, encrypted: true, lockedAt: 100 }),
];

test('Agent 检索范围排除加密文档，管理员身份也不例外', () => {
  const candidates = selectAgentCandidates(docs).map((d) => d.id);
  assert.deepEqual(candidates, ['f1', 'd1c']);
  assert.ok(!candidates.includes('e1'), '加密文档绝不能进入模型上下文');
  assert.ok(!candidates.includes('d1'), '文件夹不是检索单元');
});

test('加密文档即使有正文残留也不能进入模型上下文', () => {
  // 防御性用例：万一某条写入路径漏了 content 置空，检索侧仍要挡住
  const leaked = selectAgentCandidates([
    doc({ id: 'e3', name: '加密文档', type: 'file', content: '不该被读到', size: 6, encrypted: true }),
  ]);
  assert.deepEqual(leaked, []);
});

/* ------------------------------ 检索范围求交集 ------------------------------ */

const scopeDocs: DocNode[] = [
  doc({ id: 'a1', name: '甲的文档', type: 'file', content: '甲', size: 2 }),
  doc({ id: 'a2', name: '甲的另一篇', type: 'file', content: '甲二', size: 3 }),
  doc({ id: 'b1', name: '乙的文档', type: 'file', content: '乙', size: 2 }),
  doc({ id: 'n1', name: '散件', type: 'file', content: '散', size: 2 }),
];

const ALL_SCOPE: RagScope = { mode: 'all', docIds: [], includeAttachments: true };

test('请求没带范围时沿用全局配置', () => {
  const scope = resolveAskScope(undefined, ALL_SCOPE);
  assert.equal(scope.mode, 'all');
  assert.equal(scope.includeAttachments, true);
});

test('临时收窄到具体文档：只剩那几篇', () => {
  const scope = resolveAskScope(
    { mode: 'docs', docIds: ['a1', 'a2'], includeAttachments: true },
    ALL_SCOPE,
  );
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids.sort(), ['a1', 'a2']);
  assert.ok(!ids.includes('n1'), '没点名的文档不该被带进来');
});

test('请求的范围不能把全局范围放宽', () => {
  // 全局只允许「乙的一篇文档」，请求却声称要看甲的两篇
  const configured: RagScope = { mode: 'docs', docIds: ['b1'], includeAttachments: true };
  const scope = resolveAskScope(
    { mode: 'docs', docIds: ['a1', 'a2'], includeAttachments: true },
    configured,
  );
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, [], '交集为空：管理员没放行的文档，宁可答不出也不能越界');
});

test('请求的范围与全局范围有交集时，取交集', () => {
  // 全局只放行 b1；请求点了 a1 与 b1
  const configured: RagScope = { mode: 'docs', docIds: ['b1'], includeAttachments: true };
  const scope = resolveAskScope(
    { mode: 'docs', docIds: ['a1', 'b1'], includeAttachments: true },
    configured,
  );
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, ['b1']);
});

test('全局限定文档时，请求给不出更宽的范围', () => {
  const configured: RagScope = { mode: 'docs', docIds: ['b1'], includeAttachments: true };
  const scope = resolveAskScope(
    { mode: 'all', docIds: [], includeAttachments: true },
    configured,
  );
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, ['b1'], '「全站」这种请求不能覆盖管理员的限定');
});

test('全局关掉附件后，请求参数无法把它打开', () => {
  const configured: RagScope = { mode: 'all', docIds: [], includeAttachments: false };
  const scope = resolveAskScope(
    { mode: 'all', docIds: [], includeAttachments: true },
    configured,
  );
  assert.equal(scope.includeAttachments, false);
});

test('全局开着附件时，请求可以临时关掉', () => {
  const scope = resolveAskScope(
    { mode: 'all', docIds: [], includeAttachments: false },
    ALL_SCOPE,
  );
  assert.equal(scope.includeAttachments, false);
});
