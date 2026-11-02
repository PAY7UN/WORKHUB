/**
 * 文档的访问范围判定。
 *
 * 单独抽成模块而不是留在 index.ts 里，是因为这件事是**安全边界**：
 * 哪些文档允许进入 Agent 的检索范围。
 *
 * 安全边界必须有回归保护。放在入口文件里就只能靠端到端脚本间接覆盖，
 * 一旦有人重构路由就可能悄悄改掉判定而没人察觉。
 *
 * 注：「对访客隐藏」已下线，访客与管理员看到同一份文档清单，因此这里
 * 不再需要「按身份裁剪清单」这一层判断——保密完全由加密承担。
 */
import type { DocNode, RagScope } from '../shared/types.ts';

/** 范围判定的可选输入 */
export interface ScopeOptions {
  /**
   * 检索范围。缺省视为全站。
   *
   * 缺省取最宽是刻意的：范围只该由管理员显式收紧，
   * 而不是因为某处漏传参数就悄悄少看了一半资料。
   */
  scope?: RagScope;
  /**
   * 判断某个仓库是否参与检索。
   *
   * 仓库可以整体关掉检索（只留档、不进模型），
   * 这是比 repoIds 白名单更粗的一档控制。
   */
  isRepoEnabled?: (repoId: string | null | undefined) => boolean;
}

/** 默认的仓库启用判断：没有仓库信息就当作启用 */
const alwaysEnabled = () => true;

/**
 * 判断一篇文档是否落在检索范围内。
 *
 * 三道关，顺序即优先级：
 * 1. 本身可检索（是文件、未加密）；
 * 2. 所属仓库参与检索；
 * 3. 落在配置的范围之内。
 */
export function isInScope(doc: DocNode, options: ScopeOptions = {}): boolean {
  if (doc.type !== 'file' || doc.encrypted) return false;

  const isRepoEnabled = options.isRepoEnabled ?? alwaysEnabled;
  if (!isRepoEnabled(doc.repoId)) return false;

  const scope = options.scope;
  if (!scope) return true;

  if (scope.mode === 'repos') {
    // 管理员圈定了某几个仓库，意思就是「只看这几块」。
    // 文档必有归属（repoId 不为空），所以只管看仓库对不对得上。
    return scope.repoIds.includes(doc.repoId);
  }

  if (scope.mode === 'docs') {
    return scope.docIds.includes(doc.id);
  }

  return true;
}

/**
 * Agent 检索的候选文档。
 *
 * 加密文档一律排除，且**不区分身份**——管理员身份也不行。
 *
 * 加密文档连模型都不能碰到内容，否则它会经由回答泄进对话记录、
 * 甚至被写进日志与第三方平台的会话记录。
 */
export function selectAgentCandidates(docs: DocNode[], options: ScopeOptions = {}): DocNode[] {
  return docs.filter((d) => isInScope(d, options));
}

/**
 * 归一化前端传来的检索范围。
 *
 * 前端提交的是完整的一份，服务端只接受合法取值：
 * 模式只认三种，仓库与文档 id 必须是字符串数组，
 * 附件开关默认开——关掉是管理员的显式动作。
 */
export function normalizeRagScope(raw: unknown): RagScope | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<RagScope>;
  const mode: RagScope['mode'] = r.mode === 'repos' || r.mode === 'docs' ? r.mode : 'all';
  return {
    mode,
    repoIds: Array.isArray(r.repoIds) ? r.repoIds.filter((x): x is string => typeof x === 'string') : [],
    docIds: Array.isArray(r.docIds) ? r.docIds.filter((x): x is string => typeof x === 'string') : [],
    includeAttachments: r.includeAttachments !== false,
  };
}

/**
 * 从问题里认出「明确点到某个仓库」的措辞。
 *
 * 判定标准只有一个：仓库名出现在问题里。
 * 这是最直白的「明确指向」——猜「大概是指哪个仓库」只会让回答跑偏，
 * 而说错了仓库名的代价是答非所问，宁可当作没指定。
 *
 * 名字互相包含时只认更长的那个：同时存在「项目」与「项目甲」时，
 * 问的显然是后者，把两个仓库都算进去等于没指定。
 */
export function detectRepoFocus(
  question: string,
  repos: Array<{ id: string; name: string }>,
): string[] {
  const q = question.trim();
  if (!q) return [];

  // 长的先判：这样「项目甲」命中后，「项目」会被它盖掉
  const candidates = repos
    .filter((r) => r.name.trim())
    .sort((a, b) => b.name.trim().length - a.name.trim().length);

  const picked: Array<{ id: string; name: string }> = [];
  for (const repo of candidates) {
    const name = repo.name.trim();
    if (!q.includes(name)) continue;
    // 已被更长的名字覆盖：不再单独算一个仓库
    if (picked.some((p) => p.name.includes(name))) continue;
    picked.push({ id: repo.id, name });
  }
  return picked.map((p) => p.id);
}

/**
 * 解析本次提问使用的检索范围。
 *
 * 规则是「只能更严，不能更宽」：
 * - 请求没带范围 → 用全局配置；
 * - 请求带了范围 → 与全局配置取交集，窄的那份说了算。
 *
 * 交集是落在「具体文档集合」上算的，而不是按 mode 挑一份来用。
 * 因为三种 mode 之间没有天然的包含关系：全局限定到「文档 X」时，
 * 请求即使只说「仓库 R」，也可能带出 X 之外的文档——
 * 只按 mode 挑，等于把范围悄悄放宽了。
 * 只有落到文档粒度做交集，才谈得上「更严」。
 *
 * focusRepoIds 是「本次只看哪几个仓库」这一层落点（默认仓库或问题里点名的仓库）。
 * 它同样只参与取交集，不会把管理员划定的范围撑大。
 *
 * 这样做的原因：范围是「模型能看到什么」的边界，
 * 收紧它可以是临时的（用户此刻只想聊某个项目），
 * 但放宽它必须是管理员在设置里做的显式动作，不能靠改一个请求参数。
 */
export function resolveAskScope(
  requested: unknown,
  configured: RagScope,
  docs: DocNode[],
  focusRepoIds: string[] = [],
): RagScope {
  const requestedScope = normalizeRagScope(requested);

  /** 某份范围实际覆盖的文档集合；null 表示不限制 */
  const covered = (scope: RagScope): Set<string> | null => {
    if (scope.mode === 'all') return null;
    if (scope.mode === 'docs') return new Set(scope.docIds);
    const repoIds = new Set(scope.repoIds);
    const set = new Set<string>();
    for (const d of docs) {
      if (d.repoId && repoIds.has(d.repoId)) set.add(d.id);
    }
    return set;
  };

  const configuredSet = covered(configured);
  const requestedSet = requestedScope ? covered(requestedScope) : null;

  // 仓库落点：这些仓库之外的文档一律不参与本次问答
  const focusSet = focusRepoIds.length
    ? new Set(
        docs.filter((d) => d.repoId && focusRepoIds.includes(d.repoId)).map((d) => d.id),
      )
    : null;

  // 三层取交集：null 表示这一层不限制，非空即以它为准
  const intersect = (a: Set<string> | null, b: Set<string>): Set<string> =>
    a ? new Set([...a].filter((id) => b.has(id))) : new Set(b);

  let effective: Set<string> | null = null;
  for (const layer of [configuredSet, requestedSet, focusSet]) {
    if (!layer) continue;
    effective = intersect(effective, layer);
  }

  // 附件：全局关掉就是关掉，请求不能偷偷打开
  const includeAttachments = configured.includeAttachments && requestedScope?.includeAttachments !== false;

  if (!effective) {
    return { mode: 'all', repoIds: [], docIds: [], includeAttachments };
  }
  return { mode: 'docs', repoIds: [], docIds: [...effective], includeAttachments };
}
