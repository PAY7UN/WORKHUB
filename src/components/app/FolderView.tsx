import { useState, useMemo, useCallback } from 'react';
import {
  FileText,
  Folder,
  Search,
  Grid3x3,
  List,
  Download,
  Eye,
  FolderInput,
  Trash2,
  Pencil,
  Calendar,
  User as UserIcon,
  Home,
  ChevronRight,
  Lock,
  Boxes,
  FileWarning,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { downloadAsFile, formatBytes, formatRelativeTime } from '@/utils';
import type { DocNode } from '@/types';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from './fileIcons';
import { previewModeOf } from '../../../shared/files';

/**
 * 这个节点能不能在浏览器里直接打开。
 *
 * 原件的形态由 previewModeOf 判定：图片、PDF、文本（源码、Markdown 等）
 * 能直接看；其余的（zip、docx、exe…）浏览器根本打不开——它们能收进来、
 * 能被下载，可点开只会得到一句「这个格式没法在浏览器里直接预览」。
 *
 * 目录里混着这两类文件时，不做区分就都长成「能点开」的样子。
 * 上传一整个文件夹尤其明显：源码和图片能看，压缩包和 Office 文档不能，
 * 两类并排躺着，用户只能一个个点过去撞墙才分辨得出。
 *
 * 文件夹与笔记不算：文件夹是去路，笔记永远是 Markdown，都打得开。
 */
function isPreviewable(doc: DocNode): boolean {
  if (doc.type === 'folder') return true;
  if (doc.kind !== 'file') return true;
  return previewModeOf(doc.ext ?? '') !== 'generic';
}

interface FolderViewProps {
  folderId: string | null;
  onOpen: (doc: DocNode) => void;
  onRequestRename: (doc: DocNode) => void;
  onRequestDelete: (doc: DocNode) => void;
  onRequestMove: (doc: DocNode) => void;
  /** 打开仓库归属选择；只有管理员拿得到这个入口 */
  onRequestRepo?: (doc: DocNode) => void;
}

export function FolderView({
  folderId,
  onOpen,
  onRequestRename,
  onRequestDelete,
  onRequestMove,
  onRequestRepo,
}: FolderViewProps) {
  const { repoScopedDocs, users, hasPermission, getDoc, getPath, isAdmin } = useApp();
  // 仓库是管理维度：普通访客看不到「归入仓库」这个动作
  const canAssignRepo = Boolean(onRequestRepo) && isAdmin;
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  // 「只看可预览」：上传一整个目录时，里面常混着 zip、Office 文档这类
  // 浏览器打不开的文件。这个开关让想读的人一眼看到能读的，
  // 也不想读的人不必逐个点开撞墙。
  // 默认全显示——文件已经入库了，藏起来等于假装它不存在。
  const [onlyPreviewable, setOnlyPreviewable] = useState(false);

  const folder = folderId ? getDoc(folderId) : null;
  const breadcrumbs = useMemo(() => (folderId ? getPath(folderId) : []), [folderId, getPath]);

  /**
   * 下载。
   *
   * 两种东西，两种下载方式：
   * - 原件 → 服务端的下载路由按原始字节与原文件名回传（原件没有「正文」
   *   可导出，本地导出会把一个 zip 变成 0 字节的假文件）；
   * - 笔记 → 先取正文再存盘。清单里只有元数据（正文在仓库目录的文件里），
   *   直接拿 doc.content 下到的是一个空文件——看着下载成功了，内容却没了。
   */
  const handleDownload = useCallback(async (doc: DocNode) => {
    try {
      if (doc.kind === 'file') {
        await api.downloadDoc(doc.id, doc.name);
        return;
      }
      const { doc: full } = await api.getDoc(doc.id);
      downloadAsFile(doc.name, full.content ?? '');
    } catch (e) {
      toast.error((e as Error)?.message ?? '下载失败：取不到正文');
    }
  }, []);

  // 目录里的全部条目（搜索后），以及其中能在浏览器里打开的那些
  const matched = useMemo(() => {
    return repoScopedDocs
      .filter((d) => d.parentId === folderId)
      .filter((d) => (search ? d.name.toLowerCase().includes(search.toLowerCase()) : true))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
  }, [repoScopedDocs, folderId, search]);

  const children = useMemo(
    () => (onlyPreviewable ? matched.filter(isPreviewable) : matched),
    [matched, onlyPreviewable],
  );

  const stats = useMemo(() => {
    const allInFolder = (id: string | null): { files: number; folders: number } => {
      let files = 0;
      let folders = 0;
      const queue = [id];
      while (queue.length) {
        const cur = queue.shift()!;
        repoScopedDocs.filter((d) => d.parentId === cur).forEach((d) => {
          if (d.type === 'folder') {
            folders++;
            queue.push(d.id);
          } else files++;
        });
      }
      return { files, folders };
    };
    return allInFolder(folderId);
  }, [repoScopedDocs, folderId]);

  const canEdit = hasPermission('doc.edit');
  const canDelete = hasPermission('doc.delete');
  const canMove = hasPermission('doc.move');
  const canDownload = hasPermission('doc.download');

  return (
    <div className="h-full flex flex-col">
      {/* 头部 */}
      <div className="px-6 py-4 border-b border-indigo-100/40 dark:border-indigo-900/40 glass shrink-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            {breadcrumbs.length > 0 && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1.5 flex-wrap">
                <Home className="h-3 w-3" />
                {breadcrumbs.map((b, i) => (
                  <span key={b.id} className="flex items-center gap-1">
                    {i > 0 && <ChevronRight className="h-3 w-3 opacity-50" />}
                    <span
                      className={cn(
                        'hover:text-indigo-600 transition-colors',
                        i === breadcrumbs.length - 1 && 'text-indigo-600 font-medium',
                      )}
                    >
                      {b.name}
                    </span>
                  </span>
                ))}
              </div>
            )}
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Folder className="h-5 w-5 text-amber-500" />
              {folder ? folder.name : '我的工作区'}
            </h2>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
              <span>{stats.files} 个文档</span>
              <span>·</span>
              <span>{stats.folders} 个文件夹</span>
              {folder && (
                <>
                  <span>·</span>
                  <span>更新于 {formatRelativeTime(folder.updatedAt)}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-1 justify-end max-w-md">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索文件名..."
                className="pl-9 h-9 bg-white/60 dark:bg-white/5 border-indigo-200/50"
              />
            </div>
            <div className="flex p-0.5 rounded-lg bg-indigo-50/60 dark:bg-indigo-950/30 border border-indigo-100/40">
              <button
                onClick={() => setView('grid')}
                className={cn(
                  'h-8 w-8 rounded-md flex items-center justify-center transition-all',
                  view === 'grid' ? 'bg-white dark:bg-indigo-900/60 shadow-sm text-indigo-600' : 'text-muted-foreground hover:text-foreground',
                )}
                title="网格视图"
              >
                <Grid3x3 className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView('list')}
                className={cn(
                  'h-8 w-8 rounded-md flex items-center justify-center transition-all',
                  view === 'list' ? 'bg-white dark:bg-indigo-900/60 shadow-sm text-indigo-600' : 'text-muted-foreground hover:text-foreground',
                )}
                title="列表视图"
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            {/* 「只看可预览」：浏览器打不开的文件（zip、Office 文档…）
                在列表里长得和能看的文件一模一样，用户只能挨个点开试。
                这个开关把能读的挑出来；被筛掉的那些仍在这个目录里，
                关掉开关就都回来，不会凭空少掉文件。 */}
            <button
              onClick={() => setOnlyPreviewable((v) => !v)}
              aria-pressed={onlyPreviewable}
              className={cn(
                'h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs border transition-all shrink-0',
                onlyPreviewable
                  ? 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/20 dark:text-indigo-300 dark:border-indigo-800'
                  : 'bg-indigo-50/60 dark:bg-indigo-950/30 border-indigo-100/40 text-muted-foreground hover:text-foreground',
              )}
              title={
                onlyPreviewable
                  ? '正在只看能直接打开的文件，点击显示全部'
                  : '只看浏览器能直接打开的文件'
              }
            >
              <Eye className="h-3.5 w-3.5" />
              只看可预览
            </button>
          </div>
        </div>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-auto scrollbar-thin p-6">
        {children.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
            <Folder className="h-16 w-16 mb-3 opacity-30" />
            <div className="text-base font-medium">
              {search
                ? '没有匹配的文档'
                : onlyPreviewable
                  ? '这个目录里没有能直接打开的文件'
                  : '此目录为空'}
            </div>
            <div className="text-xs mt-1">
              {search
                ? '尝试其他关键词'
                : onlyPreviewable
                  ? '关掉「只看可预览」就能看到目录里的全部文件'
                  : '通过左侧新建按钮或上传按钮添加内容'}
            </div>
          </div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {children.map((doc, i) => (
              <DocGridCard
                key={doc.id}
                doc={doc}
                onOpen={onOpen}
                onRename={onRequestRename}
                onDelete={onRequestDelete}
                onMove={onRequestMove}
                onDownload={handleDownload}
                canEdit={canEdit}
                canDelete={canDelete}
                canMove={canMove}
                canDownload={canDownload}
                onRequestRepo={canAssignRepo ? onRequestRepo : undefined}
                updatedBy={users.find((u) => u.id === doc.updatedBy)?.displayName}
                delay={i * 30}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-1.5">
            {children.map((doc, i) => (
              <DocListRow
                key={doc.id}
                doc={doc}
                onOpen={onOpen}
                onRename={onRequestRename}
                onDelete={onRequestDelete}
                onMove={onRequestMove}
                onDownload={handleDownload}
                canEdit={canEdit}
                canDelete={canDelete}
                canMove={canMove}
                canDownload={canDownload}
                onRequestRepo={canAssignRepo ? onRequestRepo : undefined}
                updatedBy={users.find((u) => u.id === doc.updatedBy)?.displayName}
                delay={i * 20}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface DocCardProps {
  doc: DocNode;
  onOpen: (doc: DocNode) => void;
  onRename: (doc: DocNode) => void;
  onDelete: (doc: DocNode) => void;
  onMove: (doc: DocNode) => void;
  /** 下载：正文得现取，清单里只有元数据 */
  onDownload: (doc: DocNode) => void;
  canEdit: boolean;
  canDelete: boolean;
  canMove: boolean;
  canDownload: boolean;
  /** 打开仓库归属选择；管理员才拿得到 */
  onRequestRepo?: (doc: DocNode) => void;
  updatedBy?: string;
  delay?: number;
}

function DocGridCard({
  doc,
  onOpen,
  onRename,
  onDelete,
  onMove,
  onDownload,
  canEdit,
  canDelete,
  canMove,
  canDownload,
  onRequestRepo,
  updatedBy,
  delay = 0,
}: DocCardProps) {
  const isFolder = doc.type === 'folder';
  // 浏览器打不开的文件：图标降饱和，别让它和能看的文件长得一模一样
  const previewable = isPreviewable(doc);
  return (
    <Card
      onClick={() => onOpen(doc)}
      className="group glass cursor-pointer p-4 hover:shadow-xl hover:scale-[1.02] hover:border-indigo-300 transition-all relative animate-slide-up"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between mb-3">
        <div
          className={cn(
            'h-11 w-11 rounded-xl flex items-center justify-center shrink-0',
            isFolder
              ? 'bg-gradient-to-br from-amber-400 to-orange-400 text-white'
              : 'bg-gradient-to-br from-indigo-500 to-violet-500 text-white',
            // 降饱和：这是「看不了」的信号，与徽标一起说明，不必点开才知道
            !isFolder && !previewable && 'opacity-60 saturate-50',
          )}
        >
          {isFolder ? (
            <Folder className="h-5 w-5" />
          ) : doc.kind === 'file' ? (
            <FileTypeIcon name={doc.name} ext={doc.ext ?? ''} plain className="h-5 w-5" />
          ) : (
            <FileText className="h-5 w-5" />
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!isFolder && canDownload && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDownload(doc);
              }}
              disabled={doc.encrypted && doc.kind !== 'file'}
              className="h-7 w-7 rounded-md hover:bg-white/60 dark:hover:bg-white/10 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title={
                doc.encrypted && doc.kind !== 'file'
                  ? '文档已加密，解锁后才能下载明文'
                  : doc.encrypted
                    ? '下载加密原件（按你的访问授权判定）'
                    : '下载'
              }
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
          {canEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRename(doc);
              }}
              className="h-7 w-7 rounded-md hover:bg-white/60 dark:hover:bg-white/10 flex items-center justify-center"
              title="重命名"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {canMove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMove(doc);
              }}
              className="h-7 w-7 rounded-md hover:bg-white/60 dark:hover:bg-white/10 flex items-center justify-center"
              title="移动"
            >
              <FolderInput className="h-3.5 w-3.5" />
            </button>
          )}
          {onRequestRepo && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRequestRepo(doc);
              }}
              className="h-7 w-7 rounded-md hover:bg-white/60 dark:hover:bg-white/10 flex items-center justify-center"
              title="归入仓库"
            >
              <Boxes className="h-3.5 w-3.5" />
            </button>
          )}
          {canDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(doc);
              }}
              className="h-7 w-7 rounded-md hover:bg-red-100/60 dark:hover:bg-red-950/30 text-red-600 flex items-center justify-center"
              title="删除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="font-semibold text-sm truncate mb-1 flex items-center gap-1.5" title={doc.name}>
        {doc.encrypted && (
          <span
            className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-100/70 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
            title="已加密：需申请访问后方可查看"
          >
            <Lock className="h-2.5 w-2.5" />
            已加密
          </span>
        )}
        {/* 不可预览：浏览器打不开这个格式，能做的只有下载。
            与「已加密」一样放在名字前面——两件事都关乎「点开之前得先知道」。 */}
        {!previewable && (
          <span
            className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100/70 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            title="这个格式没法在浏览器里直接预览，只能下载"
          >
            <FileWarning className="h-2.5 w-2.5" />
            不可预览
          </span>
        )}
        <span className="truncate">{doc.name}</span>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Calendar className="h-3 w-3" />
          {formatRelativeTime(doc.updatedAt)}
        </span>
        {!isFolder && <span>{formatBytes(doc.size)}</span>}
      </div>
      {doc.tags && doc.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {doc.tags.slice(0, 2).map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0 bg-indigo-100/60 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
              {t}
            </Badge>
          ))}
          {doc.tags.length > 2 && (
            <span className="text-[10px] text-muted-foreground">+{doc.tags.length - 2}</span>
          )}
        </div>
      )}
      {updatedBy && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1.5">
          <UserIcon className="h-2.5 w-2.5" />
          {updatedBy}
        </div>
      )}
    </Card>
  );
}

function DocListRow({
  onDownload,
  doc,
  onOpen,
  onRename,
  onDelete,
  onMove,
  canEdit,
  canDelete,
  canMove,
  canDownload,
  onRequestRepo,
  updatedBy,
  delay = 0,
}: DocCardProps) {
  const isFolder = doc.type === 'folder';
  const previewable = isPreviewable(doc);
  return (
    <div
      onClick={() => onOpen(doc)}
      className="group flex items-center gap-3 p-3 rounded-xl glass cursor-pointer hover:shadow-md hover:border-indigo-300 transition-all animate-slide-up"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className={cn(
          'h-10 w-10 rounded-lg flex items-center justify-center shrink-0',
          isFolder
            ? 'bg-gradient-to-br from-amber-400 to-orange-400 text-white'
            : 'bg-gradient-to-br from-indigo-500 to-violet-500 text-white',
          // 与网格卡片一致：看不了的文件，图标先降饱和
          !isFolder && !previewable && 'opacity-60 saturate-50',
        )}
      >
        {isFolder ? (
          <Folder className="h-4 w-4" />
        ) : doc.kind === 'file' ? (
          <FileTypeIcon name={doc.name} ext={doc.ext ?? ''} plain className="h-4 w-4" />
        ) : (
          <FileText className="h-4 w-4" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate flex items-center gap-1.5">
          {doc.encrypted && (
            <span
              className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-100/70 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
              title="已加密：需申请访问后方可查看"
            >
              <Lock className="h-2.5 w-2.5" />
              已加密
            </span>
          )}
          {!previewable && (
            <span
              className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100/70 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
              title="这个格式没法在浏览器里直接预览，只能下载"
            >
              <FileWarning className="h-2.5 w-2.5" />
              不可预览
            </span>
          )}
          <span className="truncate">{doc.name}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
          <span>{formatRelativeTime(doc.updatedAt)}</span>
          {!isFolder && <span>{formatBytes(doc.size)}</span>}
          {updatedBy && <span>· {updatedBy}</span>}
        </div>
      </div>
      {doc.tags && doc.tags.length > 0 && (
        <div className="hidden md:flex flex-wrap gap-1 shrink-0">
          {doc.tags.slice(0, 3).map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0 bg-indigo-100/60 text-indigo-700">
              {t}
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {/* 「预览」只给打得开的文件：浏览器打不开的格式点进去只会撞上一句
            「这个格式没法在浏览器里直接预览」，那这个按钮就只是在骗人。
            这类文件的唯一去处是下载。 */}
        {!isFolder && previewable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(doc);
            }}
            className="h-7 px-2"
            title="预览"
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
        )}
        {!isFolder && canDownload && (
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onDownload(doc);
            }}
            disabled={doc.encrypted && doc.kind !== 'file'}
            className="h-7 px-2"
            title={
              doc.encrypted && doc.kind !== 'file'
                ? '文档已加密，解锁后才能下载明文'
                : doc.encrypted
                  ? '下载加密原件（按你的访问授权判定）'
                  : '下载'
            }
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        )}
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onRename(doc); }} className="h-7 px-2" title="重命名">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        {canMove && (
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onMove(doc); }} className="h-7 px-2" title="移动">
            <FolderInput className="h-3.5 w-3.5" />
          </Button>
        )}
        {onRequestRepo && (
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onRequestRepo(doc); }} className="h-7 px-2" title="归入仓库">
            <Boxes className="h-3.5 w-3.5" />
          </Button>
        )}
        {canDelete && (
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onDelete(doc); }} className="h-7 px-2 text-red-600 hover:text-red-600" title="删除">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
