import { useEffect, useState, useRef } from 'react';
import { Upload, FileText, AlertCircle, ShieldCheck, Lock, Boxes, FolderUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import type { Repo } from '@/types';

interface AdminLoginDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 返回失败原因时按原样展示，不得一律显示成「密码错误」 */
  onLogin: (password: string) => Promise<{ ok: boolean; message: string }>;
}

export function AdminLoginDialog({ open, onOpenChange, onLogin }: AdminLoginDialogProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError('');
      setSubmitting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!password || submitting) return;
    setSubmitting(true);
    setError('');
    const { ok, message } = await onLogin(password);
    if (ok) {
      onOpenChange(false);
    } else {
      setError(message || '密码错误，请重新输入');
      inputRef.current?.select();
    }
    setSubmitting(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-sm border-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-indigo-500" />
            管理员登录
          </DialogTitle>
          <DialogDescription>
            输入管理员密码以获取文档管理权限
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="admin-password">密码</Label>
          <Input
            id="admin-password"
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
            placeholder="请输入管理员密码"
            className="h-11 bg-white/60 dark:bg-white/5 border-indigo-200/50 focus:border-indigo-400"
          />
          {error && (
            <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void handleSubmit()} className="gradient-bg hover:opacity-90" disabled={!password || submitting}>
            {submitting ? '登录中…' : '登录'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  type: 'file' | 'folder';
  parentName?: string;
  onConfirm: (name: string) => void;
}

export function CreateDialog({ open, onOpenChange, type, parentName, onConfirm }: CreateDialogProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // 文档名不必带 .md：服务端会自动补后缀，用户少敲一个字符、少想一件事
      setName(type === 'file' ? '未命名文档' : '新建文件夹');
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [open, type]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md border-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {type === 'file' ? <FileText className="h-5 w-5 text-indigo-500" /> : <Upload className="h-5 w-5 text-indigo-500" />}
            {type === 'file' ? '新建文档' : '新建文件夹'}
          </DialogTitle>
          <DialogDescription>
            {parentName ? `在「${parentName}」中创建` : '在根目录创建'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="name">名称</Label>
          <Input
            id="name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                onConfirm(name.trim());
                onOpenChange(false);
              }
            }}
            className="bg-white/60 dark:bg-white/5"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={() => {
              if (name.trim()) {
                onConfirm(name.trim());
                onOpenChange(false);
              }
            }}
            className="gradient-bg hover:opacity-90"
            disabled={!name.trim()}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialName: string;
  onConfirm: (name: string) => void;
}

export function RenameDialog({ open, onOpenChange, initialName, onConfirm }: RenameDialogProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [open, initialName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md border-0">
        <DialogHeader>
          <DialogTitle>重命名</DialogTitle>
          <DialogDescription>修改文件或文件夹的名称</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rname">名称</Label>
          <Input
            id="rname"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && name !== initialName) {
                onConfirm(name.trim());
                onOpenChange(false);
              }
            }}
            className="bg-white/60 dark:bg-white/5"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={() => {
              if (name.trim() && name !== initialName) {
                onConfirm(name.trim());
                onOpenChange(false);
              }
            }}
            className="gradient-bg hover:opacity-90"
            disabled={!name.trim() || name === initialName}
          >
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DeleteDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  name: string;
  isFolder: boolean;
  /** 待一并删除的后代数量，文件夹删除时提示影响范围 */
  descendantCount?: { files: number; folders: number };
  onConfirm: () => void;
}

export function DeleteDialog({ open, onOpenChange, name, isFolder, descendantCount, onConfirm }: DeleteDialogProps) {
  // 二次确认：第一次点击仅"上膛"，5 秒内再次点击才真正执行删除
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open && armed) setArmed(false);
  }, [open, armed]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const armOrConfirm = () => {
    if (!armed) {
      setArmed(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setArmed(false), 5000);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setArmed(false);
    onConfirm();
    onOpenChange(false);
  };

  const total = descendantCount ? descendantCount.files + descendantCount.folders : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md border-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertCircle className="h-5 w-5" />
            确认删除
          </DialogTitle>
          <DialogDescription>
            {isFolder
              ? `此操作将永久删除文件夹「${name}」及其所有内容，该操作不可撤销。`
              : `此操作将永久删除文档「${name}」，该操作不可撤销。`}
            {isFolder && total > 0 && (
              <span className="mt-2 block rounded-md bg-red-500/10 px-2.5 py-1.5 text-red-600 dark:text-red-400">
                其中包含 {descendantCount!.folders} 个子文件夹、{descendantCount!.files} 个文档，将被一并删除
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={armed}>
            取消
          </Button>
          <Button
            onClick={armOrConfirm}
            variant="destructive"
            className={armed ? 'bg-red-600 hover:bg-red-700 animate-pulse' : 'bg-red-500 hover:bg-red-600'}
          >
            {armed ? '再次点击以确认删除' : '确认删除'}
          </Button>
        </DialogFooter>
        {armed && (
          <p className="text-center text-[11px] text-muted-foreground">
            危险操作：请在 5 秒内再次点击上方按钮完成删除
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface MoveDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  node: import('@/types').DocNode | null;
  tree: import('@/types').DocTree[];
  currentParentId: string | null;
  onConfirm: (newParentId: string | null) => void;
}

export function MoveDialog({ open, onOpenChange, node, tree, currentParentId, onConfirm }: MoveDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedId(currentParentId);
    }
  }, [open, currentParentId]);

  // 过滤掉 node 自身和其所有子孙
  const collectIds = (rootId: string, all: import('@/types').DocTree[]): Set<string> => {
    const result = new Set<string>([rootId]);
    const walk = (list: import('@/types').DocTree[]) => {
      list.forEach((n) => {
        if (n.id === rootId) {
          // 不递归 rootId 自身以外的子节点
          n.children.forEach((c) => result.add(c.id));
          walk(n.children);
        }
      });
    };
    walk(all);
    return result;
  };

  const excludeIds = node ? collectIds(node.id, tree) : new Set<string>();
  const renderFolders = (list: import('@/types').DocTree[], depth = 0): React.ReactNode => {
    return list
      .filter((n) => n.type === 'folder' && !excludeIds.has(n.id))
      .map((n) => (
        <div key={n.id}>
          <button
            onClick={() => setSelectedId(n.id)}
            className={`w-full text-left px-3 py-1.5 rounded-md text-sm hover:bg-indigo-50/60 dark:hover:bg-indigo-950/40 transition-colors flex items-center gap-2 ${
              selectedId === n.id ? 'bg-indigo-100/70 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' : ''
            }`}
            style={{ paddingLeft: `${depth * 14 + 12}px` }}
          >
            <span className="text-amber-500">📁</span>
            {n.name}
          </button>
          {n.children.length > 0 && renderFolders(n.children, depth + 1)}
        </div>
      ));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md border-0">
        <DialogHeader>
          <DialogTitle>移动「{node?.name}」</DialogTitle>
          <DialogDescription>选择目标位置（根目录或某个文件夹）</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto scrollbar-thin border border-indigo-100/40 dark:border-indigo-900/40 rounded-lg p-1 bg-white/40 dark:bg-white/5">
          <button
            onClick={() => setSelectedId(null)}
            className={`w-full text-left px-3 py-1.5 rounded-md text-sm hover:bg-indigo-50/60 dark:hover:bg-indigo-950/40 transition-colors flex items-center gap-2 ${
              selectedId === null ? 'bg-indigo-100/70 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' : ''
            }`}
          >
            <span>🏠</span> 根目录
          </button>
          {renderFolders(tree)}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={() => {
              onConfirm(selectedId);
              onOpenChange(false);
            }}
            className="gradient-bg hover:opacity-90"
            disabled={selectedId === currentParentId}
          >
            移动到此处
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface EncryptDocDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  docName: string;
  /** 确认加密；返回是否成功与失败原因 */
  onConfirm: () => Promise<{ ok: boolean; message: string }>;
}

/**
 * 加密文档的确认对话框。
 *
 * 只有一个确认动作，没有密码输入框：加密后访客一律走访问申请，
 * 服务端不签发、也不存储任何访客口令。
 *
 * 加密是单向的（在管理员主动取消加密之前）：正文改为密文保存，
 * 访客看不到内容，Agent 一律无权读取。
 */
export function EncryptDocDialog({
  open,
  onOpenChange,
  docName,
  onConfirm,
}: EncryptDocDialogProps) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    const result = await onConfirm();
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message || '加密失败');
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md border-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-indigo-500" />
            加密文档
          </DialogTitle>
          <DialogDescription>
            加密「{docName}」：正文改为密文保存，访客看不到内容，Agent 一律无权读取。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-indigo-200/60 bg-indigo-50/60 px-3 py-2 text-xs leading-relaxed text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300">
            加密后，访客需要<strong className="font-semibold">提交访问申请</strong>，
            由你在管理后台批准后才能查看；批准与撤销都随时可做。
            服务端不再签发、也不存储任何访问密码。
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-500 dark:border-red-900 dark:bg-red-950/30">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={submitting} className="gradient-bg hover:opacity-90">
            {submitting ? '处理中…' : '确认加密'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一批上传的处理结果 */
export interface UploadBatchResult {
  /** 成功处理的文件数 */
  ok: number;
  /** 失败的文件与原因 */
  failed: Array<{ name: string; reason: string }>;
  /** 额外说明（如压缩包解出了多少文件） */
  notes?: string[];
}

/** 上传过程中的进度回调 */
export type UploadProgress = (done: number, total: number, label: string) => void;

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 目标目录名（展示用） */
  parentName?: string;
  /** 当前仓库名 */
  repoName?: string;
  /** 当前仓库允许的格式；空数组表示不限 */
  allowedExts?: string[];
  /** 当前仓库的单文件体积上限（字节） */
  maxFileSize?: number;
  /** 处理一批文件；返回成功数与失败清单 */
  onUpload: (files: File[], onProgress?: UploadProgress) => Promise<UploadBatchResult>;
}

/**
 * 上传文件。
 *
 * 「上传」在这里是两件事，不只是传 .md：
 * - .md / .markdown → 直接变成可编辑的文档正文；
 * - 其它格式（docx、pdf、图片、源码、压缩包……）→ 变成同名条目 + 挂着的附件原件，
 *   点开能下载原件，检索照样命中正文。
 *
 * 压缩包不会被解开：上传压缩包就是把这个包原样存进来。
 * 解包会擅自改变资料的组织方式，归档的边界该由用户自己定。
 *
 * 界面必须把这两条规则讲清楚：用户拖进来一个压缩包却只看到一句
 * 「上传失败」，下次就不会再用这个功能了。
 */
export function UploadDialog({
  open,
  onOpenChange,
  parentName,
  repoName,
  allowedExts = [],
  maxFileSize,
  onUpload,
}: UploadDialogProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setError('');
      setUploading(false);
      setProgress(null);
    }
  }, [open]);

  // 整批交给上层处理：单文件失败不中断整批，全部成功才自动关闭弹窗
  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError('');
    setProgress({ done: 0, total: files.length, label: '准备中…' });
    try {
      const result = await onUpload(files, (done, total, label) =>
        setProgress({ done, total, label }),
      );
      if (result.failed.length > 0) {
        const detail = result.failed
          .slice(0, 3)
          .map((f) => `「${f.name}」${f.reason}`)
          .join('、');
        setError(
          result.failed.length > 3
            ? `${detail} 等 ${result.failed.length} 个文件未导入`
            : `${detail} 未导入`,
        );
      }
      if (result.ok === 0 && result.failed.length === 0) {
        setError('没有可导入的文件');
        return;
      }
      // 有失败项时留在界面上，让人看清少了什么
      if (result.failed.length === 0) onOpenChange(false);
    } catch (e) {
      setError((e as Error)?.message ?? '上传失败');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md border-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-indigo-500" />
            上传文件
          </DialogTitle>
          <DialogDescription>
            {parentName ? `上传到「${parentName}」` : '上传到根目录'}：.md 变成文档，
            其它格式（含压缩包）原样存为原件文件。
          </DialogDescription>
        </DialogHeader>
        <div
          data-native-dropzone=""
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFiles(Array.from(e.dataTransfer.files));
          }}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
            dragOver
              ? 'border-indigo-500 bg-indigo-50/80 dark:bg-indigo-950/50'
              : // 常态必须自带底色与可辨识的边框：深色模式下仅靠 hover 变化时，
                // 整个区域与弹窗背景几乎融为一体，看起来像禁用态而非可点击区域
                'border-indigo-300 bg-indigo-50/40 hover:border-indigo-500 hover:bg-indigo-50/80 ' +
                  'dark:border-indigo-700 dark:bg-indigo-950/25 hover:border-indigo-500 hover:bg-indigo-950/45'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              // 先取快照再清空 value：清空会连带清掉 input.files，
              // 且不重置的话重选同一个文件不会再触发 change
              const picked = Array.from(e.target.files ?? []);
              e.target.value = '';
              void handleFiles(picked);
            }}
          />
          <Upload
            className={`h-10 w-10 mx-auto mb-3 ${
              dragOver ? 'text-indigo-600 dark:text-indigo-400' : 'text-indigo-500 dark:text-indigo-400'
            }`}
          />
          {/* 显式指定前景色：继承链上的默认色在深色模式下会显得发灰 */}
          <div className="text-sm font-medium text-foreground">
            {uploading ? '处理中…' : dragOver ? '松开鼠标上传' : '点击或拖拽文件到这里'}
          </div>
          <div className="text-xs text-muted-foreground/90 mt-1">可多选；压缩包与其它格式一样，原样存为原件文件</div>
        </div>

        {/* 选整个文件夹：目录结构会被一并还原 */}
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          // webkitdirectory / directory 是非标准属性，TS 的 JSX 类型里没有
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = '';
            void handleFiles(picked);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          disabled={uploading}
          onClick={() => folderRef.current?.click()}
        >
          <FolderUp className="mr-1.5 h-3.5 w-3.5" />
          选择整个文件夹（保留目录结构）
        </Button>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {repoName
            ? allowedExts.length > 0
              ? `仓库「${repoName}」仅允许 ${allowedExts.join('、')}`
              : `仓库「${repoName}」不限格式`
            : '未选定仓库，文件将归入默认仓库'}
          {maxFileSize ? `，单文件 ≤${Math.round(maxFileSize / 1024 / 1024)}MB` : ''}
        </p>

        {uploading && progress && (
          <div className="text-xs text-muted-foreground">
            正在处理 {progress.done}/{progress.total}：{progress.label}
          </div>
        )}
        {error && (
          <div className="text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={uploading}>
            {uploading ? '请稍候…' : '完成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RepoAssignDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 待迁移的文档名 */
  docName: string;
  /** 当前归属的仓库 id */
  currentRepoId?: string;
  /** 候选仓库 */
  repos: Repo[];
  /** 确认后把文档迁到该仓库 */
  onConfirm: (repoId: string) => void;
}

/**
 * 文档的仓库归属选择（跨仓库迁移）。
 *
 * 归属跟着文档走，而不是把文档复制一份到另一个仓库：
 * 复制会让两个仓库各有一份，改一处就出现「两份内容不一样」的老问题。
 * 迁移时整棵子树一起搬，父子不分属两个仓库。
 *
 * 这里没有「不归入任何仓库」这一项：每个文档都必须有归属。
 */
export function RepoAssignDialog({
  open,
  onOpenChange,
  docName,
  currentRepoId,
  repos,
  onConfirm,
}: RepoAssignDialogProps) {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (open) setSelected(currentRepoId ?? null);
  }, [open, currentRepoId]);

  const optionClass = (id: string | null) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors text-left cursor-pointer ${
      selected === id
        ? 'bg-indigo-100/70 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
        : 'hover:bg-indigo-50/60 dark:hover:bg-indigo-950/40'
    }`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md border-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-indigo-500" />
            归入仓库
          </DialogTitle>
          <DialogDescription>
            选择「{docName}」归属的仓库。归属之后它会跟随该仓库的留存规则（允许格式、体积上限）与检索开关。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin rounded-lg border border-indigo-100/40 p-1 dark:border-indigo-900/40">
          {repos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSelected(r.id)}
              className={optionClass(r.id)}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              {!r.ragEnabled && (
                <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                  不检索
                </span>
              )}
              {selected === r.id && <span className="shrink-0 text-[10px] text-muted-foreground">当前</span>}
            </button>
          ))}
          {repos.length === 0 && (
            <p className="px-3 py-3 text-[11px] text-muted-foreground">
              还没有仓库。先到「管理后台 · 仓库管理」建一个，再回来选归属。
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              if (!selected) return;
              onConfirm(selected);
              onOpenChange(false);
            }}
            className="gradient-bg hover:opacity-90"
            disabled={!selected || selected === (currentRepoId ?? null)}
          >
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
