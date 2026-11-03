import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Download,
  Eye,
  X,
  Clock,
  User as UserIcon,
  Tag,
  Check,
  Maximize2,
  Minimize2,
  Undo2,
  Redo2,
  Bold,
  Italic,
  Strikethrough,
  Superscript,
  Subscript,
  Heading1,
  Heading2,
  Heading3,
  Link2,
  Code2,
  SquareCode,
  List,
  ListOrdered,
  Quote,
  Minus,
  Table,
  CheckSquare,
  Sparkles,
  Lock,

  PenLine,
  BookOpen,
  Paperclip,
  ChevronDown,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { MarkdownPreview } from './MarkdownPreview';
import { MarkdownEditor, type MarkdownEditorHandle, type EditorContext } from './MarkdownEditor';
import { DocOutline } from './DocOutline';
import { LockedDocPanel } from './LockedDocPanel';
import { useAccessWatch } from './useAccessWatch';
import { DecryptingPanel } from './DecryptingPanel';
import { PolishDialog } from './PolishDialog';
import { AttachmentPanel } from './AttachmentPanel';
import { FilePreview } from './FilePreview';
import { api } from '@/lib/api';
import { downloadAsFile, formatBytes, formatRelativeTime, debounce, extractHeadings } from '@/utils';
import { cn } from '@/lib/utils';
import type { AccessCapability, DocNode } from '@/types';

interface DocEditorProps {
  doc: DocNode;
  onClose: () => void;
}

/** 预览延迟渲染的停手时长（ms）。取 300ms：短到几乎察觉不到，长到足以把
 *  连续输入合并成一次解析。低于这个值预览仍在每键重算，等于没做防抖。 */
const PREVIEW_DEBOUNCE_MS = 300;

/**
 * 空白正文里的起手式。
 *
 * 全部是「结构类」命令——它们在空正文里也能落地（往源码行首加标记或
 * 插一段块），点一下源码里就出现对应的结构，光标落点也在那儿。
 * 行内格式没放进来：空白正文里没有字可加粗，硬塞只会写进正文。
 */
const QUICK_START_ACTIONS: {
  label: string;
  icon: React.ReactNode;
  apply: (editor: MarkdownEditorHandle | null) => void;
}[] = [
  { label: '标题', icon: <Heading2 className="h-3.5 w-3.5" />, apply: (ed) => ed?.linePrefix('## ') },
  { label: '列表', icon: <List className="h-3.5 w-3.5" />, apply: (ed) => ed?.toggleList('bullet') },
  {
    label: '待办',
    icon: <CheckSquare className="h-3.5 w-3.5" />,
    apply: (ed) => ed?.toggleList('task'),
  },
  { label: '引用', icon: <Quote className="h-3.5 w-3.5" />, apply: (ed) => ed?.linePrefix('> ') },
  {
    label: '代码块',
    icon: <SquareCode className="h-3.5 w-3.5" />,
    apply: (ed) => ed?.insertBlock('\n```\n\n```\n'),
  },
  {
    label: '表格',
    icon: <Table className="h-3.5 w-3.5" />,
    apply: (ed) => ed?.insertBlock('\n| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |\n'),
  },
];

export function DocEditor({ doc, onClose }: DocEditorProps) {
  const { updateDoc, docSync, hasPermission, users, isAdmin, canUseAgent, revealDoc, repos } = useApp();
  const [content, setContent] = useState(doc.content ?? '');
  const [saved, setSaved] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [polishOpen, setPolishOpen] = useState(false);
  /** 附件区是否展开。默认收起：附件平时不该挤占正文的地方 */
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });

  /**
   * 文档所属仓库。
   *
   * 仓库决定了这份文档能挂什么格式的附件、单文件多大——
   * 不同项目的留存要求本就不一样，所以规则要跟着文档走。
   */
  const repo = useMemo(() => repos.find((r) => r.id === doc.repoId), [repos, doc.repoId]);
  // 光标处的格式上下文：工具栏据此高亮「当前正在用的格式」，
  // 让按钮从盲目的快捷键变成有状态的指示器
  const [editorCtx, setEditorCtx] = useState<EditorContext>({
    heading: 0,
    list: 'none',
    quote: false,
    hasSelection: false,
    inline: { bold: false, italic: false, strike: false, sup: false, sub: false },
  });
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  // 操作坞在正文滚动时隐去：它悬浮在正文上方，滚动中一直挂着会压住
  // 正在读的那几行字——停手 0.5s 后再淡回来。
  const [dockHidden, setDockHidden] = useState(false);
  const dockTimer = useRef<number | null>(null);
  const hideDockOnScroll = useCallback(() => {
    setDockHidden(true);
    if (dockTimer.current !== null) window.clearTimeout(dockTimer.current);
    dockTimer.current = window.setTimeout(() => setDockHidden(false), 500);
  }, []);
  const { resolvedTheme } = useTheme();

  const canEdit = hasPermission('doc.edit');

  // ---------- 视图形态 ----------
  // 两种形态，互斥——同一时刻只呈现一面：
  //   preview 预览——全宽只读正文，文章长什么样就是什么样
  //   edit   编辑——全宽 Markdown 源码，改字的地方
  // 早先还有第三种「左右分屏（左源码右预览）」，那形态把两件事挤在一屏：
  // 窗口一窄，两栏各剩几百像素，正文与源码都被压得读不下去；滚动还要互相
  // 牵着走，两边各让半步，结果谁都不在预期的位置。拆成互斥的两面后，
  // 每一面都能占满整个正文区，滚动也只有一处，不再有联动与错位。
  // 默认落在预览：多数时候是「读」，写的时候再切到编辑面。
  const [viewMode, setViewMode] = useState<'preview' | 'edit'>('preview');

  // 切到编辑面时让编辑器重新测量并接管焦点。
  // 编辑面此前是 display:none，CodeMirror 在隐藏期间量到的尺寸是 0，
  // 不让它重新测量，光标落点与滚动定位都会算到错误的位置上；
  // 而「我要编辑」这个动作本身，就该把光标交到编辑器手里。
  useEffect(() => {
    if (viewMode !== 'edit') return;
    const raf = window.requestAnimationFrame(() => {
      editorRef.current?.refresh();
      editorRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [viewMode]);

  // ---------- 空白文档的落地 ----------
  //
  // 新建文档进来时正文一个字都没有，用户面对的是一张白纸：
  // 落点没有（光标不在这儿），也不知道该从哪儿写起。
  // 这里做两件事——把光标送进源码栏，再给一块「快速开始」，
  // 让「新建」不再是「打开一个空文件」这种需要自己想清楚从哪下手的事。
  const [focusRequest, setFocusRequest] = useState(() =>
    hasPermission('doc.edit') && !(doc.content ?? '').trim() ? 1 : 0,
  );
  /** 正文是不是一张白纸：空白文档才需要「快速开始」的引导 */
  const blankDoc = canEdit && content.trim() === '';

  // 光标送进源码栏。
  // 用 requestAnimationFrame 等一帧：CodeMirror 刚挂载时还没完成首次测量，
  // 这时候 focus 落下去，编辑器内部可能还拿不到视口信息。
  useEffect(() => {
    if (!canEdit) return;
    if (focusRequest === 0) return;
    // 空白文档没有正文可读，落在预览面只会看到一张白纸——直接进编辑面
    setViewMode('edit');
    const raf = window.requestAnimationFrame(() => editorRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [focusRequest, canEdit]);

  // ---------- 加密文档的解锁状态 ----------
  // 解锁后的明文只留在组件内存里：既不写回全局 docs（会被缓存进 localStorage），
  // 也不落盘。切换文档时状态清空——离开后再进来必须重新解锁，
  // 免得同一台机器上后来打开这个页面的人直接看到明文。
  const [unlockedContent, setUnlockedContent] = useState<string | null>(null);
  // 授权是否被收回：收回后要把正文从界面上撤掉，不能只改个锁图标了事
  const [accessRevoked, setAccessRevoked] = useState(false);
  // 访客要走申请，管理员不用：服务端本就持有被主密钥包裹的数据密钥，
  // 管理员用自己的主密钥就能直接解密（见 /api/docs/:id/reveal）。
  // 让管理员先向自己要一次审批才看得到自己管理的文档，
  // 只是把一次点击换成了一次点击，并没有多出任何安全性。
  /**
   * 加密原件不需要「解锁正文」这一步。
   *
   * 笔记的正文是一段密文文本，管理员要先把它解开才能看到；
   * 原件的正文就是它自己的字节，服务端在 /raw 与 /download 里
   * 直接解密回传——所以管理员打开加密原件就是直接看到文件，
   * 不该被一个「正在解密…」的中间态挡住。
   */
  const isEncryptedOriginal = doc.encrypted === true && doc.kind === 'file';
  const adminReveal = doc.encrypted === true && isAdmin && !isEncryptedOriginal;
  // 管理员正在解密：这段时间正文还没到，界面要交代在等什么
  const revealing = adminReveal && unlockedContent === null;
  // 访客侧：没有授权就只能看到申请入口
  const locked = doc.encrypted === true && unlockedContent === null && !adminReveal && !isAdmin;
  // 访客此刻正看着明文：开着监听，授权一被收回就当场撤下正文
  const watchingAccess = doc.encrypted === true && !isAdmin && unlockedContent !== null;

  /**
   * 授权被收回（或到期）：把明文从内存里抹掉。
   *
   * 这一步是「收回」真正生效的地方。管理员点了收回之后，对方
   * 屏幕上那份明文必须同时消失——不然收回只是心理安慰：
   * 内容还在对方屏幕里，还被复制走了。
   */
  const handleAccessRevoked = useCallback(() => {
    setUnlockedContent(null);
    setAccessRevoked(true);
    toast.warning('访问授权已被收回，该文档已重新锁定');
  }, []);
  useAccessWatch(doc.id, watchingAccess, handleAccessRevoked);
  const [revealError, setRevealError] = useState('');
  // 重试用：改它就重跑一次解密 effect
  const [revealNonce, setRevealNonce] = useState(0);

  /**
   * 访客此刻手里的授权能干什么。
   *
   * 授权是分级的：管理员可能只给了「查看」。这时候下载按钮得消失——
   * 让用户点下去再吃服务端一个 403 是白折腾，
   * 而且「按钮在但点不动」比「按钮不在」更像出了故障。
   */
  const [grantCaps, setGrantCaps] = useState<AccessCapability[] | null>(null);
  useEffect(() => {
    if (!watchingAccess) {
      setGrantCaps(null);
      return;
    }
    let alive = true;
    const probe = async () => {
      try {
        const s = await api.checkDocAccess(doc.id);
        if (alive && s.granted) setGrantCaps(s.capabilities ?? ['view']);
      } catch {
        // 探测不到就按最保守的处理：不给下载
        if (alive) setGrantCaps(['view']);
      }
    };
    void probe();
    // 授权能力是会被管理员改的：管理员刚把「下载」放开，
    // 访客这边不该非得关掉重开文档才看得到变化。
    const timer = window.setInterval(() => void probe(), 15000);
    const onFocus = () => void probe();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [watchingAccess, doc.id]);

  const canDownload =
    hasPermission('doc.download') &&
    // 访客看加密文档时，下载要跟着授权走；管理员与普通文档不受影响
    (!watchingAccess || (grantCaps?.includes('download') ?? false));
  /**
   * 这个文档是不是「原件」。
   *
   * 原件就是文件本身（zip / 图片 / PDF / 代码……），没有 Markdown 正文可编辑，
   * 也不该被塞进 Markdown 编辑器里让人对着一个空壳发呆。
   */
  const isFileDoc = doc.kind === 'file';
  // 润色入口：需管理员身份 + 可用 Agent + 可编辑 + 正文非空。
  // 服务端对 /agent/polish 另有 requireAdmin 兜底，此处仅为入口可见性。
  // 加密文档一律排除：它的正文不应进入模型，服务端也会以 403 拒绝。
  // 原件也排除：二进制内容送进模型既没意义也不安全。
  const canPolish =
    isAdmin &&
    canEdit &&
    canUseAgent &&
    doc.type === 'file' &&
    !isFileDoc &&
    !doc.encrypted &&
    content.trim() !== '';

  // ---------- 预览延迟渲染 ----------
  // 原实现把 content 直接喂给 MarkdownPreview，等于每敲一个键就
  // marked.parse + DOMPurify.sanitize 整篇一遍再整体重排 DOM。
  // 预览与编辑之间本就不需要逐字符一致，停手后再更新即可。
  const [previewText, setPreviewText] = useState(content);
  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewText(content), PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [content]);

  // ---------- 管理员免密解密 ----------
  // 打开加密文档即向服务端要明文：解密在服务端完成，
  // 浏览器全程拿不到正文密文，前端也没有解密运算要做。
  //
  // 明文同样只进内存：不写回全局 docs（会被缓存进 localStorage），不落盘。
  useEffect(() => {
    if (!revealing) return;
    let cancelled = false;
    setRevealError('');
    void (async () => {
      try {
        const revealed = await revealDoc(doc.id);
        if (cancelled) return;
        const plain = revealed.content ?? '';
        setUnlockedContent(plain);
        setContent(plain);
        setPreviewText(plain);
        setSaved(true);
      } catch (e) {
        if (!cancelled) setRevealError(e instanceof Error ? e.message : '解密失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revealing, doc.id, revealDoc, revealNonce]);

  // 字节数用 TextEncoder 而非 new Blob(...).size：两者结果相同，
  // 但后者每次渲染都要分配一个 Blob 对象。
  const byteSize = useMemo(() => new TextEncoder().encode(content).length, [content]);

  // ---------- 文档目录 ----------
  // 用 previewText 而非 content：目录必须和预览里真正渲染出来的标题一一对应，
  // 而预览本身有 300ms 防抖。跟着 content 走会让目录比正文抢先一拍。
  const headings = useMemo(() => extractHeadings(previewText), [previewText]);
  // 预览面的次级行要报规模，用的是同一份防抖后的正文
  const previewLineCount = useMemo(() => previewText.split('\n').length, [previewText]);
  const [activeHeading, setActiveHeading] = useState(-1);
  // 目录常驻，不再提供开关。
  //
  // 早先目录可以收起，可「收起」换来的好处很有限：正文卡片本就限宽居中，
  // 两侧空着的地方摆一列目录并不挤。反倒是一收一放，目录与正文的相对位置
  // 每次都变，眼睛要重新找落点——同一个功能摆在两个地方，读者却只当它是一个。
  // 现在它固定在正文右侧，预览与编辑两面都在同一个位置，读到哪一节都按得到。
  //
  // 只有确实没有标题时目录才不占位：空目录没有内容可列，占着位置只是空白。
  // 这个判断同时决定目录列与操作坞右侧的占位块——两者必须同时出现或同时消失，
  // 否则操作坞的居中基准会与正文列错开。
  const outlineVisible = headings.length > 0;

  // 正文一改，序号就可能指向别的标题了，清掉高亮避免误认
  useEffect(() => {
    setActiveHeading(-1);
  }, [previewText]);

  // ---------- 目录跳转 ----------
  // 两个面各有各的落点：预览面滚到对应标题，编辑面落到对应源码行。
  const scrollToHeading = (index: number) => {
    const heading = headings[index];
    if (!heading) return;
    if (viewMode === 'edit') {
      // 编辑面里没有渲染出来的标题可指，只能按源码行定位
      editorRef.current?.gotoLine(heading.line);
      setActiveHeading(index);
      return;
    }
    const container = previewScrollRef.current;
    if (!container) return;
    // 靠 extractHeadings 保证「第 n 个 token」对应「第 n 个 h 标签」
    const target = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')[index];
    if (!target) return;
    // 只滚动预览容器本身。用 getBoundingClientRect 求差值，避开 offsetParent 链；
    // scrollIntoView 会连带滚动所有可滚动的祖先，把外层容器也一起拽动。
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: Math.max(0, container.scrollTop + delta - 16), behavior: 'smooth' });
    setActiveHeading(index);
    // 目标标题闪一下：平滑滚动结束后，用户需要知道究竟停在了哪一节
    target.classList.add('outline-flash');
    window.setTimeout(() => target.classList.remove('outline-flash'), 1200);
  };

  // ---------- 分屏时代的遗留 ----------
  // 这里曾经有一整套「左右分屏的滚动同步」：按源码行号把预览和源码对齐，
  // 并记住「最后是谁在被用户操作」，好让只有被操作的那一侧带动另一侧。
  // 那套机制的前提是两栏同屏——行号对齐、块顶对齐都只在并排时才成立。
  // 现在编辑与预览是互斥的两面，任何一面在场时另一面都不存在，
  // 同步没有对象，驱动者、抑制窗口、块查找一并失去意义，整套删除。
  //
  // 「双击预览跳回源码」同理：那条路径本来就只为并排而生，
  // 预览面现在是纯粹的阅读界面，要改字请切到编辑面。

  // 未持久化的内容（属于 prevIdRef 记录的那篇文档）
  const pendingRef = useRef<string | null>(null);
  const prevIdRef = useRef(doc.id);

  // 切换文档时：先把上一篇的未保存内容写入正确文档，再同步新文档内容
  useEffect(() => {
    if (prevIdRef.current !== doc.id) {
      const oldId = prevIdRef.current;
      if (pendingRef.current !== null) {
        updateDoc(oldId, { content: pendingRef.current });
        pendingRef.current = null;
      }
      prevIdRef.current = doc.id;
      setContent(doc.content ?? '');
      setPreviewText(doc.content ?? '');
      setSaved(true);
      // 换文档时解锁状态一并清空：加密文档的明文只在内存里，
      // 离开后再回来必须重新走一次解锁流程。
      setUnlockedContent(null);
      // 「已被收回」的提示只属于刚才那篇文档
      setAccessRevoked(false);
      // 切到空白文档：把光标送进源码栏。
      // 只在「换文档」时提这个请求——用户自己把正文清空时不该抢回焦点，
      // 那一刻光标本来就在源码栏里。
      if (canEdit && !(doc.content ?? '').trim()) setFocusRequest((n) => n + 1);
    }
  }, [doc.id, doc.content, updateDoc, canEdit]);

  /**
   * 正文是异步取回来的：清单里只有元数据（正文在仓库目录的文件里），
   * 打开一篇要单独取一次。取回来之前编辑器是空的，拿到之后得把内容补进去——
   *
   * 上面那个 effect 只管「换文档」，同一篇文档后到的正文它管不着。
   *
   * 两个前提：
   * - 本地没有待保存的内容（用户已经开始写了就不能抢过来盖掉）；
   * - 文档没加密（加密文档的明文只走解锁流程，别处塞不进来）。
   */
  useEffect(() => {
    if (pendingRef.current !== null) return;
    if (doc.encrypted) return;
    if (doc.content === undefined) return;
    setContent(doc.content);
    setPreviewText(doc.content);
    setSaved(true);
  }, [doc.content, doc.encrypted]);

  const flushSave = useCallback(() => {
    if (pendingRef.current !== null) {
      updateDoc(doc.id, { content: pendingRef.current });
      pendingRef.current = null;
    }
    setSaved(true);
  }, [doc.id, updateDoc]);

  // 外部内容覆盖（当前来自「应用到文档」）。
  //
  // 必须清空 pendingRef：它存着本篇文档未落盘的内容，若不清，用户下一次输入会
  // 经 handleChange 用旧内容覆盖全文，把刚应用的润色结果静默丢弃。依赖用 token
  // 而非 content——同一篇文档连续应用两次润色时内容可能相同，只比内容会漏掉后一次。
  const appliedTokenRef = useRef(0);
  useEffect(() => {
    if (!docSync || docSync.docId !== doc.id || docSync.token === appliedTokenRef.current) return;
    appliedTokenRef.current = docSync.token;
    setContent(docSync.content);
    setPreviewText(docSync.content);
    pendingRef.current = null;
    setSaved(true);
  }, [docSync, doc.id]);

  // 通过 ref 转发，保证防抖回调始终调用最新的 flushSave（不会捕获过期的 doc.id）
  // 注意：ref 只能在副作用中更新，不能在渲染期间赋值
  const flushRef = useRef(flushSave);
  useEffect(() => {
    flushRef.current = flushSave;
  }, [flushSave]);
  // 防抖保存：debounce 实例在 effect 里创建并存进 ref。
  // 渲染期间创建它会读到 flushRef.current，触发 react-hooks/refs 规则；
  // useState 惰性初始化同样不放过初始化器里的 ref 访问，所以只能在 effect 里做。
  const debouncedSaveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    debouncedSaveRef.current = debounce(() => flushRef.current(), 600);
  }, []);

  /** 落库的共同入口：内容一改就走这里 */
  const applyContent = (val: string) => {
    setContent(val);
    setSaved(false);
    pendingRef.current = val;
    debouncedSaveRef.current?.();
  };

  /**
   * 源码侧改动。
   *
   * 唯一的编辑入口：改完就落库，预览随即按新内容重排。
   */
  const handleSourceChange = (val: string) => {
    applyContent(val);
  };

  // 用 useCallback 固定身份：快捷键的 effect 才能把 handleSave 列进依赖而不会每次渲染重挂载监听器
  const handleSave = useCallback(() => {
    pendingRef.current = content;
    flushSave();
  }, [content, flushSave]);

  // Ctrl+S 快捷键：跳过防抖立即落盘
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (canEdit) handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canEdit, handleSave]);

  // Esc 退出全屏
  //
  // 全屏把文档提到所有浮层之上，鼠标够得到「退出全屏」那个按钮，
  // 键盘用户却没有出口——Esc 是这类浮层的通用退出键。
  //
  // 有弹窗打开时不抢 Esc：润色对话框、标签输入等自己要用 Esc 关闭，
  // 顺手把整篇文档退出全屏会让人以为界面出故障。
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      setFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreen]);

  // 卸载 / 页面隐藏时兜底落盘
  //
  // 防抖窗口（600ms）内关闭编辑器、切走标签页或关页面，pending 内容会随组件卸载
  // 一起消失且无任何提示。移除「保存」按钮后用户已无手动补救手段，这里是唯一的保险。
  // 用 pagehide 而非 beforeunload：后者在移动端与 bfcache 场景下不可靠。
  useEffect(() => {
    const flush = () => flushRef.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, []);

  // 操作坞的隐藏定时器：组件卸载后不能再让它把 state 写回已销毁的组件
  useEffect(() => {
    return () => {
      if (dockTimer.current !== null) window.clearTimeout(dockTimer.current);
    };
  }, []);

  /**
   * 下载。
   *
   * 两种东西，两种下载方式：
   * - 原件 → 交给服务端的下载路由，按原始字节与原文件名回传；
   * - 笔记 → 浏览器本地导出正文为 .md（正文在编辑区里，可能还没落库）。
   *
   * 混成一种会有具体的麻烦：原件没有「正文」可导出，
   * 本地导出会把一个 zip 变成一个 0 字节的假文件——用户拿到的
   * 东西看起来下载成功了，打开却是空的。
   *
   * 原件走 api.downloadDoc 而不是 window.location：
   * 跳转不会带 Authorization 头（管理员下加密原件会被当成访客挡下），
   * 失败时还会把人带离当前页面，只留下一屏 JSON 错误。
   */
  const handleDownload = async () => {
    if (isFileDoc) {
      try {
        await api.downloadDoc(doc.id, doc.name);
      } catch (e) {
        toast.error((e as Error)?.message ?? '下载失败');
      }
      return;
    }
    downloadAsFile(doc.name, content);
  };

  const updatedBy = users.find((u) => u.id === doc.updatedBy);
  const createdBy = users.find((u) => u.id === doc.createdBy);

  const handleAddTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    if (doc.tags?.includes(t)) {
      setTagInput('');
      return;
    }
    updateDoc(doc.id, { tags: [...(doc.tags || []), t] });
    setTagInput('');
  };

  const handleRemoveTag = (t: string) => {
    updateDoc(doc.id, { tags: (doc.tags || []).filter((x) => x !== t) });
  };

  // ---------- 工具栏 ----------
  // 源码侧的命令全部交给 CodeMirror 的 transaction 执行，不再手工拼字符串改 content：
  // 手工改 content 会绕过编辑器状态，撤销栈与光标随即失真。
  //
  // active 字段表示「当前光标处正处于这种格式」：按钮常亮既是状态提示，
  // 也是二次点击的语义保证——亮的按钮再点一次是取消，不是重复叠加。

  /** 工具栏的指示灯按源码侧的状态亮 */
  const ctx: EditorContext = editorCtx;

  /**
   * 执行一条排版命令。
   *
   * 命令只有源码一个落点：预览是只读的呈现，改动从左栏发起、
   * 在右栏立刻看得见。命令没生效（比如没有选区）时把焦点送回源码栏，
   * 用户能看出自己刚才点的是哪儿。
   */
  const runCommand = (sourceAction: () => void) => {
    sourceAction();
  };

  type ToolbarItem = {
    sep?: true;
    icon?: React.ReactNode;
    title?: string;
    action?: () => void;
    disabled?: boolean;
    active?: boolean;
  };

  const toolbarItems: ToolbarItem[] = [
    {
      icon: <Undo2 className="h-4 w-4" />,
      title: '撤销 (Ctrl+Z)',
      action: () => runCommand(() => editorRef.current?.undo()),
      disabled: !historyState.canUndo,
    },
    {
      icon: <Redo2 className="h-4 w-4" />,
      title: '重做 (Ctrl+Shift+Z)',
      action: () => runCommand(() => editorRef.current?.redo()),
      disabled: !historyState.canRedo,
    },
    { sep: true },
    {
      icon: <Heading1 className="h-4 w-4" />,
      title: '一级标题',
      action: () => runCommand(() => editorRef.current?.linePrefix('# ')),
      active: ctx.heading === 1,
    },
    {
      icon: <Heading2 className="h-4 w-4" />,
      title: '二级标题',
      action: () => runCommand(() => editorRef.current?.linePrefix('## ')),
      active: ctx.heading === 2,
    },
    {
      icon: <Heading3 className="h-4 w-4" />,
      title: '三级标题',
      action: () => runCommand(() => editorRef.current?.linePrefix('### ')),
      active: ctx.heading === 3,
    },
    { sep: true },
    {
      icon: <Bold className="h-4 w-4" />,
      title: '加粗 (Ctrl+B)',
      action: () => runCommand(() => editorRef.current?.wrapSelection('**', '**', '粗体文本')),
      active: ctx.inline.bold,
    },
    {
      icon: <Italic className="h-4 w-4" />,
      title: '斜体 (Ctrl+I)',
      action: () => runCommand(() => editorRef.current?.wrapSelection('*', '*', '斜体文本')),
      active: ctx.inline.italic,
    },
    {
      icon: <Strikethrough className="h-4 w-4" />,
      title: '删除线',
      action: () => runCommand(() => editorRef.current?.wrapSelection('~~', '~~', '删除文本')),
      active: ctx.inline.strike,
    },
    {
      icon: <Superscript className="h-4 w-4" />,
      title: '上标',
      action: () => runCommand(() => editorRef.current?.wrapSelection('^', '^', '上标')),
      active: ctx.inline.sup,
    },
    {
      icon: <Subscript className="h-4 w-4" />,
      title: '下标',
      action: () => runCommand(() => editorRef.current?.wrapSelection('~', '~', '下标')),
      active: ctx.inline.sub,
    },
    // 删除线只用双波浪：单波浪 ~x~ 归下标（见 MarkdownPreview 的 marked 扩展）
    { sep: true },
    {
      icon: <List className="h-4 w-4" />,
      title: '无序列表',
      action: () => runCommand(() => editorRef.current?.toggleList('bullet')),
      active: ctx.list === 'bullet',
    },
    {
      icon: <ListOrdered className="h-4 w-4" />,
      title: '有序列表',
      action: () => runCommand(() => editorRef.current?.toggleList('ordered')),
      active: ctx.list === 'ordered',
    },
    {
      icon: <CheckSquare className="h-4 w-4" />,
      title: '任务列表',
      action: () => runCommand(() => editorRef.current?.toggleList('task')),
      active: ctx.list === 'task',
    },
    { sep: true },
    {
      icon: <Quote className="h-4 w-4" />,
      title: '引用',
      action: () => runCommand(() => editorRef.current?.linePrefix('> ')),
      active: ctx.quote,
    },
    {
      icon: <Code2 className="h-4 w-4" />,
      title: '行内代码 (Ctrl+`)',
      action: () => runCommand(() => editorRef.current?.wrapSelection('`', '`', 'code')),
    },
    {
      icon: <SquareCode className="h-4 w-4" />,
      title: '代码块',
      action: () =>
        runCommand(
          () =>
            editorRef.current?.insertBlock(
              doc.type === 'file' ? '\n```ts\n// 在此编写代码\n```\n' : '\n```\n\n```\n',
            )
        ),
    },
    {
      icon: <Minus className="h-4 w-4" />,
      title: '分隔线',
      action: () => runCommand(() => editorRef.current?.insertBlock('\n---\n')),
    },
    { sep: true },
    {
      icon: <Link2 className="h-4 w-4" />,
      title: '链接',
      action: () => runCommand(() => editorRef.current?.wrapSelection('[', '](https://)', '链接文字')),
    },
    {
      icon: <Table className="h-4 w-4" />,
      title: '表格',
      action: () =>
        runCommand(
          () =>
            editorRef.current?.insertBlock(
              '\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n',
            )
        ),
    },
  ];

  // 按分隔线切成组，每组整体换行：
  // 逐个按钮换行会把「引用 / 行内代码」这类一组命令拆到两行，
  // 第二行开头只剩一根孤零零的分隔线，看起来像排版出了错
  const toolbarGroups: ToolbarItem[][] = [];
  {
    let group: ToolbarItem[] = [];
    // eslint-disable-next-line react-hooks/refs -- 工具栏 item.action 只在点击时执行，渲染期不会被调用
    for (const item of toolbarItems) {
      if (item.sep) {
        if (group.length) toolbarGroups.push(group);
        group = [];
      } else {
        group.push(item);
      }
    }
    if (group.length) toolbarGroups.push(group);
  }

  // ---------- 预览面：访客与管理员共用同一份排版 ----------
  //
  // 早先访客预览与管理员预览各写了一份 JSX：卡片最大宽度、卡内边距、
  // 滚动容器内边距三处参数在两个地方各调各的。改了一处忘了另一处，
  // 两个界面的正文宽度就对不上——同一个文档，看的人看到的却是两种版式。
  // 现在只有这一份实现：访客看到的就是管理员预览面看到的那版排版。
  //
  // 这一面与编辑面共用同款外壳：同样的留白、同样尺寸的卡片、同样高的卡片头、
  // 同样高的次级行，滚动条同样贴在卡片内壁。
  // 早先预览的滚动发生在最外层容器上，滚动条落在窗口右缘，而编辑的滚动
  // 发生在 CodeMirror 内部、滚动条贴在卡片右壁——两个界面上下叠在一起时，
  // 滚动条像是从屏幕边缘搬进了屏幕中间，卡片也一会儿撑满、一会儿随内容收缩。
  // 统一之后，切换只换卡片里的内容：边界不动、滚动条不搬家、正文起点不跳。
  //
  // hidden 只切 display，不卸载节点：卸载会让预览容器重建，
  // 读了一半切去改字再切回来，滚动位置就丢了。
  const renderPreviewPane = (hidden: boolean) => (
    <div
      className="min-h-0 min-w-0 flex flex-col"
      style={{ display: hidden ? 'none' : 'flex' }}
    >
      <div className="flex-1 min-h-0 flex flex-col p-5 sm:p-8 pb-16">
        <Card
          className={[
            'glass mx-auto w-full flex-1 min-h-0',
            // 全屏时铺满：全屏的意义就是用尽这块屏幕。
            // 还按 68rem 卡着，大屏上左右就是两大片空白——那不叫全屏，
            // 只叫「把窗口放大了一点」。
            fullscreen ? 'max-w-none' : 'max-w-[68rem]',
            // 与编辑面同一张卡片：零内边距、零间隙，
            // 内边距由卡片头、次级行、正文区各段自己管
            'p-0 gap-0 overflow-hidden',
          ].join(' ')}
        >
          {/* 卡片头：标明这一面是什么。与编辑面同样高、同样位置。 */}
          <div className="flex items-center gap-2 h-10 px-4 shrink-0 border-b border-indigo-100/60 dark:border-indigo-900/50">
            <BookOpen className="h-4 w-4 text-indigo-500/80" />
            <span className="text-[13px] font-medium text-muted-foreground">Markdown 预览</span>
          </div>
          {/* 次级行：与编辑面的排版工具栏同高、同底色、同边框。
              预览面没有可改的东西，这一行给的是只读说明与文档规模——
              两面都多出同样高的一行，正文的起点才不会在切换时上下跳。 */}
          <div className="shrink-0 border-b border-indigo-100/60 dark:border-indigo-900/50 bg-white/40 dark:bg-white/[0.04]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 min-h-10 text-[12px] text-muted-foreground">
              <span className="shrink-0">只读预览</span>
              <span className="w-px h-3.5 bg-indigo-200/70 dark:bg-indigo-800/70 shrink-0" />
              <span className="shrink-0 tabular-nums">{previewLineCount} 行</span>
              <span className="w-px h-3.5 bg-indigo-200/70 dark:bg-indigo-800/70 shrink-0" />
              <span className="shrink-0 tabular-nums">{headings.length} 个标题</span>
            </div>
          </div>
          {/* 正文区：滚动发生在卡片内部，与编辑面（CodeMirror 内部滚动）同一位置。
              底部留白 96px，与编辑器 .cm-content 的底部留白对齐：
              末段不会紧贴卡片下边缘，最后一行也能滚到视区中部附近。 */}
          <div
            ref={previewScrollRef}
            className="flex-1 min-h-0 overflow-auto scrollbar-thin px-6 sm:px-9 pt-5 pb-24"
          >
            <MarkdownPreview
              // 统一喂防抖后的 previewText：每敲一个字都整篇
              // marked.parse 一遍太浪费，防抖后重排就够了
              source={previewText}
            />
          </div>
        </Card>
      </div>
    </div>
  );

  return (
    <div
      onScrollCapture={hideDockOnScroll}
      // 全屏三层讲究：
      // - z-[60] 高于所有浮层（Agent 面板、对话框都是 z-50）。同层级时
      //   Agent 面板在 DOM 里更靠后，会直接盖在全屏文档上——那不叫全屏。
      // - 底色用不透明的 bg-background：半透明加模糊会把下面的界面
      //   糊成一层鬼影，正文压在鬼影上读不下去。拖拽预览那边早就踩过
      //   这个坑并换成不透明底，这里跟上。
      // - 不用 backdrop-blur：全屏尺寸下这一层模糊的开销纯属白付。
      //
      // relative 与 fixed 必须二选一，不能同时挂：Tailwind 把 position
      // 这组工具类按 static → fixed → absolute → relative → sticky 的顺序
      // 输出，relative 排在 fixed 后面，两者同挂时 relative 生效，
      // 全屏层压根不会离开原来的位置——于是「全屏」只是正文变宽，
      // 侧边栏和顶栏照样杵在旁边。
      className={`flex flex-col h-full ${fullscreen ? 'fixed inset-0 z-[60] bg-background' : 'relative'}`}
    >
      {/* 顶部操作栏
          单行两栏：左侧「标题 + 元信息」可压缩可截断，右侧操作区固定宽度不换行。
          早先整栏 flex-wrap，窗口一窄按钮整排掉到第二行、标题行被拉高，
          视觉上就是「挤成一团」。这里改为两栏定宽布局，窗口变窄时
          先牺牲元信息与标题的完整度，控件位置保持稳定。 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-indigo-100/40 dark:border-indigo-900/40 glass shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-semibold truncate">{doc.name}</h2>
            {/* 状态徽章只对可编辑者有意义：访客不可编辑，saved 恒为 true，
                会一直显示「已保存」，反而让人误以为访客的预览内容被存了下来。
                原件也不显示：它没有正文可保存，「已保存」在这里是句空话。 */}
            {canEdit && !isFileDoc &&
              (saved ? (
                <Badge variant="secondary" className="shrink-0 bg-emerald-100/70 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                  <Check className="h-3 w-3 mr-1" /> 已保存
                </Badge>
              ) : (
                <Badge variant="secondary" className="shrink-0 bg-amber-100/70 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                  <Clock className="h-3 w-3 mr-1" /> 编辑中
                </Badge>
              ))}
            <Badge variant="outline" className="shrink-0 border-indigo-200/60 text-indigo-600">
              {/* 原件的大小是文件本身的大小，不是「正文长度」——
                  原件没有正文，拿正文字节数去算会显示成 0 字节。 */}
              {formatBytes(isFileDoc ? doc.size : byteSize)}
            </Badge>
            {/* 原件标识：这个文档本身就是文件，没有 Markdown 正文可编辑。
                摆出来是为了让人一眼知道「这不是写坏了的空白文档」。 */}
            {isFileDoc && (
              <Badge
                variant="outline"
                className="shrink-0 border-amber-200/70 text-amber-700 dark:border-amber-800/70 dark:text-amber-300"
                title="这是原件：文档本身就是这个文件，可预览、可下载，不配备注"
              >
                原件{doc.ext ? ` · ${doc.ext.replace(/^\./, '')}` : ''}
              </Badge>
            )}
            {doc.encrypted && (
              <Badge
                variant="secondary"
                className="shrink-0 bg-indigo-100/70 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                title="该文档以密文保存，需申请访问后方可查看；Agent 无权读取其内容"
              >
                <Lock className="h-3 w-3 mr-1" /> 已加密
              </Badge>
            )}
            {/* 形态标识只给访客看：他们没有形态可选，「只读」这件事需要说明。
                管理员的形态由右下角的切换按钮表达（按钮的语义是动作，
                不是状态），头部再挂一个徽章只会重复，还把「所见即所得」
                这类术语摆在眼前——熟悉的人用不上，生僻的人看不懂 */}
            {!canEdit && (
              <Badge
                variant="outline"
                className="shrink-0 border-indigo-200/70 text-indigo-500/90 dark:border-indigo-800/70 dark:text-indigo-300/90 font-normal"
              >
                <Eye className="h-3 w-3 mr-1" /> 只读预览
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground whitespace-nowrap overflow-hidden">
            <span className="flex shrink-0 items-center gap-1">
              <Clock className="h-3 w-3" />
              更新于 {formatRelativeTime(doc.updatedAt)}
            </span>
            {updatedBy && (
              <span className="flex shrink-0 items-center gap-1">
                <UserIcon className="h-3 w-3" />
                {updatedBy.displayName}
              </span>
            )}
            {createdBy && <span className="shrink-0">创建：{createdBy.displayName}</span>}
          </div>
        </div>

        {/* 右侧原本是文档操作按钮（AI 润色 / 下载 / 目录 / 全屏 / 关闭），
            现在整体下沉为底部居中的悬浮操作坞。这里只留一个视觉占位，
            头部因此只剩「这是什么文档」这一件事要读。 */}
      </div>

      {/* 标签栏：访客仅展示，不可编辑/删除 */}
      {canEdit ? (
        (doc.tags?.length || 0) > 0 ? (
          <div className="flex items-center gap-2 px-4 py-1.5 border-b border-indigo-100/30 dark:border-indigo-900/30 bg-white/30 dark:bg-white/5 shrink-0 flex-wrap">
            <Tag className="h-3.5 w-3.5 text-indigo-500" />
            {doc.tags?.map((t) => (
              <Badge
                key={t}
                variant="secondary"
                className="bg-indigo-100/60 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 hover:bg-indigo-200/80 cursor-pointer"
                onClick={() => canEdit && handleRemoveTag(t)}
              >
                {t}
                {canEdit && <X className="h-3 w-3 ml-1" />}
              </Badge>
            ))}
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTag();
              }}
              placeholder="添加标签..."
              className="h-6 text-xs w-28 bg-white/60 dark:bg-white/5 border-indigo-200/40"
            />
          </div>
        ) : null
      ) : doc.tags && doc.tags.length > 0 ? (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-indigo-100/30 dark:border-indigo-900/30 bg-white/30 dark:bg-white/5 shrink-0 flex-wrap">
          <Tag className="h-3.5 w-3.5 text-indigo-400" />
          {doc.tags.map((t) => (
            <Badge
              key={t}
              variant="secondary"
              className="bg-indigo-100/50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300"
            >
              {t}
            </Badge>
          ))}
        </div>
      ) : null}

      {/* 附件区：默认收起成一行摘要，展开才占地方。
          写文档时顺手挂个设计稿、需求 pdf 是常事，但这些内容平时不该挤占正文，
          所以默认只显示「有几个附件」这个事实，需要时再展开。

          原件不显示这一栏：原件本身就是文件，再给它挂附件是叠罗汉。 */}
      {!locked && !revealing && !isFileDoc && (
        <div className="shrink-0 border-b border-indigo-100/30 dark:border-indigo-900/30 bg-white/20 dark:bg-white/[0.03]">
          <button
            type="button"
            onClick={() => setAttachmentsOpen((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={attachmentsOpen}
          >
            <Paperclip className="h-3.5 w-3.5" />
            <span>附件</span>
            <ChevronDown className={cn('h-3 w-3 transition-transform', attachmentsOpen && 'rotate-180')} />
            {attachmentsOpen && <span className="ml-auto text-[10px]">按格式留档 · 可被检索的内容会进入 AI 引用</span>}
          </button>
          {attachmentsOpen && (
            <div className="px-4 pb-3 pt-1">
              <AttachmentPanel
                docId={doc.id}
                canEdit={canEdit && !doc.encrypted}
                allowedExts={repo?.allowedExts ?? []}
                maxFileSize={repo?.maxFileSize ?? 25 * 1024 * 1024}
              />
            </div>
          )}
        </div>
      )}

      {/* 编辑器主体。
          @container + 容器查询：目录侧栏按「正文可用宽度」决定是否显示，
          而不是按视口宽度。AI 面板并排展开时视口依然很宽、正文区却被压窄，
          用视口断点（md）会让目录硬挤在只剩几百像素的正文旁边。

          目录贴正文区右缘，正文吃掉剩下的全部宽度。
          早先把两者合成一个「阅读外壳」再整体居中（max-w-[72rem] + mx-auto），
          于是在宽屏上外壳两侧空出一大片，目录被推到中间偏右，
          右边还留着窗口余量——目录既不靠边，主体也没能占满。
          现在外壳铺满正文区，正文列 flex-1 吃掉其余宽度，目录作为最后一列贴住右缘。 */}
      <div className="@container flex-1 min-h-0 overflow-hidden">
        <div className="relative flex h-full w-full gap-6">
          <div className="flex min-w-0 flex-1 flex-col">
            {revealing ? (
              /* 管理员免密查看：服务端用主密钥直接解密，浏览器全程拿不到密文。
                 这里只交代在等什么，失败时把原因说清楚。 */
              <DecryptingPanel error={revealError} onRetry={() => setRevealNonce((n) => n + 1)} />
            ) : locked ? (
              /* 加密文档对访客：服务端不存明文，正文区只提供申请入口。 */
              <LockedDocPanel
                doc={doc}
                revoked={accessRevoked}
                onUnlocked={(plain) => {
                  setUnlockedContent(plain);
                  setAccessRevoked(false);
                  setContent(plain);
                  setPreviewText(plain);
                  setSaved(true);
                }}
              />
            ) : isFileDoc ? (
              /* 原件：打开就看到原件本身。
                 不是一篇同名同格式的空笔记——那正是「上传一个 zip 却弹出一个
                 Markdown 编辑器」的由来。文件不需要配备注，
                 它的说明要么在文件里，要么就干脆没有。 */
              <FilePreview doc={doc} canDownload={canDownload} />
            ) : canEdit ? (
              <div className="h-full flex flex-col">
                {/*
                  编辑面。预览面在场时它用 display:none 收起而不是卸载：
                  卸载会让 CodeMirror 实例重建，撤销历史随之清空——
                  读一篇文档再切回来想按 Ctrl+Z 撤销，就发现没东西可撤了。
                */}
                <div
                  className="flex-1 min-h-0 min-w-0 flex flex-col"
                  // 用内联 display 覆盖，而不是给这一栏加 hidden 类：
                  // 它本身是 flex 容器，hidden 与 flex 都是 display 工具类，
                  // 谁生效取决于样式表里的先后顺序——不能拿它当开关用
                  style={{ display: viewMode === 'edit' ? 'flex' : 'none' }}
                >
                  {/*
                    编辑面用的是与预览面同一张卡片：同样的最大宽度、同样的圆角
                    与阴影。两个界面在眼前交替时，卡片的左右边界不动，
                    眼睛不用重新找落点——「编辑与预览是同一篇文档的两种看法」
                    在视觉上也有了同一处落点。

                    源码不再横铺整个正文区：铺满时一行能有几百字符宽，
                    从行首看到行尾要跨过整块屏幕。收在一栏里，
                    行宽才落在眼睛舒服的范围。上限 68rem：目录挪到左侧之后，
                    主体可用宽度本就宽出许多，仍按旧上限卡着，
                    主体看着还是一小块，留白全跑到右边去了。
                  */}
                  <div className="flex-1 min-h-0 flex flex-col p-5 sm:p-8 pb-16">
                    <Card
                      className={[
                        'glass mx-auto w-full flex-1 min-h-0',
                        // 与预览面同一条规则：全屏铺满，平时守住舒适行宽
                        fullscreen ? 'max-w-none' : 'max-w-[68rem]',
                        // Card 自带 py-6 与 gap-6，编辑面要的是零内边距、零间隙：
                        // 内边距由卡片头、工具栏、编辑器各段自己管
                        'p-0 gap-0 overflow-hidden',
                        // 聚焦光晕跟着编辑器走：从编辑器外壳挪到卡片上，
                        'focus-within:ring-2 focus-within:ring-indigo-500/20',
                      ].join(' ')}
                    >
                      {/* 卡片头：标明这一面是什么 */}
                      <div className="flex items-center gap-2 h-10 px-4 shrink-0 border-b border-indigo-100/60 dark:border-indigo-900/50">
                        <Code2 className="h-4 w-4 text-indigo-500/80" />
                        <span className="text-[13px] font-medium text-muted-foreground">Markdown 源码</span>
                      </div>
                      {/*
                        排版工具栏。它只作用于源码，所以必须待在源码这一面里：
                        早先挂在整行通栏的位置，预览上方也拖着一排按钮，
                        看着像「这些命令对正文也生效」——其实点的仍是源码。
                        放在这一面里，它和下面的源码区自然组成一处。

                        按钮放不下时换行，不横向滚动：
                        滚动的代价是「链接」「表格」这类低频按钮被藏起来，
                        用户多半根本不知道它们存在。换成两行只是多占一行高度，
                        换来每个命令都伸手可及。

                        按钮的常亮状态表示「光标正处于该格式」，按下时缩放一下给出即时反馈——
                        排版命令改的是光标处那一行，没有视觉回执的话很容易以为没点上。
                      */}
                      <div className="shrink-0 border-b border-indigo-100/60 dark:border-indigo-900/50 bg-white/40 dark:bg-white/[0.04]">
                        <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1 px-2 py-1.5">
                          {toolbarGroups.map((group, gi) => (
                            <div key={gi} className="flex items-center gap-0.5 shrink-0">
                              {gi > 0 && (
                                <div className="w-px h-5 bg-indigo-200/70 dark:bg-indigo-800/70 mx-1 shrink-0" />
                              )}
                              {group.map((item, i) => (
                                <button
                                  key={i}
                                  onClick={item.action}
                                  // 按下时不让按钮抢走焦点：焦点被抢走的话，
                                  // 正文里的选区会随之消失，命令就不知道该作用在哪一段文字上
                                  onMouseDown={(e) => e.preventDefault()}
                                  title={item.title}
                                  aria-label={item.title}
                                  aria-pressed={item.active || undefined}
                                  disabled={item.disabled}
                                  className={[
                                    'h-7 w-7 rounded-md flex items-center justify-center shrink-0 transition-all duration-100',
                                    'active:scale-90 active:duration-75',
                                    item.active
                                      ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300 shadow-sm'
                                      : 'text-muted-foreground hover:text-indigo-600 hover:bg-white/90 dark:hover:bg-white/10',
                                    'disabled:opacity-35 disabled:pointer-events-none',
                                  ].join(' ')}
                                >
                                  {item.icon}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                      {/*
                        空白文档的起手式。
                        新建文档进来时正文一个字都没有，打开文件不等于开始写。
                        这里给几个结构化的起点，点一下源码栏里就出现了——
                        它们改的是这一面的源码，切到预览面就能看到结果。
                      */}
                      {blankDoc && (
                        <div className="mx-3 mt-3 rounded-xl border border-dashed border-indigo-200/70 dark:border-indigo-800/60 bg-white/60 dark:bg-white/[0.03] px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="text-[11px] text-muted-foreground mr-1">快速开始</span>
                            {QUICK_START_ACTIONS.map((item) => (
                              <button
                                key={item.label}
                                type="button"
                                // mousedown 阻止默认：不让按钮抢走焦点，
                                // 否则编辑器里的选区会丢，插入的块没有落点
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  item.apply(editorRef.current);
                                  editorRef.current?.focus();
                                }}
                                className="flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] text-muted-foreground hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-white/10 transition-colors"
                              >
                                {item.icon}
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="flex-1 min-h-0">
                        <MarkdownEditor
                          ref={editorRef}
                          value={content}
                          onChange={handleSourceChange}
                          resetKey={doc.id}
                          readOnly={!canEdit}
                          dark={resolvedTheme === 'dark'}
                          placeholder={canEdit ? '开始编写 Markdown' : '只读模式'}
                          onHistoryChange={setHistoryState}
                          onContextChange={setEditorCtx}
                        />
                      </div>
                    </Card>
                  </div>
                </div>

                {/*
                  预览面：与访客看到的是同一套排版（renderPreviewPane）。
                  和编辑面一样用 display 切换而非卸载——滚动位置留在原地，
                  读了一半切去改字再切回来，还停在原来那段。
                */}
                {renderPreviewPane(viewMode === 'edit')}
              </div>
            ) : (
              /*
                访客：只有预览面。正文列里放的就是管理员预览面的那一份，
                两个身份看到的排版完全一致。
              */
              renderPreviewPane(false)
            )}
          </div>

        {/* 导航目录侧栏。阈值 56rem：低于此值正文每行不足 40 个汉字，目录纯属负担。

            目录固定在右侧，编辑面与预览面都一样。早先它会跟着视图形态换边——
            可目录占的是同一块地方，换来换去只会让视线在两个界面之间来回跳：
            正文卡片该在哪、目录该在哪，两边保持一致才是同一篇文档的两种看法。 */}
        {/* 全屏时目录列一并让路。
            它平时占的是正文行的右侧一列，全屏下这一列若照旧留着，
            正文铺满的宽度就要减去它——目录不撤，正文就还是差一截，
            成了「正文宽了、目录还杵在旁边」的半吊子样子。
            全屏是沉浸阅读：目录收起，Esc 或操作坞的按钮随时回来。 */}
        {outlineVisible && !fullscreen && (
          <aside className="hidden w-56 shrink-0 @min-[56rem]:block">
            <DocOutline headings={headings} activeIndex={activeHeading} onSelect={scrollToHeading} />
          </aside>
        )}

        {/* 文档操作坞：底部居中的悬浮胶囊。
            这几个操作原先挤在标题行右侧，和标题、元信息、状态标识混成一条线：
            状态文字（预览模式）夹在按钮中间、带文字的「下载」和纯图标按钮参差不齐、
            目录按钮还占了实心靛蓝——整排控件互相抢注意力，读文档时先看到的是按钮，
            不是文档本身。

            下沉到正文下方居中后，它离开阅读视线的正中，且只有一排同尺寸的图标，
            真正要用的「目录 / 下载 / 全屏 / 关闭」伸手即得。

            它现在住在阅读外壳里，居中的基准也随之变成「正文列」而不是整个窗口：
            右侧给目录列留一块等宽的位（见下方占位块），
            左边剩下的空间与正文列完全重合，胶囊因此与正文卡片中心对齐。 */}
        <div
          className={[
            'pointer-events-none absolute inset-x-0 bottom-0 z-30 flex gap-6 pb-3 sm:pb-4',
            'transition-all duration-300 ease-out',
            dockHidden ? 'opacity-0 translate-y-3' : 'opacity-100 translate-y-0',
          ].join(' ')}
        >
          <div
            className={[
              'flex items-center gap-0.5 px-1.5 py-1.5 rounded-2xl border border-indigo-200/60 dark:border-indigo-800/60 bg-white/85 dark:bg-slate-900/85 backdrop-blur-xl shadow-xl shadow-indigo-500/10',
              // mx-auto：把这一排按钮推到「整行减去目录列」之后剩下的空间的正中，
              // 也就是正文列的正中——与正文卡片对齐，而不是与窗口对齐
              'mx-auto',
              dockHidden ? 'pointer-events-none' : 'pointer-events-auto',
            ].join(' ')}
          >
            {/* 不提供「保存」按钮：输入已在 600ms 防抖后自动落盘，
                按钮只会诱使管理员以为防抖失效而反复点击。
                需要立即落盘时用 Ctrl+S，落盘兜底见下方卸载/页面隐藏时的 flush */}
            {canEdit && !isFileDoc && (
              <>
                {/*
                  视图形态切换。两个形态是并列关系而不是一条来回切的路径，
                  所以用分段控件而不是单个按钮——单按钮只能表达「下一个」，
                  用户想直接回到预览就得先切到别的再切回来。

                  原件不摆这一组：原件没有 Markdown 源码可切，
                  它只有「原件本身」这一种看法。给一个永远切不过去的开关，
                  等于骗人。
                */}
                <div
                  role="radiogroup"
                  aria-label="视图形态"
                  className="flex items-center gap-0.5 p-0.5 rounded-xl bg-indigo-50/70 dark:bg-white/5"
                >
                  {(
                    [
                      { id: 'preview', icon: <BookOpen className="h-4 w-4" />, title: '预览（全宽看，不改）' },
                      { id: 'edit', icon: <PenLine className="h-4 w-4" />, title: '编辑（Markdown 源码）' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      role="radio"
                      aria-checked={viewMode === m.id}
                      onClick={() => setViewMode(m.id)}
                      title={m.title}
                      aria-label={m.title}
                      className={[
                        'h-8 w-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-100 active:scale-90',
                        viewMode === m.id
                          ? 'bg-white text-indigo-600 shadow-sm dark:bg-slate-800 dark:text-indigo-300'
                          : 'text-muted-foreground hover:text-indigo-600 hover:bg-white/70 dark:hover:bg-white/10',
                      ].join(' ')}
                    >
                      {m.icon}
                    </button>
                  ))}
                </div>
                <div className="w-px h-5 bg-indigo-200/70 dark:bg-indigo-800/70 mx-1 shrink-0" />
              </>
            )}
            {isAdmin && canEdit && !isFileDoc && (
              <>
                <button
                  onClick={() => setPolishOpen(true)}
                  disabled={!canPolish}
                  title={
                    canPolish
                      ? '用 AI 润色当前文章'
                      : !canUseAgent
                        ? '请先在 Agent 设置中配置 API Key'
                        : '仅支持润色非空的文档正文'
                  }
                  aria-label="AI 润色"
                  className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 text-indigo-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 transition-all duration-100 active:scale-90 disabled:opacity-35 disabled:pointer-events-none"
                >
                  <Sparkles className="h-4 w-4" />
                </button>
                <div className="w-px h-5 bg-indigo-200/70 dark:bg-indigo-800/70 mx-1 shrink-0" />
              </>
            )}
            {/* 目录不再有开关：它常驻在正文右侧，操作坞里也就不必再放一个
                「显示/隐藏目录」按钮——按钮的可点状态会随着它变成常态而失去意义，
                读者只会把它当成一个开关去点，点一下发现什么都没变。 */}
            {/* 下载按钮。
                访客看加密文档而授权只给了「查看」时，按钮保留但置灰：
                直接藏掉会让人以为这个功能不存在，置灰并说清原因才是如实交代。 */}
            {(canDownload || watchingAccess) && (
              <button
                onClick={() => void handleDownload()}
                disabled={!canDownload || locked || revealing}
                title={
                  revealing
                    ? '正在解密，请稍候'
                    : locked
                      ? '文档已加密，解锁后才能下载正文'
                      : !canDownload
                        ? '本次授权仅允许查看，不含下载。需要下载请联系管理员放开下载权限'
                        : isFileDoc
                          ? '下载原件（按原始格式与原文件名）'
                          : '下载当前正文'
                }
                aria-label={isFileDoc ? '下载原件' : '下载当前正文'}
                className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 text-muted-foreground hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-white/10 transition-all duration-100 active:scale-90 disabled:opacity-35 disabled:pointer-events-none"
              >
                <Download className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => setFullscreen((v) => !v)}
              title={fullscreen ? '退出全屏' : '全屏查看'}
              aria-label={fullscreen ? '退出全屏' : '全屏查看'}
              className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 text-muted-foreground hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-white/10 transition-all duration-100 active:scale-90"
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            {/* 关闭会离开当前文档，单独用一条分隔线隔开，
                免得它在密集图标里被顺手点掉 */}
            <div className="w-px h-5 bg-indigo-200/70 dark:bg-indigo-800/70 mx-1 shrink-0" />
            <button
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
              className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 text-muted-foreground hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/15 transition-all duration-100 active:scale-90"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
            {/* 目录列的占位块：宽度与目录列一致。
                有了它，胶囊的居中基准就落在正文列的正中；
                目录没显示时这块也不在，基准随之回到整列。

                这里不再用 -ml-6 抵消 gap：占位块 224px 加上它与按钮组之间的
                gap(24px)，正好等于目录列在正文行里占掉的宽度（224 + 24），
                基准与正文列严格重合。早先用 -ml-6 把 gap 抵掉，右侧实际只占
                224px，胶囊的居中基准就比正文卡片偏右半个 gap（12px）——
                看着像「没对齐」，其实就差这 12px。 */}
            {outlineVisible && !fullscreen && (
              <div className="hidden w-56 shrink-0 @min-[56rem]:block" />
            )}
        </div>
        </div>
      </div>

      {/* 润色改为提交后台任务：弹窗关闭不再中断生成，
          结果与回填统一在 Agent 助手的任务列表中完成 */}
      <PolishDialog
        open={polishOpen}
        onOpenChange={setPolishOpen}
        docId={doc.id}
        content={content}
        docName={doc.name}
        docType={doc.type}
      />
    </div>
  );
}