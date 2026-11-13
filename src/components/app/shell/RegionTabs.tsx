import { REGION_LABELS, type AppRegion } from '@/types';

interface RegionTabsProps {
  /** 当前所在的地方 */
  active: AppRegion;
  /** 切到某个地方 */
  onSelect: (region: AppRegion) => void;
  /**
   * 访客看不到「管理」。
   *
   * 后台讲的是「谁能看、账号怎么管」——那是管理员的事。
   * 给访客摆一个点进去就撞墙的 tab，不如不摆。
   */
  showAdmin?: boolean;
  /** 待审批申请数（「管理」上的角标） */
  pending?: number;
}

/**
 * 顶栏的区域切换：**文档 / 工具 / 管理**。
 *
 * 全站只有这一排，页面不再各自造导航。
 *
 * 它是「去哪儿」，不是「这页叫什么」：
 * - 文档：工作台，看资料
 * - 工具：外部数据怎么进来（独立路由 /tools，对所有登录用户开放）
 * - 管理：后台，五个分区平铺（概览、项目仓库、访问权限、AI Agent、账号安全）
 *
 * 后台不再按「文档/系统」拆成两半——拆开之后同一个后台有两副面孔，
 * 顶栏的「系统」、右上角的「管理」按钮、后台里那排二级 tab，
 * 三处都在做同一件事，用户自然觉得「有两套逻辑」。现在只剩这一排。
 */
export function RegionTabs({
  active,
  onSelect,
  showAdmin = true,
  pending = 0,
}: RegionTabsProps) {
  const regions: AppRegion[] = showAdmin ? ['doc', 'tool', 'admin'] : ['doc', 'tool'];

  return (
    <nav
      className="scrollbar-thin flex shrink-0 items-stretch self-stretch overflow-x-auto"
      aria-label="区域切换"
    >
      {regions.map((r) => {
        const isActive = active === r;
        return (
          <button
            key={r}
            type="button"
            onClick={() => onSelect(r)}
            aria-current={isActive ? 'page' : undefined}
            className={
              'relative flex shrink-0 items-center gap-1.5 px-3 text-sm font-medium transition-colors ' +
              (isActive
                ? 'text-indigo-600 dark:text-indigo-300'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {REGION_LABELS[r]}
            {/* 待审批数挂在「管理」上：这是唯一一个「有活儿等着」的入口 */}
            {r === 'admin' && pending > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] leading-none font-medium text-white">
                {pending}
              </span>
            )}
            {isActive && (
              <span className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-indigo-500" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
