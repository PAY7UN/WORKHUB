/**
 * 文档访问范围的安全边界测试。
 *
 * 「对访客隐藏」已下线，访客与管理员看到同一份文档清单，因此这里不再有
 * 「按身份裁剪清单」的用例；保留下来的都是**不能被放松**的那几条：
 * 加密文档绝不能进入模型上下文。
 *
 * 访问控制的实现方式变了，边界没变——这正是需要回归保护的地方。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocNode, RagScope } from '../shared/types.ts';
import { selectAgentCandidates, resolveAskScope, detectRepoFocus } from './docAccess.ts';

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
    tags: partial.tags,
    encrypted: partial.encrypted ?? false,
    lockedAt: partial.lockedAt,
    repoId: partial.repoId ?? 'r-default',
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
  doc({ id: 'a1', name: '项目甲的文档', type: 'file', repoId: 'r-a', content: '甲', size: 2 }),
  doc({ id: 'a2', name: '项目甲的另一篇', type: 'file', repoId: 'r-a', content: '甲二', size: 3 }),
  doc({ id: 'b1', name: '项目乙的文档', type: 'file', repoId: 'r-b', content: '乙', size: 2 }),
  doc({ id: 'n1', name: '默认仓库的文档', type: 'file', repoId: 'r-default', content: '散件', size: 2 }),
];

const ALL_SCOPE: RagScope = { mode: 'all', repoIds: [], docIds: [], includeAttachments: true };

test('请求没带范围时沿用全局配置', () => {
  const scope = resolveAskScope(undefined, ALL_SCOPE, scopeDocs);
  assert.equal(scope.mode, 'all');
  assert.equal(scope.includeAttachments, true);
});

test('临时收窄到某个仓库：只剩该仓库的文档', () => {
  const scope = resolveAskScope(
    { mode: 'repos', repoIds: ['r-a'], docIds: [], includeAttachments: true },
    ALL_SCOPE,
    scopeDocs,
  );
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids.sort(), ['a1', 'a2']);
  assert.ok(!ids.includes('n1'), '别的仓库的文档不该被带进来');
});

test('请求的范围不能把全局范围放宽', () => {
  // 全局只允许「项目乙的一篇文档」，请求却声称要看整个项目甲
  const configured: RagScope = { mode: 'docs', repoIds: [], docIds: ['b1'], includeAttachments: true };
  const scope = resolveAskScope(
    { mode: 'repos', repoIds: ['r-a'], docIds: [], includeAttachments: true },
    configured,
    scopeDocs,
  );
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, [], '交集为空：项目甲里没有管理员放行的文档，宁可答不出也不能越界');
});

test('请求的范围与全局范围有交集时，取交集', () => {
  // 全局只放行 b1；用户此刻选中的项目乙恰好包含它
  const configured: RagScope = { mode: 'docs', repoIds: [], docIds: ['b1'], includeAttachments: true };
  const scope = resolveAskScope(
    { mode: 'repos', repoIds: ['r-b'], docIds: [], includeAttachments: true },
    configured,
    scopeDocs,
  );
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, ['b1']);
});

test('请求的范围不能把仓库白名单撑大', () => {
  const configured: RagScope = { mode: 'repos', repoIds: ['r-b'], docIds: [], includeAttachments: true };
  const scope = resolveAskScope(
    { mode: 'repos', repoIds: ['r-a', 'r-b'], docIds: [], includeAttachments: true },
    configured,
    scopeDocs,
  );
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, ['b1']);
});

test('全局关掉附件后，请求参数无法把它打开', () => {
  const configured: RagScope = { mode: 'all', repoIds: [], docIds: [], includeAttachments: false };
  const scope = resolveAskScope(
    { mode: 'all', repoIds: [], docIds: [], includeAttachments: true },
    configured,
    scopeDocs,
  );
  assert.equal(scope.includeAttachments, false);
});

test('全局开着附件时，请求可以临时关掉', () => {
  const scope = resolveAskScope(
    { mode: 'all', repoIds: [], docIds: [], includeAttachments: false },
    ALL_SCOPE,
    scopeDocs,
  );
  assert.equal(scope.includeAttachments, false);
});

/* ------------------------------ 仓库落点 ------------------------------ */

test('认不出仓库时不给落点', () => {
  const repos = [
    { id: 'r-a', name: '项目甲' },
    { id: 'r-b', name: '项目乙' },
  ];
  assert.deepEqual(detectRepoFocus('这份规范讲了什么？', repos), []);
});

test('问题里点名了仓库，就落到那个仓库', () => {
  const repos = [
    { id: 'r-a', name: '项目甲' },
    { id: 'r-b', name: '项目乙' },
  ];
  assert.deepEqual(detectRepoFocus('项目乙里怎么配置流水线？', repos), ['r-b']);
});

test('仓库名互相包含时只认更长的那个', () => {
  const repos = [
    { id: 'r-short', name: '项目' },
    { id: 'r-long', name: '项目甲' },
  ];
  assert.deepEqual(detectRepoFocus('项目甲的资料有哪些？', repos), ['r-long']);
});

test('默认落点是默认仓库：只答那个仓库的内容', () => {
  const scope = resolveAskScope(undefined, ALL_SCOPE, scopeDocs, ['r-default']);
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, ['n1']);
});

test('落点只收窄不放宽：全局白名单之外的仓库仍然看不到', () => {
  const configured: RagScope = { mode: 'repos', repoIds: ['r-b'], docIds: [], includeAttachments: true };
  const scope = resolveAskScope(undefined, configured, scopeDocs, ['r-default']);
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, []);
});

test('落点与全局范围有交集时取交集', () => {
  const configured: RagScope = { mode: 'repos', repoIds: ['r-b', 'r-default'], docIds: [], includeAttachments: true };
  const scope = resolveAskScope(undefined, configured, scopeDocs, ['r-default']);
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids, ['n1']);
});

test('不给落点时范围不受影响（管理员划定的范围原样生效）', () => {
  const configured: RagScope = { mode: 'repos', repoIds: ['r-a'], docIds: [], includeAttachments: true };
  const scope = resolveAskScope(undefined, configured, scopeDocs, []);
  const ids = selectAgentCandidates(scopeDocs, { scope }).map((d) => d.id);
  assert.deepEqual(ids.sort(), ['a1', 'a2']);
});
