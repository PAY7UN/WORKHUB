import {
  ADMIN_SECTIONS,
  ADMIN_SECTION_LABELS,
  type AdminSection,
} from '@/types';

interface AdminTopBarProps {
  /** 当前分区 */
  section: AdminSection;
  /** 待审批申请数（访问权限角标） */
  pending: number;
  /** 切到某个分区 */
  onSelect: (section: AdminSection) => void;
}

/**
 * 后台的分区条：六个页面平铺，一条走完。
 *
 * 先前这里是「按区域分两套」的：从顶栏「文档」进来只看见概览与项目仓库，
 * 从「系统」进来换成访问权限、AI Agent、账号安全。同一个后台两副面孔，
 * 加上顶栏的「系统」和右上角的「管理」按钮，一共三处入口指向同一批页面。
 *
 * 现在后台就是一个地方：顶栏点「管理」进来，六个分区都在这儿，
 * 内容区顶部只有这一条，高度固定 44px，切分区时其余部分不动。
 */
export function AdminTopBar({ section, pending, onSelect }: AdminTopBarProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 bg-white/60 px-4 backdrop-blur-sm sm:px-6 dark:bg-slate-950/40">
      <span className="shrink-0 text-sm font-semibold">管理后台</span>

      <nav className="scrollbar-thin flex min-w-0 items-center gap-1 overflow-x-auto">
        {ADMIN_SECTIONS.map((s) => {
          const active = section === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onSelect(s)}
              aria-current={active ? 'page' : undefined}
              className={
                'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12px] transition-colors ' +
                (active
                  ? 'bg-indigo-500/12 font-medium text-indigo-600 dark:text-indigo-300'
                  : 'text-muted-foreground hover:bg-slate-100 hover:text-foreground dark:hover:bg-white/5')
              }
            >
              {ADMIN_SECTION_LABELS[s]}
              {s === 'access' && pending > 0 && (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                  {pending}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
