import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  FilePlus,
  FolderPlus,
  Upload,
  Home,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '@/context/AppContext';
import { DocTreeView } from '../DocTreeView';
import { FolderView } from '../FolderView';
import { DocEditor } from '../DocEditor';
import { DropPreview } from '../DropPreview';
import {
  CreateDialog,
  RenameDialog,
  DeleteDialog,
  MoveDialog,
  UploadDialog,
  EncryptDocDialog,
  type UploadBatchResult,
  type UploadProgress,
} from '../Modal';
import { api } from '@/lib/api';
import { extOf } from '../../../../shared/attachments';
import type { DocNode } from '@/types';
import { toast } from 'sonner';

/**
 * 文档工作区。
 *
 * 这里只放「文档」这一件事：文件树、编辑器、文件夹视图，以及围绕它们的
 * 新建/重命名/删除/移动/上传/加密等操作。
 *
 * 全局性的东西（身份、管理后台、AI 助手）不在这里——它们属于整个应用，
 * 挂在 Shell 上，换到工作台时依然在。
 */
export function DocsWorkspace() {
  const {
    isAdmin,
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
    refreshDocs,
    bootstrapping,
  } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 退出管理员时收起编辑器：访客身份下编辑器里的写入会被服务端拒绝，
  // 留着一个改不动的编辑界面只会让人以为文档坏了。
  useEffect(() => {
    if (!isAdmin) setEditingId(null);
  }, [isAdmin]);

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
  const [deleteTarget, setDeleteTarget] = useState<DocNode | null>(null);

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<DocNode | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadParentId, setUploadParentId] = useState<string | null>(null);

  // 文档加密：目标文档
  const [encryptTarget, setEncryptTarget] = useState<DocNode | null>(null);

  const tree = useMemo(() => buildTree(), [buildTree]);

  /* ------------------------------ 深链：?doc=<节点 id> ------------------------------ */

  /**
   * 深链：地址栏里带着 `?doc=<节点 id>` 时，落在这篇文档上。
   *
   * 这是「说明书从工具区搬进记录区」之后的关键一环：
   * 工具区的协议行给的链接就是 `/?doc=<节点 id>`，
   * 点一下直接落到记录区里那篇说明书，而不是落到记录区的首页。
   */
  const deepLinkId = searchParams.get('doc');

  /** 展开一篇文档的祖先目录，否则它在树里是收着的，看不到自己落在哪 */
  const expandAncestors = useCallback(
    (doc: DocNode) => {
      setExpanded((prev) => {
        const next = { ...prev };
        let parentId = doc.parentId;
        while (parentId) {
          next[parentId] = true;
          parentId = docs.find((d) => d.id === parentId)?.parentId ?? null;
        }
        return next;
      });
    },
    [docs],
  );

  useEffect(() => {
    if (!deepLinkId) return;
    const doc = visibleDocs.find((d) => d.id === deepLinkId);
    if (!doc) return;
    // 已经开着了就别再动：否则每次渲染都重新取一遍正文
    if (editingId === deepLinkId) return;
    setSelectedId(doc.id);
    if (doc.type === 'file') {
      setCurrentFolderId(doc.parentId);
      setEditingId(doc.id);
      // 清单里只有元数据，正文得单独取
      void loadDocContent(doc.id);
    } else {
      setCurrentFolderId(doc.id);
    }
    expandAncestors(doc);
  }, [deepLinkId, visibleDocs, editingId, loadDocContent, expandAncestors]);

  /** 地址栏跟着当前打开的文档走：关掉编辑器就把参数撤掉 */
  const syncDocParam = useCallback(
    (docId: string | null) => {
      const current = searchParams.get('doc');
      if (docId) {
        if (current === docId) return;
        const next = new URLSearchParams(searchParams);
        next.set('doc', docId);
        setSearchParams(next, { replace: true });
      } else if (current) {
        const next = new URLSearchParams(searchParams);
        next.delete('doc');
        setSearchParams(next, { replace: true });
      }
    },
    [searchParams, setSearchParams],
  );

  // 统计某节点下所有后代（用于删除前提示影响范围）
  const countDescendants = useCallback(
    (id: string) => {
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
    },
    [docs],
  );

  const deleteTargetStats = useMemo(
    () => (deleteTarget && deleteTarget.type === 'folder' ? countDescendants(deleteTarget.id) : undefined),
    [deleteTarget, countDescendants],
  );

  // ---------- 操作 ----------

  const handleSelect = (doc: DocNode) => {
    setSelectedId(doc.id);
    if (doc.type === 'folder') {
      setCurrentFolderId(doc.id);
      setEditingId(null);
      syncDocParam(null);
    } else {
      // 点击文件直接打开文章
      setCurrentFolderId(doc.parentId);
      setEditingId(doc.id);
      syncDocParam(doc.id);
      // 清单里只有元数据，正文得单独取
      void loadDocContent(doc.id);
    }
  };

  const handleOpenDoc = (doc: DocNode) => {
    if (doc.type === 'file') {
      setEditingId(doc.id);
      setSelectedId(doc.id);
      syncDocParam(doc.id);
      // 清单里只有元数据，正文得单独取
      void loadDocContent(doc.id);
    } else {
      setCurrentFolderId(doc.id);
      setExpanded((p) => ({ ...p, [doc.id]: true }));
      syncDocParam(null);
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
    const trimmed =
      renameTarget.type === 'file' && !name.toLowerCase().endsWith('.md') ? `${name}.md` : name;
    // 检查同名
    if (
      docs.some(
        (d) => d.parentId === renameTarget.parentId && d.name === trimmed && d.id !== renameTarget.id,
      )
    ) {
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
    if (selectedId === id) setSelectedId(null);
    if (editingId === id) setEditingId(null);
    // 删除当前所在文件夹时回退到父目录，避免停留在已失效的目录 id 上
    if (currentFolderId === id) setCurrentFolderId(parentId);
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
      const { doc } = await api.createDoc({ name, type: 'folder', parentId });
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
          // uploadFile 每传一个文件就多一次独立往返，
          // 一批文件会打出同样多的请求，批量里直接挨个建更省事。
          const { doc } = await api.createDoc({
            name: file.name,
            type: 'file',
            parentId,
            content: await file.text(),
          });
          result.ok += 1;
          setSelectedId(doc.id);
          setEditingId(doc.id);
          // 上传的正文在 vault 的文件里，清单里只有元数据
          void loadDocContent(doc.id);
        } else {
          // 其它格式（含压缩包）：文件本身就是这个节点。
          //
          // 不再「建一篇同名笔记 + 挂一个附件」——那会给一个自解释的文件
          // 配一份没人写的备注，还让人每次点开都扑个空。
          // 压缩包尤其不该配备注：包里的清单就是它的说明，
          // 而备注不会跟着包一起更新，必然过期。
          const doc = await api.uploadFile(file, parentId);
          result.ok += 1;
          setSelectedId(doc.id);
        }
      } catch (e) {
        result.failed.push({ name: file.name, reason: (e as Error)?.message ?? '上传失败' });
      }
      done += 1;
      onProgress?.(done, total, file.name);
    }

    if (result.ok > 0) await refreshDocs();
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
      // 从文档菜单进入管理后台的「访问权限」分区，并限定在这一篇文档
      navigate(`/admin/access?doc=${encodeURIComponent(n.id)}`);
    },
  };

  const canCreate = hasPermission('doc.create');
  const canUpload = hasPermission('doc.upload');

  return (
    <div className="h-full flex overflow-hidden">
      {/* 侧边栏：文件树 */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-border/60 glass xl:w-64">
        {/*
         * 操作区：三个按钮等分，全部只留图标。
         *
         * 宽度一样（flex-1 + basis-0，不看内容），谁也不多占地方。
         * 外观一致：三个都是描边样式，挨在一起时边界是对齐的。
         * 图标是唯一的标识，区分靠 title 与 aria-label——
         * 「新建文档/新建文件夹」两个按钮挨着，靠文字反而更容易看花。
         *
         * 用 flex-1 basis-0 而不是 grid-cols-3：没有上传权限时只剩两个按钮，
         * 这时自动各占一半，grid 会空出一格。
         */}
        {canCreate && (
          <div className="border-b border-border/60 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => openCreate(currentFolderId, 'file')}
                title="新建文档"
                aria-label="新建文档"
                className="flex h-8 min-w-0 flex-1 basis-0 cursor-pointer items-center justify-center rounded-lg border border-border/70 bg-white/70 text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:outline-none dark:bg-white/5 dark:text-slate-300 dark:hover:bg-indigo-500/15"
              >
                <FilePlus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => openCreate(currentFolderId, 'folder')}
                title="新建文件夹"
                aria-label="新建文件夹"
                className="flex h-8 min-w-0 flex-1 basis-0 cursor-pointer items-center justify-center rounded-lg border border-border/70 bg-white/70 text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:outline-none dark:bg-white/5 dark:text-slate-300 dark:hover:bg-indigo-500/15"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
              {canUpload && (
                <button
                  type="button"
                  onClick={() => openUpload(currentFolderId)}
                  title="上传文件：.md 变成文档，其它格式（含压缩包）原样存为原件"
                  aria-label="上传文件"
                  className="flex h-8 min-w-0 flex-1 basis-0 cursor-pointer items-center justify-center rounded-lg border border-border/70 bg-white/70 text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:outline-none dark:bg-white/5 dark:text-slate-300 dark:hover:bg-indigo-500/15"
                >
                  <Upload className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/*
         * 工具区入口已经挪到顶部的区域切换条（记录 / 工具 / 管理），
         * 左侧这一列是文件树的地盘，不再塞站点级导航进去——
         * 同一件事有两个入口，人会 unsure 该点哪个。
         */}

        {/* 文件树 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          <div className="mb-1.5 flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              文件树
            </span>
            <button
              onClick={() => setCurrentFolderId(null)}
              className="text-[10px] text-indigo-500 hover:text-indigo-700 flex items-center gap-0.5 cursor-pointer"
              title="回到根目录"
            >
              <Home className="h-3 w-3" /> 根
            </button>
          </div>
          {/* 读取中只报状态，别把「还没到」说成「没有」 */}
          <DocTreeView tree={tree} loading={bootstrapping} {...treeProps} />
        </div>
      </aside>

      {/* 主内容区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        {editingDoc ? (
          <DocEditor
            doc={editingDoc}
            onClose={() => {
              setEditingId(null);
              syncDocParam(null);
            }}
          />
        ) : (
          <FolderView
            folderId={visibleFolderId}
            loading={bootstrapping}
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
          />
        )}
      </div>

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
        onUpload={handleUploadBatch}
      />
      {/* 拖拽预览：把 .md 拖到页面任意位置即可就地阅读（不入库） */}
      <DropPreview
        parentId={visibleFolderId}
        onSaved={(docId) => {
          setSelectedId(docId);
          setEditingId(docId);
          // 正文在 vault 的文件里，清单里只有元数据
          void loadDocContent(docId);
        }}
      />
    </div>
  );
}
