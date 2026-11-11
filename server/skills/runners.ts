/**
 * 能力的服务端执行体。
 *
 * skills/ 目录里的 SKILL.md 说的是「这份能力能干什么」，
 * 这里给的是「拿到参数之后真的去做」。
 * 两份必须一一对应：目录里出现一个跑不起来的能力，
 * 比目录里少一份能力更糟——用户会照着说明书去建任务，跑起来才发现是空头支票。
 *
 * 与界面共用同一套语义：能力页里手动跑一次，任务里自动跑，
 * 执行逻辑只有这一份。
 */
import { getAgentConfigPublic, listAllDocs, searchDocs } from '../db.ts';
import { listRepos, repoStats } from '../repos.ts';
import { listAttachments } from '../attachments.ts';
import { buildAskMessages, retrieveForAsk } from '../agentContext.ts';
import { readUpstreamStream } from '../upstream.ts';
import { fetchWeb } from './webFetch.ts';
import { analyze, formatAnalyzeResult } from './dataAnalyze.ts';
import type { AgentSettings } from '../../shared/types.ts';

/** 能力执行失败：message 是给用户看的原因，不是堆栈 */
export class SkillRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillRunError';
  }
}

/** 执行能力时的上下文 */
export interface SkillRunContext {
  /** 执行者的用户 id */
  userId: string;
  /** 是否管理员：部分能力只对管理员开放 */
  isAdmin: boolean;
  /** Agent 配置（模型凭据、检索范围、上下文预算） */
  cfg: AgentSettings;
  /** 本次运行的输入（调用方给的原始问题） */
  input?: string;
  /**
   * 上游已经产出的内容。
   *
   * 「检索 → 问答」这类串联，光靠参数占位符是不够的：
   * 下游往往只写一句「根据上面的结果总结」，那句话不是检索关键词，
   * 指望它自己再查一遍只会查空。把上游的产出直接递下去才顺手。
   */
  upstream?: string;
  /** 上游资料的段数：用来把「引用了几份资料」说准 */
  upstreamCount?: number;
  /** 中止信号 */
  signal?: AbortSignal;
}

/** 能力的执行结果 */
export interface SkillRunResult {
  /** 一句话摘要：这一步干了什么 */
  summary: string;
  /** 输出正文：下游可以引用它 */
  output: string;
  /** 结构化数据，给界面展示用 */
  data: unknown;
  /**
   * 可续接的载荷：给下一步接着算用的原始内容。
   *
   * 和 output 的区别：output 是给人看的（带标题、带来源说明），
   * payload 是给机器接的（纯内容）。串联时必须用 payload——
   * 拿 output 去解析，解析器会先撞上「来源：」那一行。
   */
  payload?: string;
}

/** 一个能力的执行器 */
export type SkillRunner = (params: Record<string, string>, ctx: SkillRunContext) => Promise<SkillRunResult>;

/** 读参数并去掉首尾空白 */
function param(params: Record<string, string>, key: string): string {
  return (params[key] ?? '').trim();
}

/* ------------------------------ 检索与内容 ------------------------------ */

/**
 * 全文检索。
 *
 * 走 FTS5 索引，与界面上的搜索栏是同一条链路：
 * 用户在能力页看到的命中条数与片段，应当和在任务里看到的一致。
 */
const docSearch: SkillRunner = async (params) => {
  const q = param(params, 'q');
  if (!q) throw new SkillRunError('关键词为空，检索无从下手');
  const hits = searchDocs(q, 50);
  const output = hits.map((h, i) => `[${i + 1}] ${h.name}（${h.path}）\n${h.snippet}`).join('\n\n');
  return {
    summary: `命中 ${hits.length} 篇`,
    output: output || '没有命中任何文档',
    data: hits,
  };
};

/** 文档清单：只给元数据，正文不在其中 */
const docList: SkillRunner = async () => {
  const docs = listAllDocs();
  const output = docs.map((d) => `${d.name}（${d.type}）`).join('\n');
  return {
    summary: `共 ${docs.length} 篇文档`,
    output: output || '库里还没有文档',
    data: docs.map((d) => ({ id: d.id, name: d.name, type: d.type, updatedAt: d.updatedAt })),
  };
};

/** 仓库清单：项目是资料的容器，先看清分了几摊再谈检索 */
const repoList: SkillRunner = async () => {
  const repos = listRepos();
  const stats = repoStats();
  const statMap = new Map(stats.map((s) => [s.repoId, s]));
  const rows = repos.map((r) => {
    const s = statMap.get(r.id);
    return {
      id: r.id,
      name: r.name,
      docCount: s?.docCount ?? 0,
      attachmentCount: s?.attachmentCount ?? 0,
      totalSize: s?.totalSize ?? 0,
    };
  });
  const output = rows.map((r) => `${r.name}：${r.docCount} 篇文档 / ${r.attachmentCount} 个附件`).join('\n');
  return {
    summary: `共 ${rows.length} 个仓库`,
    output: output || '还没有仓库',
    data: rows,
  };
};

/** 附件的文本抽取状态 → 人话 */
const ATTACHMENT_TEXT_STATUS: Record<string, string> = {
  ok: '可检索',
  none: '未抽取文本',
  unsupported: '该格式不抽文本',
  failed: '抽取失败',
};

/** 附件清单：附件的可见性完全跟随宿主文档 */
const attachmentList: SkillRunner = async (params) => {
  const docId = param(params, 'docId');
  if (!docId) throw new SkillRunError('缺少文档 id');
  const attachments = listAttachments(docId);
  const output = attachments
    .map((a) => `${a.name}（${Math.round(a.size / 1024)} KB，${ATTACHMENT_TEXT_STATUS[a.textStatus] ?? a.textStatus}）`)
    .join('\n');
  return {
    summary: `共 ${attachments.length} 个附件`,
    output: output || '该文档没有附件',
    data: attachments.map((a) => ({ id: a.id, name: a.name, size: a.size, textStatus: a.textStatus })),
  };
};

/* ------------------------------ 智能 ------------------------------ */

/** Agent 状态：让任务能先确认「这台机器能不能问模型」 */
const agentStatus: SkillRunner = async (_params, ctx) => {
  const pub = getAgentConfigPublic();
  const usable = Boolean(pub.hasApiKey) && (ctx.isAdmin || pub.allowGuest);
  const reason = !pub.hasApiKey ? 'NO_API_KEY' : !ctx.isAdmin && !pub.allowGuest ? 'GUEST_DISABLED' : '';
  return {
    summary: usable ? `可用（模型 ${pub.model}）` : '不可用',
    output: usable
      ? `Agent 可用，模型为 ${pub.model}`
      : `Agent 不可用：${reason === 'NO_API_KEY' ? '尚未配置 API Key' : '管理员尚未开放访客使用 Agent'}`,
    data: { ...pub, usable, reason },
  };
};

/**
 * 智能问答。
 *
 * 与面板里的问答同一条链路（见 server/agentContext.ts），
 * 区别只在结果的取法：面板要边读边转发给浏览器，这里要一次拿完整答案，
 * 好让下游引用它。
 */
const agentAsk: SkillRunner = async (params, ctx) => {
  const asked = (params.question ?? '').trim() || (ctx.input ?? '').trim();
  const upstream = (ctx.upstream ?? '').trim();
  if (!asked && !upstream) throw new SkillRunError('问题不能为空');
  if (!ctx.cfg.apiKey.trim()) throw new SkillRunError('尚未配置 API Key，请联系管理员');
  if (!ctx.isAdmin && !ctx.cfg.allowGuest) throw new SkillRunError('管理员尚未开放访客使用 Agent');

  // 没写问题、但上游有东西（比如刚取到的数据）时，
  // 就让模型自己看资料：问法是死的，资料是活的。
  // 不这么兜底的话，「取数 → 解读」这条最自然的用法会卡在「问题不能为空」。
  const question = asked || '请分析这份数据，说明你看到的规律、异常和值得注意的地方。';

  const retrieval = retrieveForAsk({ question, cfg: ctx.cfg, extraContext: upstream });
  const messages = buildAskMessages(question, retrieval);

  let answer = '';
  let failure = '';
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });

  await readUpstreamStream({
    cfg: ctx.cfg,
    messages,
    signal: controller.signal,
    handlers: {
      onDelta: (text) => {
        answer += text;
      },
      onError: (message) => {
        failure = message;
      },
    },
  });
  ctx.signal?.removeEventListener('abort', onAbort);

  if (failure) throw new SkillRunError(failure);
  if (!answer.trim()) throw new SkillRunError('模型未返回任何内容，请检查模型名与 API Key，或稍后重试');

  // 资料来源要说准：模型引用的「资料1」往往来自上游给的资料，
  // 而不是本次检索命中的文档。只报检索篇数会让人以为模型没拿到东西。
  const cited = [
    ctx.upstreamCount ? `上游 ${ctx.upstreamCount} 段` : '',
    retrieval.sources.length ? `检索 ${retrieval.sources.length} 篇` : '',
  ].filter(Boolean);

  return {
    summary: `回答完成（${cited.join(' / ') || '无引用'}）`,
    output: answer,
    data: { answer, sources: retrieval.sources, scopeRepos: retrieval.scopeRepos },
  };
};

/* ------------------------------ 注册表 ------------------------------ */

/**
 * 网页请求。
 *
 * 给的是 URL，拿到的是正文：HTML 抽成可读文本，JSON 解析成结构化数据。
 * 摘要只说清楚「取到了什么」，正文另存——下游要算数的时候用得着原始内容。
 */
const webFetch: SkillRunner = async (params, ctx) => {
  const url = param(params, 'url');
  if (!url) throw new SkillRunError('请给出要请求的地址');

  const result = await fetchWeb(
    {
      url,
      method: param(params, 'method') || 'GET',
      headers: param(params, 'headers'),
      body: param(params, 'body'),
      timeoutSec: Number(param(params, 'timeoutSec')) || undefined,
      maxChars: Number(param(params, 'maxChars')) || undefined,
    },
    ctx.signal,
  );

  const kindText = result.kind === 'json' ? 'JSON' : result.kind === 'html' ? '网页' : '文本';
  const sizeText = result.bytes < 1024 ? `${result.bytes} 字节` : `${(result.bytes / 1024).toFixed(1)} KB`;
  const summary = `${result.status} ${result.statusText}｜${kindText}｜${sizeText}${result.truncated ? '｜已截断' : ''}`;

  const output = [
    result.title ? `标题：${result.title}` : '',
    `来源：${result.finalUrl}`,
    '',
    result.text,
  ]
    .filter((part) => part !== '')
    .join('\n');

  return {
    summary,
    output: output || '（内容为空）',
    // 续接用纯内容：JSON 就是 JSON 原文，HTML 就是抽好的正文
    payload: result.text,
    data: {
      url: result.finalUrl,
      status: result.status,
      contentType: result.contentType,
      kind: result.kind,
      title: result.title,
      text: result.text,
      truncated: result.truncated,
      bytes: result.bytes,
    },
  };
};

/**
 * 数据分析。
 *
 * source 可以是数据本身，也可以是一个地址——是地址就先取回来再算。
 * 还可以不传 source：那就用上游的产出接着算（web.fetch 拿到的 JSON 直接喂进来）。
 */
const dataAnalyze: SkillRunner = async (params, ctx) => {
  const op = (param(params, 'op') || 'describe') as 'describe' | 'groupby' | 'filter' | 'top';

  let source = param(params, 'source');
  let origin = '直接给的数据';
  if (!source) {
    source = (ctx.upstream ?? '').trim();
    origin = '上一步的产出';
  }
  if (!source) throw new SkillRunError('没有数据可分析：请给 source，或先取回数据再让我接着算');

  // 给的是地址就先取回来
  if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchWeb({ url: source }, ctx.signal);
    if (fetched.status >= 400) throw new SkillRunError(`取数据失败：${fetched.status} ${fetched.statusText}`);
    source = fetched.text;
    origin = fetched.finalUrl;
  }

  const result = analyze({
    source,
    format: (param(params, 'format') || 'auto') as 'auto' | 'json' | 'csv' | 'tsv',
    op,
    groupBy: param(params, 'groupBy'),
    column: param(params, 'column'),
    condition: param(params, 'condition'),
    value: param(params, 'value'),
    limit: Number(param(params, 'limit')) || undefined,
  });

  const output = [`数据来源：${origin}`, '', formatAnalyzeResult(result, op)].join('\n');
  const summary =
    op === 'describe'
      ? `${result.rows} 行 × ${result.columns.length} 列，已给出画像`
      : op === 'groupby'
        ? `${result.rows} 行分成 ${result.groups?.length ?? 0} 组`
        : `命中 ${result.matchedCount ?? 0} 行`;

  return { summary, output, payload: formatAnalyzeResult(result, op), data: result };
};

/**
 * 能力执行体注册表。
 *
 * key 与 skills/ 目录里的 id 一一对应。
 * 注意这里只登记「读类 + 智能」能力：会写数据的能力（提交授权申请）
 * 留在能力页手动执行——任务一次跑错就是错数据，代价远高于手动点一下。
 */
export const SKILL_RUNNERS: Record<string, SkillRunner> = {
  'doc.search': docSearch,
  'doc.list': docList,
  'repo.list': repoList,
  'attachment.list': attachmentList,
  'agent.status': agentStatus,
  'agent.ask': agentAsk,
  'web.fetch': webFetch,
  'data.analyze': dataAnalyze,
};

/**
 * 取能力执行体。
 *
 * 执行器得真的实现了才算数：目录里声明了能力却没实现，
 * 宁可报错说清楚，也不能让任务跑到一半才炸。
 */
export function findSkillRunner(id: string): SkillRunner | undefined {
  return SKILL_RUNNERS[id];
}
