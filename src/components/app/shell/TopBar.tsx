import { useState } from 'react';
import { FileText, LogOut, ShieldCheck } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { AdminLoginDialog } from '../Modal';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/types';
import type { AppRegion } from '@/types';
import { RegionTabs } from './RegionTabs';

interface TopBarProps {
  /** 点 Logo 回到欢迎页 */
  onGoHome: () => void;
}

/**
 * 全站唯一的顶栏。
 *
 * 它以前在每个页面里各写一份（工作台一份、工具页一份、后台一份），
 * 三份的高度、边框、按钮位置都略有出入，从这页切到那页时
 * 同一排导航会横向挪几像素、底色深浅也会变——「看着不稳」多半来自这里。
 *
 * 现在只有这一条：品牌在左，区域切换紧跟其后，用户区贴右。
 * 页面自己的那点导航（比如后台的二级分区）留在内容区顶部，
 * 不跟这条混在一起。
 */
export function TopBar({ onGoHome }: TopBarProps) {
  const {
    currentUser,
    isAdmin,
    loginAdmin,
    logoutAdmin,
    pendingAccessCount,
    adminPasswordState,
  } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [adminLoginOpen, setAdminLoginOpen] = useState(false);

  /** 当前位置由地址决定——刷新、转发链接后高亮不会错位 */
  const region: AppRegion = location.pathname.startsWith('/tools')
    ? 'tool'
    : location.pathname.startsWith('/admin')
      ? 'admin'
      : 'doc';

  const gotoRegion = (r: AppRegion) => {
    if (r === 'doc') navigate('/');
    else if (r === 'tool') navigate('/tools');
    else navigate('/admin/overview');
  };

  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-3 glass sm:px-4">
      {/* 品牌 */}
      <button
        onClick={onGoHome}
        className="group flex shrink-0 cursor-pointer items-center gap-2.5 text-left"
        title="返回首页"
      >
        <div className="relative">
          <div className="absolute inset-0 gradient-bg rounded-xl opacity-50 blur-md" />
          <div className="relative flex h-9 w-9 items-center justify-center rounded-xl gradient-bg shadow-md">
            <FileText className="h-4.5 w-4.5 text-white" />
          </div>
        </div>
        <div className="hidden min-w-0 sm:block">
          <div className="gradient-text text-base leading-tight font-bold transition-opacity group-hover:opacity-80">
            WorkHub
          </div>
          <div className="text-[10px] leading-tight text-muted-foreground">个人记录网站</div>
        </div>
      </button>

      {/* 导航紧贴品牌：主导航在最左，视线从左上角起步就落在这里 */}
      <div className="mx-1 h-6 w-px shrink-0 bg-border" />

      {/*
       * 「管理」就在这一排里，不再另设一个按钮。
       * 先前顶栏有「系统」tab，右边又有一个「管理」按钮，两者都通向后台，
       * 后台里还有第三排二级导航——同一批页面三个入口，谁也不知道自己在第几层。
       */}
      <RegionTabs
        active={region}
        showAdmin={isAdmin}
        pending={pendingAccessCount}
        onSelect={gotoRegion}
      />

      <div className="flex-1" />

      {/* 用户区 */}
      <div className="flex items-center gap-2 rounded-lg bg-white/40 p-1.5 pr-2 dark:bg-white/5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: currentUser.color }}
        >
          {currentUser.avatar}
        </div>
        <div className="hidden min-w-0 md:block">
          <div className="truncate text-sm leading-tight font-medium">{currentUser.displayName}</div>
          <div className="truncate text-[10px] leading-tight text-muted-foreground">
            {ROLE_LABELS[currentUser.role]} · {ROLE_DESCRIPTIONS[currentUser.role].split('，')[0]}
          </div>
        </div>
        {isAdmin ? (
          <>
            {/* 密码还停在初始值时挂个点：横幅被关掉也还能找回来 */}
            {adminPasswordState !== 'custom' && (
              <button
                type="button"
                onClick={() => navigate('/admin/security')}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 hover:ring-2 hover:ring-amber-300"
                title="管理员密码还是初始值，点这里去改"
              />
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                logoutAdmin();
                toast.success('已退出管理员，当前为访客模式');
              }}
              className="h-7 w-7 hover:bg-red-100/60 hover:text-red-600 dark:hover:bg-red-950/30"
              title="退出管理员"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => setAdminLoginOpen(true)}
            className="h-7 px-2 text-[11px] gradient-bg hover:opacity-90"
            title="切换为管理员"
          >
            <ShieldCheck className="mr-1 h-3 w-3" />
            管理员
          </Button>
        )}
      </div>

      <AdminLoginDialog
        open={adminLoginOpen}
        onOpenChange={setAdminLoginOpen}
        onLogin={async (pwd) => {
          const result = await loginAdmin(pwd);
          if (result.ok) toast.success('已切换为管理员模式');
          return result;
        }}
      />
    </header>
  );
}
