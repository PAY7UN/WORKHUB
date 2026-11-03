import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  FileText,
  Home,
  FilePlus,
  FolderPlus,
  Upload,
  LogOut,
  ShieldCheck,
  LayoutDashboard,
  Bot,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { AgentPanel } from './AgentPanel';
import { AdminConsole } from './admin/AdminConsole';
import { DocTreeView } from './DocTreeView';
import { FolderView } from './FolderView';
import { DocEditor } from './DocEditor';
import { DropPreview } from './DropPreview';
import { RepoSwitcher } from './RepoSwitcher';
import {
  AdminLoginDialog,
  CreateDialog,
  RenameDialog,
  DeleteDialog,
  MoveDialog,
  UploadDialog,
  EncryptDocDialog,
  RepoAssignDialog,
  type UploadBatchResult,
  type UploadProgress,
} from './Modal';
import { api } from '@/lib/api';
import { extOf } from '../../../shared/attachments';
import type { DocNode } from '@/types';
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from '@/types';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface WorkspaceProps {
  onGoHome: () => void;
}

export function Workspace({ onGoHome }: WorkspaceProps) {
  const {
    currentUser,
    isAdmin,
    loginAdmin,
    logoutAdmin,
    docs,
    buildTree,
    loadDocContent,
    createDoc,
    updateDoc,
    deleteDoc,
    moveDoc,
    hasPermission,
    visibleDocs,
    encryptDoc,
    decryptDoc,
    canUseAgent,
    pendingAccessCount,
    openAdminConsole,
    currentRepoId,
    currentRepo,
    repos,
    refreshRepos,
    refreshDocs,
  } = useApp();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);  // 仅记录正在编辑的文档 id，文档对象从 docs 实时派生，保证切换/更新时内容同步
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  /** 深链定位只处理一次 */
  const handledFocusRef = useRef(false);

  /**
   * 访问申请定位深链：带着 ?access=<申请单号> 落回本站时，
   * 直接跳到「访问授权」分区并定位那一条申请。
   *
   * 只在管理员身份下生效：这条链接要的是「批不批」，
   * 访客点开也做不了审批，不如让他看见一个打不开的后台。
   * 没登录成管理员就等着——等管理员登录完，身份一变这个副作用会再跑一次。
   */
  useEffect(() => {
    if (handledFocusRef.current) return;
    let requestId = '';
    try {
      requestId = sessionStorage.getItem('mdhub.focusRequest') ?? '';
    } catch {
      return;
    }
    if (!requestId || !isAdmin) return;
    handledFocusRef.current = true;
    sessionStorage.removeItem('mdhub.focusRequest');
    openAdminConsole('access', undefined, requestId);
  }, [isAdmin, openAdminConsole]);

  // 当前所在目录 / 正在编辑的文档若已不存在（被删除），派生值自动回退
  const visibleFolderId = useMemo(
    () => (currentFolderId && visibleDocs.some((d) => d.id === currentFolderId) ? currentFolderId : null),
    [visibleDocs, currentFolderId],
  );
  const visibleEditingId = useMemo(
    () => (editingId && visibleDocs.some((d) => d.id === editingId) ? editingId : null),
    [visibleDocs, editingId],
  );

  const editingDoc: DocNode | null = useMemo(
    () => (visibleEditingId ? docs.find((d) => d.id === visibleEditingId) ?? null : null),
    [visibleEditingId, docs],
  );

  // 选中的节点若已不存在，回退到第一个文档（等价于「自动选中首个文档」）
  const effectiveSelectedId = useMemo(() => {
    if (selectedId && visibleDocs.some((d) => d.id === selectedId)) return selectedId;
    return visibleDocs.find((d) => d.type === 'file')?.id ?? null;
  }, [selectedId, visibleDocs]);

  // 各类弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'folder'>('file');
  const [createParentId, setCreateParentId] = useState<string | null>(null);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DocNode | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  // Agent 面板
  const [agentOpen, setAgentOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocNode | null>(null);

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<DocNode | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadParentId, setUploadParentId] = useState<string | null>(null);

  const [adminLoginOpen, setAdminLoginOpen] = useState(false);

  // 文档加密：目标文档
  const [encryptTarget, setEncryptTarget] = useState<DocNode | null>(null);

  // 仓库归属：待迁移的文档
  const [repoTarget, setRepoTarget] = useState<DocNode | null>(null);

  // 按当前所在仓库过滤文件树：只看选中仓库的资料。
  // 仓库是必选的，所以这里始终带着仓库 id——不存在「所有仓库混在一起」的视图。
  const tree = useMemo(() => buildTree(currentRepoId || undefined), [buildTree, currentRepoId]);

  // 统计某节点下所有后代（用于删除前提示影响范围）
  const countDescendants = useCallback((id: string) => {
    const acc = { files: 0, folders: 0 };
    const walk = (parentId: string) => {
      docs.forEach((d) => {
        if (d.parentId !== parentId) return;
        if (d.type === 'folder') acc.folders += 1;
        else acc.files += 1;
        walk(d.id);
      });
    };
    walk(id);
    return acc;
  }, [docs]);

  const deleteTargetStats = useMemo(
    () => (deleteTarget && deleteTarget.type === 'folder' ? countDescendants(deleteTarget.id) : undefined),
    [deleteTarget, countDescendants]
  );

  // ---------- 操作 ----------
  const handleSelect = (doc: DocNode) => {
    setSelectedId(doc.id);
    if (doc.type === 'folder') {
      setCurrentFolderId(doc.id);
      setEditingId(null);
    } else {
      // 点击文件直接打开文章
      setCurrentFolderId(doc.parentId);
      setEditingId(doc.id);
      // 清单里只有元数据，正文得单独取
      void loadDocContent(doc.id);
    }
  };

  const handleOpenDoc = (doc: DocNode) => {
    if (doc.type === 'file') {
      setEditingId(doc.id);
      setSelectedId(doc.id);
      // 清单里只有元数据，正文得单独取
      void loadDocContent(doc.id);
    } else {
      setCurrentFolderId(doc.id);
      setExpanded((p) => ({ ...p, [doc.id]: true }));
    }
  };

  const handleCreate = async (name: string) => {
    try {
      const result = await createDoc({ name, type: createType, parentId: createParentId });
      if (!result) return;
      setExpanded((p) => ({ ...p, [createParentId || 'root']: true }));
      if (createType === 'file') {
        // 新建文档的落点是「开始写」，不是「打开一个空文件」——
        // 说清楚下一步要做什么，用户才知道该往哪儿看
        toast.success(`文档「${result.name}」已创建，直接在正文里写`);
        setEditingId(result.id);
        setSelectedId(result.id);
      } else {
        toast.success(`文件夹「${result.name}」已创建`);
        setCurrentFolderId(result.id);
      }
    } catch (e) {
      toast.error((e as Error)?.message ?? '创建失败');
    }
  };

  const handleRename = (name: string) => {
    if (!renameTarget) return;
    const trimmed = renameTarget.type === 'file' && !name.toLowerCase().endsWith('.md') ? `${name}.md` : name;
    // 检查同名
    if (docs.some((d) => d.parentId === renameTarget.parentId && d.name === trimmed && d.id !== renameTarget.id)) {
      toast.error('同名文件已存在');
      return;
    }
    updateDoc(renameTarget.id, { name: trimmed });
    toast.success('已重命名');
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    const { id, name, parentId } = deleteTarget;
    // 先关弹窗，不等网络：等待期间界面不卡住
    setDeleteTarget(null);
    setDeleteOpen(false);
    // 选中与目录状态也当场收拾掉，不等服务端回话。
    // deleteDoc 内部是乐观删除（先把本地子树摘了），这里的清理要跟上，
    // 否则会有一瞬间的错位：清单里节点没了，选中状态却还指着它。
    if (selectedId === id) {
      setSelectedId(null);
    }
    if (editingId === id) {
      setEditingId(null);
    }
    // 删除当前所在文件夹时回退到父目录，避免停留在已失效的目录 id 上
    if (currentFolderId === id) {
      setCurrentFolderId(parentId);
    }
    // 删除失败时不弹成功提示：那会把「服务端未启动 / 无权限」伪装成删除成功，
    // 用户刷新后文档原样回来，反而更难定位。失败提示由 deleteDoc 内部统一给出。
    void deleteDoc(id).then((ok) => {
      if (!ok) return;
      toast.success(`已删除「${name}」`);
    });
  };

  /**
   * 文档加密相关操作。
   *
   * 取消加密不需要确认，直接执行；
   * 加密走对话框：这是不可逆的（除非再取消加密），值得一次确认。
   */
  const handleRequestEncrypt = (node: DocNode, mode: 'encrypt' | 'decrypt') => {
    if (mode === 'decrypt') {
      void decryptDoc(node.id)
        .then(() => toast.success(`已取消加密「${node.name}」`))
        .catch((e) => toast.error(e instanceof Error ? e.message : '取消加密失败'));
      return;
    }
    setEncryptTarget(node);
  };

  /** 对话框提交：确认加密 */
  const handleEncryptConfirm = async (): Promise<{ ok: boolean; message: string }> => {
    if (!encryptTarget) return { ok: false, message: '未选择文档' };
    try {
      await encryptDoc(encryptTarget.id);
      toast.success(`已加密「${encryptTarget.name}」，访客需提交访问申请后方可查看`);
      return { ok: true, message: '' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '操作失败' };
    }
  };

  const handleMove = (newParentId: string | null) => {
    if (!moveTarget) return;
    const ok = moveDoc(moveTarget.id, newParentId);
    if (ok) {
      toast.success(`已将「${moveTarget.name}」移动到${newParentId ? '新位置' : '根目录'}`);
    } else {
      toast.error('移动失败：目标位置无效或存在同名文件');
    }
  };

  /**
   * 把文档（连同整棵子树）迁移到另一个仓库。
   *
   * 迁移的是归属，不是内容：文档不会被复制一份到新仓库，
   * 否则两份内容迟早会不一样。子树跟着一起搬，父子不分属两个仓库。
   *
   * 文档没有「移出仓库」这个选项：每个文档都必须有归属，
   * 想换归属就换一个仓库，而不是把它丢在一边。
   *
   * 迁完必须重拉文档与仓库：归属信息随文档下发，
   * 不刷新的话界面显示的还是旧归属，用户会以为没生效。
   */
  const handleAssignRepo = async (repoId: string) => {
    if (!repoTarget) return;
    const { id, name } = repoTarget;
    try {
      const moved = (await api.assignDocsToRepo(repoId, [id])).moved;
      await Promise.all([refreshDocs(), refreshRepos()]);
      const repoName = repos.find((r) => r.id === repoId)?.name;
      const extra = moved > 1 ? `，连带 ${moved - 1} 篇子文档` : '';
      toast.success(`「${name}」已归入「${repoName ?? '仓库'}」${extra}`);
    } catch (e) {
      toast.error((e as Error)?.message ?? '操作失败');
    }
  };

  /**
   * 处理一批上传的文件。
   *
   * 两条分流，因为它们是两种东西：
   * - .md / .markdown → 文档正文，可编辑、可检索；
   * - 其它格式（含 .zip）→ **原件**，节点就是这个文件本身，点开可预览可下载。
   *
   * 文件不需要配一份 Markdown 备注。原先非 Markdown 文件会被建成
   * 「同名笔记 + 挂在下面的附件」，于是一个 zip 在树上多出一篇空笔记，
   * 打开是个空编辑器——逼着人以为「文件必须配备注才能用」。
   *
   * 压缩包不再被解开：上传压缩包就是把这个包原样存进来，
   * 和上传其它二进制没有区别。解包会擅自改变资料的组织方式，
   * 而归档的边界该由用户自己定。
   *
   * 用「选择文件夹」上传时，文件自带 webkitRelativePath，
   * 这里的层级会先被还原成真实的文件夹，再把文件放进去。
   */
  const handleUploadBatch = async (
    files: File[],
    onProgress?: UploadProgress,
  ): Promise<UploadBatchResult> => {
    const result: UploadBatchResult = { ok: 0, failed: [] };
    // 明确归入当前仓库：文档必须有归属，上传时就把归属定下来，
    // 免得先落进默认仓库再搬一遍
    const repoId = currentRepoId || undefined;
    const total = files.length;
    let done = 0;

    /** 相对目录路径 → 目录文档 id；重复上传同一目录时复用 */
    const dirCache = new Map<string, string | null>();

    const ensureDir = async (path: string): Promise<string | null> => {
      if (!path) return uploadParentId;
      const cached = dirCache.get(path);
      if (cached !== undefined) return cached;
      const idx = path.lastIndexOf('/');
      const parentPath = idx >= 0 ? path.slice(0, idx) : '';
      const name = idx >= 0 ? path.slice(idx + 1) : path;
      const parentId = await ensureDir(parentPath);
      const { doc } = await api.createDoc({ name, type: 'folder', parentId, repoId });
      dirCache.set(path, doc.id);
      return doc.id;
    };

    for (const file of files) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
      const ext = extOf(file.name);
      try {
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        const parentId = dir ? await ensureDir(dir) : uploadParentId;

        if (ext === '.md' || ext === '.markdown') {
          // 这里直接建文档，不再走 uploadFile：
          // uploadFile 每传一个文件就刷一次仓库统计，
          // 一批文件会打出同样多的请求，而这批的统计在末尾统一刷一次就够。
          const { doc } = await api.createDoc({
            name: file.name,
            type: 'file',
            parentId,
            content: await file.text(),
            ...(repoId !== undefined ? { repoId } : {}),
          });
          result.ok += 1;
          setSelectedId(doc.id);
          setEditingId(doc.id);
          // 上传的正文在仓库目录的文件里，清单里只有元数据
          void loadDocContent(doc.id);
        } else {
          // 其它格式（含压缩包）：文件本身就是这个节点。
          //
          // 不再「建一篇同名笔记 + 挂一个附件」——那会给一个自解释的文件
          // 配一份没人写的备注，还让人每次点开都扑个空。
          // 压缩包尤其不该配备注：包里的清单就是它的说明，
          // 而备注不会跟着包一起更新，必然过期。
          const doc = await api.uploadFile(file, parentId, repoId);
          result.ok += 1;
          setSelectedId(doc.id);
        }
      } catch (e) {
        result.failed.push({ name: file.name, reason: (e as Error)?.message ?? '上传失败' });
      }
      done += 1;
      onProgress?.(done, total, file.name);
    }

    // 文档与仓库统计一起刷新：上传既增了文档数，也增了附件数，
    // 只刷文档的话仓库里的文件个数会停在旧值上
    if (result.ok > 0) await Promise.all([refreshDocs(), refreshRepos()]);
    if (result.failed.length === 0 && result.ok > 0) {
      toast.success(`已导入 ${result.ok} 个文件`);
    }
    return result;
  };

  const openCreate = (parentId: string | null, type: 'file' | 'folder') => {
    setCreateParentId(parentId);
    setCreateType(type);
    setCreateOpen(true);
  };

  const openUpload = (parentId: string | null) => {
    setUploadParentId(parentId);
    setUploadOpen(true);
  };

  /** 文件树的交互回调：分组显示时，多棵树共用同一套 */
  const treeProps = {
    selectedId: effectiveSelectedId,
    expanded,
    onToggleExpand: (id: string) => setExpanded((p) => ({ ...p, [id]: !(p[id] ?? false) })),
    onSelect: handleSelect,
    onRequestCreate: openCreate,
    onRequestRename: (n: DocNode) => {
      setRenameTarget(n);
      setRenameOpen(true);
    },
    onRequestDelete: (n: DocNode) => {
      setDeleteTarget(n);
      setDeleteOpen(true);
    },
    onRequestMove: (n: DocNode) => {
      setMoveTarget(n);
      setMoveOpen(true);
    },
    onRequestUpload: openUpload,
    onRequestEncrypt: handleRequestEncrypt,
    onRequestAccessGrant: (n: DocNode) => {
      // 从文档菜单进入管理后台的「访问授权」分区，并限定在这一篇文档
      openAdminConsole('access', { docId: n.id, docName: n.name });
    },
    onRequestRepo: (n: DocNode) => setRepoTarget(n),
  };

  const canCreate = hasPermission('doc.create');
  const canUpload = hasPermission('doc.upload');

  return (
    <div className="h-screen flex overflow-hidden">
      {/* 侧边栏 */}
      <aside className="w-64 shrink-0 flex flex-col border-r border-indigo-100/40 dark:border-indigo-900/40 glass">
        {/* Logo（点击返回主页） */}
        <div className="p-4 border-b border-indigo-100/40 dark:border-indigo-900/40">
          <button
            onClick={onGoHome}
            className="flex items-center gap-2.5 w-full text-left group cursor-pointer"
            title="返回主页"
          >
            <div className="relative">
              <div className="absolute inset-0 gradient-bg rounded-xl blur-md opacity-50" />
              <div className="relative h-9 w-9 rounded-xl gradient-bg flex items-center justify-center shadow-md">
                <FileText className="h-4.5 w-4.5 text-white" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-base gradient-text leading-tight group-hover:opacity-80 transition-opacity">
                WorkHub
              </div>
              <div className="text-[10px] text-muted-foreground">现代化文档管理 · 点击返回主页</div>
            </div>
          </button>
        </div>

        {/* 用户信息 / 管理员切换 */}
        <div className="p-3 border-b border-indigo-100/40 dark:border-indigo-900/40">
          <div className="flex items-center gap-2.5 p-2 rounded-lg bg-white/40 dark:bg-white/5">
            <div
              className="h-8 w-8 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0"
              style={{ backgroundColor: currentUser.color }}
            >
              {currentUser.avatar}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{currentUser.displayName}</div>
              <div className="text-[10px] text-muted-foreground truncate">
                {ROLE_LABELS[currentUser.role]} · {ROLE_DESCRIPTIONS[currentUser.role].split('，')[0]}
              </div>
            </div>
            {isAdmin ? (
              <>
                {/* 管理入口只留一个。
                    以前这里是三个挤在一起的小图标（授权、密码、改密），
                    光看图标认不出哪个是哪件事；现在统一进「管理后台」，
                    按功能分区在后台里找。 */}
                <div className="relative">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openAdminConsole('overview')}
                    className="h-7 px-2 text-[11px] hover:bg-indigo-100/60 hover:text-indigo-600 dark:hover:bg-indigo-950/30"
                    title="管理后台：概览、访问授权、加密文档、AI Agent、账号安全"
                  >
                    <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                    管理
                  </Button>
                  {pendingAccessCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-medium text-white">
                      {pendingAccessCount}
                    </span>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    logoutAdmin();
                    setEditingId(null);
                    toast.success('已退出管理员，当前为访客模式');
                  }}
                  className="h-7 w-7 hover:bg-red-100/60 hover:text-red-600 dark:hover:bg-red-950/30"
                  title="退出管理员"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={() => setAdminLoginOpen(true)}
                className="h-7 px-2 text-[11px] gradient-bg hover:opacity-90"
                title="切换为管理员"
              >
                <ShieldCheck className="h-3 w-3 mr-1" />
                管理员
              </Button>
            )}
          </div>
        </div>

        {/* 操作按钮：三档操作同排分段，静止态统一，强调只在 hover 出现 */}
        {canCreate && (
          <div className="border-b border-indigo-100/40 px-3 pb-3 pt-2.5 dark:border-indigo-900/40">
            <div className="flex overflow-hidden rounded-lg border border-slate-200/70 bg-white/60 transition-colors dark:border-slate-700/50 dark:bg-white/5">
              <button
                type="button"
                onClick={() => openCreate(currentFolderId, 'file')}
                title="新建文档"
                className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1 text-[11px] font-medium text-slate-700 transition-colors hover:bg-indigo-50 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 focus-visible:outline-none dark:text-slate-200 dark:hover:bg-indigo-500/15 dark:hover:text-indigo-200"
              >
                <FilePlus className="h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-nowrap">新建文档</span>
              </button>
              <button
                type="button"
                onClick={() => openCreate(currentFolderId, 'folder')}
                title="新建文件夹"
                className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1 border-l border-slate-200/70 text-[11px] font-medium text-slate-700 transition-colors hover:bg-indigo-50 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 focus-visible:outline-none dark:border-slate-700/50 dark:text-slate-200 dark:hover:bg-indigo-500/15 dark:hover:text-indigo-200"
              >
                <FolderPlus className="h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-nowrap">新建文件夹</span>
              </button>
              {canUpload && (
                <button
                  type="button"
                  onClick={() => openUpload(currentFolderId)}
                  title="上传文件：.md 变成文档，其它格式（含压缩包）原样存为原件"
                  className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1 border-l border-slate-200/70 text-[11px] font-medium text-slate-700 transition-colors hover:bg-indigo-50 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 focus-visible:outline-none dark:border-slate-700/50 dark:text-slate-200 dark:hover:bg-indigo-500/15 dark:hover:text-indigo-200"
                >
                  <Upload className="h-3.5 w-3.5 shrink-0" />
                  <span className="whitespace-nowrap">上传文件</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* 仓库切换：按项目圈定当前看得见的资料 */}
        <RepoSwitcher />

        {/* 文件树 */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-2">
          <div className="flex items-center justify-between mb-2 px-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              文件树
              {currentRepo ? ` · ${currentRepo.name}` : ''}
            </span>
            <button
              onClick={() => setCurrentFolderId(null)}
              className="text-[10px] text-indigo-500 hover:text-indigo-700 flex items-center gap-0.5 cursor-pointer"
              title="回到根目录"
            >
              <Home className="h-3 w-3" /> 根
            </button>
          </div>
          <DocTreeView tree={tree} {...treeProps} />
        </div>

        {/* 原「载入示例文档」入口已移除。
            它会把全部真实文档清空换成示例内容，仅靠 confirm() 兜底；
            本项目已承载真实文档，这类破坏性入口不应出现在界面上。
            对应的服务端接口与实现也已一并删除，不留后门。 */}
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 min-w-0 flex flex-col">
        {editingDoc ? (
          <DocEditor doc={editingDoc} onClose={() => setEditingId(null)} />
        ) : (
          <FolderView
            folderId={visibleFolderId}
            onOpen={handleOpenDoc}
            onRequestRename={(n) => {
              setRenameTarget(n);
              setRenameOpen(true);
            }}
            onRequestDelete={(n) => {
              setDeleteTarget(n);
              setDeleteOpen(true);
            }}
            onRequestMove={(n) => {
              setMoveTarget(n);
              setMoveOpen(true);
            }}
            onRequestRepo={(n) => setRepoTarget(n)}
          />
        )}
      </main>

      {/* 弹窗 */}
      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        type={createType}
        parentName={createParentId ? docs.find((d) => d.id === createParentId)?.name : undefined}
        onConfirm={handleCreate}
      />
      <EncryptDocDialog
        open={encryptTarget !== null}
        onOpenChange={(v) => {
          if (!v) setEncryptTarget(null);
        }}
        docName={encryptTarget?.name ?? ''}
        onConfirm={handleEncryptConfirm}
      />
      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        initialName={renameTarget?.name || ''}
        onConfirm={handleRename}
      />
      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        name={deleteTarget?.name || ''}
        isFolder={deleteTarget?.type === 'folder'}
        descendantCount={deleteTargetStats}
        onConfirm={handleDelete}
      />
      <MoveDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        node={moveTarget}
        tree={tree}
        currentParentId={moveTarget?.parentId ?? null}
        onConfirm={handleMove}
      />
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        parentName={uploadParentId ? docs.find((d) => d.id === uploadParentId)?.name : undefined}
        repoName={currentRepo?.name}
        allowedExts={currentRepo?.allowedExts}
        maxFileSize={currentRepo?.maxFileSize}
        onUpload={handleUploadBatch}
      />
      <AdminLoginDialog
        open={adminLoginOpen}
        onOpenChange={setAdminLoginOpen}
        onLogin={async (pwd) => {
          const result = await loginAdmin(pwd);
          if (result.ok) toast.success('已切换为管理员模式');
          return result;
        }}
      />
      {/* 仓库归属：跨仓库迁移（含整棵子树） */}
      <RepoAssignDialog
        open={repoTarget !== null}
        onOpenChange={(v) => {
          if (!v) setRepoTarget(null);
        }}
        docName={repoTarget?.name ?? ''}
        currentRepoId={repoTarget?.repoId}
        repos={repos}
        onConfirm={(repoId) => void handleAssignRepo(repoId)}
      />
      {/* 拖拽预览：把 .md 拖到页面任意位置即可就地阅读（不入库） */}
      <DropPreview
        parentId={visibleFolderId}
        onSaved={(docId) => {
          setSelectedId(docId);
          setEditingId(docId);
          // 正文在仓库目录的文件里，清单里只有元数据
          void loadDocContent(docId);
        }}
      />

      {/* 管理后台：按功能分区（概览 / 访问授权 / 加密文档 / AI Agent / 账号安全） */}
      <AdminConsole />

      {/* 文档分析 Agent（配置入口在面板右上角齿轮） */}
      <AgentPanel open={agentOpen} onOpenChange={setAgentOpen} />

      {/* 右下角悬浮入口：常显，面板展开时隐藏避免遮挡 */}
      {!agentOpen && (
        <button
          type="button"
          onClick={() => setAgentOpen(true)}
          title={
            canUseAgent
              ? '基于可见文档的智能问答'
              : isAdmin
                ? '尚未配置 API Key，点击进入配置'
                : '管理员尚未开放或未配置 Agent'
          }
          className={cn(
            'fixed bottom-5 right-5 z-40 flex items-center gap-2 h-11 pl-3.5 pr-4 rounded-full',
            'text-sm font-medium text-white shadow-lg shadow-indigo-500/25',
            'transition-all duration-200 hover:scale-105 active:scale-95',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
            canUseAgent
              ? 'bg-gradient-to-br from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600'
              : 'bg-slate-400/80 hover:bg-slate-500 dark:bg-slate-600/80 dark:hover:bg-slate-500',
          )}
        >
          <Bot className="h-5 w-5 shrink-0" />
          <span className="whitespace-nowrap">AI 助手</span>
          {!canUseAgent && (
            <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-normal leading-none">
              未就绪
            </span>
          )}
        </button>
      )}
    </div>
  );
}
