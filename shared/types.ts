/**
 * 前后端共享的数据结构与默认配置。
 * 该文件同时被 Vite（浏览器）与 Node（服务端）加载，因此：
 * - 只使用可擦除语法（Node 原生 TS 要求）
 * - 不引用任何路径别名（@/ 仅在 src 内有效）
 */

export type UserRole = 'admin' | 'viewer';

/**
 * 管理员密码的状态。
 *
 * - 'initial-default'：还是公开的默认值 admin（最该提醒改的那一种）
 * - 'initial-configured'：还是部署时在 .env 里写下的那个值
 * - 'custom'：已经被使用者改过了
 *
 * 服务端判定，界面据此提醒「该改密码了」；改完密码状态自然变成 'custom'，提醒随之消失。
 */
export type AdminPasswordState = 'initial-default' | 'initial-configured' | 'custom';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  avatar: string;
  color: string;
}

export type DocType = 'folder' | 'file';

/**
 * 文档形态。
 *
 * - `note`：Markdown 笔记。正文是 UTF-8 文本，落盘为 `.md`，可编辑、可全文检索。
 * - `file`：**原件**。正文就是这个文件本身（zip / 图片 / PDF / JSON / 代码……），
 *   落盘时保留原名与扩展名，只能预览与下载，不能当 Markdown 改。
 *
 * 为什么要把「文件」和「笔记」分开，而不是一律当笔记、附件另挂：
 * 挂附件的做法会凭空造出一篇同名同格式的 Markdown 空壳——
 * 上传一个 zip，树上就多出一篇「xxx.zip」的笔记，打开是个空编辑器，
 * 让人以为 zip 需要配一份备注才能用。文件本身就是文件，不必配备注。
 */
export type DocKind = 'note' | 'file';

export interface DocNode {
  id: string;
  name: string;
  type: DocType;
  parentId: string | null;
  content?: string;
  size?: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  /**
   * 是否已加密。
   *
   * 加密文档的正文不落明文（正文文件里只有密文），访客一律拿不到内容：
   * 要看就得走访问申请，由管理员批准后凭授权打开。
   * Agent 链路一律无权读取——管理员身份也不例外。
   */
  encrypted?: boolean;
  /** 加密时间（毫秒时间戳），仅加密文档有值 */
  lockedAt?: number;
  /**
   * 文档形态。缺省按 `note` 处理（历史数据没有这一列）。
   *
   * `file` 形态的节点自带原件：`mime` 与 `ext` 描述它的真实格式，
   * 下载与预览都按这份描述走，而不是靠文件名的后缀去猜。
   */
  kind?: DocKind;
  /**
   * 是否内置文档（系统自带，跟代码走版本管理的那份）。
   *
   * 内置文档能改内容——现场拿到厂家 PDF 后要能就地修订——
   * 但不许改名、搬家或删除：删掉之后代码里那份还在，下次启动又会长回来，
   * 删的人只会觉得「删了又冒出来」。
   */
  builtin?: boolean;
  /**
   * 内置文档对应的协议 id（只有内置文档有）。
   *
   * 界面据此把「导入/换文档」「恢复内置」这类操作挂到这篇文档上——
   * 文档操作跟着文档走，而不是散在工具区里。
   */
  protocolId?: string;
  /** 原件的 MIME 类型（kind='file' 时有值） */
  mime?: string;
  /** 原件的扩展名（含点，小写）。kind='file' 时有值 */
  ext?: string;
}

/* ------------------------------ 附件 ------------------------------ */

/**
 * 附件的正文可检索程度。
 *
 * none：还没抽（刚上传，或抽不出来）
 * ok：抽出了纯文本，可进入 RAG
 * unsupported：该格式不抽文本（图片、压缩包等），只存档不检索
 * failed：抽文本时出错
 */
export type AttachmentTextStatus = 'none' | 'ok' | 'unsupported' | 'failed';

/**
 * 附件：挂在文档上的留存文件。
 *
 * 与文档正文分开存：正文明文进库便于检索，附件二进制落盘按内容寻址去重。
 * 附件不复制正文，而是记录自己属于哪一篇文档——文档搬家，附件跟着走。
 */
export interface Attachment {
  id: string;
  /** 宿主文档 id */
  docId: string;
  /** 原始文件名（含扩展名） */
  name: string;
  /** 小写扩展名，含点，如 '.pdf'；无扩展名为空串 */
  ext: string;
  mime: string;
  /** 字节数 */
  size: number;
  /** 内容哈希，用于去重与校验 */
  sha256: string;
  textStatus: AttachmentTextStatus;
  /** 抽出文本的字符数；0 表示没有可用文本 */
  textChars: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

/* ------------------------------ RAG 范围 ------------------------------ */

/**
 * 检索范围的两种模式。
 *
 * all：全站（仍会排除加密文档）
 * docs：限定若干篇具体文档
 */
export type RagScopeMode = 'all' | 'docs';

/**
 * Agent 的检索范围。
 *
 * 范围控制是「模型能看到什么」的唯一入口，缺省即最宽——
 * 宁可让管理员显式收紧，也不要在某一处悄悄漏掉过滤条件。
 */
export interface RagScope {
  mode: RagScopeMode;
  /** mode==='docs' 时生效：这些文档才进检索 */
  docIds: string[];
  /** 是否把附件抽出的文本一并纳入检索 */
  includeAttachments: boolean;
}

/** 全站范围：不限文档、纳入附件 */
export const DEFAULT_RAG_SCOPE: RagScope = {
  mode: 'all',
  docIds: [],
  includeAttachments: true,
};

/**
 * 全文搜索命中的一条结果。
 *
 * 只回片段而不是整篇正文：搜索页要的是「在哪一段出现过」，
 * 把全文塞回列表等于把数据库重新下载一遍。
 */
export interface DocSearchHit {
  id: string;
  name: string;
  type: DocType;
  parentId: string | null;
  /** 命中位置附近的正文片段（命中词已被服务端定位并裁切） */
  snippet: string;
  /** 命中的是标题还是正文 */
  matchedIn: 'name' | 'content';
  /** 所在目录的路径，如「产品手册 / 接口说明」 */
  path: string;
  updatedAt: number;
}

export interface DocTree extends DocNode {
  children: DocTree[];
}

/**
 * 访问授权（「获取权限」式的申请）。
 *
 * 访客申请 → 管理员批准 → 访客凭授权免密打开。
 * 这是加密文档的唯一访问方式：给一个人开一道口子，随时可以收回。
 */
export type AccessRequestStatus = 'pending' | 'approved' | 'rejected';

export interface AccessRequest {
  id: string;
  docId: string;
  docName: string;
  guestName: string;
  reason: string;
  status: AccessRequestStatus;
  createdAt: number;
  decidedAt: number | null;
  /** 授权到期时间；null 表示长期有效 */
  expiresAt: number | null;
}

export interface AccessGrant {
  id: string;
  docId: string;
  docName: string;
  /** 访客标识：批量授权时要按人筛，所以留一份 */
  guestId: string;
  guestName: string;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  /**
   * 这条授权允许做什么。
   *
   * 分级的意义在于「让一个人读」和「让一个人把原件带走」不是同一件事：
   * 前者只是读，后者等于把数据交出去。默认只给 `view`，
   * 要放行下载得管理员显式勾选——权限该在默认方向上收紧，而不是默认放开。
   */
  capabilities: AccessCapability[];
}

/**
 * 访问授权的能力项。
 *
 * - `view`：打开并阅读正文
 * - `download`：下载原件（.md 导出或原始文件）
 */
export type AccessCapability = 'view' | 'download';

/** 能力项的中文名，用于界面展示 */
export const ACCESS_CAPABILITY_LABELS: Record<AccessCapability, string> = {
  view: '查看正文',
  download: '下载原件',
};

/**
 * 访问审计事件。
 *
 * 加密文档的每一次「申请 / 批准 / 打开 / 下载 / 撤销」都留一行：
 * 权限一旦授出，真正需要回答的问题是「谁在什么时候看过、拿走过什么」，
 * 而这件事只有留下流水才答得上来。
 */
export type AccessAuditAction =
  | 'request'
  | 'approve'
  | 'reject'
  | 'open'
  | 'download'
  | 'revoke'
  | 'adjust'
  | 'share';

export interface AccessAuditEntry {
  id: string;
  docId: string;
  docName?: string;
  action: AccessAuditAction;
  /** 操作者：访客 id 或管理员 id */
  actorId: string;
  actorName: string;
  /** 补充说明：申请理由、有效期、能力项等 */
  detail: string;
  createdAt: number;
}

/** 审计事件的中文名 */
export const ACCESS_AUDIT_LABELS: Record<AccessAuditAction, string> = {
  request: '提交申请',
  approve: '批准授权',
  reject: '拒绝申请',
  open: '打开正文',
  download: '下载原件',
  revoke: '撤销授权',
  adjust: '调整授权',
  share: '生成分享链接',
};

/**
 * 访客此刻对某篇加密文档的权限状态。
 *
 * granted=有有效授权；pending=申请在审；rejected=申请被拒；none=没申请过。
 */
export type AccessReason = 'granted' | 'pending' | 'rejected' | 'none';

/** 访客身份：cookie 里那个 httpOnly 会话对应的人 */
export interface GuestIdentity {
  id: string;
  name: string;
}

export interface AgentSettings {
  /** OpenAI 兼容接口地址，如 https://api.minimaxi.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 可选：MiniMax GroupId，作为 MiniMax-Group-Id 请求头下发（仅 MiniMax 需要） */
  groupId: string;
  temperature: number;
  /** 是否允许访客使用 Agent（仅管理员可配置） */
  allowGuest: boolean;
  /** 检索送入模型的文档数量上限 */
  topK: number;
  /** 单次提问的最大上下文字符数 */
  contextBudget: number;
  /**
   * 检索范围。
   *
   * 范围只会比默认值更受限，除非管理员显式改成 all——
   * 「模型能看到什么」必须有明确的收紧动作，不靠某处漏掉的默认值。
   */
  ragScope: RagScope;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  baseUrl: 'https://api.minimaxi.com/v1',
  apiKey: '',
  model: 'MiniMax-M3',
  groupId: '',
  temperature: 0.3,
  allowGuest: false,
  topK: 5,
  contextBudget: 24000,
  ragScope: DEFAULT_RAG_SCOPE,
};

/* ------------------------------ 能力 ------------------------------ */
// 能力的类型（分类、入参、形态、规格）已经挪到 shared/skills.ts：
// 它们描述的是「磁盘上一份能力」，而不是「代码里写死的一条工具」。

/* ------------------------------ 任务 ------------------------------ */
// 任务的图与步骤类型在 shared/skills.ts：
// 它们描述的是「由能力串起来的一次运行」，与能力的类型放在一起更成一体。
