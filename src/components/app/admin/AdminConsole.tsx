import { Bot, Boxes, LayoutDashboard, Lock, MessageSquare, ShieldCheck, UserCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useApp } from '@/context/AppContext';
import { ADMIN_SECTION_LABELS, type AdminSection } from '@/types';
import { AccessSection } from './AccessSection';
import { AgentSection } from './AgentSection';
import { DingTalkSection } from './DingTalkSection';
import { EncryptedSection } from './EncryptedSection';
import { OverviewSection } from './OverviewSection';
import { RepoSection } from './RepoSection';
import { SecuritySection } from './SecuritySection';

/**
 * 管理后台的分区导航。
 *
 * 说明文字写在每个分区名下面：管理员进来先看到「这件事归谁管」，
 * 而不是面对一排没有文字的图标去猜。
 */
const SECTIONS: {
  id: AdminSection;
  label: string;
  desc: string;
  icon: typeof LayoutDashboard;
}[] = [
  { id: 'overview', label: '概览', desc: '现在有多少事等着处理', icon: LayoutDashboard },
  { id: 'access', label: '访问授权', desc: '审批申请、收回授权', icon: UserCheck },
  { id: 'encrypted', label: '加密文档', desc: '哪些文档以密文保存', icon: Lock },
  { id: 'repos', label: '仓库管理', desc: '项目、留存规则、迁移', icon: Boxes },
  { id: 'agent', label: 'AI Agent', desc: '模型、API Key、访客开关', icon: Bot },
  { id: 'dingtalk', label: '钉钉同步', desc: '到点提醒、待办同步', icon: MessageSquare },
  { id: 'security', label: '账号安全', desc: '修改管理员密码', icon: ShieldCheck },
];

/**
 * 管理后台。
 *
 * 以前这些管理功能是一排挤在侧边栏图标里的东西：授权、密码清单、改密，
 * 每一件都得先猜「那个图标是哪件事」，图标多了以后连哪个是哪个都得对着看。
 *
 * 现在按功能拆成分区：入口只有一个「管理后台」，进去以后左边是功能导航，
 * 右边是这一块的内容。同一件事只在一个地方出现，
 * 别的入口（文档菜单、AI 助手齿轮）直接跳到对应分区，不再各开各的弹窗。
 */
export function AdminConsole() {
  const {
    adminConsoleOpen,
    adminSection,
    adminDocFilter,
    adminFocusRequestId,
    openAdminConsole,
    closeAdminConsole,
    pendingAccessCount,
  } = useApp();

  const current = SECTIONS.find((s) => s.id === adminSection) ?? SECTIONS[0];

  return (
    <Dialog open={adminConsoleOpen} onOpenChange={(v) => (v ? undefined : closeAdminConsole())}>
      <DialogContent className="glass-strong flex h-[85vh] flex-col gap-0 border-0 p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <LayoutDashboard className="h-5 w-5 text-indigo-500" />
            管理后台
            <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-normal text-indigo-600 dark:text-indigo-400">
              {ADMIN_SECTION_LABELS[current.id]}
            </span>
          </DialogTitle>
          <DialogDescription>
            按功能分区管理：概览、访问授权、加密文档、仓库管理、AI Agent、钉钉同步、账号安全。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* 分区导航：窄屏横向滚动，宽屏固定在左侧 */}
          <nav className="scrollbar-thin flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 p-2 md:w-52 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = s.id === adminSection;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => openAdminConsole(s.id)}
                  className={
                    'flex shrink-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors md:w-full ' +
                    (active
                      ? 'bg-indigo-100/70 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                      : 'hover:bg-slate-100/70 dark:hover:bg-white/5')
                  }
                >
                  <Icon
                    className={
                      'mt-0.5 h-4 w-4 shrink-0 ' +
                      (active ? 'text-indigo-500' : 'text-muted-foreground')
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {s.label}
                      {s.id === 'access' && pendingAccessCount > 0 && (
                        <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                          {pendingAccessCount}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">{s.desc}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          {/* 分区内容 */}
          <div className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
            {adminSection === 'overview' && (
              <OverviewSection onNavigate={(s) => openAdminConsole(s)} />
            )}
            {adminSection === 'access' && (
              <AccessSection
                docId={adminDocFilter?.docId}
                docName={adminDocFilter?.docName}
                onClearFilter={() => openAdminConsole('access')}
                focusRequestId={adminFocusRequestId ?? undefined}
              />
            )}
            {adminSection === 'encrypted' && <EncryptedSection />}
            {adminSection === 'repos' && <RepoSection />}
            {adminSection === 'agent' && <AgentSection />}
            {adminSection === 'dingtalk' && <DingTalkSection />}
            {adminSection === 'security' && <SecuritySection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
