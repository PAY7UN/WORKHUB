import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
// 引入即注册：marked 的配置与上下标扩展在这里，前端与测试共用同一份
import '../../lib/markedExt';

interface MarkdownPreviewProps {
  source: string;
  className?: string;
  /** 窄容器（Agent 面板等）下启用紧凑排版，见 index.css 的 markdown-body-compact */
  compact?: boolean;
}

/**
 * 给每个 table 套一层可横向滚动的容器。
 *
 * 不能靠给 table 本身加 overflow-x 解决：overflow 只对块级/弹性容器生效，
 * table 是 display: table，声明了也不起作用，窄容器里表现为「内容被裁掉、
 * 也滚不动」。而把 table 改成 display: block 去换取 overflow，会让它退化成
 * 普通块盒、自动布局按比例瓜分宽度——列少时表现尚可，一旦某列是长 URL，
 * 该列会抢走几乎全部宽度，把「客户端 1」这类短列压成逐字竖排（截图里正是如此）。
 *
 * 包一层 div 后，滚动能力交给容器，表格保持 table 语义，
 * 列宽改由内容决定（见 index.css 的 width: max-content），短列不再被挤扁。
 *
 * 放在 sanitize 之后做：DOMParser 重建的是已净化过的 HTML，
 * 不会给攻击面留下绕过净化直接注入节点的机会。
 */
function wrapTables(html: string): string {
  if (!html.includes('<table')) return html;
  const holder = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild;
  if (!holder) return html;
  holder.querySelectorAll('table').forEach((table) => {
    const wrap = holder.ownerDocument.createElement('div');
    wrap.className = 'md-table-scroll scrollbar-thin';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });
  return holder.innerHTML;
}

/**
 * Markdown 预览：只读的渲染层。
 *
 * 这一层只负责「把 Markdown 变成能读的东西」，不负责编辑。
 *
 * 曾经它还兼着所见即所得：正文可改，改完由 turndown 转回 Markdown。
 * 那条路的代价是全部的复杂度——DOM 手术、选区捕获与恢复、浏览器默认行为
 * 的逐条纠正，以及「渲染出来的 HTML 和转回去的 Markdown 不完全等价」这
 * 类永远补不完的边角。写作交给 CodeMirror 之后，这些补丁一个都不再需要，
 * 预览层退回它本来的样子：一个纯粹的渲染器。
 *
 * 它也曾给每个块标注源码行号、供双击跳回源码。那套标注是为「并排编辑」
 * 服务的：两栏同屏时才需要知道屏幕上这段对应源码第几行。现在编辑与预览
 * 各自独立成面，不存在「从预览跳到源码」这条路径，行号标注与双击一并
 * 去掉——留着只是白付一遍 DOM 遍历的代价。
 */
export function MarkdownPreview({ source, className, compact }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    const raw = marked.parse(source || '', { async: false }) as string;
    const safe = DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target'],
    });
    return wrapTables(safe);
  }, [source]);

  return (
    <div
      className={`markdown-body ${compact ? 'markdown-body-compact' : ''} ${className ?? ''}`}
      spellCheck={false}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
