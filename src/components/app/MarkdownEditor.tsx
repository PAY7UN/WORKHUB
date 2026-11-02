/**
 * CodeMirror 6 封装的 Markdown 源码编辑器。
 *
 * 为什么换掉 @uiw/react-md-editor：
 * 该库把 textarea 做成了完全受控组件（value 取自内部 reducer 的 markdown），
 * 并在 Editor.factory.js 里以 `propsValue !== state.markdown` 为条件反复 dispatch。
 * 于是每次按键都会「父组件 setState → propsValue 变化 → 回灌 dispatch → 重置 textarea.value」，
 * 中文输入法正处于组字状态时被打断，表现为候选框闪烁、跳字、连不上句。
 *
 * 这里的同步策略与之相反：CodeMirror 是自己的状态源，React 的 value 仅在
 * 「与 CM 内部文档确实不同」时才通过 transaction 写入（见 syncFromProps 的注释）。
 * 用户输入时两者本就相等，该分支不会进入，因此输入法不再被打断。
 */
import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  rectangularSelection,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands';
import {
  HighlightStyle,
  LanguageDescription,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { diffRange } from '../../lib/textDiff';

/**
 * 「这次改动是外部灌进来的」标记。
 *
 * 外部同步（AI 润色结果、正文改动回写源码）如果再走一遍 onChange，
 * 就会把「用户在正文里刚敲的字还没转成 Markdown」的那次延迟落库取消掉——
 * 用户会发现自己在正文里打的字凭空消失。带上这个标记就能把外部同步
 * 与用户输入区分开。
 */
const externalSync = Annotation.define<boolean>();

/**
 * 围栏代码块按语言分配高亮。
 *
 * 手写清单而非 @codemirror/language-data：后者会把全部语言的数据打进产物，
 * 而实际用得上的就这十来个。
 *
 * load 必须返回 Promise——@codemirror/language 6.10 起该签名收紧了，
 * 直接返回 LanguageSupport 编译不过，故统一用 async 包一层。
 */
const CODE_LANGUAGES = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'jsx', 'mjs', 'cjs', 'node'],
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    load: async () => javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'typescript',
    alias: ['ts', 'tsx'],
    extensions: ['ts', 'tsx'],
    load: async () => javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({ name: 'python', alias: ['py'], extensions: ['py'], load: async () => python() }),
  LanguageDescription.of({ name: 'html', alias: ['htm'], extensions: ['html', 'htm'], load: async () => html() }),
  LanguageDescription.of({ name: 'css', alias: ['scss', 'less'], extensions: ['css'], load: async () => css() }),
  LanguageDescription.of({ name: 'json', alias: ['jsonc'], extensions: ['json'], load: async () => json() }),
  LanguageDescription.of({ name: 'sql', alias: ['mysql', 'sqlite'], extensions: ['sql'], load: async () => sql() }),
  LanguageDescription.of({ name: 'java', alias: [], extensions: ['java'], load: async () => java() }),
  LanguageDescription.of({
    name: 'cpp',
    alias: ['c', 'cc', 'c++', 'h', 'hpp'],
    extensions: ['c', 'cpp', 'cc', 'h', 'hpp'],
    load: async () => cpp(),
  }),
  LanguageDescription.of({ name: 'rust', alias: ['rs'], extensions: ['rs'], load: async () => rust() }),
];

/** 浅色高亮：以 indigo 为主色，压低标点与分隔线的视觉权重，避免正文显得花 */
const lightHighlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: '#4338ca', fontWeight: '700', fontSize: '1.08em' },
  { tag: t.strong, color: '#1e1b4b', fontWeight: '700' },
  { tag: t.emphasis, color: '#3730a3', fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', opacity: '0.65' },
  { tag: t.link, color: '#4f46e5', textDecoration: 'underline' },
  { tag: t.url, color: '#6366f1' },
  { tag: t.monospace, color: '#be123c', backgroundColor: 'rgba(99,102,241,0.09)' },
  { tag: [t.quote, t.quote], color: '#6b7280', fontStyle: 'italic' },
  { tag: t.list, color: '#4f46e5' },
  { tag: t.contentSeparator, color: '#94a3b8', fontWeight: '700' },
  { tag: [t.processingInstruction, t.meta], color: '#a855f7' },
  { tag: t.keyword, color: '#7c3aed' },
  { tag: [t.string, t.special(t.string)], color: '#047857' },
  { tag: [t.number, t.bool, t.null], color: '#c2410c' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#94a3b8', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#1d4ed8' },
  { tag: [t.typeName, t.className], color: '#0e7490' },
  { tag: t.propertyName, color: '#b45309' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: '#64748b' },
  { tag: t.tagName, color: '#be123c' },
  { tag: t.attributeName, color: '#b45309' },
  { tag: t.invalid, color: '#dc2626' },
]);

const darkHighlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: '#a5b4fc', fontWeight: '700', fontSize: '1.08em' },
  { tag: t.strong, color: '#e0e7ff', fontWeight: '700' },
  { tag: t.emphasis, color: '#c7d2fe', fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', opacity: '0.7' },
  { tag: t.link, color: '#93c5fd', textDecoration: 'underline' },
  { tag: t.url, color: '#818cf8' },
  { tag: t.monospace, color: '#fda4af', backgroundColor: 'rgba(129,140,248,0.16)' },
  { tag: [t.quote, t.quote], color: '#94a3b8', fontStyle: 'italic' },
  { tag: t.list, color: '#a5b4fc' },
  { tag: t.contentSeparator, color: '#64748b', fontWeight: '700' },
  { tag: [t.processingInstruction, t.meta], color: '#d8b4fe' },
  { tag: t.keyword, color: '#c4b5fd' },
  { tag: [t.string, t.special(t.string)], color: '#6ee7b7' },
  { tag: [t.number, t.bool, t.null], color: '#fdba74' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#64748b', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#93c5fd' },
  { tag: [t.typeName, t.className], color: '#67e8f9' },
  { tag: t.propertyName, color: '#fcd34d' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: '#94a3b8' },
  { tag: t.tagName, color: '#fda4af' },
  { tag: t.attributeName, color: '#fcd34d' },
  { tag: t.invalid, color: '#f87171' },
]);

/** 布局与配色一律引用项目 CSS 变量，深浅色由 .dark 作用域内的变量切换决定 */
const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    height: '100%',
    fontSize: '14px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    // 中文正文落在等宽字体上字距偏紧，略微放开可读性明显更好；
    // 末位补 Microsoft YaHei，避免中文落到系统默认衬线体
    fontFamily:
      "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Microsoft YaHei', monospace",
    // 1.65 而不是更松的值：源码是逐行扫的，行距一大，视线就在行与行之间
    // 多走一段冤枉路；又不能太紧，紧了中文字符上下会挤在一起
    lineHeight: '1.65',
    letterSpacing: '0.01em',
    overflow: 'auto',
  },
  // 底部留白：让最后一行能滚到视区中部附近，而不是紧贴卡片下边缘。
  // 固定值而非 vh——编辑器在卡片里是固定高度，vh 会随窗口高度忽大忽小
  '.cm-content': { padding: '10px 0 96px', caretColor: '#6366f1' },
  '.cm-line': { padding: '0 14px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--muted-foreground)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted-foreground)' },
  '.cm-activeLine': { backgroundColor: 'rgba(99,102,241,0.06)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#6366f1', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(99,102,241,0.22)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(99,102,241,0.2)',
    outline: 'none',
  },
  /* 只保留 .cm-panels 容器本身：.cm-tooltip 是它的子元素，容器样式仍被 tooltip 依赖。
     搜索面板专用的输入框/按钮样式已随查找替换一起移除。 */
  '.cm-panels': { backgroundColor: 'var(--card)', border: 'none', color: 'var(--foreground)' },
  '.cm-tooltip': { backgroundColor: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgba(99,102,241,0.2)' },
  '.cm-placeholder': { color: 'var(--muted-foreground)', fontStyle: 'normal' },
});

export interface MarkdownEditorHandle {
  /** 包裹选区；无选区时插入占位文案并选中它 */
  wrapSelection: (before: string, after: string, placeholder: string) => void;
  /** 在当前行加/去行首标记（同名标记已存在时视为取消） */
  linePrefix: (prefix: string) => void;
  /**
   * 切换列表类型。kind 决定目标形态，而不是按现状循环：
   * 点「无序列表」就一定得到无序列表，已经是同类则取消。
   */
  toggleList: (kind: ListKind) => void;
  /** 在选区处插入块级内容 */
  insertBlock: (block: string) => void;
  undo: () => void;
  redo: () => void;
  focus: () => void;
  /**
   * 把光标定位到指定源码行并整行选中。
   *
   * 编辑态点目录跳章节用它。选整行而不是只放光标：
   * 整行选中后接着打字会替换该行内容，正是「改这一段」的直觉。
   */
  gotoLine: (line: number) => void;
  /** 容器尺寸变化后让编辑器重新测量（视图从隐藏切回时需要） */
  refresh: () => void;
}

/**
 * 光标所在处的 Markdown 结构。
 *
 * 工具栏要能回答「这一行现在是什么格式」——按钮常亮才知道自己处于哪种状态，
 * 也才知道再点一次会发生什么。不给这个信息，工具栏就只是一排盲目的快捷键。
 */
export interface EditorContext {
  /** 标题级别 1~6；0 表示当前行不是标题 */
  heading: number;
  /** 列表类型 */
  list: 'none' | 'bullet' | 'ordered' | 'task';
  /** 是否在引用块内 */
  quote: boolean;
  /** 是否有非空选区 */
  hasSelection: boolean;
  /** 选区已被哪些行内标记包裹（仅选区非空时有意义） */
  inline: {
    bold: boolean;
    italic: boolean;
    strike: boolean;
    sup: boolean;
    sub: boolean;
  };
}

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  dark: boolean;
  placeholder?: string;
  /**
   * 变化时重建编辑器实例。
   *
   * 切换文档必须走这条路而不是靠外部同步：CodeMirror 的 undo 栈记录的是
   * 「相对当前文档的变更」，换文档后旧栈仍在，按 Ctrl+Z 会把上一篇文章的内容
   * 撤销回当前文档。重建实例才能让历史与文档对齐。
   */
  resetKey?: string;
  /** 撤销/重做可用状态变化时回调，供工具栏置灰 */
  onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
  /** 光标处格式变化时回调，供工具栏高亮当前所处的格式 */
  onContextChange?: (ctx: EditorContext) => void;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { value, onChange, readOnly = false, dark, placeholder, resetKey, onHistoryChange, onContextChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment()).current;
  const readOnlyCompartment = useRef(new Compartment()).current;
  // 视图尚未建好时收到的定位请求：实例就绪后补做，否则这次点击会悄无声息地丢掉
  const pendingGotoRef = useRef<number | null>(null);

  // 命令式 API 与各类回调都只注册一次，必须通过 ref 读最新值，否则会捕获首帧闭包
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  const historyRef = useRef(onHistoryChange);
  const contextRef = useRef(onContextChange);

  useEffect(() => {
    onChangeRef.current = onChange;
    readOnlyRef.current = readOnly;
    historyRef.current = onHistoryChange;
    contextRef.current = onContextChange;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 重建时清空 host，避免上一个实例的 DOM 残留
    host.replaceChildren();

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          EditorState.allowMultipleSelections.of(true),
          EditorView.lineWrapping,
          placeholder ? cmPlaceholder(placeholder) : [],
          markdown({ codeLanguages: CODE_LANGUAGES, addKeymap: true }),
          keymap.of([
            // 显式绑定 Mod-z：默认键位里 redo 是 Mod-y，与 macOS 的 Shift 习惯不一致，
            // 两种都收下，避免不同平台表现分裂
            { key: 'Mod-z', run: undo, preventDefault: true },
            { key: 'Mod-y', run: redo, preventDefault: true },
            { key: 'Mod-Shift-z', run: redo, preventDefault: true },
            // 行内样式走与工具栏相同的实现：markdownKeymap 自带的 Mod-b/i
            // 选中区形态不同（它保留含标记的整段选区），会与工具栏的状态灯脱节
            {
              key: 'Mod-b',
              run: (view) => wrapSelectionIn(view, '**', '**', '粗体文本'),
              preventDefault: true,
            },
            {
              key: 'Mod-i',
              run: (view) => wrapSelectionIn(view, '*', '*', '斜体文本'),
              preventDefault: true,
            },
            {
              key: 'Mod-`',
              run: (view) => wrapSelectionIn(view, '`', '`', 'code'),
              preventDefault: true,
            },
            ...markdownKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          syntaxHighlighting(dark ? darkHighlight : lightHighlight),
          editorTheme,
          EditorView.editorAttributes.of({ 'aria-label': 'Markdown 编辑器' }),
          readOnlyCompartment.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            // 外部同步不算「用户改了内容」：它已经是最终形态，
            // 再回调一次只会让上层把同一份内容重写一遍
            const fromExternal = update.transactions.some((tr) => tr.annotation(externalSync) === true);
            if (update.docChanged && !fromExternal) onChangeRef.current(update.state.doc.toString());
            // 撤销栈深度没有对应的 update 标志位，每次 update 读一次即可：
            // undoDepth/redoDepth 只是读 state field，O(1)，不值得为它做节流
            historyRef.current?.({
              canUndo: undoDepth(update.state) > 0,
              canRedo: redoDepth(update.state) > 0,
            });
            // 光标移动或正文改动都可能让「当前处于什么格式」发生变化。
            // 只在这两种情况下重算，其余 update（仅选区标记变化等）不必打扰工具栏。
            if (update.selectionSet || update.docChanged) {
              contextRef.current?.(parseContext(update.state));
            }
          }),
        ],
      }),
    });

    viewRef.current = view;
    // 实例刚建好就收到过定位请求：现在补做，否则那次点击等于没发生
    if (pendingGotoRef.current !== null) {
      gotoLineIn(view, pendingGotoRef.current);
      pendingGotoRef.current = null;
    }
    historyRef.current?.({ canUndo: false, canRedo: false });
    contextRef.current?.(parseContext(view.state));
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // 文档内容、主题、只读态各有自己的同步通道，重建会连带丢弃 undo 历史与
    // 滚动位置，因此仅在宿主挂载与 resetKey（切文档）变化时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  /**
   * 外部值 → 编辑器。
   *
   * 「不乱跳」的关键就在这一处。用户每次输入时，CodeMirror 内部文档已经等于
   * React 侧收到的 value，两者相等直接返回，编辑器状态零改动；只有应用润色
   * 结果这类真正的外部覆盖才会写一次 transaction。
   *
   * 反例是被替换掉的实现：那里按 props 变化无条件回灌 textarea.value，
   * 恰好打断了输入法正在进行的组字。
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === value) return;
    // 只替换真正变了的那一段：整篇覆盖会把光标、选区一起抹掉，
    // 而外部改动往往只动了几行（比如在正文里改字后同步回源码）
    const { from, to, insert } = diffRange(cur, value);
    const whole = from === 0 && to === cur.length;
    view.dispatch({
      changes: { from, to, insert },
      // 整篇被替换后，原光标位置失去意义，移到末尾符合直觉；
      // 局部替换则让 CodeMirror 自己把光标映射过去，不打断正在输入的人
      ...(whole ? { selection: { anchor: value.length } } : {}),
      // 不进 undo 栈：润色结果是外部灌进来的，Ctrl+Z 应能把它整体撤掉，
      // 而不是撤到这一步之前、得到一份「润色前 + 上一次局部编辑」的混合内容
      annotations: [Transaction.addToHistory.of(false), externalSync.of(true)],
      scrollIntoView: false,
    });
  }, [value]);

  // 主题切换：只重配高亮样式而非重建实例，undo 历史与滚动位置都得以保留
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(syntaxHighlighting(dark ? darkHighlight : lightHighlight)),
    });
  }, [dark, themeCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly, readOnlyCompartment]);

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => {
      /** 只读态下所有写操作直接退出，避免误改后又立刻被外部值同步覆盖掉 */
      const writable = (view: EditorView) => view && !readOnlyRef.current ? view : null;

      return {
        wrapSelection: (before, after, ph) => {
          const view = writable(viewRef.current!);
          if (!view) return;
          wrapSelectionIn(view, before, after, ph);
        },

        linePrefix: (prefix) => {
          const view = writable(viewRef.current!);
          if (!view) return;
          const { from, to } = view.state.selection.main;
          const first = view.state.doc.lineAt(from);
          const last = view.state.doc.lineAt(to);
          const isHeading = prefix.startsWith('#');
          const lines: string[] = [];
          for (let n = first.number; n <= last.number; n++) {
            const text = view.state.doc.line(n).text;
            const indent = /^[ \t]*/.exec(text)![0];
            const body = text.slice(indent.length);
            if (isHeading) {
              // 标题是「设为某一级」：先剥掉既有 ATX 标记再写入，
              // 否则点 H1 会得到 "## " 前面再叠一个 "#"
              lines.push(indent + prefix + body.replace(/^#{1,6}\s+/, ''));
            } else {
              // 引用等按「有则去、无则加」切换，剥标记时连同一个空格一起去掉
              const quoted = /^>[ \t]?/.exec(body);
              lines.push(quoted ? indent + body.slice(quoted[0].length) : indent + prefix + body);
            }
          }
          const next = lines.join('\n');
          // 保持光标相对首行的位置：整段替换会让默认映射失效，
          // 不显式指定的话光标会被甩到末尾，多行改标题时尤其明显
          const oldMark = first.text.match(/^([ \t]*)(?:[-*+][ \t]|\d+[.)][ \t])/);
          const newMark = /^[ \t]*/.exec(lines[0])![0] + (isHeading ? prefix : '');
          const delta = newMark.length - (oldMark ? oldMark[0].length : 0);
          view.dispatch({
            changes: { from: first.from, to: last.to, insert: next },
            selection: { anchor: first.from + Math.max(0, from - first.from + delta) },
          });
          view.focus();
        },

        toggleList: (kind) => {
          const view = writable(viewRef.current!);
          if (!view) return;
          const { from, to } = view.state.selection.main;
          const first = view.state.doc.lineAt(from);
          const last = view.state.doc.lineAt(to);
          const nextText = rewriteListMarkup(view.state, first.from, last.to, kind);
          view.dispatch({ changes: { from: first.from, to: last.to, insert: nextText } });
          view.focus();
        },

        insertBlock: (block) => {
          const view = writable(viewRef.current!);
          if (!view) return;
          const { from, to } = view.state.selection.main;
          view.dispatch({ changes: { from, to, insert: block }, scrollIntoView: true });
          view.focus();
        },

        undo: () => {
          const view = writable(viewRef.current!);
          if (view) undo(view);
        },
        redo: () => {
          const view = writable(viewRef.current!);
          if (view) redo(view);
        },
        focus: () => viewRef.current?.focus(),
        gotoLine: (line: number) => {
          const view = viewRef.current;
          if (!view) {
            // 视图还没建好（刚切到编辑态）：先记着，实例就绪后补做
            pendingGotoRef.current = line;
            return;
          }
          gotoLineIn(view, line);
        },
        refresh: () => {
          // 源码栏从 display:none 恢复时，编辑器仍按旧尺寸布局；
          // 不让它重新测量，滚动定位就会算到错误的位置上
          viewRef.current?.requestMeasure();
        },
      };
    },
    [],
  );

  return <div ref={hostRef} className="h-full overflow-hidden [&_.cm-editor]:h-full" />;
});

/* ---------- 模块级辅助 ---------- */

/**
 * 把光标定位到指定源码行并整行选中。
 *
 * 行号可能被预览侧的防抖甩开几行，故做区间钳制：越界时落到首行或末行，
 * 而不是让 CodeMirror 抛错。
 */
function gotoLineIn(view: EditorView, line: number): void {
  const n = Math.max(1, Math.min(Math.round(line), view.state.doc.lines));
  const l = view.state.doc.line(n);
  view.dispatch({
    selection: { anchor: l.from, head: l.to },
    scrollIntoView: true,
  });
  view.focus();
}

/** 匹配任意形式的列表标记（含任务列表的 [x]），保留其后的缩进 */
const LIST_MARKUP = /^(\s*)(?:[-*+]\s(?:\[[ xX]\]\s)?|\d+[.)]\s)/;

/**
 * 读出光标所在行的 Markdown 结构。
 *
 * 引用块里的列表仍是列表，所以先剥掉 `>` 前缀再判列表；
 * 否则 `> - 项目` 会被判成「普通引用」，列表按钮该亮时就不亮。
 *
 * 只看光标所在的那一行，不做多行统计：多行混合排版时「当前格式」本就
 * 没有唯一答案，工具栏亮一个最贴近光标位置的形态即可。
 */
function parseContext(state: EditorState): EditorContext {
  const sel = state.selection.main;
  const raw = state.doc.lineAt(sel.from).text;
  const quote = /^\s*>/.test(raw);
  // 剥掉引用标记（可能多层）与缩进，得到这一行的「本体」
  const body = raw.replace(/^(\s*>\s?)+/, '').replace(/^\s+/, '');

  const headingMatch = /^(#{1,6})\s/.exec(body);
  const listMatch = /^(?:[-*+]\s(?:\[[ xX]\]\s)?|\d+[.)]\s)/.exec(body);

  let list: EditorContext['list'] = 'none';
  if (listMatch) {
    if (/^\d+[.)]\s/.test(listMatch[0])) list = 'ordered';
    else if (/^\[[ xX]\]\s/.test(listMatch[0].slice(2))) list = 'task';
    else list = 'bullet';
  }

  return {
    heading: headingMatch ? headingMatch[1].length : 0,
    list,
    quote,
    hasSelection: sel.to > sel.from,
    inline: sel.to > sel.from ? detectInline(state, sel) : EMPTY_INLINE,
  };
}

/** 无选区时的行内状态：什么都不亮 */
const EMPTY_INLINE: EditorContext['inline'] = {
  bold: false,
  italic: false,
  strike: false,
  sup: false,
  sub: false,
};

/**
 * 给选区套上（或脱下）一层行内标记。
 *
 * 工具栏按钮与 Ctrl+B / Ctrl+I / Ctrl+` 走的是同一个函数：
 * 两处各写一套的话，快捷键裹出来的标记与按钮裹出来的形态就会不同，
 * 而工具栏的状态灯是按「标记长什么样」判断的——行为分叉时灯就会说谎。
 *
 * 已经是这层标记 → 解开。只加不撤的话，第二次点击会得到 ****文字****
 * 这种嵌套标记，预览里渲染成加粗里还套着加粗，删起来还得手工收拾。
 */
function wrapSelectionIn(view: EditorView, before: string, after: string, placeholder: string): boolean {
  const { from, to } = view.state.selection.main;
  const text = view.state.doc.sliceString(from, to);
  const sel = { from, to };

  if (isWrappedBy(view.state, sel, before)) {
    const line = view.state.doc.lineAt(from);
    const startInLine = from - line.from;
    const endInLine = to - line.from;
    const lineText = line.text;
    const left = lineText.slice(Math.max(0, startInLine - before.length), startInLine);
    const right = lineText.slice(endInLine, endInLine + after.length);
    // 标记在选区之外（点过按钮后选区收缩到了文字内部）
    const outside = left === before && right === after;

    if (outside) {
      view.dispatch({
        changes: [
          { from: from - before.length, to: from, insert: '' },
          { from: to, to: to + after.length, insert: '' },
        ],
        selection: { anchor: from - before.length, head: to - before.length },
        scrollIntoView: true,
      });
    } else {
      const inner = text.slice(before.length, text.length - after.length);
      view.dispatch({
        changes: { from, to, insert: inner },
        selection: { anchor: from, head: from + inner.length },
        scrollIntoView: true,
      });
    }
    view.focus();
    return true;
  }

  const selected = text || placeholder;
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/**
 * 判断选区是否被给定标记包裹。
 *
 * 两种位置都要认：
 * 1. 标记在选区内部（用户用鼠标把 `**文字**` 整体选中）；
 * 2. 标记紧贴选区两侧——点「加粗」后选区会收缩到文字内部（与 VSCode 一致，
 *    继续输入才会替换文字而不是标记），此时标记在选区外。
 * 只认第 1 种的话，按完加粗按钮反而灭掉，等于状态在骗人；
 * 而「按钮显示的格式」与「点击后实际发生的事」必须用同一套判定，
 * 否则会出现按钮亮着、点下去却是叠加的状态与行为不一致。
 */
function isWrappedBy(state: EditorState, sel: { from: number; to: number }, mark: string): boolean {
  const text = state.doc.sliceString(sel.from, sel.to);
  if (text.length > mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) return true;

  const line = state.doc.lineAt(sel.from);
  const startInLine = sel.from - line.from;
  const endInLine = sel.to - line.from;
  const lineText = line.text;
  // 左右各取两字符：够容纳最长的标记 ~~，也够用来区分 *斜体* 与 **粗体**
  const left = lineText.slice(Math.max(0, startInLine - 2), startInLine);
  const right = lineText.slice(endInLine, endInLine + 2);
  if (!left.endsWith(mark) || !right.startsWith(mark)) return false;

  // 单字符标记要排除双字符标记的情形：*斜体* 两侧是单星，**粗体** 两侧是双星
  if (mark.length === 1) {
    const doubled = mark + mark;
    if (left.endsWith(doubled) && right.startsWith(doubled)) return false;
  }
  return true;
}

/** 读出选区上的行内标记状态 */
function detectInline(state: EditorState, sel: { from: number; to: number }): EditorContext['inline'] {
  const bold = isWrappedBy(state, sel, '**') || isWrappedBy(state, sel, '__');
  return {
    bold,
    italic: !bold && (isWrappedBy(state, sel, '*') || isWrappedBy(state, sel, '_')),
    strike: isWrappedBy(state, sel, '~~'),
    sup: isWrappedBy(state, sel, '^'),
    sub: isWrappedBy(state, sel, '~'),
  };
}

/** 列表类型。名称与工具栏按钮一一对应，不再用「按现状循环」的形态推演 */
type ListKind = 'bullet' | 'ordered' | 'task';

/** 各类型的标记前缀；ordered 的编号由 rewriteListMarkup 按行号填充 */
const LIST_PREFIX: Record<ListKind, string> = {
  bullet: '- ',
  ordered: '1. ',
  task: '- [ ] ',
};

/** 判断某行是否已处于指定类型的列表中 */
function isListOfKind(text: string, kind: ListKind): boolean {
  const m = text.match(LIST_MARKUP);
  if (!m) return false;
  const markup = m[0].slice(m[1].length);
  switch (kind) {
    case 'ordered':
      return /^\d+[.)]\s/.test(markup);
    case 'task':
      return /^[-*+]\s\[[ xX]\]\s/.test(markup);
    case 'bullet':
      // 任务列表是「带 checkbox 的无序列表」，但归 task 所有，否则点无序列表
      // 会把已完成/未完成状态悄悄抹掉
      return /^[-*+]\s$/.test(markup);
  }
}

/**
 * 把 [from, to] 范围内每一行的列表标记改成 kind 指定类型。
 *
 * 语义是「切到这一种」而非「沿着四种形态轮转」：工具栏上无序/有序/任务是三个
 * 独立按钮，点「无序列表」必须得到无序列表；若整段已经是该类型则整体取消。
 *
 * 逐行处理而非整段 replace：多行选区若一次性替换，行内出现的 "- " 也会被改掉。
 * 空行不加标记，否则会插入空列表项。
 */
function rewriteListMarkup(state: EditorState, from: number, to: number, kind: ListKind): string {
  const doc = state.doc;
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  // 整段都已是目标类型 → 视为取消。逐行判断会在混合选区里留下半转半不转的结果。
  const allAreKind = () => {
    let meaningful = 0;
    for (let i = first.number; i <= last.number; i++) {
      const text = doc.line(i).text;
      // 空行是松散列表的一部分，不参与判定；否则列表中间隔一个空行，
      // 取消功能就永远触发不了
      if (!text.trim()) continue;
      meaningful++;
      if (!isListOfKind(text, kind)) return false;
    }
    return meaningful > 0;
  };
  const cancel = allAreKind();
  const lines: string[] = [];
  let ordinal = 1;
  for (let n = first.number; n <= last.number; n++) {
    const line = doc.line(n);
    // 空行不加标记，否则会插入空列表项、把段落撑成一个空 bullet
    if (!line.text.trim()) {
      lines.push(line.text);
      continue;
    }
    // 缩进独立于列表标记：无标记的普通行也要能加上列表，
    // 因此不能像旧实现那样「匹配不到标记就原样返回」——那会让按钮对纯文本完全失效
    const indent = /^[ \t]*/.exec(line.text)![0];
    const m = line.text.match(LIST_MARKUP);
    if (cancel) {
      // 取消列表只摘标记，保留正文与缩进层级
      lines.push(m ? indent + line.text.slice(m[0].length) : line.text);
      continue;
    }
    const body = m ? line.text.slice(m[0].length) : line.text.slice(indent.length);
    // 有序列表按实际行序重新编号，否则从 3. 跳到 5. 会很难看
    const prefix = kind === 'ordered' ? `${ordinal++}. ` : LIST_PREFIX[kind];
    lines.push(indent + prefix + body);
  }
  return lines.join('\n');
}