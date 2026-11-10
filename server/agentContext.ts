/**
 * 问答的检索上下文。
 *
 * 「召回 → 精排 → 拼上下文 → 组织消息」这段逻辑原先内联在 /api/agent/ask 的路由里。
 * 任务要复用它——任务里的「智能问答」步骤必须和面板里的问答问出一样的结果，
 * 而复制一份必然走样：两边的范围判定、候选上限、附件处理一旦不同步，
 * 用户会看到「面板里问得到，任务里问不到」，那比直接报错更难排查。
 *
 * 所以抽到这里，问答路由与任务里的问答步骤用的是同一份实现。
 */
import { defaultRepoId, getDoc, listAllDocs, recallAttachmentIds, recallDocIds } from './db.ts';
import { listRepos } from './repos.ts';
import { loadAttachmentsWithText } from './attachments.ts';
import { detectRepoFocus, normalizeRagScope, resolveAskScope, selectAgentCandidates } from './docAccess.ts';
import {
  SYSTEM_PROMPT,
  buildContext,
  docToUnit,
  retrieveDocs,
  type RetrievedUnit,
  type RetrievalUnit,
} from '../shared/retrieval.ts';
import type { AgentSettings } from '../shared/types.ts';
import type { UpstreamMessage } from './upstream.ts';

/** 一次召回的条数上限：先多召回一些交给精排，只读正文时才按候选上限收敛 */
const RECALL_LIMIT = 40;

/** 召回之后交给精排的候选上限 */
const CANDIDATE_LIMIT = 40;

/** 一条引用（与前端展示的 source 结构一致） */
export interface AskSource {
  id: string;
  name: string;
  kind: string;
  docId?: string;
  score: number;
  snippet: string;
}

/** 一次检索的完整结果 */
export interface AskRetrieval {
  /** 拼给模型的资料正文 */
  context: string;
  /** 真正参与本次回答的资料 */
  sources: AskSource[];
  /** 本次实际落在哪几个仓库 */
  scopeRepos: string[];
  /** 精排后的单元，构造消息时还要用 */
  retrieved: RetrievedUnit[];
}

/**
 * 检索本次问题相关的资料。
 *
 * 范围是安全边界：索引里命中了还不够，得再过一遍范围才算数。
 * 「找得到」是检索的事，「准不准看」是范围的事，两件事分开做——
 * 所以这里先按范围圈定候选，再在其中检索，而不是先检索再筛。
 */
export function retrieveForAsk(opts: {
  question: string;
  cfg: AgentSettings;
  rawScope?: unknown;
  /**
   * 上游提供的资料。
   *
   * 任务里「检索 → 问答」是最常见的组合：上游已经把资料查出来了，
   * 下游再拿一句抽象的问题去重新检索，往往什么也检索不到——
   * 检索用的是关键词，而「根据刚才的结果总结一下」这类话不是关键词。
   * 所以上游的产出要直接进上下文，而不是指望下游再查一遍。
   */
  extraContext?: string;
}): AskRetrieval {
  const { question, cfg, rawScope, extraContext } = opts;
  const docs = listAllDocs();
  const repos = listRepos();

  /**
   * 本次只看哪几个仓库。
   *
   * 优先级：界面上明确选定的仓库 → 问题里点名的仓库 → 默认仓库。
   *
   * 「默认仓库」是兜底落点：没点名时不该让模型把各项目的资料混着答，
   * 否则 A 项目的结论会被 B 项目的资料带偏。
   * 但管理员若已在设置里划定了范围（仓库白名单或指定文档），
   * 那份划定本身就是「看哪些仓库」的答案，不再叠加默认落点——
   * 否则默认仓库不在白名单里时，交集直接为空，Agent 会彻底答不出话。
   */
  const requestedScope = normalizeRagScope(rawScope);
  const explicitRepoIds =
    requestedScope && requestedScope.mode === 'repos' && requestedScope.repoIds.length > 0
      ? requestedScope.repoIds
      : detectRepoFocus(question, repos);
  const focusRepoIds =
    explicitRepoIds.length > 0
      ? explicitRepoIds
      : cfg.ragScope.mode === 'all' && repos.length > 0
        ? [defaultRepoId()]
        : [];

  /**
   * 本次实际能看的范围。
   *
   * 默认取全局配置，允许本次提问临时收窄，但**收窄只能更严不能更宽**：
   * 请求里带的范围若比配置更松，按配置的来。
   * 免得有人改个前端参数就把范围绕过去了——范围是安全边界，
   * 它的收紧权只在管理员手里。
   */
  const scope = resolveAskScope(rawScope, cfg.ragScope, docs, focusRepoIds);

  const repoEnabled = new Map(repos.map((r) => [r.id, r.ragEnabled]));
  const isRepoEnabled = (repoId: string | null | undefined) =>
    repoId ? repoEnabled.get(repoId) !== false : true;

  const candidates = selectAgentCandidates(docs, { scope, isRepoEnabled });
  const allowedDocIds = new Set(candidates.map((d) => d.id));
  const docNames = new Map(docs.map((d) => [d.id, d.name]));

  // 召回交给 FTS5 索引：查一遍索引，命中哪几篇就只读哪几篇的正文。
  // 老做法是每次提问都把全站正文读进内存再逐篇分词——资料一多就慢得没法用。
  const units: RetrievalUnit[] = [];

  for (const hit of recallDocIds(question, RECALL_LIMIT)) {
    if (!allowedDocIds.has(hit.id)) continue;
    const doc = getDoc(hit.id);
    if (!doc) continue;
    units.push(docToUnit(doc));
    if (units.length >= CANDIDATE_LIMIT) break;
  }

  // 附件正文也是可供检索的资料，只是来源不同，所以同样进索引、同样召回。
  // 它的可见性完全跟随宿主文档——宿主不在范围内，它的附件也不在。
  if (scope.includeAttachments) {
    const attHits = recallAttachmentIds(question, RECALL_LIMIT);
    for (const item of loadAttachmentsWithText(attHits.map((h) => h.id))) {
      if (!allowedDocIds.has(item.attachment.docId)) continue;
      units.push({
        id: `att:${item.attachment.id}`,
        name: `${docNames.get(item.attachment.docId) ?? '未知文档'} › ${item.attachment.name}`,
        content: item.text,
        kind: 'attachment',
        docId: item.attachment.docId,
      });
      if (units.length >= CANDIDATE_LIMIT) break;
    }
  }

  // 候选已经被索引筛到几十篇，这一轮精排很轻：
  // 在小集合上按词频算相关度，取出真正相关的几篇并给出命中片段。
  const retrieved = retrieveDocs(question, units, { topK: cfg.topK });
  const searched = buildContext(retrieved, cfg.contextBudget);
  // 上游提供的资料排在检索结果之前：它是本次问题真正的出发点，
  // 检索只是补充。
  const context = extraContext ? `${extraContext}\n\n${searched}` : searched;

  return {
    context,
    retrieved,
    scopeRepos: repos.filter((r) => focusRepoIds.includes(r.id)).map((r) => r.name),
    sources: retrieved.map((r) => ({
      id: r.unit.id,
      name: r.unit.name,
      kind: r.unit.kind,
      docId: r.unit.docId,
      score: r.score,
      snippet: r.snippet,
    })),
  };
}

/**
 * 把检索结果与问题组织成发给上游的消息。
 *
 * 系统提示与资料正文合成一条 system 消息：拆成两条反而会让部分网关
 * 把后一条当成用户输入，模型的回答口径会飘。
 */
export function buildAskMessages(
  question: string,
  retrieval: AskRetrieval,
  history: Array<{ role: string; content: string }> = [],
): UpstreamMessage[] {
  const { context } = retrieval;
  return [
    {
      role: 'system',
      content: context ? `${SYSTEM_PROMPT}\n\n以下是可供分析的文档资料：\n${context}` : SYSTEM_PROMPT,
    },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];
}
