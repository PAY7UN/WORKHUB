/**
 * 服务端 API 客户端：统一附带 JWT、错误提示与 SSE 流解析。
 * 文档与 Agent 凭据均由服务端持有，本文件不接触任何模型密钥。
 */
import type {
  AccessAuditEntry,
  AccessCapability,
  AccessGrant,
  AccessRequest,
  AdminPasswordState,
  AgentSettings,
  Attachment,
  DocNode,
  DocSearchHit,
  GuestIdentity,
  RagScope,
  User,
} from '../../shared/types';
import type { AgentEvent } from '../../shared/agent';
import type { PluginSummary } from '../../shared/plugins';
import type { SkillSummary } from '../../shared/skills';
import type {
  ChannelRecord,
  ChannelSession,
  DecodedField,
  FrameSegment,
  ProtocolDocRef,
  ProtocolTemplate,
  SerialPortInfo,
  ToolCategoryDef,
  ToolDef,
} from '../../shared/tools';
import { saveBlob } from '../utils';
import { readStore, removeStore, writeStore } from './storage';

/**
 * 解出来的一帧（与服务端 parser 的 DecodedFrame 对齐）。
 *
 * 「解码一段 HEX」用：粘贴一段抓到的字节，看看它被解成了什么。
 */
export interface DecodedFrame {
  /** 按编码解码后的文本 */
  text: string;
  /** 原始字节的十六进制 */
  hex: string;
  /** 模板要求按 JSON 解析时的结构化结果 */
  parsed?: unknown;
  /** 具名解码器读出来的字段列表 */
  fields?: DecodedField[];
  /** 具名解码器给出的摘要 */
  summary?: string;
}

/**
 * 内置文档（协议说明书）的同步状态。
 *
 * 「本地已改」= 现场版跟上次同步时的内置版不一样（有人动过）；
 * 「代码有新版本」= 代码里的那份比上次同步时新了。
 * 两者同时成立时：现场版留着不动，只提示有新版，该合还是该换由人决定。
 */
export interface BuiltinDocState {
  /** 协议 id */
  protocolId: string;
  /** 代码里的说明书有更新 */
  hasUpdate: boolean;
  /** 现场版被人改过 */
  localModified: boolean;
}

const TOKEN_KEY = 'workhub.token';
const BASE = '/api';

export function getToken(): string {
  return readStore(localStorage, TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) writeStore(localStorage, TOKEN_KEY, token);
  else removeStore(localStorage, TOKEN_KEY);
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

/**
 * 请求超时：超过这个时间还没回来，就算它失败。
 *
 * 少了它，请求一旦卡住就是永远卡住——界面上一圈「正在读取…」转到底，
 * 既不报错也不重试，看起来像「没有数据」，其实是压根没连上。
 *
 * 常见的卡住原因：通道监听占用了网页自己的端口，
 * 浏览器发来的请求被那个原始 TCP 监听接走了（它说的是协议帧，不是 HTTP）。
 */
const REQUEST_TIMEOUT_MS = 20_000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  // 传了 body 就默认当 JSON；但如果调用方自己指定了 Content-Type
  // （比如上传原始字节），就别覆盖——服务端按类型决定怎么解析。
  if (init.body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  // 自己控超时：调用方给的 signal 也一并接上，中途取消同样要真的停
  const controller = new AbortController();
  const callerSignal = init.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    // credentials: 'include' —— 访客会话在 httpOnly cookie 里，不带上的话
    // 申请与授权都认不出「是谁」
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch {
    if (timedOut) {
      throw new ApiError(
        `请求超时（${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒没等到服务端）：` +
          '若通道监听占用了网页自己的端口，网页就会这样——换个监听端口再试',
        0,
      );
    }
    throw new ApiError('无法连接服务端，请确认后端已启动（端口见 .env 的 WORKHUB_PORT）', 0);
  } finally {
    clearTimeout(timer);
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
      const data = (await res.json()) as { error?: string };
      if (data?.error) msg = data.error;
    } catch {
      /* 忽略解析失败 */
    }
    throw new ApiError(msg, 401);
  }
  if (!res.ok) {
    let msg = `请求失败（HTTP ${res.status}）`;
    let data: Record<string, unknown> | undefined;
    try {
      const parsed = (await res.json()) as { error?: string };
      data = parsed as Record<string, unknown>;
      // 服务端的错误体统一是 { error }。缺失具体原因会退化成
      // 无信息量的「HTTP 400」，用户无从判断该拆分文档还是检查权限
      if (parsed?.error) msg = parsed.error;
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
    const data = (await res.json()) as { error?: string };
    return data?.error || fallback;
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
  byScene: Record<'chat', { calls: number; totalTokens: number }>;
  recent: Array<{ scene: string; model: string; totalTokens: number; createdAt: number }>;
}

/** 单次调用随 SSE 下发的用量 */
interface AgentUsageEvent {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 工具目录：接入大类 + 接入方式 + 协议类型 + 解析插件 + 串口可用性 */
export interface ToolsCatalog {
  /** 接入大类：界面上先按大类进，点了才是全屏 */
  categories: ToolCategoryDef[];
  tools: ToolDef[];
  groups: Record<string, string>;
  /** 协议类型：内置的 + 插件自带的，开通道时由人选一套 */
  protocols: ProtocolTemplate[];
  /** 解析插件：内置的与开发者发布的都在这儿 */
  plugins: PluginSummary[];
  /** 插件装载时的警告：插件坏了要让人看见，但不该拦住别的功能 */
  pluginWarnings: string[];
  serial: { available: boolean; reason: string };
  /**
   * 应用自己占着的端口：监听到这些端口上，网页会被自己的监听堵死。
   * 界面据此在填参数时就提醒，而不是让人开完监听才发现网页打不开了。
   */
  reservedPorts?: { port: number; what: string }[];
}

/** 开启通道的请求体 */
export interface StartSessionBody {
  /** 接入方式：字节从哪儿来 */
  tool: string;
  /** 这一次用哪套协议类型。空串 / 不传 = 调试模式，只记原始字节 */
  protocolId?: string;
  /** 这一次用哪个解析插件。不传 = 跟着协议走 */
  pluginId?: string;
  config: Record<string, string>;
  /** 会话显示用的名字 */
  name?: string;
}

export const api = {
  // 认证
  /**
   * 管理员登录。
   *
   * passwordState 由服务端判定：密码是否还是初始值（admin 或 .env 里定的那个）。
   * 前端只负责据此提醒，是否要改是用户的事，但「还没改」这件事必须说出口。
   */
  login: (password: string) =>
    request<{ token: string; user: User; passwordState?: AdminPasswordState }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  me: () =>
    request<{
      user: User;
      isAnon: boolean;
      tokenInvalid?: boolean;
      passwordState?: AdminPasswordState;
    }>('/auth/me'),

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
   * 清单只回元数据——正文已经落到 vault 的文件里，
   * 列全站就把整个库读一遍了。打开一篇就取一篇。
   */
  getDoc: (id: string) =>
    request<{ doc: DocNode; builtin?: BuiltinDocState }>(`/docs/${id}`),
  createDoc: (input: {
    name: string;
    type: 'file' | 'folder';
    parentId: string | null;
    content?: string;
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
  uploadFile: (file: File, parentId: string | null) => {
    const token = getToken();
    const qs = new URLSearchParams({
      name: file.name,
      mime: file.type || 'application/octet-stream',
    });
    if (parentId) qs.set('parentId', parentId);
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
   * scope 可传，用于显式指定「这次只看哪几篇文档」。
   * 不传则按全局配置。它只能比全局配置更严：服务端会取交集，
   * 放宽范围的权限在管理员设置里。
   */
  ask: (
    question: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    handlers: {
      onSources: (sources: AgentSource[]) => void;
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
   * 对话式 agent：让它自己动手把事做完。
   *
   * 与 ask 的区别是它会自己调能力、必要时拆给别人做，中途还能反问用户。
   * 服务端逐个推 agent 事件（谁在干活、调了什么能力、结果是什么），
   * 最后推 done 给出结论。
   */
  chat: (
    message: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    handlers: {
      onEvent: (event: AgentEvent) => void;
      onDone: (result: { answer: string; usedSkills: string[]; asked: boolean }) => void;
      signal: AbortSignal;
    },
  ) => chatStream(message, history, handlers),

  /* ------------------------------ 工具区 ------------------------------ */

  /**
   * 工具区：接入、协议、解析插件。
   *
   * 串口读回来的字节、别的驱动读回来的字节，落到数据上都是同一件事：
   * 从字节流里切出一条条记录。
   * 所以这里只有一套接口——加一种新通道是加一个驱动，不是加一组接口。
   */
  tools: {
    /** 工具目录：有哪些工具、要填什么参数、有哪些协议模板与工具条目 */
    catalog: async (): Promise<ToolsCatalog> => {
      return request<ToolsCatalog>('/tools');
    },

    /** 本机可用串口 */
    serialPorts: async (): Promise<SerialPortInfo[]> => {
      const { ports } = await request<{ ports: SerialPortInfo[] }>('/tools/serial-ports');
      return ports;
    },

    /** 全部协议模板（目录接口里已带一份，这里按需单独取） */
    protocols: async (): Promise<ProtocolTemplate[]> => {
      const { protocols } = await request<{ protocols: ProtocolTemplate[] }>('/tools');
      return protocols;
    },

    /**
     * 导入协议文档。
     *
     * 给文件就传 file，给网址就传 url——服务端转成 Markdown，
     * 写进记录区里那篇内置文档的正文（而不是另开一份）。
     */
    importProtocolDoc: async (
      protocolId: string,
      input: { file?: File; url?: string; title?: string },
    ): Promise<{ doc: ProtocolDocRef; warnings: string[]; kind: string }> => {
      if (input.file) {
        const bytes = await input.file.arrayBuffer();
        const query = `?filename=${encodeURIComponent(input.file.name)}`;
        return request(`/tools/protocols/${protocolId}/doc${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
      }
      return request(`/tools/protocols/${protocolId}/doc`, {
        method: 'POST',
        body: JSON.stringify({ url: input.url, title: input.title }),
      });
    },

    /**
     * 恢复成内置版本。
     *
     * 不是把现场版删掉（那等于让用户自己的稿子消失），
     * 而是把代码里那份抄回去——抄回去之后它又归代码管了。
     */
    resetProtocolDoc: async (
      protocolId: string,
    ): Promise<{ reset: boolean; doc?: ProtocolDocRef }> =>
      request(`/tools/protocols/${protocolId}/doc`, { method: 'DELETE' }),

    /** 当前所有通道会话 */
    sessions: async (): Promise<ChannelSession[]> => {
      const { sessions } = await request<{ sessions: ChannelSession[] }>('/tools/sessions');
      return sessions;
    },

    /** 开启一个通道 */
    startSession: async (input: StartSessionBody): Promise<ChannelSession> => {
      const { session } = await request<{ session: ChannelSession }>('/tools/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return session;
    },

    /** 停掉一个通道 */
    stopSession: async (id: string): Promise<void> => {
      await request(`/tools/sessions/${id}`, { method: 'DELETE' });
    },

    /** 拉记录（after 是游标：只要序号比它大的） */
    records: async (id: string, after = 0): Promise<{ session: ChannelSession; records: ChannelRecord[] }> => {
      return request(`/tools/sessions/${id}/records?after=${after}`);
    },

    /** 往通道里发数据：串口写出去走这里 */
    send: async (id: string, data: string, format: 'text' | 'hex', peer?: string): Promise<number> => {
      const { sent } = await request<{ sent: number }>(`/tools/sessions/${id}/send`, {
        method: 'POST',
        body: JSON.stringify({ data, format, peer }),
      });
      return sent;
    },

    /**
     * 组一条命令并发出去。
     *
     * 「解析」是把收到的字节读成人话，「组包」反过来：
     * 按这套协议把参数组装成字节帧发出去。
     *
     * 能组什么、每条要填哪些参数，由这条通道的解析插件说了算
     * （见 session.builds），界面照着渲染表单，不自己猜协议。
     *
     * dryRun 为真时只组不发，返回的是「将要发出去的那几字节」。
     */
    build: async (
      id: string,
      kind: string,
      args: Record<string, string>,
      peer?: string,
      dryRun?: boolean,
    ): Promise<{
      sent: number;
      frame: string;
      bytes: number;
      dryRun?: boolean;
      segments?: FrameSegment[];
    }> => {
      return request<{
        sent: number;
        frame: string;
        bytes: number;
        dryRun?: boolean;
        segments?: FrameSegment[];
      }>(`/tools/sessions/${id}/build`, {
        method: 'POST',
        body: JSON.stringify({ kind, args, peer, dryRun: dryRun === true }),
      });
    },

    /** 改记录开关：收到 / 发出的数据要不要记成记录 */
    setRecording: async (
      id: string,
      options: { recordIn?: boolean; recordOut?: boolean },
    ): Promise<ChannelSession> => {
      const { session } = await request<{ session: ChannelSession }>(`/tools/sessions/${id}/recording`, {
        method: 'PATCH',
        body: JSON.stringify(options),
      });
      return session;
    },

    /**
     * 解一段十六进制。
     *
     * 调试台上的「自定义解析数据」就是这么用的：
     * 粘一段抓到的字节，点一下就看清它被解成了什么——
     * 不用先接上设备，也不用先开一条通道。
     */
    decode: async (pluginId: string, hex: string): Promise<DecodedFrame> => {
      const { decoded } = await request<{ decoded: DecodedFrame }>('/tools/decode', {
        method: 'POST',
        body: JSON.stringify({ pluginId, hex }),
      });
      return decoded;
    },

    /**
     * 订阅通道的实时事件。
     *
     * 连上先给一份快照（历史记录 + 当前状态），之后才是增量——
     * 界面不用自己去拼「先拉历史、再接流」之间那点时间差。
     */
    streamChannel: (
      id: string,
      handlers: {
        onSnapshot: (snapshot: { session: ChannelSession; records: ChannelRecord[] }) => void;
        onRecord: (record: ChannelRecord) => void;
        onStatus: (session: ChannelSession) => void;
        onPeers: (peers: string[]) => void;
        signal: AbortSignal;
      },
    ): Promise<void> =>
      openEventStream(
        `/tools/sessions/${id}/stream`,
        { method: 'GET' },
        { onDelta: () => {}, signal: handlers.signal },
        '通道实时数据',
        (event, raw) => {
          try {
            if (event === 'snapshot') {
              handlers.onSnapshot(JSON.parse(raw) as { session: ChannelSession; records: ChannelRecord[] });
            } else if (event === 'record') {
              handlers.onRecord(JSON.parse(raw) as ChannelRecord);
            } else if (event === 'status') {
              handlers.onStatus(JSON.parse(raw) as ChannelSession);
            } else if (event === 'peers') {
              handlers.onPeers((JSON.parse(raw) as { peers: string[] }).peers);
            }
          } catch {
            /* 忽略解析失败 */
          }
        },
      ),
  },

  /* ------------------------------ 能力清单 ------------------------------ */

  /**
   * 能力（Skill）清单。
   *
   * 能力平时只给模型用；「能力清单」那一页靠它摆条目，
   * 让「有哪些活能干」也看得见，而不是只存在于模型的上下文里。
   */
  skills: {
    list: async (): Promise<{ skills: SkillSummary[]; warnings: string[] }> =>
      request<{ skills: SkillSummary[]; warnings: string[] }>('/skills'),
  },

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
 * 各条 SSE 链路的线上格式一致（reasoning / delta / error），仅端点与附加事件不同，
 * 故帧解析与错误处理集中于此，避免各链路的报错口径出现分歧。
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
      const data = (await res.json()) as { error?: string };
      if (data?.error) msg = `${actionLabel}失败：${data.error}`;
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
        const { error } = JSON.parse(raw) as { error: string };
        throw new ApiError(error || `${actionLabel}失败`, 500);
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
 * 对话式 agent 的事件流。
 *
 * 服务端推两类事件：
 * - agent：谁在干活、说了什么、调了哪份能力、结果如何；
 * - done：结论、动过的能力、是不是在反问用户。
 */
async function chatStream(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  handlers: {
    onEvent: (event: AgentEvent) => void;
    onDone: (result: { answer: string; usedSkills: string[]; asked: boolean }) => void;
    signal: AbortSignal;
  },
): Promise<void> {
  await postEventStream(
    '/agent/chat',
    { message, history },
    { onDelta: () => {}, signal: handlers.signal },
    '对话',
    (event, raw) => {
      if (event === 'agent') {
        try {
          handlers.onEvent(JSON.parse(raw) as AgentEvent);
        } catch {
          /* 忽略解析失败 */
        }
      } else if (event === 'done') {
        try {
          handlers.onDone(JSON.parse(raw) as { answer: string; usedSkills: string[]; asked: boolean });
        } catch {
          /* 忽略解析失败 */
        }
      }
    },
  );
}

async function askStream(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  handlers: {
    onSources: (sources: AgentSource[]) => void;
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
        const data = JSON.parse(raw) as { sources: AgentSource[] };
        handlers.onSources(data.sources);
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
