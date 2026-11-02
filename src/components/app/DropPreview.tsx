import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileDown, FileText, Maximize2, Minimize2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MarkdownPreview } from './MarkdownPreview';
import { DocOutline } from './DocOutline';
import { extractHeadings, formatBytes } from '@/utils';
import { cn } from '@/lib/utils';

/** 一个被拖进来的文件 */
interface DroppedFile {
  /** 原始 File 保留着：存进文档库时可以直接复用上传链路 */
  file: File;
  name: string;
  text: string;
  size: number;
}

interface DropPreviewProps {
  /** 存进文档库时的落点目录 */
  parentId: string | null;
  /** 存进去之后把新文档打开 */
  onSaved?: (docId: string) => void;
}

/**
 * 预览用的体积上限。
 *
 * 拖进来的是要整个读进内存再渲染的：正文超过这个量级，
 * 读进来就是一次几 MB 的字符串分配，渲染还要再过一遍
 * marked + DOMPurify，卡顿得不偿失。这种文件本就该
 * 用「上传」按钮传上去，不该走预览这条路。
 */
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

const MD_EXT = /\.(md|markdown)$/i;

function isMarkdown(file: File): boolean {
  return MD_EXT.test(file.name);
}

/**
 * dataTransfer.types 在各浏览器里的形态不一（数组 / DOMStringList），
 * 统一按数组读，别指望它一定有 includes。
 */
function hasFiles(dt: DataTransfer | null): boolean {
  const types = dt?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

/**
 * 组件自己接管拖放的区域（上传弹窗的投放框）要把事件让给它。
 *
 * 全局监听跑在捕获阶段，先于任何组件拿到事件；不主动让开的话，
 * 上传弹窗就再也收不到投放了——它自己的 onDrop 根本不会触发。
 */
function inNativeDropZone(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return typeof el?.closest === 'function' && Boolean(el.closest('[data-native-dropzone]'));
}

/**
 * 拖入 .md 即看内容。
 *
 * 拖进来的文件只在浏览器里读一遍、渲染一遍，不写文档库、不落盘：
 * 看与存是两件事，存要走「上传」那条路（或在预览窗里显式存一次），
 * 免得一次手滑就把一堆文件塞进了文档树。
 */
export function DropPreview({ parentId, onSaved }: DropPreviewProps) {
  const { uploadFile, hasPermission } = useApp();

  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<DroppedFile[]>([]);
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  /**
   * 伪全屏：弹窗铺满视口（与 DocEditor 的全屏同一套做法，不动用原生 Fullscreen API）。
   *
   * 默认就是全屏：拖进来的东西通常是要认真读的——不是扫一眼标题、
   * 确认个大小。居中弹窗把正文压在当中，四周留出的空白一半是页面透过来的
   * 背景，反而让人以为还有别的东西要看。全屏打开，读完直接关。
   */
  const [fullscreen, setFullscreen] = useState(true);
  /** 目录里当前高亮的标题序号，-1 表示没有 */
  const [activeHeading, setActiveHeading] = useState(-1);
  /** 正文滚动容器：目录跳转与滚动高亮都以它为基准 */
  const previewRef = useRef<HTMLDivElement>(null);

  // 事件监听只注册一次，闭包里的 state 会过期：
  // 拖拽状态一律走 ref，state 只用来渲染
  const draggingRef = useRef(false);
  const depthRef = useRef(0);

  const canSave = hasPermission('doc.upload');

  const resetDragging = useCallback(() => {
    depthRef.current = 0;
    draggingRef.current = false;
    setDragging(false);
  }, []);

  const handleFiles = useCallback(async (list: File[]) => {
    const markdown = list.filter(isMarkdown);
    if (markdown.length === 0) {
      toast.error('只支持拖入 .md / .markdown 文件');
      return;
    }
    const oversized = markdown.filter((f) => f.size > MAX_PREVIEW_BYTES);
    const readable = markdown.filter((f) => f.size <= MAX_PREVIEW_BYTES);

    const loaded: DroppedFile[] = [];
    for (const file of readable) {
      try {
        loaded.push({ file, name: file.name, text: await file.text(), size: file.size });
      } catch {
        toast.error(`「${file.name}」读取失败`);
      }
    }
    if (loaded.length === 0) return;

    setFiles(loaded);
    setActive(0);
    // 每次拖入都从全屏打开；用户中途退出全屏只影响这一次预览
    setFullscreen(true);

    const skipped = list.length - markdown.length;
    if (skipped > 0) toast.warning(`已跳过 ${skipped} 个非 Markdown 文件`);
    if (oversized.length > 0) {
      toast.error(`「${oversized[0].name}」超过 ${formatBytes(MAX_PREVIEW_BYTES)}，未加载`);
    }
  }, []);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || inNativeDropZone(e.target)) return;
      depthRef.current += 1;
      if (!draggingRef.current) {
        draggingRef.current = true;
        setDragging(true);
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || inNativeDropZone(e.target)) return;
      // 不 preventDefault 的话浏览器不会把这次放下当成「接受」
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (!draggingRef.current) {
        draggingRef.current = true;
        setDragging(true);
      }
    };

    const onDragLeave = (e: DragEvent) => {
      if (!draggingRef.current) return;
      // relatedTarget 为空表示鼠标离开了窗口：此时计数收不回来，
      // 遮罩会一直挂在屏幕上
      if (e.relatedTarget === null) {
        resetDragging();
        return;
      }
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) {
        draggingRef.current = false;
        setDragging(false);
      }
    };

    const onDrop = (e: DragEvent) => {
      const native = inNativeDropZone(e.target);
      resetDragging();
      if (native) return;
      const dt = e.dataTransfer;
      if (!hasFiles(dt)) return;
      // 拦下这次放下：既不让浏览器直接打开文件，也不让 CodeMirror
      // 把文件内容当成纯文本插进正在编辑的正文
      e.preventDefault();
      e.stopPropagation();
      const dropped = Array.from(dt?.files ?? []);
      if (dropped.length === 0) return;
      void handleFiles(dropped);
    };

    const onDragEnd = () => resetDragging();

    window.addEventListener('dragenter', onDragEnter, true);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('dragend', onDragEnd, true);
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true);
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('dragleave', onDragLeave, true);
      window.removeEventListener('drop', onDrop, true);
      window.removeEventListener('dragend', onDragEnd, true);
    };
  }, [handleFiles, resetDragging]);

  const current = files[active];

  // ---------- 目录 ----------
  // 目录与 DocEditor 用同一套提取规则：extractHeadings 走 marked.lexer，
  // 产出的顺序与 MarkdownPreview 渲染出的 <h1>~<h6> 在 DOM 里严格一致，
  // 于是「第 n 个标题」可以直接按序号定位，不必往 HTML 里注入 id。
  const headings = useMemo(() => extractHeadings(current?.text ?? ''), [current?.text]);

  // 目录跟着滚动高亮当前章节。
  // 阈值取 40px：标题顶边滚到视口上沿附近就算「当前章节」，
  // 否则长章节的正文会把上一节的标题顶出判定范围，高亮会显得滞后。
  useEffect(() => {
    const container = previewRef.current;
    if (!container) return;
    let raf = 0;
    const update = () => {
      const nodes = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
      if (nodes.length === 0) {
        setActiveHeading(-1);
        return;
      }
      const top = container.getBoundingClientRect().top;
      let idx = -1;
      for (let i = 0; i < nodes.length; i += 1) {
        if (nodes[i].getBoundingClientRect().top - top <= 40) idx = i;
        else break;
      }
      setActiveHeading(idx);
    };
    // 滚动事件很密，用 rAF 合并成一帧一次，避免每帧都去量所有标题的位置
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [current?.text]);

  // 点目录跳到对应标题：只滚动正文容器本身。
  // 用 getBoundingClientRect 求差值，避开 offsetParent 链；
  // scrollIntoView 会连带滚动所有可滚动的祖先，把弹窗也一起拽动。
  const scrollToHeading = (index: number) => {
    const container = previewRef.current;
    if (!container) return;
    const target = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')[index];
    if (!target) return;
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: Math.max(0, container.scrollTop + delta - 16), behavior: 'smooth' });
    setActiveHeading(index);
    // 目标标题闪一下：平滑滚动结束后，用户需要知道究竟停在了哪一节
    target.classList.add('outline-flash');
    window.setTimeout(() => target.classList.remove('outline-flash'), 1200);
  };

  // 关闭预览。全屏状态不在这里复位：下一次拖入一律由 handleFiles 置为全屏，
  // 在这里多改一次只会让状态有两个来源。
  const closePreview = useCallback(() => {
    setFiles([]);
    setActiveHeading(-1);
  }, []);

  const handleSave = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    try {
      // 服务端会给不以 .md 结尾的文件名补后缀，
      // .markdown 补出来是「xxx.markdown.md」，这里先改成 .md
      const name = current.name.replace(/\.markdown$/i, '.md');
      const file =
        name === current.name
          ? current.file
          : new File([current.text], name, { type: 'text/markdown' });
      const result = await uploadFile(file, parentId);
      if (!result) {
        toast.error('保存失败：没有上传权限');
        return;
      }
      toast.success(`「${result.name}」已存入文档库`);
      closePreview();
      onSaved?.(result.id);
    } catch (e) {
      toast.error(`保存失败：${e instanceof Error ? e.message : '网络错误'}`);
    } finally {
      setSaving(false);
    }
  }, [current, parentId, uploadFile, onSaved, closePreview]);

  const lineCount = current ? current.text.split('\n').length : 0;

  return (
    <>
      {/* 拖拽提示：pointer-events-none，让这次放下仍然落在页面里 */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-indigo-500/10 backdrop-blur-[2px]">
          <div className="glass-strong rounded-2xl border-2 border-dashed border-indigo-500 px-12 py-10 text-center shadow-2xl shadow-indigo-500/20">
            <FileDown className="mx-auto mb-3 h-11 w-11 text-indigo-500" />
            <div className="text-base font-semibold text-foreground">松开鼠标，预览 Markdown 文档</div>
            <div className="mt-1 text-xs text-muted-foreground">支持 .md / .markdown，仅在本地预览</div>
          </div>
        </div>
      )}

      <Dialog
        open={files.length > 0}
        onOpenChange={(v) => {
          if (!v) closePreview();
        }}
      >
        <DialogContent
          className={cn(
            'flex flex-col gap-0 overflow-hidden border-0 p-0',
            // 伪全屏：把 Dialog 自带的居中定位改回左上角并铺满视口。
            // 不走原生 Fullscreen API——它要用户手势授权，还会把整个页面
            // 交给浏览器接管，弹窗的关闭、目录这些交互反而变得不可控。
            //
            // 全屏时连玻璃底也换成不透明底：标题栏压在页面顶部的导航上，
            // 半透明会让两行字叠在一起，谁也读不清。全屏本来就是「只看这一篇」。
            fullscreen
              ? 'bg-background top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none'
              : 'glass-strong max-h-[88vh] sm:max-w-4xl',
          )}
        >
          <DialogHeader className="shrink-0 border-b border-indigo-100/40 px-6 py-4 text-left dark:border-indigo-900/40">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-5 w-5 shrink-0 text-indigo-500" />
                  <span className="truncate">{current?.name ?? ''}</span>
                </DialogTitle>
                <DialogDescription className="text-xs">
                  {formatBytes(current?.size)} · {lineCount} 行 · 拖入预览，尚未写入文档库
                </DialogDescription>
              </div>
              {/* 右侧留出 pr-8，给 Dialog 自带的关闭按钮腾位置 */}
              <div className="flex shrink-0 items-center gap-1 pr-8">
                <button
                  type="button"
                  onClick={() => setFullscreen((v) => !v)}
                  title={fullscreen ? '退出全屏' : '全屏查看'}
                  aria-label={fullscreen ? '退出全屏' : '全屏查看'}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-indigo-500/10 hover:text-foreground"
                >
                  {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </DialogHeader>

          {/* 一次拖了多个文件时，用标签页在它们之间切换 */}
          {files.length > 1 && (
            <div className="scrollbar-thin flex shrink-0 gap-1 overflow-x-auto border-b border-indigo-100/40 px-4 py-2 dark:border-indigo-900/40">
              {files.map((f, i) => (
                <button
                  key={`${f.name}-${i}`}
                  type="button"
                  onClick={() => {
                    setActive(i);
                    // 换文件等于换一篇文档，滚动位置与目录高亮都从头开始
                    setActiveHeading(-1);
                    previewRef.current?.scrollTo({ top: 0 });
                  }}
                  className={cn(
                    'max-w-[16rem] shrink-0 cursor-pointer truncate rounded-md px-3 py-1.5 text-xs transition-colors',
                    i === active
                      ? 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300'
                      : 'text-muted-foreground hover:bg-indigo-500/10',
                  )}
                  title={f.name}
                >
                  {f.name}
                </button>
              ))}
            </div>
          )}

          {/* 正文与目录并排。容器查询按「这一行的可用宽度」决定目录是否占位：
              宽度不足时正文每行撑不满，再挤一列目录只会两边都难读。

              这一层垫了不透明底：弹窗本身是毛玻璃的，背后的工作区会透进来，
              而目录是一列浅色小字，压在文件卡片上几乎读不出来。 */}
          <div className="@container flex min-h-0 flex-1 overflow-hidden bg-background/85">
            <div ref={previewRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {/* 正文限宽居中，与文档页同一档（68rem）：全屏下正文区很宽，
                  不限宽的话一行能塞进上百个字符，眼睛从行首拉到行尾会漏字。 */}
              <MarkdownPreview source={current?.text ?? ''} className="mx-auto max-w-[68rem]" />
            </div>

            {headings.length > 0 && (
              <aside className="hidden w-56 shrink-0 border-l border-indigo-100/40 bg-muted/30 @min-[44rem]:block dark:border-indigo-900/40">
                <DocOutline headings={headings} activeIndex={activeHeading} onSelect={scrollToHeading} />
              </aside>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t border-indigo-100/40 px-6 py-3 dark:border-indigo-900/40">
            <Button variant="ghost" onClick={closePreview}>
              关闭
            </Button>
            {canSave && (
              <Button onClick={() => void handleSave()} disabled={saving} className="gradient-bg hover:opacity-90">
                {saving ? '保存中…' : '存入文档库'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
