import { useState, useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/context/AppContext';
import { AgentPanel } from '../AgentPanel';
import { DocsWorkspace } from '../docs/DocsWorkspace';
import { readStore, removeStore } from '@/lib/storage';
import { cn } from '@/lib/utils';

/**
 * 工作台。
 *
 * 顶栏已经提到 App 层（见 TopBar）——这一层只负责工作区主体：
 * 左侧文件树 + 右侧文档区，外加右下角的 AI 入口。
 * 早先这里自己带一条顶栏，于是「顶栏长什么样」在三个页面里各有一份，
 * 改一处就得同步三处，还容易改漏。
 */
export function AppShell() {
  const { isAdmin, canUseAgent } = useApp();
  const navigate = useNavigate();

  const [agentOpen, setAgentOpen] = useState(false);

  /** 深链定位只处理一次 */
  const handledFocusRef = useRef(false);

  /**
   * 访问申请定位深链：带着 ?access=<申请单号> 落回本站时，
   * 直接跳到「访问权限」分区并定位那一条申请。
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
    navigate(`/admin/access?req=${encodeURIComponent(requestId)}`);
  }, [isAdmin, navigate]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 工作区主体 */}
      <main className="min-h-0 flex-1 overflow-hidden">
        <DocsWorkspace />
      </main>

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
            'fixed right-4 bottom-4 z-40 flex h-11 items-center gap-2 rounded-full px-3.5 sm:right-5 sm:bottom-5 sm:pr-4 sm:pl-3.5',
            'text-sm font-medium text-white shadow-lg shadow-indigo-500/25',
            'transition-all duration-200 hover:scale-105 active:scale-95',
            'focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:outline-none',
            canUseAgent
              ? 'bg-gradient-to-br from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600'
              : 'bg-slate-400/80 hover:bg-slate-500 dark:bg-slate-600/80 dark:hover:bg-slate-500',
          )}
        >
          <Bot className="h-5 w-5 shrink-0" />
          {/* 窄屏收成一个圆钮：这时正文只剩一列，胶囊会压住右下角的内容 */}
          <span className="hidden pr-1 whitespace-nowrap sm:inline">AI 助手</span>
          {!canUseAgent && (
            <span className="hidden rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] leading-none font-normal sm:inline">
              未就绪
            </span>
          )}
        </button>
      )}
    </div>
  );
}
