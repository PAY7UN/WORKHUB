import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  FolderInput,
  Loader2,
  Paperclip,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { extOf, formatBytes, KIND_LABELS, type AttachmentKind } from '@/lib/attachments';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useApp } from '@/context/AppContext';
import type { Attachment, DocNode } from '@/types';

interface AttachmentPanelProps {
  docId: string;
  /** 是否可写（管理员才有权上传/删除） */
  canEdit: boolean;
  /** 该文档所属仓库的允许格式；空数组表示不限 */
  allowedExts: string[];
  /** 单文件体积上限（字节） */
  maxFileSize: number;
}

/** 按扩展名挑一个图标——附件格式五花八门，一眼能认出类型比文字说明有用 */
function iconFor(ext: string) {
  switch (ext as AttachmentKind) {
    case 'image':
      return FileImage;
    case 'archive':
      return FileArchive;
    case 'code':
      return FileCode2;
    case 'office':
      return FileType2;
    case 'pdf':
      return FileText;
    default:
      return FileText;
  }
}

/** 附件的检索状态说明，直接告诉用户「这份文件模型能不能看到」 */
function textStatusHint(a: Attachment): { label: string; tone: string } {
  switch (a.textStatus) {
    case 'ok':
      return { label: '可检索', tone: 'text-emerald-600 dark:text-emerald-400' };
    case 'unsupported':
      return { label: '仅存档', tone: 'text-muted-foreground' };
    case 'failed':
      return { label: '抽取失败', tone: 'text-amber-600 dark:text-amber-400' };
    default:
      return { label: '未抽取', tone: 'text-muted-foreground' };
  }
}

/**
 * 文档的附件面板。
 *
 * 写文档时经常要挂一堆留存文件：设计稿、需求 pdf、表格、参考截图。
 * 这些东西的共同点是「不是正文，但属于这篇文档」——
 * 所以它们挂在文档上，而不是散在文件系统里各自漂着。
 *
 * 与文档正文分开存：正文是文字，附件是字节。
 * 分开之后，附件能按格式留档、能被抽成文本参与检索，
 * 又不会把二进制塞进正文让编辑变卡。
 */
export function AttachmentPanel({ docId, canEdit, allowedExts, maxFileSize }: AttachmentPanelProps) {
  const { docs, refreshRepos } = useApp();
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [moving, setMoving] = useState<Attachment | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { attachments } = await api.listAttachments(docId);
      setItems(attachments);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [docId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 前端也按仓库规则先筛一道：能在上传前就告诉用户哪些文件会被拒 */
  const accept = allowedExts.length > 0 ? allowedExts.join(',') : undefined;

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    let ok = 0;
    for (const file of Array.from(files)) {
      const ext = extOf(file.name);
      if (allowedExts.length > 0 && !allowedExts.includes(ext)) {
        toast.error(`「${file.name}」的格式不在本仓库允许的范围内（${allowedExts.join('、')}）`);
        continue;
      }
      if (file.size > maxFileSize) {
        toast.error(`「${file.name}」超过体积上限（${formatBytes(maxFileSize)}）`);
        continue;
      }
      try {
        await api.uploadAttachment(docId, file);
        ok += 1;
      } catch (e) {
        toast.error(`「${file.name}」上传失败：${(e as Error)?.message ?? '网络错误'}`);
      }
    }
    setUploading(false);
    if (ok > 0) {
      toast.success(`已上传 ${ok} 个附件`);
      await load();
      // 仓库统计里的附件数要跟着变，否则侧边栏显示的是上传前的旧值
      void refreshRepos();
    }
  };

  const handleRemove = async (a: Attachment) => {
    // 附件是真删：文件一起抹掉，没有回收站，所以删之前确认一次
    if (!window.confirm(`删除附件「${a.name}」？该操作不可恢复。`)) return;
    try {
      await api.deleteAttachment(a.id);
      toast.success(`「${a.name}」已删除`);
      await load();
      void refreshRepos();
    } catch (e) {
      toast.error((e as Error)?.message ?? '删除失败');
    }
  };

  /** 改名：只改文件名与扩展名，不动内容 */
  const commitRename = async (a: Attachment) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name || name === a.name) return;
    try {
      await api.renameAttachment(a.id, name);
      toast.success(`已重命名为「${name}」`);
      await load();
    } catch (e) {
      toast.error((e as Error)?.message ?? '重命名失败');
    }
  };

  /** 移动：换一篇文档挂着（只改指针，内容不搬） */
  const handleMove = async (a: Attachment, targetDocId: string) => {
    try {
      await api.moveAttachment(a.id, targetDocId);
      const target = docs.find((d) => d.id === targetDocId);
      toast.success(`「${a.name}」已移动到「${target?.name ?? '目标文档'}」`);
      await load();
    } catch (e) {
      toast.error((e as Error)?.message ?? '移动失败');
    }
  };

  /** 可作为宿主的文档：只有正文文档能挂附件，文件夹不行 */
  const moveCandidates = useMemo(
    () => docs.filter((d) => d.type === 'file' && d.id !== docId && !d.encrypted),
    [docs, docId],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" />
          附件
          <span className="text-[10px]">({items.length})</span>
        </div>
        {canEdit && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={accept}
              className="hidden"
              onChange={(e) => {
                void handleFiles(e.target.files);
                // 清空以便连续上传同一个文件时仍能触发 change
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              className="flex cursor-pointer items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              title={allowedExts.length > 0 ? `只允许 ${allowedExts.join('、')}` : '不限格式'}
            >
              {uploading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Upload className="h-3 w-3" />
              )}
              上传附件
            </button>
          </>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-1.5 py-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          加载中…
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-[11px] text-muted-foreground">
          {canEdit
            ? '还没有附件。把设计稿、需求 pdf、表格之类挂进来，它们会跟着这篇文档一起留存。'
            : '还没有附件。'}
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((a) => {
            const Icon = iconFor(a.ext);
            const hint = textStatusHint(a);
            return (
              <li
                key={a.id}
                className="group flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {renamingId === a.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void commitRename(a)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(a);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-indigo-300 bg-white/70 px-1.5 py-0.5 text-xs outline-none focus:border-indigo-400 dark:bg-white/5"
                    title="回车确认，Esc 取消"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={a.name}>
                    {a.name}
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(a.size)}</span>
                <span className={`shrink-0 text-[10px] ${hint.tone}`} title={KIND_LABELS[a.ext as AttachmentKind]}>
                  {hint.label}
                </span>
                <a
                  href={api.attachmentUrl(a.id)}
                  className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                  title="下载"
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
                {canEdit && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(a.id);
                        setRenameValue(a.name);
                      }}
                      className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                      title="重命名"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setMoving(a)}
                      className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                      title="移动到其他文档"
                    >
                      <FolderInput className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemove(a)}
                      className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-red-600"
                      title="删除附件"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && allowedExts.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          本仓库只允许 {allowedExts.join('、')} 格式，单文件不超过 {formatBytes(maxFileSize)}
        </p>
      )}

      {/* 移动到其他文档：只改宿主指针，内容不搬 */}
      <MoveAttachmentDialog
        attachment={moving}
        candidates={moveCandidates}
        onClose={() => setMoving(null)}
        onMove={(targetDocId) => {
          if (moving) void handleMove(moving, targetDocId);
          setMoving(null);
        }}
      />
    </div>
  );
}

interface MoveAttachmentDialogProps {
  attachment: Attachment | null;
  /** 可作为宿主的文档 */
  candidates: DocNode[];
  onClose: () => void;
  onMove: (targetDocId: string) => void;
}

/**
 * 把附件挂到另一篇文档下。
 *
 * 移动的是「归属」而不是复制：同一份文件在磁盘上只有一份，
 * 换宿主只改一个指针，因此不会产生两份内容不一致的问题。
 */
function MoveAttachmentDialog({ attachment, candidates, onClose, onMove }: MoveAttachmentDialogProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (attachment) {
      setQuery('');
      setSelected(null);
    }
  }, [attachment]);

  const filtered = candidates.filter((d) => d.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Dialog open={attachment !== null} onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="glass-strong sm:max-w-md border-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="h-5 w-5 text-indigo-500" />
            移动附件
          </DialogTitle>
          <DialogDescription>
            把「{attachment?.name ?? ''}」挂到另一篇文档下。文件内容不会被复制。
          </DialogDescription>
        </DialogHeader>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索目标文档…"
          className="w-full rounded-md border border-border bg-white/60 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-400 dark:bg-white/5"
        />

        <div className="max-h-64 space-y-1 overflow-y-auto scrollbar-thin rounded-md border border-border/60 p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-muted-foreground">没有可移动到的文档。</p>
          ) : (
            filtered.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setSelected(d.id)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                  selected === d.id
                    ? 'bg-indigo-100/70 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                    : 'hover:bg-accent/60'
                }`}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && onMove(selected)}
            className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
          >
            移动
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
