import { useEffect, useRef } from 'react';
import { ListTree } from 'lucide-react';
import type { DocHeading } from '@/utils';

interface DocOutlineProps {
  headings: DocHeading[];
  /** 当前选中的标题序号，-1 表示未选中 */
  activeIndex: number;
  onSelect: (index: number) => void;
}

/**
 * 文章导航目录，纵向侧栏形态。
 *
 * 纵向而非横向：横向条只能容纳几个标题，长文档会挤成一条必须左右拖动的细带，
 * 而且层级只能靠缩进暗示——纵向的缩进才是读者真正预期的「层级」。
 *
 * 组件自己持有滚动容器（flex-1 + overflow-y-auto），不把滚动交给父级：
 * 这样选中项回到视野时可以只动自己，不会连带滚动 Modal 等祖先节点。
 */
export function DocOutline({ headings, activeIndex, onSelect }: DocOutlineProps) {
  const listRef = useRef<HTMLElement>(null);

  // 选中项滚出可视区时把它带回视野。手动算 scrollTop 而不用 scrollIntoView：
  // 后者会滚动所有可滚动的祖先节点，把正文预览区也一起拽动。
  useEffect(() => {
    const box = listRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    if (!box || !el) return;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTo({ top: Math.max(0, box.scrollTop + delta - 8), behavior: 'smooth' });
  }, [activeIndex]);

  if (headings.length === 0) return null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-3 border-b border-indigo-100/40 dark:border-indigo-900/40 shrink-0 flex items-center gap-1.5">
        <ListTree className="h-3.5 w-3.5 text-indigo-500" />
        <span className="text-xs font-medium text-muted-foreground">目录</span>
        <span className="ml-auto text-[10px] text-muted-foreground/70 tabular-nums">{headings.length}</span>
      </div>
      <nav
        ref={listRef}
        aria-label="文档目录"
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin py-3 pl-3 pr-2 space-y-0.5"
      >
        {headings.map((h, i) => (
          <button
            key={i}
            type="button"
            data-idx={i}
            onClick={() => onSelect(i)}
            title={h.text}
            className={[
              'block w-full text-left text-xs leading-relaxed rounded-md py-1.5 pr-2 truncate transition-colors cursor-pointer',
              i === activeIndex
                ? 'bg-indigo-500/20 text-indigo-700 dark:bg-indigo-400/25 dark:text-indigo-200 font-medium'
                : 'text-muted-foreground hover:bg-indigo-500/10 hover:text-foreground',
              // 深层级略缩字号。但不能只靠缩进——侧栏宽度有限，
              // h4/h5 的缩进已把可用文字宽度压得很窄，再小就读不清了
              h.depth >= 4 ? 'text-[11px]' : '',
            ].join(' ')}
            style={{ paddingLeft: `${10 + (h.depth - 1) * 11}px` }}
          >
            {h.text || '（无标题）'}
          </button>
        ))}
      </nav>
    </div>
  );
}