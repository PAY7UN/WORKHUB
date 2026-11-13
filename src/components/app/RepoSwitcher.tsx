import { Boxes, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/context/AppContext';
import { cn } from '@/lib/utils';

/**
 * 侧边栏的「项目区」导航。
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
 *
 * 分区归属：站点是「个人记录网站」，「项目区」是它当前唯一的分区，
 * 按仓库（项目）分块留存资料。后面会并列加上「工作区」——
 * 两者是同级分区，不是谁包含谁，所以这里只管自己这一块的导航。
 */
export function RepoSwitcher() {
  const { repos, repoStats, reposStatus, currentRepoId, setCurrentRepoId, currentRepo, isAdmin } =
    useApp();
  const navigate = useNavigate();

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
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">项目区</span>
        {isAdmin && (
          <button
            type="button"
            onClick={() => navigate('/admin/projects')}
            title="管理项目仓库（新建、规则、历史）"
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
            {/*
             * 三种空法要分开说：
             * - 还在读：等一下就好；
             * - 读失败：去查服务端；
             * - 读到了但是空的：去建仓库。
             * 早先一律写「还没有仓库」，把「没连上」也说成「没有」，
             * 用户跑去建了一堆仓库，资料却一直出不来。
             */}
            {reposStatus === 'loading' && '正在读取…'}
            {reposStatus === 'error' && '暂时读不到仓库列表，请确认服务端在运行。'}
            {reposStatus === 'ready' &&
              `还没有仓库。${isAdmin ? '点右上角「+」建一个。' : '请管理员先建一个仓库。'}`}
          </div>
        )}
      </div>

      {/*
       * 当前仓库的规则压成一行。
       *
       * 先前是一张三行小卡：仓库名占一行、格式与体积一行、检索开关一行。
       * 仓库名在上一行的列表里已经高亮着，这里再写一遍是重复；
       * 而三行的高度会随「允许格式有几个」上下变，切一次仓库，
       * 下面的文件树就整体挪一次——这正是「点一下布局就跳」的来源之一。
       * 现在固定单行、超出省略，切换仓库时高度不动。
       */}
      {currentRepo && (
        <div
          className="mt-2 flex h-6 items-center gap-1 overflow-hidden rounded-md bg-slate-100/70 px-2 text-[10px] leading-none text-muted-foreground dark:bg-white/5"
          title={[
            currentRepo.allowedExts.length > 0
              ? `允许 ${currentRepo.allowedExts.join('、')}`
              : '不限格式',
            currentRepo.maxFileSize > 0
              ? `单文件 ≤${Math.round(currentRepo.maxFileSize / 1024 / 1024)}MB`
              : '',
            currentRepo.ragEnabled ? '参与 AI 检索' : '不参与 AI 检索',
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <Boxes className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {currentRepo.allowedExts.length > 0
              ? currentRepo.allowedExts.join('、')
              : '不限格式'}
            {currentRepo.maxFileSize > 0
              ? ` · ≤${Math.round(currentRepo.maxFileSize / 1024 / 1024)}MB`
              : ''}
            {currentRepo.ragEnabled ? ' · AI 检索' : ''}
          </span>
        </div>
      )}
    </div>
  );
}
