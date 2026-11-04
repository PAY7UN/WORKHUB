import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import type {
  AccessAuditEntry,
  AccessCapability,
  AccessGrant,
  AccessReason,
  AccessRequest,
  AdminSection,
  DocNode,
  DocSearchHit,
  DocTree,
  GuestIdentity,
  Permission,
  Repo,
  RepoStat,
  User,
} from '@/types';
import { ROLE_PERMISSIONS } from '@/types';
import {
  api,
  getToken,
  setToken,
  onUnauthorized,
  ApiError,
  type AgentConfigView,
  type AgentStatus,
} from '@/lib/api';
import { SEED_DOCS, SEED_REPO, SEED_REPO_ID, SEED_USERS, seedDocsForRepo } from '../../shared/seed';
import { log } from '@/lib/logger';
import { readStore, removeStore, writeStore } from '@/lib/storage';
import { toast } from 'sonner';

/**
 * 管理员登录结果。
 *
 * 带 message 而非只回 boolean：调用方需要把真实原因展示给用户，
 * 统一成「密码错误」会让限流、断连与密码打错完全无法区分。
 */
interface LoginResult {
  ok: boolean;
  /** 失败原因，成功时为空串 */
  message: string;
}

/**
 * 从清单里摘掉一棵子树（含它自己）。
 *
 * 删除文件夹时子孙一并消失——留着孩子却没了爹，文件树里点开就是一个
 * 没有父亲的文件夹。
 */
function withoutSubtree(docs: DocNode[], rootId: string): DocNode[] {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    docs.forEach((d) => {
      if (d.parentId && ids.has(d.parentId) && !ids.has(d.id)) {
        ids.add(d.id);
        changed = true;
      }
    });
  }
  return docs.filter((d) => !ids.has(d.id));
}

interface AppContextValue {
  // 认证
  currentUser: User;
  users: User[];
  /** 管理员登录，返回是否成功及失败原因 */
  loginAdmin: (password: string) => Promise<LoginResult>;
  /** 修改管理员密码。内部会换发 token，调用方无需再处理登录态 */
  changeAdminPassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logoutAdmin: () => void;
  isAdmin: boolean;
  hasPermission: (perm: Permission) => boolean;
  /** 首次从服务端加载中 */
  bootstrapping: boolean;

  // 文档（数据源为服务端，浏览器仅作离线缓存）
  docs: DocNode[];
  getDoc: (id: string) => DocNode | undefined;
  /**
   * 取回一篇文档的正文并并入清单。
   *
   * 清单只有元数据（正文在仓库目录的文件里），打开一篇就取一篇。
   */
  loadDocContent: (id: string) => Promise<void>;
  createDoc: (input: {
    name: string;
    type: 'file' | 'folder';
    parentId: string | null;
    content?: string;
    /** 归属仓库；不传则由服务端沿用父节点或落到默认仓库 */
    repoId?: string;
  }) => Promise<DocNode | null>;
  updateDoc: (id: string, patch: Partial<DocNode>) => void;
  /**
   * 以外部内容覆盖文档并广播给打开中的编辑器。
   * 仅供润色结果回写使用——普通编辑保存应继续走 updateDoc。
   */
  applyExternalContent: (id: string, content: string) => { ok: true } | { ok: false; reason: string };
  /** 外部内容同步信号，供 DocEditor 消费 */
  docSync: { docId: string; content: string; token: number } | null;
  /** 润色任务创建信号（自增），任务提交方 bump，列表订阅方据此重新拉取 */
  polishTaskEpoch: number;
  /** 通知「润色任务列表已变化」，提交成功后调用 */
  notifyPolishTaskCreated: () => void;
  /** 删除文档（级联子树）。返回是否真正删除成功，调用方据此决定要不要提示成功 */
  deleteDoc: (id: string) => Promise<boolean>;
  moveDoc: (id: string, newParentId: string | null) => boolean;
  /**
   * 上传一个 Markdown 文件成为文档。
   *
   * repoId 不传时由服务端沿用父节点的仓库归属。
   */
  uploadFile: (file: File, parentId: string | null, repoId?: string) => Promise<DocNode | null>;
  /**
   * 重新拉取文档清单。
   *
   * 文档的仓库归属会变（跨仓库迁移），而归属信息随文档一起下发，
   * 因此迁移完成后必须重拉，否则界面仍显示旧的归属。
   */
  refreshDocs: (opts?: { persist?: boolean }) => Promise<void>;

  // 访客可见文档：访客与管理员拿到的是同一份清单（「对访客隐藏」已下线），
  // 故这里直接透传 docs。保留这个别名而非让调用方直接用 docs，
  // 是因为「当前身份可见的文档」是业务语义，与「文档列表」不是一回事。
  visibleDocs: DocNode[];

  /**
   * 按当前仓库范围收窄后的文档清单。
   *
   * 始终只含当前仓库的文档：每个文档都有归属，
   * 混在一起看既分不清来源，也说不清一份资料适用哪些规则。
   * 文件树与文件夹视图都基于它渲染，两边看到的范围才不会打架。
   */
  repoScopedDocs: DocNode[];

  /* ---- 标签筛选 ---- */
  /** 当前选中的标签；为 null 表示不筛选 */
  tagFilter: string | null;
  /** 选中/取消某个标签；传 null 取消筛选 */
  setTagFilter: (tag: string | null) => void;
  /** 全部标签及各自文档数，按数量倒序 */
  allTags: Array<{ tag: string; count: number }>;

  /* ---- 仓库（项目） ---- */
  /** 全部在架仓库 */
  repos: Repo[];
  /** 各仓库的规模统计（文档数、附件数、占用） */
  repoStats: RepoStat[];
  /** 拉取仓库清单 */
  refreshRepos: () => Promise<void>;
  /**
   * 当前所在仓库。
   *
   * 侧边栏按它过滤文件树，Agent 面板按它临时收窄检索范围。
   * 它始终指向一个真实仓库：文档没有「不属于任何仓库」的状态。
   */
  currentRepoId: string;
  /** 切换所在仓库 */
  setCurrentRepoId: (id: string) => void;
  /** 当前仓库对象；还没加载出来时为 undefined */
  currentRepo: Repo | undefined;

  /* ---- 全文搜索 ---- */
  /** 当前搜索词 */
  searchQuery: string;
  /** 搜索命中（含片段与所在目录） */
  searchHits: DocSearchHit[];
  /** 搜索进行中 */
  searching: boolean;
  /** 执行搜索；空词等于清空结果 */
  runSearch: (query: string) => Promise<void>;
  /** 清空搜索词与结果 */
  clearSearch: () => void;

  // 文档加密
  /**
   * 把文档置为加密态。
   *
   * 加密后正文只以密文落库，服务端不签发、也不存储任何访客口令。
   * 访客想看得申请，由管理员批准后凭授权打开。
   */
  encryptDoc: (id: string) => Promise<void>;
  /**
   * 管理员免密查看加密文档，返回含明文的文档副本。
   * 明文刻意不写回全局 docs：全局 docs 会被缓存进 localStorage。
   */
  revealDoc: (id: string) => Promise<DocNode>;
  /** 取消加密，恢复为普通文档 */
  decryptDoc: (id: string) => Promise<void>;

  /**
   * 访问授权（「获取权限」式的申请）。
   *
   * 访客申请 → 管理员批准 → 访客凭授权免密打开。
   * 这是加密文档的唯一访问方式。
   */
  guest: GuestIdentity | null;
  /** 申请访问某篇加密文档 */
  requestDocAccess: (id: string, reason: string) => Promise<void>;
  /** 凭授权打开文档；无授权时抛出的错误里带 reason（none/pending/rejected） */
  openDocByGrant: (id: string) => Promise<DocNode>;
  /**
   * 查访客此刻对某篇加密文档的权限状态（不含正文）。
   *
   * 给轮询用：管理员一批准，访客界面自己就翻到正文。
   * granted 时带回 capabilities：只给了「查看」的授权不该摆下载按钮。
   */
  checkDocAccess: (id: string) => Promise<{
    granted: boolean;
    reason: AccessReason;
    capabilities?: AccessCapability[];
  }>;
  /** 访客自报姓名 */
  setGuestName: (name: string) => Promise<void>;
  /** 访问申请列表（仅管理员）；docId 传入时只看某篇文档的申请 */
  listAccessRequests: (
    status?: 'pending' | 'approved' | 'rejected' | 'all',
    docId?: string,
  ) => Promise<AccessRequest[]>;
  /** 待处理申请数：给管理端入口显示角标 */
  pendingAccessCount: number;
  /**
   * 批准申请（expiresInDays 为 0 表示长期有效）。
   *
   * capabilities 决定口子开多大：默认只有 view（能看），
   * 放行下载要显式带上 download（能拿走）。
   */
  approveAccessRequest: (
    id: string,
    expiresInDays?: number,
    capabilities?: AccessCapability[],
  ) => Promise<void>;
  /** 拒绝申请 */
  rejectAccessRequest: (id: string) => Promise<void>;
  /** 某篇文档的授权名单（仅管理员） */
  listDocAccessGrants: (id: string) => Promise<AccessGrant[]>;
  /** 全部授权总览（仅管理员） */
  listAllAccessGrants: () => Promise<AccessGrant[]>;
  /** 撤销授权（仅管理员） */
  revokeDocAccessGrant: (docId: string, grantId: string) => Promise<void>;
  /**
   * 调整一条授权的口子大小（仅管理员）。
   *
   * 批准时给错能力是常事。直接改比撤销再重批好：
   * 后者会把中间那段的口子状态从流水里抹掉，
   * 「那段时间到底能不能下载」就再也查不出来。
   */
  updateDocAccessGrant: (
    docId: string,
    grantId: string,
    capabilities: AccessCapability[],
  ) => Promise<void>;
  /** 批量批准申请（仅管理员）：共享一个有效期与一组能力 */
  bulkApproveAccessRequests: (
    ids: string[],
    expiresInDays?: number,
    capabilities?: AccessCapability[],
  ) => Promise<number>;
  /** 批量授权（仅管理员）：直接给某访客在多篇文档上开口子 */
  bulkGrantAccess: (
    guestId: string,
    guestName: string,
    docIds: string[],
    expiresInDays?: number,
    capabilities?: AccessCapability[],
  ) => Promise<number>;
  /** 已知访客清单（仅管理员）：批量授权时供「选谁」 */
  listKnownGuests: () => Promise<Array<{ id: string; name: string }>>;
  /**
   * 访问审计流水（仅管理员）。
   *
   * 权限授出去之后会被追问的是「谁在什么时候看过、拿走过什么」，
   * 这个问题只有流水答得上来。docId 传入时只看某篇文档。
   */
  listAccessAudit: (docId?: string) => Promise<AccessAuditEntry[]>;

  // 管理后台
  /** 管理后台是否打开 */
  adminConsoleOpen: boolean;
  /** 当前所在的分区 */
  adminSection: AdminSection;
  /** 文档范围限定：从文档菜单进入时只看这一篇 */
  adminDocFilter: { docId: string; docName: string } | null;
  /** 要定位到的申请单（深链定位）；null 表示不定位 */
  adminFocusRequestId: string | null;
  /**
   * 打开管理后台。
   * section 省略时保持当前分区；doc 省略时取消文档范围限定；
   * focusRequestId 传入时，访问授权分区会定位并高亮那一条申请。
   */
  openAdminConsole: (
    section?: AdminSection,
    doc?: { docId: string; docName: string },
    focusRequestId?: string,
  ) => void;
  /** 关闭管理后台 */
  closeAdminConsole: () => void;

  // 文档分析 Agent
  agentConfig: AgentConfigView;
  /** 当前身份是否可使用 Agent（由服务端判定） */
  canUseAgent: boolean;
  /** 不可用原因：NO_API_KEY / GUEST_DISABLED */
  agentReason: AgentStatus['reason'];
  refreshAgentStatus: () => Promise<void>;

  // 工具
  /**
   * 构建文件树。
   *
   * 传入 repoId 则只返回该仓库的文档；不传则返回全部。
   */
  buildTree: (repoId?: string) => DocTree[];
  getPath: (id: string) => DocNode[];
}

const AppContext = createContext<AppContextValue | null>(null);

/** 离线兜底缓存：仅在后端不可达时展示，后端恢复后立即以服务端为准 */
const STORAGE_KEY_DOCS = 'workhub.docs';
const STORAGE_KEY_IMPORTED = 'workhub.importedToServer';

const DEFAULT_AGENT_CONFIG: AgentConfigView = {
  baseUrl: 'https://api.minimaxi.com/v1',
  model: 'MiniMax-M3',
  groupId: '',
  temperature: 0.3,
  allowGuest: false,
  topK: 5,
  contextBudget: 24000,
  ragScope: { mode: 'all', repoIds: [], docIds: [], includeAttachments: true },
  hasApiKey: false,
};

function loadCachedDocs(): DocNode[] {
  try {
    const raw = readStore(localStorage, STORAGE_KEY_DOCS);
    if (!raw) return seedDocsForRepo(SEED_REPO_ID);
    const parsed = JSON.parse(raw) as DocNode[];
    return Array.isArray(parsed) && parsed.length ? parsed : seedDocsForRepo(SEED_REPO_ID);
  } catch {
    return seedDocsForRepo(SEED_REPO_ID);
  }
}

const ADMIN_USER = SEED_USERS.find((u) => u.role === 'admin')!;
const VIEWER_USER = SEED_USERS.find((u) => u.role === 'viewer')!;

export function AppProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string>(() => getToken());
  const [isAdmin, setIsAdmin] = useState<boolean>(() => Boolean(getToken()));
  const [docs, setDocs] = useState<DocNode[]>(() => loadCachedDocs());
  const [bootstrapping, setBootstrapping] = useState(true);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({
    canUse: false,
    reason: 'NO_API_KEY',
    model: '',
    hasApiKey: false,
    allowGuest: false,
    role: 'viewer',
  });
  const [agentConfig, setAgentConfig] = useState<AgentConfigView>(DEFAULT_AGENT_CONFIG);

  /* ---- 仓库（项目） ---- */
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoStats, setRepoStats] = useState<RepoStat[]>([]);
  /**
   * 当前所在仓库。
   *
   * 存 id 而不是对象：仓库设置（名称、允许格式）随时可能变，
   * 存 id 才能保证界面上显示的永远是最新的一份。
   */
  const [currentRepoId, setCurrentRepoId] = useState<string>('');

  const refreshRepos = useCallback(async () => {
    try {
      const { repos: list, stats } = await api.listRepos();
      setRepos(list);
      setRepoStats(stats);
    } catch {
      // 拉不到仓库不该拖垮整个应用，退回示例仓库撑住界面
      setRepos([SEED_REPO]);
      setRepoStats([]);
    }
  }, []);

  const currentRepo = useMemo(
    () => repos.find((r) => r.id === currentRepoId),
    [repos, currentRepoId],
  );

  // 仓库就位后落到第一个：没有选中仓库就没有「当前范围」，
  // 文件树与检索范围都无从谈起，所以必须始终有一个当前仓库。
  useEffect(() => {
    if (repos.length === 0) return;
    if (!repos.some((r) => r.id === currentRepoId)) {
      setCurrentRepoId(repos[0].id);
    }
  }, [repos, currentRepoId]);

  /**
   * 外部内容强制同步信号（当前为「应用到文档」的唯一通道）。
   *
   * 为什么不能只靠 docs 变化：DocEditor 的 content 是非受控本地 state，仅在初始化
   * 与切换文档（doc.id 变化）时同步。润色结果走 updateDoc 回写时文档往往正开着，
   * doc.id 不变 → 编辑器不跟随，用户看到「点了没反应」；更糟的是编辑器里残留的
   * 旧内容经防抖保存会把润色结果整个覆盖回去，且无任何提示。
   *
   * token 必须递增而非只比 docId：同一篇文档连续应用两次润色，docId 与 content
   * 都可能相同，用 (docId, content) 判等会漏掉后一次。
   */
  const [docSync, setDocSync] = useState<{ docId: string; content: string; token: number } | null>(null);
  const docSyncTokenRef = useRef(0);

  /**
   * 润色任务创建信号（自增版本号）。
   *
   * 提交入口（编辑器的 PolishDialog）与订阅方（Agent 面板的 usePolishTasks）分属两棵
   * 互不相干的组件树，彼此拿不到对方的 state，任务列表又只存在于订阅方的本地副本里。
   * 提交成功后不通知，订阅方的列表就永远停在提交前的样子——面板明明开着，任务却
   * 「看不见」，且没有任何报错可查。因此这里用自增计数器搭桥，取代「靠轮询兜底」。
   *
   * 用计数器而非任务 id 列表：调用方只需表达「列表已失效」，不必知道新任务的形状；
   * 同一函数也留给未来的批量提交。
   */
  const [polishTaskEpoch, setPolishTaskEpoch] = useState(0);
  const notifyPolishTaskCreated = useCallback(() => setPolishTaskEpoch((n) => n + 1), []);

  const currentUser: User = isAdmin ? ADMIN_USER : VIEWER_USER;

  /**
   * 拉取当前身份可见的文档。
   *
   * 仅管理员拿到的是全量视图，才允许落盘缓存：访客拿到的是同一份清单，
   * 但加密文档的正文不下发，写入缓存只会制造一个残缺数据源——
   * 一旦被迁移逻辑回写就会删除服务端数据。
   */
  const refreshDocs = useCallback(async (opts?: { persist?: boolean }) => {
    const { docs: serverDocs } = await api.listDocs();
    setDocs(serverDocs);
    if (opts?.persist) {
      try {
        writeStore(localStorage, STORAGE_KEY_DOCS, JSON.stringify(serverDocs));
      } catch {
        /* 隐私模式忽略 */
      }
    }
  }, []);

  const refreshAgentStatus = useCallback(async () => {
    const status = await api.agentStatus();
    setAgentStatus(status);
    if (status.role === 'admin') {
      const { config } = await api.getAgentConfig();
      setAgentConfig(config);
    }
  }, []);

  /**
   * 升级迁移：把浏览器 localStorage 中的历史文档导入数据库。
   *
   * importDocs 是覆盖式写入（DELETE FROM docs 后全量重插），所以必须先确认服务端
   * 确实一条文档都没有。否则会用本地快照回滚服务端的删除与移动结果；快照里不含
   * 加密文档的正文，回写时会把这些文档一并抹掉。
   */
  const migrateLocalDocsOnce = useCallback(async () => {
    let done = false;
    try {
      // 清理旧版本遗留在浏览器中的明文 API Key（新旧两个键名都清）
      removeStore(localStorage, 'workhub.agentSettings');
      done = readStore(localStorage, STORAGE_KEY_IMPORTED) === '1';
    } catch {
      return;
    }
    if (done) return;

    // 服务端已有数据：一律不导入，只补标记
    let serverDocs: DocNode[] = [];
    try {
      ({ docs: serverDocs } = await api.listDocs());
    } catch {
      return; // 服务端不可达时不做任何写入
    }
    if (serverDocs.length > 0) {
      writeStore(localStorage, STORAGE_KEY_IMPORTED, '1');
      return;
    }

    const cached = loadCachedDocs();
    // 缓存仍是初始种子时无需导入
    const isSeed =
      cached.length === SEED_DOCS.length && cached.every((d, i) => d.id === SEED_DOCS[i]?.id);
    if (isSeed) {
      writeStore(localStorage, STORAGE_KEY_IMPORTED, '1');
      return;
    }
    try {
      await api.importDocs(cached);
      writeStore(localStorage, STORAGE_KEY_IMPORTED, '1');
      await refreshDocs({ persist: true });
      log.info('已将本地历史文档导入服务端数据库');
    } catch {
      /* 导入失败不阻塞使用 */
    }
  }, [refreshDocs]);

  // 令牌被服务端判定失效时同步复位身份状态，避免界面仍显示为管理员
  useEffect(() => {
    onUnauthorized(() => {
      setTokenState('');
      setIsAdmin(false);
      void refreshDocs().catch(() => undefined);
    });
  }, [refreshDocs]);

  // 初始化：确认身份 + 拉取文档 + Agent 状态（token 变化时重跑）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 先向服务端确认身份。仅凭本地存在令牌就判定为管理员是不可靠的：
      // 令牌过期或签名密钥轮换后，服务端已不再承认该身份。
      // verified 为 null 表示服务端不可达、身份未知，此时保留原有状态。
      let verified: boolean | null = null;
      if (getToken()) {
        try {
          const { user, tokenInvalid } = await api.me();
          verified = user.role === 'admin';
          if (tokenInvalid) {
            // 令牌已被服务端作废（过期 / 密钥轮换 / 改密后指纹不符），必须清掉本地残留。
            // 不清的话，下次刷新又会因「本地有令牌」乐观地显示成管理员，
            // 然后再被这次校验打回访客——徽章与入口文案反复横跳，用户无从判断真实身份。
            setToken('');
            if (!cancelled) setTokenState('');
            log.warn('管理员登录状态已失效，已清除本地令牌');
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) verified = false;
        }
      } else {
        verified = false;
      }
      if (!cancelled && verified !== null) setIsAdmin(verified);
      const admin = verified ?? isAdmin;

      try {
        await refreshDocs({ persist: admin });
        await refreshRepos();
        const status = await api.agentStatus();
        if (!cancelled) setAgentStatus(status);
        if (admin) {
          const cfg = await api.getAgentConfig();
          if (!cancelled) setAgentConfig(cfg.config);
          await migrateLocalDocsOnce();
        }
      } catch {
        // 后端不可达：保留本地缓存，标记 Agent 不可用
        if (!cancelled) {
          log.warn('服务端不可达，当前展示本地缓存数据');
          setAgentStatus((s) => ({ ...s, canUse: false, reason: 'NO_API_KEY', model: '' }));
        }
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // 访客可见文档：访客与管理员拿到的是同一份清单（「对访客隐藏」已下线，
  // 服务端不再按身份裁剪），故这里直接透传 docs。保留这个别名而非让调用方
  // 直接用 docs，是因为「当前身份可见的文档」是业务语义，与「文档列表」不是一回事。
  //
  // 叠加标签筛选时，命中的文档连同它的祖先目录一起留下：只留命中文档会把它们
  // 从目录里连根拔起，用户再也看不出它放在哪个目录下。
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const visibleDocs = useMemo(() => {
    if (!tagFilter) return docs;
    const byId = new Map(docs.map((d) => [d.id, d]));
    const keep = new Set<string>();
    docs.forEach((d) => {
      if (!d.tags?.includes(tagFilter)) return;
      let cur: DocNode | undefined = d;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        keep.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    });
    return docs.filter((d) => keep.has(d.id));
  }, [docs, tagFilter]);

  /**
   * 按当前仓库范围收窄后的文档清单。
   *
   * 始终只留当前仓库的文档（仓库就位前先不筛，避免界面空一片）。
   * 侧边栏文件树与文件夹视图都基于它渲染，
   * 否则会出现「文件树只剩某个仓库、文件夹视图却把别的仓库也列出来」的不一致。
   */
  const repoScopedDocs = useMemo(
    () => (currentRepoId ? visibleDocs.filter((d) => d.repoId === currentRepoId) : visibleDocs),
    [visibleDocs, currentRepoId],
  );

  /** 全部标签及各自文档数，按数量倒序：先用得多的排前面 */
  const allTags = useMemo(() => {
    const counter = new Map<string, number>();
    docs.forEach((d) => d.tags?.forEach((t) => counter.set(t, (counter.get(t) ?? 0) + 1)));
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
  }, [docs]);

  /* ---- 全文搜索 ---- */

  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<DocSearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  /**
   * 执行搜索。
   *
   * 搜索走服务端（正文在库里，前端那份只是清单），空词等同于清空——
   * 逐字过滤前端那份清单只能搜到标题，搜正文得让服务端来。
   */
  const runSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    const q = query.trim();
    if (!q) {
      setSearchHits([]);
      return;
    }
    setSearching(true);
    try {
      const { hits } = await api.searchDocs(q);
      setSearchHits(hits);
    } catch {
      setSearchHits([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchHits([]);
  }, []);

  const hasPermission = useCallback(
    (perm: Permission): boolean => ROLE_PERMISSIONS[currentUser.role].includes(perm),
    [currentUser],
  );

  const loginAdmin = useCallback(
    async (password: string): Promise<LoginResult> => {
      let newToken: string;
      try {
        ({ token: newToken } = await api.login(password));
      } catch (e) {
        // 失败原因必须原样透出。笼统报「密码错误」会把限流 429、后端未启动、
        // 网络不可达一并伪装成密码打错，用户只会反复重输，反而把真正的限流
        // 越撞越久，最后连正确密码也进不去
        return { ok: false, message: (e as Error)?.message || '登录失败' };
      }

      // 到这里令牌已换发，身份实际已切换成功。后续拉取只是补充信息，
      // 失败时不能回头报登录失败——那正是「密码明明正确却提示密码错误」的来源
      setToken(newToken);
      setTokenState(newToken);
      setIsAdmin(true);
      try {
        await refreshDocs({ persist: true });
        const [{ config }, status] = await Promise.all([api.getAgentConfig(), api.agentStatus()]);
        setAgentConfig(config);
        setAgentStatus(status);
        await migrateLocalDocsOnce();
      } catch {
        void refreshDocs().catch(() => undefined);
      }
      return { ok: true, message: '' };
    },
    [refreshDocs, migrateLocalDocsOnce],
  );

  const logoutAdmin = useCallback(() => {
    setToken('');
    setTokenState('');
    setIsAdmin(false);
    void refreshDocs().catch(() => setDocs(seedDocsForRepo(SEED_REPO_ID)));
  }, [refreshDocs]);

  /**
   * 修改管理员密码。
   *
   * 服务端在改密后会作废全部旧令牌并返回新令牌，因此必须把 token 一并换掉；
   * 漏掉这一步的表现是「改密成功后立刻被踢回访客」，而且用户会以为是密码没改成功。
   */
  const changeAdminPassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<void> => {
      const { token: newToken } = await api.changePassword(currentPassword, newPassword);
      setToken(newToken);
      setTokenState(newToken);
    },
    [],
  );

  /** 用服务端返回的文档覆盖本地对应项 */
  const replaceDoc = useCallback((doc: DocNode) => {
    setDocs((prev) => prev.map((d) => (d.id === doc.id ? doc : d)));
  }, []);

  const getDoc = useCallback((id: string) => docs.find((d) => d.id === id), [docs]);

  /**
   * 取回一篇文档的正文，合并进清单。
   *
   * 清单只有元数据：正文在仓库目录的文件里，服务端不会为了列个目录
   * 把整个仓库读一遍。所以打开一篇就取一篇，取回来的正文并回原处，
   * 免得编辑器再去别处找。
   *
   * 加密文档取不到正文（服务端只存密文），这里保持原样不动——
   * 明文得走 reveal / access-open，那两条路才带权限判断。
   */
  const loadDocContent = useCallback(async (id: string): Promise<void> => {
    try {
      const { doc } = await api.getDoc(id);
      setDocs((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, content: doc.content ?? d.content } : d)),
      );
    } catch {
      // 取不到正文就当这篇暂时读不出来，界面留空而不是报错打断操作
    }
  }, []);

  /* ------------------------------ 文档加密 ------------------------------ */

  /**
   * 加密文档。
   *
   * 服务端不签发密码：加密完成后访客只能走访问申请，
   * 由管理员批准后凭授权打开。
   */
  const encryptDoc = useCallback(
    async (id: string): Promise<void> => {
      if (!isAdmin) throw new Error('仅管理员可以加密文档');
      const { doc } = await api.encryptDoc(id);
      replaceDoc(doc);
    },
    [isAdmin, replaceDoc],
  );

  /**
   * 管理员免密查看加密文档。
   * 返回的文档含明文，但**不写回全局 docs**——那会被缓存进 localStorage。
   */
  const revealDoc = useCallback(
    async (id: string): Promise<DocNode> => {
      if (!isAdmin) throw new Error('仅管理员可以免密查看加密文档');
      const { doc } = await api.revealDoc(id);
      return { ...doc, content: doc.content ?? '' };
    },
    [isAdmin],
  );

  /** 取消加密 */
  const decryptDoc = useCallback(
    async (id: string): Promise<void> => {
      if (!isAdmin) throw new Error('仅管理员可以取消加密');
      const { doc } = await api.decryptDoc(id);
      replaceDoc(doc);
    },
    [isAdmin, replaceDoc],
  );

  /**
   * 访客身份。
   *
   * 访客不需要账号，但申请与授权要落到具体的人身上：
   * 服务端给浏览器发一个 httpOnly cookie，这里读回它的昵称用于显示。
   */
  const [guest, setGuest] = useState<GuestIdentity | null>(null);
  const [pendingAccessCount, setPendingAccessCount] = useState(0);

  /**
   * 管理后台的打开状态与当前分区。
   *
   * 放在全局而不是各个面板自己持有，是因为入口散在好几个地方：
   * 侧边栏的管理入口、文档菜单的「访问授权」、AI 助手的齿轮。
   * 它们要的是同一扇门——开着同一扇门、落在同一个分区，
   * 而不是各开各的弹窗、互相盖住。
   */
  const [adminConsoleOpen, setAdminConsoleOpen] = useState(false);
  const [adminSection, setAdminSection] = useState<AdminSection>('overview');
  /** 从某篇文档进入时的范围限定；不设则看全部文档 */
  const [adminDocFilter, setAdminDocFilter] = useState<{ docId: string; docName: string } | null>(
    null,
  );
  /**
   * 要定位到的申请单（来自定位深链）。
   *
   * 审批人点开带 ?access= 的链接，落到本站就该直接看到那一条申请，
   * 而不是自己在一堆申请里找「哪条是我刚点的」。
   */
  const [adminFocusRequestId, setAdminFocusRequestId] = useState<string | null>(null);

  /**
   * 打开管理后台。
   *
   * 不传 section 就保持当前分区——从概览点「去处理」跳到具体分区，
   * 而从文档菜单再进同一分区时，不该把管理员弹回概览。
   */
  const openAdminConsole = useCallback(
    (
      section?: AdminSection,
      doc?: { docId: string; docName: string },
      focusRequestId?: string,
    ) => {
      if (section) setAdminSection(section);
      // 没给文档范围就清掉上一次的限定：否则会莫名其妙地只看上一篇文档
      setAdminDocFilter(doc ?? null);
      setAdminFocusRequestId(focusRequestId ?? null);
      setAdminConsoleOpen(true);
    },
    [],
  );

  const closeAdminConsole = useCallback(() => setAdminConsoleOpen(false), []);

  // 拉一次访客身份（服务端会顺手发 cookie），以及管理员侧的待处理申请数
  useEffect(() => {
    let cancelled = false;
    api
      .guestSession()
      .then((g) => {
        if (!cancelled) setGuest(g);
      })
      .catch(() => {
        /* 访客身份拿不到不影响浏览，忽略 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshPendingAccessCount = useCallback(async () => {
    if (!isAdmin) {
      setPendingAccessCount(0);
      return;
    }
    try {
      const { pending } = await api.listAccessRequests('pending');
      setPendingAccessCount(pending);
    } catch {
      /* 角标不是关键路径，失败就不显示 */
    }
  }, [isAdmin]);

  useEffect(() => {
    void refreshPendingAccessCount();
  }, [refreshPendingAccessCount]);

  /**
   * 角标自动刷新。
   *
   * 访客提交申请后，管理员的侧边栏角标不该一直停在旧的数字上——
   * 否则「有人等着」这件事，得靠管理员自己点开管理后台才发现。
   */
  useEffect(() => {
    if (!isAdmin) return;
    const timer = setInterval(() => {
      void refreshPendingAccessCount();
    }, 10_000);
    return () => clearInterval(timer);
  }, [isAdmin, refreshPendingAccessCount]);

  /** 申请访问某篇加密文档 */
  const requestDocAccess = useCallback(async (id: string, reason: string): Promise<void> => {
    await api.requestDocAccess(id, reason);
  }, []);

  /** 凭授权打开文档 */
  const openDocByGrant = useCallback(async (id: string): Promise<DocNode> => {
    const { doc } = await api.openDocByGrant(id);
    return { ...doc, content: doc.content ?? '' };
  }, []);

  /** 查访客此刻的权限状态（轮询用，不含正文） */
  const checkDocAccess = useCallback(
    async (id: string): Promise<{
      granted: boolean;
      reason: AccessReason;
      capabilities?: AccessCapability[];
    }> => {
      return api.checkDocAccess(id);
    },
    [],
  );

  /** 访客自报姓名 */
  const setGuestName = useCallback(async (name: string): Promise<void> => {
    const g = await api.setGuestName(name);
    setGuest(g);
  }, []);

  /** 访问申请列表（管理员） */
  const listAccessRequests = useCallback(
    async (
      status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending',
      docId?: string,
    ): Promise<AccessRequest[]> => {
      if (!isAdmin) throw new Error('仅管理员可以查看访问申请');
      const { items } = await api.listAccessRequests(status, docId);
      return items;
    },
    [isAdmin],
  );

  /** 批准申请：同时刷新角标 */
  const approveAccessRequest = useCallback(
    async (
      id: string,
      expiresInDays = 0,
      capabilities: AccessCapability[] = ['view'],
    ): Promise<void> => {
      if (!isAdmin) throw new Error('仅管理员可以批准访问申请');
      await api.approveAccessRequest(id, expiresInDays, capabilities);
      await refreshPendingAccessCount();
    },
    [isAdmin, refreshPendingAccessCount],
  );

  /** 拒绝申请 */
  const rejectAccessRequest = useCallback(
    async (id: string): Promise<void> => {
      if (!isAdmin) throw new Error('仅管理员可以拒绝访问申请');
      await api.rejectAccessRequest(id);
      await refreshPendingAccessCount();
    },
    [isAdmin, refreshPendingAccessCount],
  );

  /** 某篇文档的授权名单 */
  const listDocAccessGrants = useCallback(
    async (id: string): Promise<AccessGrant[]> => {
      if (!isAdmin) throw new Error('仅管理员可以查看授权名单');
      const { items } = await api.listDocAccessGrants(id);
      return items;
    },
    [isAdmin],
  );

  /** 撤销授权 */
  const revokeDocAccessGrant = useCallback(
    async (docId: string, grantId: string): Promise<void> => {
      if (!isAdmin) throw new Error('仅管理员可以撤销授权');
      await api.revokeDocAccessGrant(docId, grantId);
    },
    [isAdmin],
  );

  /** 调整授权的口子大小 */
  const updateDocAccessGrant = useCallback(
    async (
      docId: string,
      grantId: string,
      capabilities: AccessCapability[],
    ): Promise<void> => {
      if (!isAdmin) throw new Error('仅管理员可以调整授权');
      await api.updateDocAccessGrant(docId, grantId, capabilities);
    },
    [isAdmin],
  );

  /** 批量批准申请：返回实际批准了多少条 */
  const bulkApproveAccessRequests = useCallback(
    async (
      ids: string[],
      expiresInDays = 0,
      capabilities: AccessCapability[] = ['view'],
    ): Promise<number> => {
      if (!isAdmin) throw new Error('仅管理员可以批准访问申请');
      const { approved } = await api.bulkApproveAccessRequests(ids, expiresInDays, capabilities);
      await refreshPendingAccessCount();
      return approved;
    },
    [isAdmin, refreshPendingAccessCount],
  );

  /** 批量授权：直接给某访客在多篇文档上开口子 */
  const bulkGrantAccess = useCallback(
    async (
      guestId: string,
      guestName: string,
      docIds: string[],
      expiresInDays = 0,
      capabilities: AccessCapability[] = ['view'],
    ): Promise<number> => {
      if (!isAdmin) throw new Error('仅管理员可以授予访问权');
      const { granted } = await api.bulkGrantAccess(
        guestId,
        guestName,
        docIds,
        expiresInDays,
        capabilities,
      );
      return granted;
    },
    [isAdmin],
  );

  /** 访问审计流水 */
  const listAccessAudit = useCallback(
    async (docId?: string): Promise<AccessAuditEntry[]> => {
      if (!isAdmin) throw new Error('仅管理员可以查看访问审计');
      const { items } = await api.listAccessAudit(docId);
      return items;
    },
    [isAdmin],
  );

  /** 已知访客清单（批量授权时供「选谁」） */
  const listKnownGuests = useCallback(async (): Promise<Array<{ id: string; name: string }>> => {
    if (!isAdmin) throw new Error('仅管理员可以查看访客清单');
    const { items } = await api.listKnownGuests();
    return items;
  }, [isAdmin]);

  /** 全部授权总览 */
  const listAllAccessGrants = useCallback(async (): Promise<AccessGrant[]> => {
    if (!isAdmin) throw new Error('仅管理员可以查看授权名单');
    const { items } = await api.listAllAccessGrants();
    return items;
  }, [isAdmin]);

  /** 创建文档；重名或失败时抛出错误，由调用方提示 */
  const createDoc: AppContextValue['createDoc'] = useCallback(
    async ({ name, type, parentId, content, repoId }) => {
      if (!isAdmin) return null;
      const { doc } = await api.createDoc({
        name,
        type,
        parentId,
        content,
        // 归属明确给出，省得服务端猜：在哪个仓库建的就落在哪个仓库
        ...(repoId ? { repoId } : {}),
      });
      setDocs((prev) => [...prev, doc]);
      // 仓库统计跟着走：新建了文档，仓库里的文件个数就该变，
      // 否则侧边栏与仓库设置里显示的一直是旧值
      void refreshRepos();
      return doc;
    },
    [isAdmin, refreshRepos],
  );

  /** 更新文档：先乐观更新，失败回滚 */
  const updateDoc = useCallback(
    (id: string, patch: Partial<DocNode>) => {
      if (!isAdmin) return;
      const snapshot = docs;
      setDocs((prev) =>
        prev.map((d) => (d.id === id ? { ...d, ...patch, id: d.id, updatedAt: Date.now() } : d)),
      );
      void api
        .updateDoc(id, patch)
        .then(({ doc }) => {
          // 加密文档的响应里没有正文（服务端只存密文），这里直接用响应覆盖。
          // 不会清空编辑器里的内容：编辑器有自己的 content state，
          // 且只在切换文档（doc.id 变化）时才从 doc.content 重新同步。
          // 也不把明文塞回全局 docs——那会让明文有机会被缓存进 localStorage。
          replaceDoc(doc);
        })
        .catch((e) => {
          setDocs(snapshot);
          log.error('更新文档失败', e);
        });
    },
    [isAdmin, docs, replaceDoc],
  );

  /**
   * 以外部内容覆盖指定文档，并通知打开中的编辑器跟随。
   *
   * 与 updateDoc 的区别仅在于额外发出 docSync 广播——后者用于「用户自己编辑后保存」
   * 这类由编辑器自己发起的写入，此时无需（也不能）反向覆盖编辑器 state。
   * 润色结果来自编辑器之外，必须走这里，否则打开中的文档表面无响应。
   *
   * 返回值用于调用方区分失败原因，避免静默失败。
   */
  const applyExternalContent = useCallback(
    (id: string, content: string): { ok: true } | { ok: false; reason: string } => {
      if (!isAdmin) return { ok: false, reason: '仅管理员可应用润色结果' };
      updateDoc(id, { content });
      docSyncTokenRef.current += 1;
      setDocSync({ docId: id, content, token: docSyncTokenRef.current });
      return { ok: true };
    },
    [isAdmin, updateDoc],
  );

  const deleteDoc = useCallback(
    (id: string): Promise<boolean> => {
      if (!isAdmin) return Promise.resolve(false);
      // 乐观删除：先把本地这棵子树摘掉，界面立刻就少了这一块。
      //
      // 等服务端回话再更新界面是不行的：删一个装着几十个文件的文件夹，
      // 服务端在 Windows 上要忙上好几秒（杀软要逐个扫被删的文件），
      // 前端只能干等，用户看到的就是「点了删除，界面半天不动」。
      //
      // 服务端真失败时下面的 catch 会回读一次清单，界面自动回到删除前的样子。
      setDocs((prev) => withoutSubtree(prev, id));
      return api
        .deleteDoc(id)
        .then(() => {
          // 以服务端为准回读一次：删除不可逆，避免残留幽灵数据与过期缓存
          void refreshDocs({ persist: true }).catch(() => undefined);
          // 仓库统计也要重算：删掉文件后仓库里的文件个数必须跟着减，
          // 否则侧边栏与仓库设置里显示的一直是删除前的旧值
          void refreshRepos();
          return true;
        })
        .catch(async (e) => {
          log.error('删除文档失败', e);
          toast.error('删除失败，已恢复服务端状态，请重试');
          // 失败可能发生在服务端已提交之后，必须回读对齐，不能让界面停留在错误状态
          await refreshDocs({ persist: true }).catch(() => undefined);
          void refreshRepos();
          return false;
        });
    },
    [isAdmin, refreshDocs, refreshRepos],
  );

  const moveDoc = useCallback(
    (id: string, newParentId: string | null): boolean => {
      if (!isAdmin) return false;
      const node = docs.find((d) => d.id === id);
      if (!node || id === newParentId) return false;
      if (newParentId) {
        // 禁止移动到自身或自身子孙节点
        const descendants = new Set<string>();
        const queue = [id];
        while (queue.length) {
          const cur = queue.shift()!;
          docs.filter((d) => d.parentId === cur).forEach((c) => {
            if (!descendants.has(c.id)) {
              descendants.add(c.id);
              queue.push(c.id);
            }
          });
        }
        if (descendants.has(newParentId)) return false;
        const target = docs.find((d) => d.id === newParentId);
        if (!target || target.type !== 'folder') return false;
      }
      // 同级重名校验
      if (docs.some((d) => d.parentId === newParentId && d.name === node.name && d.id !== id)) return false;
      setDocs((prev) =>
        prev.map((d) => (d.id === id ? { ...d, parentId: newParentId, updatedAt: Date.now() } : d)),
      );
      void api
        .updateDoc(id, { parentId: newParentId })
        .then(({ doc }) => {
          replaceDoc(doc);
        })
        .catch((e) => {
          log.error('移动文档失败', e);
          void refreshDocs({ persist: isAdmin }).catch(() => undefined);
        });
      return true;
    },
    [isAdmin, docs, replaceDoc, refreshDocs],
  );

  /**
   * 上传一个文件。
   *
   * 分两种走法，因为它们是两种东西：
   * - `.md` → 当作笔记建，正文是文本，可编辑、可检索；
   * - 其它 → 当作**原件**建，节点本身就是这个文件。
   *
   * 原先的做法是给非 Markdown 文件也建一篇同名笔记、再把文件挂成附件，
   * 结果上传一个 zip 就凭空多出一篇空笔记：文件自带的说明没人要，
   * 那篇空壳倒成了每次都要点开、点开发现什么都没有的东西。
   */
  const uploadFile: AppContextValue['uploadFile'] = useCallback(
    async (file, parentId, repoId) => {
      if (!isAdmin) return null;
      if (file.name.toLowerCase().endsWith('.md')) {
        const text = await file.text();
        const { doc } = await api.createDoc({
          name: file.name,
          type: 'file',
          parentId,
          content: text,
          // 明确指定的仓库优先；不传则由服务端沿用父节点的归属
          ...(repoId !== undefined ? { repoId } : {}),
        });
        setDocs((prev) => [...prev, doc]);
        void refreshRepos();
        return doc;
      }
      // 原件：文件即节点。名字保留原样（含扩展名），字节原样落盘
      const doc = await api.uploadFile(file, parentId, repoId);
      setDocs((prev) => [...prev, doc]);
      void refreshRepos();
      return doc;
    },
    [isAdmin, refreshRepos],
  );

  // 构造树（基于可见列表）
  const buildTree: AppContextValue['buildTree'] = useCallback(
    (repoId?: string) => {
      // 按仓库过滤时只看该仓库的文档。
      // 仓库归属是沿父节点继承的，所以祖先链天然留在同一个仓库里，
      // 过滤后不会出现「父节点被滤掉、子节点悬空」的情况。
      const source =
        repoId === undefined
          ? visibleDocs
          : visibleDocs.filter((d) => d.repoId === repoId);
      const map = new Map<string, DocTree>();
      source.forEach((d) => map.set(d.id, { ...d, children: [] }));
      const roots: DocTree[] = [];
      map.forEach((node) => {
        if (node.parentId && map.has(node.parentId)) map.get(node.parentId)!.children.push(node);
        else roots.push(node);
      });
      const sortTree = (list: DocTree[]) => {
        list.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
          return a.name.localeCompare(b.name, 'zh-Hans-CN');
        });
        list.forEach((n) => sortTree(n.children));
      };
      sortTree(roots);
      return roots;
    },
    [visibleDocs],
  );

  // 路径（基于可见列表，访客面包屑不会暴露隐藏层级）
  const getPath = useCallback(
    (id: string): DocNode[] => {
      const path: DocNode[] = [];
      let cur = visibleDocs.find((d) => d.id === id);
      while (cur) {
        path.unshift(cur);
        cur = cur.parentId ? visibleDocs.find((d) => d.id === cur!.parentId) : undefined;
      }
      return path;
    },
    [visibleDocs],
  );

  // Agent 可用性以服务端判定为准：canUse 已同时考虑 API Key 与访客开关
  const canUseAgent = agentStatus.canUse;

  const value = useMemo<AppContextValue>(
    () => ({
      currentUser,
      users: SEED_USERS,
      loginAdmin,
      changeAdminPassword,
      logoutAdmin,
      isAdmin,
      hasPermission,
      bootstrapping,
      docs,
      getDoc,
      loadDocContent,
      createDoc,
      updateDoc,
      applyExternalContent,
      docSync,
      polishTaskEpoch,
      notifyPolishTaskCreated,
      deleteDoc,
      moveDoc,
      uploadFile,
      refreshDocs,
      visibleDocs,
      repoScopedDocs,
      tagFilter,
      setTagFilter,
      allTags,
      repos,
      repoStats,
      refreshRepos,
      currentRepoId,
      setCurrentRepoId,
      currentRepo,
      searchQuery,
      searchHits,
      searching,
      runSearch,
      clearSearch,
      encryptDoc,
      revealDoc,
      decryptDoc,
      guest,
      requestDocAccess,
      openDocByGrant,
      checkDocAccess,
      setGuestName,
      listAccessRequests,
      pendingAccessCount,
      approveAccessRequest,
      rejectAccessRequest,
      listDocAccessGrants,
      listAllAccessGrants,
      revokeDocAccessGrant,
      updateDocAccessGrant,
      bulkApproveAccessRequests,
      bulkGrantAccess,
      listKnownGuests,
      listAccessAudit,
      adminConsoleOpen,
      adminSection,
      adminDocFilter,
      adminFocusRequestId,
      openAdminConsole,
      closeAdminConsole,
      agentConfig,
      canUseAgent,
      agentReason: agentStatus.reason,
      refreshAgentStatus,
      buildTree,
      getPath,
      }),
      [
      currentUser,
      loginAdmin,
      changeAdminPassword,
      logoutAdmin,
      isAdmin,
      hasPermission,
      bootstrapping,
      docs,
      getDoc,
      loadDocContent,
      createDoc,
      updateDoc,
      applyExternalContent,
      docSync,
      polishTaskEpoch,
      notifyPolishTaskCreated,
      deleteDoc,
      moveDoc,
      uploadFile,
      refreshDocs,
      visibleDocs,
      repoScopedDocs,
      tagFilter,
      setTagFilter,
      allTags,
      repos,
      repoStats,
      refreshRepos,
      currentRepoId,
      currentRepo,
      searchQuery,
      searchHits,
      searching,
      runSearch,
      clearSearch,
      encryptDoc,
      revealDoc,
      decryptDoc,
      guest,
      requestDocAccess,
      openDocByGrant,
      checkDocAccess,
      setGuestName,
      listAccessRequests,
      pendingAccessCount,
      approveAccessRequest,
      rejectAccessRequest,
      listDocAccessGrants,
      listAllAccessGrants,
      revokeDocAccessGrant,
      updateDocAccessGrant,
      bulkApproveAccessRequests,
      bulkGrantAccess,
      listKnownGuests,
      listAccessAudit,
      adminConsoleOpen,
      adminSection,
      adminDocFilter,
      adminFocusRequestId,
      openAdminConsole,
      closeAdminConsole,
      agentConfig,
      canUseAgent,
      agentStatus.reason,
      refreshAgentStatus,
      buildTree,
      getPath,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- Context 配套的 hook 与 Provider 同文件是标准写法
export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
