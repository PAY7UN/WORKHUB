import { useRef, useState } from 'react';
import { FileUp, Link2, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 导入/替换协议说明书。
 *
 * 厂家给的协议文档是 PDF、Word、网页——都得先转成 Markdown 才能用，
 * 因为说明书就该是一份 Markdown：能贴进编辑器、能被检索、能跟着代码走版本管理。
 *
 * 两种给法：
 * - 传文件：PDF / Word / 网页存档 / Excel / 纯文本，服务端按扩展名处理；
 * - 给网址：服务端抓那个页面再转。
 *
 * 转完的 Markdown **写进记录区里那篇内置说明书**（不是另开一份）：
 * 全站只有一份正文、一处渲染器——说明书住在记录区，这里只是换掉它的正文。
 *
 * 转换是有损的，所以服务端会回报哪些地方要人再核一遍——
 * 那些提示原样显示出来，不藏。
 */
export function ProtocolDocDialog({
  open,
  protocolId,
  protocolName,
  caution,
  onClose,
  onImported,
}: {
  open: boolean;
  protocolId: string;
  protocolName: string;
  /** 覆盖前的提醒（例如「这份说明书你改过，替换后改动就没了」） */
  caution?: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = (): void => {
    setFile(null);
    setUrl('');
    setTitle('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async (): Promise<void> => {
    if (!file && !url.trim()) {
      toast.error('选一个文件，或者给一个网址');
      return;
    }
    setBusy(true);
    try {
      const result = await api.tools.importProtocolDoc(protocolId, {
        file: file ?? undefined,
        url: file ? undefined : url.trim(),
        title: title.trim() || undefined,
      });
      toast.success(`已转成 Markdown，写进「${protocolName}」的说明书`);
      if (result.warnings?.length) {
        toast.warning(result.warnings.join('；'), { duration: 8000 });
      }
      reset();
      onImported();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入/替换说明书</DialogTitle>
          <DialogDescription>
            传给「{protocolName}」一份文档，转成 Markdown 后替换掉记录区里那篇说明书的正文。
            支持 PDF、Word、网页、Excel、纯文本。
          </DialogDescription>
        </DialogHeader>

        {caution ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{caution}</span>
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>文档文件</Label>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.doc,.xlsx,.pptx,.html,.htm,.txt,.md,.csv,.log"
                className="hidden"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setUrl('');
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => fileRef.current?.click()}
              >
                <FileUp className="h-3.5 w-3.5" />
                {file ? file.name : '选文件'}
              </Button>
              {file ? (
                <span className="truncate text-[11px] text-muted-foreground">
                  {file.name} · {(file.size / 1024).toFixed(0)} KB
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">或用下面的网址</span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="protocol-doc-url">文档网址</Label>
            <div className="flex items-center gap-2">
              <Input
                id="protocol-doc-url"
                value={url}
                placeholder="https://example.com/protocol.html"
                className="h-8 text-[12px]"
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (e.target.value) setFile(null);
                }}
              />
              <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="protocol-doc-title">标题（可留空）</Label>
            <Input
              id="protocol-doc-title"
              value={title}
              placeholder="留空就用文件名或网页标题"
              className="h-8 text-[12px]"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
