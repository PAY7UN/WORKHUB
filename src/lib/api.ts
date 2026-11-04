/**
 * 服务端 API 客户端：统一附带 JWT、错误提示与 SSE 流解析。
 * 文档与 Agent 凭据均由服务端持有，本文件不接触任何模型密钥。
 */
import type {
  AccessAuditEntry,
  AccessCapability,
  AccessGrant,
  AccessRequest,
  AgentSettings,
  Attachment,
  DingTalkChannel,
  DingTalkConfigView,
  DocNode,
  DocSearchHit,
  GuestIdentity,
  PolishTask,
  RagScope,
  Reminder,
  ReminderRepeat,
  ReminderStatus,
  Repo,
  RepoStat,
  User,
} from '../../shared/types';
import { saveBlob } from '../utils';

const TOKEN_KEY = 'mdhub.token';
const BASE = '/api';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下忽略 */
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * 注册登录失效回调。
 * api 层只知道令牌已作废，上层还需据此把 isAdmin 等身份状态一并复位，
 * 否则界面仍显示为管理员，实际所有写操作都会被拒绝。
 */
export function onUnauthorized(fn: UnauthorizedHandler): void {
  unauthorizedHandler = fn;
}

export class ApiError extends Error {
  status: number;
  /**
   * 服务端附带的结构化信息。
   *
   * 有些错误光看文案不够用：比如「打不开加密文档」有三种原因
   * （没申请 / 在审 / 被拒），前端要按原因显示不同的界面。
   */
  data?: Record<string, unknown>;
  constructor(message: string, status: number, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    // credentials: 'include' —— 访客会话在 httpOnly cookie 里，不带上的话
    // 申请与授权都认不出「是谁」
    res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    throw new ApiError('无法连接服务端，请确认后端已启动（端口见 .env 的 WORKHUB_PORT）', 0);
  }

  // 只有服务端明确标记「令牌已过期/失效」时才清登录态。
  // 早先的判断是「状态码 401 一律当作登录失效」，太粗：
  // 任何业务性的 401（密码输错、凭证不对）都会把人踢回访客，
  // 而且真正的错因会被「登录已失效，请重新登录」盖住——
  // 用户明明输错了当前密码，看到的却是登录过期，越改越糊涂。
  const authExpired = res.headers.get('x-auth-expired') === '1';
  if (res.status === 401 && authExpired) {
    // 只有当本地令牌仍是发起本次请求时的那一个才清理。
    // 登录换发新令牌后，此前在飞的旧请求仍带着过期令牌陆续返回 401，
    // 无条件清除会把刚拿到的新令牌一并抹掉，用户看到的就是
    // 「刚切换成管理员又立刻被踢回访客」
    if (!token || getToken() === token) {
      setToken('');
      unauthorizedHandler?.();
    }
    throw new ApiError('登录已失效，请重新登录', 401);
  }
  if (res.status === 401) {
    // 业务性的 401：保留原始错因，不动登录态
    let msg = '请求失败（HTTP 401）';
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      if (data?.error || data?.message) msg = data.error || data.message || msg;
    } catch {
      /* 忽略解析失败 */
    }
    throw new ApiError(msg, 401);
  }
  if (!res.ok) {
    let msg = `请求失败（HTTP ${res.status}）`;
    let data: Record<string, unknown> | undefined;
    try {
      const parsed = (await res.json()) as { error?: string; message?: string };
      data = parsed as Record<string, unknown>;
      // 各端点历史上用过 error 与 message 两种字段名，缺失具体原因会退化成
      // 无信息量的「HTTP 400」，用户无从判断该拆分文档还是检查权限
      if (parsed?.error || parsed?.message) msg = parsed.error || parsed.message || msg;
    } catch {
      // 响应体不是 JSON —— 说明请求压根没命中后端路由，Express 回了 HTML 404 页。
      // 这种情况通常是后端进程还跑着旧版本代码（前端已更新、后端没重启），
      // 直说「重启后端」比让人对着一个没有信息量的状态码猜要省事得多。
      if (res.status === 404) msg = '接口不存在：服务端可能仍在运行旧版本代码，重启后端即可';
    }
    throw new ApiError(msg, res.status, data);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * 从失败响应里取出服务端给的那句原因。
 *
 * 服务端的错误体统一是 { error }，但下载与预览这两条路不走 request()，
 * 所以这里补一个同口径的取值：拿得到原话就用原话，
 * 拿不到就退回调用方给的兜底文案。
 */
async function errorMessageOf(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; message?: string };
    return data?.error || data?.message || fallback;
  } catch {
    return fallback;
  }
}

export interface AgentStatus {
  canUse: boolean;
  reason: 'NO_API_KEY' | 'GUEST_DISABLED' | '';
  model: string;
  hasApiKey: boolean;
  allowGuest: boolean;
  /** 服务端判定的当前身份 */
  role: 'admin' | 'viewer';
}

/** 前端使用的 Agent 配置：apiKey 不参与传输，仅 hasApiKey 表示状态 */
export type AgentConfigView = Omit<AgentSettings, 'apiKey'> & { hasApiKey: boolean };

/** token 用量汇总：面板底部那一行只依赖这个结构 */
export interface AgentUsageSummary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
  byScene: Record<'chat' | 'polish', { calls: number; totalTokens: number }>;
  recent: Array<{ scene: string; model: string; totalTokens: number; createdAt: number }>;
}

/** 单次调用随 SSE 下发的用量 */
interface AgentUsageEvent {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export const api = {
  // 认证
  login: (password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  me: () =>
    request<{ user: User; isAnon: boolean; tokenInvalid?: boolean }>('/auth/me'),

  /**
   * 访客身份。
   *
   * 访客不需要账号，但「申请访问 → 审批 → 授权」得落到具体的人身上，
   * 所以服务端给浏览器发一个 httpOnly cookie 作为访客身份，这里读回它的昵称。
   */
  guestSession: () => request<GuestIdentity>('/auth/guest'),
  setGuestName: (name: string) =>
    request<GuestIdentity>('/auth/guest', { method: 'POST', body: JSON.stringify({ name }) }),

  /**
   * 修改管理员密码。
   *
   * 返回值里的新 token 必须立刻替换掉旧的：服务端改密后会让全部旧令牌失效
   * （令牌内含密码指纹），不换发的话用户改完密码自己就被踢下线了。
   */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ token: string; user: User }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // 文档
  listDocs: () => request<{ docs: DocNode[] }>('/docs'),

  /**
   * 取单篇文档（含正文）。
   *
   * 清单只回元数据——正文已经落到仓库目录的文件里，
   * 列全站就把整个仓库读一遍了。打开一篇就取一篇。
   */
  getDoc: (id: string) => request<{ doc: DocNode }>(`/docs/${id}`),
  createDoc: (input: {
    name: string;
    type: 'file' | 'folder';
    parentId: string | null;
    content?: string;
    /** 归属仓库；不传则沿用父节点所属仓库 */
    repoId?: string;
    /** 保留原始文件名（承载附件的条目用），不自动补 .md */
    rawName?: boolean;
  }) => request<{ doc: DocNode }>('/docs', { method: 'POST', body: JSON.stringify(input) }),
  updateDoc: (id: string, patch: Partial<DocNode>) =>
    request<{ doc: DocNode }>(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /**
   * 删除文档：连正文文件带目录结构一起抹掉，不留回收站。
   *
   * 删之前系统会提示一次，但提示过了就是真的没了——
   * 保留一份「已删除」的副本，等于同一份资料在库里有两个去处，
   * 迟早会对不上。
   */
  deleteDoc: (id: string) => request<{ removed: number }>(`/docs/${id}`, { method: 'DELETE' }),

  /**
   * 上传原件：文件本身就是这个文档。
   *
   * 上传一个 zip，树上就该出现这个 zip——而不是一篇叫「xxx.zip」的
   * 空 Markdown 笔记再外挂一个附件。文件不需要备注，
   * 备注反而会变成第二份可能互相矛盾的说法。
   *
   * 请求体是原始二进制：所有格式的共同点是「一段字节」，
   * 省掉 multipart 解析，也免了 base64 的三分之一体积膨胀。
   */
  uploadFile: (file: File, parentId: string | null, repoId?: string) => {
    const token = getToken();
    const qs = new URLSearchParams({
      name: file.name,
      mime: file.type || 'application/octet-stream',
    });
    if (parentId) qs.set('parentId', parentId);
    if (repoId) qs.set('repoId', repoId);
    return fetch(`${BASE}/docs/upload?${qs.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
      credentials: 'include',
    }).then(async (res) => {
      const data = (await res.json().catch(() => ({}))) as { doc?: DocNode; error?: string };
      if (!res.ok || !data.doc) {
        throw new ApiError(data.error || `上传失败（HTTP ${res.status}）`, res.status, data);
      }
      return data.doc;
    });
  },

  /**
   * 下载地址。
   *
   * 一条地址覆盖两种形态：原件按原始字节与原始文件名回传，
   * 笔记导出为 .md。浏览器据此决定是存盘还是直接显示。
   */
  downloadUrl: (id: string) => `${BASE}/docs/${id}/download`,

  /** 内联预览地址（图片、PDF 走这条） */
  rawUrl: (id: string) => `${BASE}/docs/${id}/raw`,

  /**
   * 取原件的字节（带鉴权）。
   *
   * 预览不能写成 <img src="/api/docs/:id/raw">：浏览器发这种请求不会带
   * Authorization 头，服务端只认得 cookie 里的访客身份——
   * 于是管理员打开自己加密的图片，看到的是一张裂图（403）。
   * 所以这里显式带上令牌取回字节，页面再用对象 URL 渲染。
   */
  fetchOriginal: async (id: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`${BASE}/docs/${id}/raw`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    });
    if (!res.ok) throw new ApiError(await errorMessageOf(res, `读取失败（HTTP ${res.status}）`), res.status);
    return res.blob();
  },

  /**
   * 下载并保存原件（笔记导出为 .md 也走这条）。
   *
   * 不用 window.location 跳转：那样浏览器不带 Authorization 头，
   * 管理员下载加密原件会被当成访客（403）；而且失败时用户被带离当前页面，
   * 只留下一屏 JSON 错误。这里把字节取回来再存盘，失败就抛一句人话。
   */
  downloadDoc: async (id: string, filename: string): Promise<void> => {
    const token = getToken();
    const res = await fetch(`${BASE}/docs/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    });
    if (!res.ok) throw new ApiError(await errorMessageOf(res, `下载失败（HTTP ${res.status}）`), res.status);
    saveBlob(await res.blob(), filename);
  },

  /**
   * 全文搜索：在标题与正文里找关键词。
   *
   * 访客与管理员共用这一个入口：搜的只是非加密文档的明文，访客本来就能读；
   * 加密文档的正文在库里只有密文，搜不到内容——边界由存储方式自动成立。
   */
  searchDocs: (q: string) =>
    request<{ query: string; hits: DocSearchHit[] }>(`/docs/search?q=${encodeURIComponent(q)}`),

  importDocs: (docs: DocNode[]) =>
    request<{ imported: number }>('/docs/import', { method: 'POST', body: JSON.stringify({ docs }) }),

  /**
   * 文档加密。
   *
   * 加密后正文只以密文落库，访客一律看不到内容。
   * 访问方式只有一条路：访客提交访问申请 → 管理员批准 → 访客凭授权免密打开。
   * 服务端不再签发、也不再存储任何访客口令。
   */
  encryptDoc: (id: string) => request<{ doc: DocNode }>(`/docs/${id}/encrypt`, { method: 'POST' }),

  /**
   * 管理员免密查看加密文档的正文。
   *
   * 服务端用主密钥解开数据密钥后直接返回明文；
   * 正文密文从不下发到浏览器——免的只是「输密码」这一步。
   */
  revealDoc: (id: string) => request<{ doc: DocNode }>(`/docs/${id}/reveal`, { method: 'POST' }),

  /** 取消加密：明文写回文档，之后回到普通文档的行列 */
  decryptDoc: (id: string) => request<{ doc: DocNode }>(`/docs/${id}/decrypt`, { method: 'POST' }),

  /**
   * 申请访问一篇加密文档（访客）。
   *
   * 提交后进入管理员的待审批列表；被批准即获得该文档的免密访问权。
   */
  requestDocAccess: (id: string, reason: string) =>
    request<{ request: AccessRequest }>(`/docs/${id}/access-request`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /**
   * 凭已批准的授权打开文档（访客免密）。
   *
   * 失败时错误对象里带 reason：none（没申请）/ pending（在审）/ rejected（被拒），
   * 前端据此显示不同的界面。
   */
  openDocByGrant: (id: string) => request<{ doc: DocNode }>(`/docs/${id}/access-open`, { method: 'POST' }),

  /**
   * 查访客此刻对某篇加密文档的权限状态（不含正文）。
   *
   * 轮询用：管理员一批准，访客界面自己就翻到正文，
   * 不必守在页面上手动点「我已获批，重新检查」。
   *
   * granted 时会带回 capabilities：授权只给了「查看」的话，
   * 前端据此把下载按钮藏起来。
   */
  checkDocAccess: (id: string) =>
    request<{
      granted: boolean;
      reason: 'granted' | 'pending' | 'rejected' | 'none';
      capabilities?: AccessCapability[];
    }>(`/docs/${id}/access-status`),

  /** 访问申请列表（管理员） */
  listAccessRequests: (status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending', docId?: string) =>
    request<{ items: AccessRequest[]; pending: number }>(
      `/access-requests?status=${status}${docId ? `&docId=${docId}` : ''}`,
    ),

  /**
   * 批准访问申请。
   *
   * expiresInDays 为 0 或不传表示长期有效。
   * capabilities 决定口子开多大：默认只有 view（能看），
   * 放行下载要显式带上 download（能拿走）。
   */
  approveAccessRequest: (id: string, expiresInDays = 0, capabilities: AccessCapability[] = ['view']) =>
    request<{ grant: AccessGrant }>(`/access-requests/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ expiresInDays, capabilities }),
    }),

  /**
   * 批量批准访问申请。
   *
   * 同一访客对多篇加密文档各提一次申请时，管理员不必连点 N 次「批准」；
   * 勾上一起批，共享同一个有效期与同一组能力。跳过的条目会逐条给出原因。
   */
  bulkApproveAccessRequests: (ids: string[], expiresInDays = 0, capabilities: AccessCapability[] = ['view']) =>
    request<{ approved: number; skipped: Array<{ id: string; reason: string }> }>(
      '/access-requests/bulk-approve',
      {
        method: 'POST',
        body: JSON.stringify({ requestIds: ids, expiresInDays, capabilities }),
      },
    ),

  /** 拒绝访问申请 */
  rejectAccessRequest: (id: string) =>
    request<{ ok: boolean }>(`/access-requests/${id}/reject`, { method: 'POST' }),

  /** 某篇文档的授权名单 */
  listDocAccessGrants: (id: string) => request<{ items: AccessGrant[] }>(`/docs/${id}/access-grants`),

  /** 全部授权总览 */
  listAllAccessGrants: () => request<{ items: AccessGrant[] }>('/access-grants'),

  /** 撤销授权：访客下一次打开就该被挡住 */
  revokeDocAccessGrant: (docId: string, grantId: string) =>
    request<{ ok: boolean }>(`/docs/${docId}/access-grants/${grantId}`, { method: 'DELETE' }),

  /**
   * 调整一条已有授权的口子大小。
   *
   * 批准时给错能力是常事。直接改比「撤销再重批」好：
   * 后者会把中间那段的口子状态从流水里抹掉。
   */
  updateDocAccessGrant: (
    docId: string,
    grantId: string,
    capabilities: AccessCapability[],
    expiresAt?: number | null,
  ) =>
    request<{ ok: boolean; capabilities: AccessCapability[] }>(
      `/docs/${docId}/access-grants/${grantId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ capabilities, expiresAt }),
      },
    ),

  /**
   * 批量授权：直接给某访客在多篇文档上开口子，不经过申请。
   *
   * 管理员已经清楚「该让谁看哪几篇」时用这个，比先造一堆申请单再逐条批省事。
   */
  bulkGrantAccess: (
    guestId: string,
    guestName: string,
    docIds: string[],
    expiresInDays = 0,
    capabilities: AccessCapability[] = ['view'],
  ) =>
    request<{ granted: number; skipped: number }>('/access-grants/bulk', {
      method: 'POST',
      body: JSON.stringify({ guestId, guestName, docIds, expiresInDays, capabilities }),
    }),

  /**
   * 访问审计流水（管理员）。
   *
   * 权限授出去之后会被追问的是「谁在什么时候看过、下载过什么」，
   * 这个问题只有流水答得上来。
   */
  listAccessAudit: (docId?: string) =>
    request<{ items: AccessAuditEntry[] }>(`/access-audit${docId ? `?docId=${docId}` : ''}`),

  /** 已知访客清单（批量授权时供管理员「选谁」） */
  listKnownGuests: () => request<{ items: Array<{ id: string; name: string }> }>('/access-guests'),

  /* 仓库（项目） */

  /**
   * 仓库清单。
   *
   * 仓库只是资料的组织方式，不是保密边界，所以访客也能读；
   * 写操作一律要管理员权限。
   */
  listRepos: () => request<{ repos: Repo[]; stats: RepoStat[] }>('/repos'),

  createRepo: (input: {
    name: string;
    description?: string;
    color?: string;
    allowedExts?: string[];
    maxFileSize?: number;
    ragEnabled?: boolean;
  }) => request<{ repo: Repo }>('/repos', { method: 'POST', body: JSON.stringify(input) }),

  updateRepo: (
    id: string,
    patch: {
      name?: string;
      description?: string;
      color?: string;
      allowedExts?: string[];
      maxFileSize?: number;
      ragEnabled?: boolean;
    },
  ) => request<{ repo: Repo }>(`/repos/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  /**
   * 删除仓库：连带其中的文档与附件一起抹掉，不留回收站。
   *
   * 返回值给出实际清掉的文档与附件数，界面据此提示「连带删掉了多少东西」。
   */
  deleteRepo: (id: string) =>
    request<{ removed: boolean; docs: number; attachments: number }>(`/repos/${id}`, { method: 'DELETE' }),

  /** 把文档归入仓库（跨仓库迁移，整棵子树一起搬） */
  assignDocsToRepo: (repoId: string, docIds: string[]) =>
    request<{ moved: number }>(`/repos/${repoId}/docs`, { method: 'POST', body: JSON.stringify({ docIds }) }),

  /* 附件 */

  /** 某篇文档的附件清单 */
  listAttachments: (docId: string) => request<{ attachments: Attachment[] }>(`/docs/${docId}/attachments`),

  /**
   * 上传附件。
   *
   * 请求体是**原始二进制**而不是 multipart：
   * 一个文件一段字节这件事对所有格式都成立，
   * 省掉一套 multipart 解析，也免了 base64 带来的三分之一体积膨胀。
   * 请求体固定用 application/octet-stream——否则上传 .json 文件时
   * 会被服务端的 JSON 解析器抢走并报「非法 JSON」。
   */
  uploadAttachment: (docId: string, file: File) => {
    const token = getToken();
    const qs = `name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type || 'application/octet-stream')}`;
    return fetch(`${BASE}/docs/${docId}/attachments?${qs}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
      credentials: 'include',
    }).then(async (res) => {
      const data = (await res.json().catch(() => ({}))) as { attachment?: Attachment; error?: string };
      if (!res.ok) throw new ApiError(data.error || `上传失败（HTTP ${res.status}）`, res.status, data);
      return data.attachment as Attachment;
    });
  },

  /** 附件下载地址 */
  attachmentUrl: (id: string) => `${BASE}/attachments/${id}/download`,

  renameAttachment: (id: string, name: string) =>
    request<{ attachment: Attachment }>(`/attachments/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  /** 把附件挂到另一篇文档下 */
  moveAttachment: (id: string, docId: string) =>
    request<{ attachment: Attachment }>(`/attachments/${id}/move`, { method: 'POST', body: JSON.stringify({ docId }) }),

  /** 删除附件：文件一并抹掉，不留回收站 */
  deleteAttachment: (id: string) => request<{ removed: boolean }>(`/attachments/${id}`, { method: 'DELETE' }),

  // Agent
  agentStatus: () => request<AgentStatus>('/agent/status'),
  getAgentConfig: () => request<{ config: AgentConfigView }>('/agent/config'),
  getAgentUsage: () => request<{ usage: AgentUsageSummary }>('/agent/usage'),
  saveAgentConfig: (patch: Partial<AgentConfigView> & { apiKey?: string; clearApiKey?: boolean }) =>
    request<{ config: AgentConfigView }>('/agent/config', { method: 'PUT', body: JSON.stringify(patch) }),

  /**
   * 提问并流式接收结果。
   * 服务端先推 sources（引用文档），再逐段推 delta，最后 done 或 error。
   *
   * scope 可传，用于显式指定「这次只看某个仓库」。
   * 不传则由服务端按默认规则落点（默认仓库，或问题里点名的仓库）。
   * 它只能比全局配置更严：服务端会取交集，放宽范围的权限在管理员设置里。
   */
  ask: (
    question: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    handlers: {
      onSources: (sources: AgentSource[], meta?: AgentScopeInfo) => void;
      onDelta: (text: string) => void;
      /** 推理模型的思考内容（部分上游才有） */
      onReasoning?: (text: string) => void;
      /** 本次调用的 token 用量；上游未下发时不会触发 */
      onUsage?: (usage: AgentUsageEvent) => void;
      signal: AbortSignal;
    },
    scope?: RagScope,
  ) => askStream(question, history, handlers, scope),

  /**
   * 提交润色任务，立即返回任务 id，不等待生成结束。
   *
   * 生成在服务端后台推进，用户关闭弹窗或刷新页面都不影响任务；
   * 进度与结果通过 `streamPolishTask` 订阅。
   */
  polish: async (input: {
    content: string;
    instruction: string;
    docId?: string;
    docName?: string;
    type?: string;
  }): Promise<string> => {
    const { taskId } = await request<{ taskId: string }>('/agent/polish', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return taskId;
  },

  /** 润色任务列表（进行中/已完成/失败），用于面板展示 */
  listPolishTasks: async (): Promise<PolishTask[]> => {
    const { tasks } = await request<{ tasks: PolishTask[] }>('/agent/polish-tasks');
    return tasks;
  },

  /** 订阅单个任务的进度。任务已完成时服务端会立即补发终态 */
  streamPolishTask: (
    id: string,
    handlers: {
      onState: (task: PolishTask) => void;
      onDelta: (text: string) => void;
      onReasoning?: (text: string) => void;
      signal: AbortSignal;
    },
  ): Promise<void> =>
    openEventStream(
      `/agent/polish-tasks/${id}/stream`,
      { method: 'GET' },
      handlers,
      '润色任务',
      (event, raw) => {
        if (event !== 'state') return;
        try {
          handlers.onState(JSON.parse(raw) as PolishTask);
        } catch {
          /* 忽略解析失败 */
        }
      },
    ),

  /**
   * 删除润色任务；任务仍在生成时先中止上游再删除。
   *
   * 取消与删除是同一个动作、同一套语义：中止后任务记录一并清除，不会留下
   * 一条「界面上消失、重新进入面板又出现」的任务。任务已不存在时服务端返回
   * 404，调用方应视为删除成功。
   */
  removePolishTask: async (id: string): Promise<void> => {
    await request(`/agent/polish-tasks/${id}`, { method: 'DELETE' });
  },

  /** 清空所有已结束的润色任务，进行中的原样保留 */
  clearFinishedPolishTasks: async (): Promise<{
    removed: string[];
    cancelled: string[];
    missing: string[];
  }> => {
    return request('/agent/polish-tasks/clear-finished', { method: 'POST' });
  },

  /* 钉钉同步 */

  /** 钉钉配置：密钥不回显，只拿到「已配置 / 未配置」 */
  getDingTalkConfig: () => request<{ config: DingTalkConfigView }>('/dingtalk/config'),

  /**
   * 保存钉钉配置。
   *
   * 密钥类字段留空表示保持原值；传 clearXxx 则清除。
   */
  saveDingTalkConfig: (
    patch: Partial<DingTalkConfigView> & {
      webhookSecret?: string;
      clearWebhookSecret?: boolean;
      appSecret?: string;
      clearAppSecret?: boolean;
    },
  ) => request<{ config: DingTalkConfigView }>('/dingtalk/config', { method: 'PUT', body: JSON.stringify(patch) }),

  /**
   * 连通性测试：按草稿配置发一条测试消息。
   * 不必先保存——改完配置直接测，测不过再改。
   */
  testDingTalk: (
    patch: Partial<DingTalkConfigView> & { webhookSecret?: string; appSecret?: string },
  ) => request<{ ok: boolean; message: string }>('/dingtalk/test', { method: 'POST', body: JSON.stringify(patch) }),

  /** 提醒清单 */
  listReminders: () => request<{ reminders: Reminder[] }>('/reminders'),

  /** 新建提醒。remindAt 为毫秒时间戳 */
  createReminder: (input: {
    title: string;
    content?: string;
    remindAt: number;
    repeat?: ReminderRepeat;
    channel?: DingTalkChannel;
    docId?: string;
  }) => request<{ reminder: Reminder }>('/reminders', { method: 'POST', body: JSON.stringify(input) }),

  /** 修改提醒：改时间、标题，或标记完成/取消 */
  updateReminder: (id: string, patch: { title?: string; content?: string; remindAt?: number; status?: ReminderStatus }) =>
    request<{ reminder: Reminder }>(`/reminders/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  /** 删除提醒记录 */
  deleteReminder: (id: string) => request<{ ok: boolean }>(`/reminders/${id}`, { method: 'DELETE' }),

  /** 立即发送一条提醒（与自动触发同一套逻辑） */
  fireReminder: (id: string) => request<{ reminder: Reminder }>(`/reminders/${id}/fire`, { method: 'POST' }),

};

interface StreamHandlers {
  onDelta: (text: string) => void;
  /** 推理模型的思考内容（部分上游才有） */
  onReasoning?: (text: string) => void;
  signal: AbortSignal;
}

async function postEventStream(
  path: string,
  body: unknown,
  handlers: StreamHandlers,
  actionLabel: string,
  onEvent?: (event: string, raw: string) => void,
): Promise<void> {
  return openEventStream(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    handlers,
    actionLabel,
    onEvent,
  );
}

/**
 * 建立 SSE 连接并把事件分派给 handlers，直到流结束。
 *
 * 问答与润色任务的线上格式一致（reasoning / delta / error），仅端点与附加事件不同，
 * 故帧解析与错误处理集中于此，避免两条链路的报错口径出现分歧。
 */
async function openEventStream(
  path: string,
  init: RequestInit,
  handlers: StreamHandlers,
  actionLabel: string,
  onEvent?: (event: string, raw: string) => void,
): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: handlers.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return;
    throw new ApiError('无法连接服务端，请确认后端已启动', 0);
  }

  if (!res.ok) {
    // 必须与 request() 保持同一口径，优先展示服务端给出的具体原因。
    // 图片转 md 的逐张校验（格式、体积、张数）都带了可读文案，丢掉它只会让用户
    // 看到一个无信息量的「HTTP 400」，无从判断该换模型、换图片还是检查权限。
    // 解析失败时保留状态码文案即可——例如 404 多半由 Express 直接返回，无 JSON 体。
    let msg = `${actionLabel}失败（HTTP ${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      if (data?.error || data?.message) msg = `${actionLabel}失败：${data.error || data.message}`;
    } catch {
      /* 无可解析的响应体，沿用状态码文案 */
    }
    throw new ApiError(msg, res.status);
  }
  if (!res.body) throw new ApiError('当前环境不支持流式响应', 0);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (event: string, raw: string) => {
    if (event === 'reasoning') {
      try {
        const { text } = JSON.parse(raw) as { text: string };
        if (text) handlers.onReasoning?.(text);
      } catch {
        /* 忽略解析失败 */
      }
    } else if (event === 'delta') {
      try {
        const { text } = JSON.parse(raw) as { text: string };
        if (text) handlers.onDelta(text);
      } catch {
        /* 忽略解析失败 */
      }
    } else if (event === 'error') {
      try {
        const { message } = JSON.parse(raw) as { message: string };
        throw new ApiError(message || `${actionLabel}失败`, 500);
      } catch (e) {
        if (e instanceof ApiError) throw e;
      }
    }
    onEvent?.(event, raw);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let event = 'message';
      const dataLines: string[] = [];
      chunk.split('\n').forEach((line) => {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      });
      if (dataLines.length) handle(event, dataLines.join('\n'));
    }
  }
}

/**
 * 一次提问引用的资料。
 *
 * kind 区分来源：文档正文还是附件抽出的文本。
 * 界面上要能让用户看出「这条引用是从哪个附件里来的」，
 * 否则模型引用了 pdf 里的内容，用户却只看到一个文档名，无从核对。
 */
export interface AgentSource {
  id: string;
  name: string;
  kind: 'doc' | 'attachment';
  docId: string;
  score: number;
  snippet: string;
}

/**
 * 本次问答实际落在哪几个仓库。
 *
 * 由服务端在召回后回传：检索范围可能因为问题里点名了某个仓库而临时改变，
 * 界面照抄本地选择就会显示得与实际不符。
 */
export interface AgentScopeInfo {
  /** 参与本次检索的仓库名；为空表示范围由管理员的配置决定 */
  scopeRepos: string[];
}

async function askStream(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  handlers: {
    onSources: (sources: AgentSource[], meta?: AgentScopeInfo) => void;
    onDelta: (text: string) => void;
    /** 推理模型的思考内容（部分上游才有） */
    onReasoning?: (text: string) => void;
    /** 本次调用的 token 用量；上游未下发时不会触发 */
    onUsage?: (usage: AgentUsageEvent) => void;
    signal: AbortSignal;
  },
  scope?: RagScope,
): Promise<void> {
  await postEventStream('/agent/ask', { question, history, scope }, handlers, '提问', (event, raw) => {
    if (event === 'sources') {
      try {
        const data = JSON.parse(raw) as { sources: AgentSource[]; scopeRepos?: string[] };
        handlers.onSources(data.sources, { scopeRepos: data.scopeRepos ?? [] });
      } catch {
        /* 忽略解析失败 */
      }
    } else if (event === 'usage') {
      // 统计用途：解析失败直接放弃，不能因此中断正在进行的对话
      try {
        const u = JSON.parse(raw) as AgentUsageEvent;
        if (u?.total_tokens || u?.prompt_tokens || u?.completion_tokens) handlers.onUsage?.(u);
      } catch {
        /* 忽略解析失败 */
      }
    }
  });
}
