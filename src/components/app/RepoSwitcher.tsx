import { Boxes, Plus } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { cn } from '@/lib/utils';

/**
 * 侧边栏的仓库导航。
 *
 * 原来是一个需要点开才能看到选项的下拉框：切换要两次点击，
 * 而且展开前根本不知道有几个仓库、每个仓库里放着多少东西。
 * 现在改成常驻列表——一眼看清有哪些仓库、规模多大，点一下就切。
 *
 * 选中某个仓库后，下面的文件树只显示它的资料，
 * 右边 AI 助手也会默认把检索范围收在这一块。
 *
 * 这里没有「全部项目」：每个文档都必须属于某个仓库，
 * 混在一起看既分不清来源，也说不清一份资料适用哪些规则。
 */
export function RepoSwitcher() {
  const { repos, repoStats, currentRepoId, setCurrentRepoId, currentRepo, isAdmin, openAdminConsole } =
    useApp();

  const statOf = (repoId: string) => repoStats.find((s) => s.repoId === repoId);

  const rowClass = (active: boolean) =>
    cn(
      'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
      active
        ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200'
        : 'text-slate-600 hover:bg-slate-100/70 dark:text-slate-300 dark:hover:bg-white/5',
    );

  return (
    <div className="border-b border-indigo-100/40 px-2 py-2 dark:border-indigo-900/40">
      <div className="mb-1 flex items-center justify-between px-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">仓库</span>
        {isAdmin && (
          <button
            type="button"
            onClick={() => openAdminConsole('repos')}
            title="管理仓库（新建、规则、统计）"
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-indigo-100 hover:text-indigo-600 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-300"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="space-y-0.5">
        {repos.map((r) => {
          const active = currentRepoId === r.id;
          const count = statOf(r.id)?.docCount ?? 0;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setCurrentRepoId(r.id)}
              className={rowClass(active)}
              title={`只看「${r.name}」里的资料`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: r.color }}
              />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              {!r.ragEnabled && (
                <span className="shrink-0 text-[10px] text-muted-foreground">不检索</span>
              )}
              <span className="shrink-0 text-[10px] text-muted-foreground">{count}</span>
            </button>
          );
        })}

        {repos.length === 0 && (
          <div className="px-1.5 py-1 text-[10px] leading-relaxed text-muted-foreground">
            还没有仓库。{isAdmin ? '点右上角「+」建一个。' : '请管理员先建一个仓库。'}
          </div>
        )}
      </div>

      {/* 当前范围的规则要说清楚：允许什么格式、单文件多大、参不参与检索 */}
      {currentRepo && (
        <div className="mt-2 rounded-md border border-indigo-100/70 bg-indigo-50/40 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground dark:border-indigo-900/60 dark:bg-indigo-950/20">
          <div className="flex items-center gap-1 font-medium text-foreground/80">
            <Boxes className="h-3 w-3" />
            {currentRepo.name}
          </div>
          <div className="mt-0.5">
            {currentRepo.allowedExts.length > 0
              ? `允许 ${currentRepo.allowedExts.join('、')}`
              : '不限格式'}
            {currentRepo.maxFileSize > 0
              ? ` · 单文件 ≤${Math.round(currentRepo.maxFileSize / 1024 / 1024)}MB`
              : ''}
          </div>
          <div className="mt-0.5">
            {currentRepo.ragEnabled ? '参与 AI 检索' : '不参与 AI 检索'}
          </div>
        </div>
      )}
    </div>
  );
}
