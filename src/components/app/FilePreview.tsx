import { useEffect, useState } from 'react';
import { AlertCircle, Download, FileType as FileTypeIconGlyph, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { DocNode } from '@/types';
import { FILE_PREVIEW_LABELS, previewModeOf } from '../../../shared/files';
import { FileTypeIcon } from './fileIcons';
import { formatBytes, formatRelativeTime } from '@/utils';

/** 文本预览的体积上限：超过这个量级就不适合整篇铺在屏幕上了 */
const TEXT_PREVIEW_LIMIT = 512 * 1024;

interface FilePreviewProps {
  doc: DocNode;
  /**
   * 能不能下载。
   *
   * 访客拿到加密文档的授权时，管理员可能只给了「查看」——
   * 这时候按钮要置灰并说清原因，而不是让人点下去再吃服务端一个 403。
   */
  canDownload?: boolean;
}

/** 原件字节的取回状态 */
interface OriginalState {
  loading: boolean;
  /** 对象 URL：页面里渲染图片与 PDF 用的地址 */
  url?: string;
  /** 文本内容（只在文本模式下取） */
  text?: string;
  error?: string;
}

/**
 * 取回原件的字节。
 *
 * 不直接用 <img src="/api/docs/:id/raw">：浏览器发这种请求不会带
 * Authorization 头，服务端只认得 cookie 里的访客身份——
 * 管理员打开自己加密的图片就会看到一张裂图。
 * 所以这里带着令牌把字节取回来，再用对象 URL 渲染。
 */
function useOriginal(
  docId: string,
  opts: { enabled: boolean; wantText: boolean },
): OriginalState {
  const { enabled, wantText } = opts;
  const [state, setState] = useState<OriginalState>({ loading: enabled });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let objectUrl = '';
    setState({ loading: true });

    api
      .fetchOriginal(docId)
      .then(async (blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        const text = wantText ? await blob.text() : undefined;
        if (!alive) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setState({ loading: false, url: objectUrl, text });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setState({ loading: false, error: err instanceof Error ? err.message : '读取失败' });
      });

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, enabled, wantText]);

  return state;
}

/**
 * 原件预览。
 *
 * 这个组件存在的理由是：文件不需要配一份 Markdown 备注，
 * 所以原件打开时看到的就该是原件本身——一张图、一份 PDF、一段文本，
 * 或者一张说清「这是什么、多大、怎么拿走」的卡片，
 * 而不是一篇同名同格式的空笔记编辑器。
 *
 * 分档而不是一律「打不开」：能看的直接看，不能看的也给足信息。
 */
export function FilePreview({ doc, canDownload = true }: FilePreviewProps) {
  const ext = doc.ext ?? '';
  const mode = previewModeOf(ext);
  const original = useOriginal(doc.id, {
    enabled: mode !== 'generic',
    wantText: mode === 'text',
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/60 px-6 py-4">
        <div className="flex items-start gap-3">
          <FileTypeIcon name={doc.name} ext={ext} className="h-8 w-8 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold truncate">{doc.name}</h2>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {FILE_PREVIEW_LABELS[mode]}
              </span>
              {ext && <span className="text-[11px] text-muted-foreground">{ext.replace(/^\./, '')}</span>}
            </div>
            <div className="mt-1 text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
              <span>{formatBytes(doc.size)}</span>
              {doc.mime && <span className="truncate max-w-[420px]">{doc.mime}</span>}
              <span>更新于 {formatRelativeTime(doc.updatedAt)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {mode === 'image' && <ImagePreview state={original} name={doc.name} />}
        {mode === 'pdf' && <PdfPreview state={original} />}
        {mode === 'text' && <TextPreview state={original} />}
        {mode === 'generic' && <GenericPreview doc={doc} canDownload={canDownload} />}
      </div>
    </div>
  );
}

function ImagePreview({ state, name }: { state: OriginalState; name: string }) {
  const [broken, setBroken] = useState(false);
  if (state.loading) return <Loading />;
  if (state.error) {
    return (
      <Fallback
        title="图片无法显示"
        detail={state.error}
        hint="可能是浏览器不支持这个格式，或者你没有查看这份文件的权限。也可以下载后用本地工具打开。"
      />
    );
  }
  if (broken || !state.url) {
    return (
      <Fallback
        title="图片无法显示"
        detail="浏览器可能不支持这个格式，或文件已损坏。可以下载后用本地工具打开。"
      />
    );
  }
  return (
    <div className="h-full flex items-center justify-center p-6 bg-muted/20">
      <img
        src={state.url}
        alt={name}
        onError={() => setBroken(true)}
        className="max-w-full max-h-full object-contain rounded-md shadow-sm"
      />
    </div>
  );
}

function PdfPreview({ state }: { state: OriginalState }) {
  if (state.loading) return <Loading />;
  if (state.error) {
    return (
      <Fallback
        title="PDF 无法显示"
        detail={state.error}
        hint="可以下载后用本地阅读器打开。"
      />
    );
  }
  if (!state.url) return <Fallback title="PDF 无法显示" detail="文件内容为空。" />;
  return (
    <iframe
      src={state.url}
      title="PDF 预览"
      className="h-full w-full border-0 bg-white"
    />
  );
}

/**
 * 文本预览。
 *
 * 直接取原始字节按 UTF-8 解。取不到就说明它其实不是文本
 * （扩展名写着 .json 但里面是二进制），这时候说清原因，
 * 比给一段乱码让人猜要诚实。
 */
function TextPreview({ state }: { state: OriginalState }) {
  if (state.loading) return <Loading />;
  if (state.error) {
    return (
      <Fallback
        title="内容读取失败"
        detail={state.error}
        hint="文件可能不是文本，或者你没有查看它的权限。"
      />
    );
  }

  const text = state.text ?? '';
  const truncated = text.length > TEXT_PREVIEW_LIMIT;
  const shown = truncated ? text.slice(0, TEXT_PREVIEW_LIMIT) : text;

  return (
    <div className="h-full">
      <pre className="m-0 p-5 text-[12.5px] leading-relaxed font-mono whitespace-pre-wrap break-words bg-muted/20 h-full overflow-auto">
        {shown || '（空文件）'}
      </pre>
      {truncated && (
        <div className="px-5 py-2 text-xs text-muted-foreground border-t border-border/60">
          内容较长，仅显示前 {Math.round(TEXT_PREVIEW_LIMIT / 1024)} KB。完整内容请下载查看。
        </div>
      )}
    </div>
  );
}

function GenericPreview({ doc, canDownload }: { doc: DocNode; canDownload: boolean }) {
  const handleDownload = async () => {
    if (!canDownload) return;
    try {
      await api.downloadDoc(doc.id, doc.name);
    } catch (e) {
      toast.error((e as Error)?.message ?? '下载失败');
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <FileTypeIconGlyph className="h-12 w-12 mx-auto text-muted-foreground/50" />
        <div className="mt-3 text-sm font-medium">{doc.name}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {(doc.ext ?? '').replace(/^\./, '') || '未知格式'} · {formatBytes(doc.size)}
        </div>
        <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
          这个格式没法在浏览器里直接预览，但文件本身是完整的。
          下载下来用本地工具打开即可——原件按原样保存，不做转换。
        </p>
        <button
          type="button"
          disabled={!canDownload}
          onClick={() => void handleDownload()}
          title={canDownload ? undefined : '本次授权仅允许查看，不含下载'}
          className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-45 disabled:cursor-not-allowed"
        >
          <Download className="h-4 w-4" />
          下载文件
        </button>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      正在读取内容…
    </div>
  );
}

function Fallback({ title, detail, hint }: { title: string; detail: string; hint?: string }) {
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <AlertCircle className="h-10 w-10 mx-auto text-amber-500/70" />
        <div className="mt-3 text-sm font-medium">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{detail}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{hint}</div>}
      </div>
    </div>
  );
}
