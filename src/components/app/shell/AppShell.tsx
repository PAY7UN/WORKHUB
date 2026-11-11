import { useState, useEffect, useRef } from 'react';
import {
  FileText,
  LogOut,
  ShieldCheck,
  LayoutDashboard,
  Bot,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { AdminConsole } from '../admin/AdminConsole';
import { AgentPanel } from '../AgentPanel';
import { AdminLoginDialog } from '../Modal';
import { DocsWorkspace } from '../docs/DocsWorkspace';
import { readStore, removeStore } from '@/lib/storage';
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from '@/types';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface AppShellProps {
  onGoHome: () => void;
}

export function AppShell({ onGoHome }: AppShellProps) {
  const {
    currentUser,
    isAdmin,
    loginAdmin,
    logoutAdmin,
    canUseAgent,
    pendingAccessCount,
    openAdminConsole,
  } = useApp();

  const [agentOpen, setAgentOpen] = useState(false);
  const [adminLoginOpen, setAdminLoginOpen] = useState(false);

  /** 深链定位只处理一次 */
  const handledFocusRef = useRef(false);

  /**
   * 访问申请定位深链：带着 ?access=<申请单号> 落回本站时，
   * 直接跳到「访问授权」分区并定位那一条申请。
   *
   * 只在管理员身份下生效：这条链接要的是「批不批」，
   * 访客点开也做不了审批，不如让他看见一个打不开的后台。
   * 没登录成管理员就等着——等管理员登录完，身份一变这个副作用会再跑一次。
   */
  useEffect(() => {
    if (handledFocusRef.current) return;
    const requestId = readStore(sessionStorage, 'workhub.focusRequest') ?? '';
    if (!requestId || !isAdmin) return;
    handledFocusRef.current = true;
    removeStore(sessionStorage, 'workhub.focusRequest');
    openAdminConsole('access', undefined, requestId);
  }, [isAdmin, openAdminConsole]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* 顶部导航：工作区切换 + 身份入口 */}
      <header className="h-14 shrink-0 flex items-center gap-3 px-3 sm:px-4 border-b border-indigo-100/40 dark:border-indigo-900/40 glass z-30">
        {/* Logo（点击返回主页） */}
        <button
          onClick={onGoHome}
          className="flex items-center gap-2.5 text-left group cursor-pointer shrink-0"
          title="返回主页"
        >
          <div className="relative">
            <div className="absolute inset-0 gradient-bg rounded-xl blur-md opacity-50" />
            <div className="relative h-9 w-9 rounded-xl gradient-bg flex items-center justify-center shadow-md">
              <FileText className="h-4.5 w-4.5 text-white" />
            </div>
          </div>
          <div className="hidden sm:block min-w-0">
            <div className="font-bold text-base gradient-text leading-tight group-hover:opacity-80 transition-opacity">
              WorkHub
            </div>
            <div className="text-[10px] text-muted-foreground leading-tight">现代化文档管理</div>
          </div>
        </button>

        <div className="flex-1" />

        {/* 用户信息 / 管理员切换 */}
        <div className="flex items-center gap-2 p-1.5 pr-2 rounded-lg bg-white/40 dark:bg-white/5">
          <div
            className="h-8 w-8 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0"
            style={{ backgroundColor: currentUser.color }}
          >
            {currentUser.avatar}
          </div>
          <div className="hidden md:block min-w-0">
            <div className="text-sm font-medium truncate leading-tight">{currentUser.displayName}</div>
            <div className="text-[10px] text-muted-foreground truncate leading-tight">
              {ROLE_LABELS[currentUser.role]} · {ROLE_DESCRIPTIONS[currentUser.role].split('，')[0]}
            </div>
          </div>
          {isAdmin ? (
            <>
              {/* 管理入口只留一个：按功能分区在后台里找 */}
              <div className="relative">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openAdminConsole('overview')}
                  className="h-7 px-2 text-[11px] hover:bg-indigo-100/60 hover:text-indigo-600 dark:hover:bg-indigo-950/30"
                  title="管理后台：概览、访问权限、仓库管理、AI Agent、账号安全"
                >
                  <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                  管理
                </Button>
                {pendingAccessCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-medium text-white">
                    {pendingAccessCount}
                  </span>
                )}
              </div>
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
              <ShieldCheck className="h-3 w-3 mr-1" />
              管理员
            </Button>
          )}
        </div>
      </header>

      {/* 工作区主体 */}
      <main className="flex-1 min-h-0 overflow-hidden">
        <DocsWorkspace />
      </main>

      {/* 管理后台：按功能分区（概览 / 访问权限 / 仓库管理 / AI Agent / 账号安全） */}
      <AdminConsole />

      {/* 文档分析 Agent（配置入口在面板右上角齿轮） */}
      <AgentPanel open={agentOpen} onOpenChange={setAgentOpen} />

      {/* 右下角悬浮入口：常显，面板展开时隐藏避免遮挡 */}
      {!agentOpen && (
        <button
          type="button"
          onClick={() => setAgentOpen(true)}
          title={
            canUseAgent
              ? '基于可见文档的智能问答'
              : isAdmin
                ? '尚未配置 API Key，点击进入配置'
                : '管理员尚未开放或未配置 Agent'
          }
          className={cn(
            'fixed bottom-5 right-5 z-40 flex items-center gap-2 h-11 pl-3.5 pr-4 rounded-full',
            'text-sm font-medium text-white shadow-lg shadow-indigo-500/25',
            'transition-all duration-200 hover:scale-105 active:scale-95',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
            canUseAgent
              ? 'bg-gradient-to-br from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600'
              : 'bg-slate-400/80 hover:bg-slate-500 dark:bg-slate-600/80 dark:hover:bg-slate-500',
          )}
        >
          <Bot className="h-5 w-5 shrink-0" />
          <span className="whitespace-nowrap">AI 助手</span>
          {!canUseAgent && (
            <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-normal leading-none">
              未就绪
            </span>
          )}
        </button>
      )}

      <AdminLoginDialog
        open={adminLoginOpen}
        onOpenChange={setAdminLoginOpen}
        onLogin={async (pwd) => {
          const result = await loginAdmin(pwd);
          if (result.ok) toast.success('已切换为管理员模式');
          return result;
        }}
      />
    </div>
  );
}
