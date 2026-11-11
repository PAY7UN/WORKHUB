import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  FileText,
  FolderTree,
  Loader2,
  Lock,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { ADMIN_SECTION_LABELS, type AdminSection } from '@/types';

interface OverviewSectionProps {
  onNavigate: (section: AdminSection) => void;
}

/**
 * 管理后台概览。
 *
 * 管理员一进来先看到「现在有多少事等着我」：
 * 几篇文档、几份授权待批、Agent 配没配好。
 * 数字后面各带一个按钮，点一下直接跳到对应的分区——
 * 概览的价值不是好看，是省掉「找入口」这一步。
 */
export function OverviewSection({ onNavigate }: OverviewSectionProps) {
  const { docs, agentConfig, pendingAccessCount, listAllAccessGrants } = useApp();
  const [grantCount, setGrantCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const grants = await listAllAccessGrants();
        if (!alive) return;
        setGrantCount(grants.filter((g) => !g.revokedAt).length);
      } catch {
        // 概览数字取不到不该挡住其余内容，静默留空即可
      }
    })();
    return () => {
      alive = false;
    };
  }, [listAllAccessGrants]);

  const fileCount = docs.filter((d) => d.type === 'file').length;
  const folderCount = docs.filter((d) => d.type === 'folder').length;
  const lockedCount = docs.filter((d) => d.encrypted).length;

  const cards: {
    label: string;
    value: number | string;
    icon: typeof FileText;
    hint: string;
    section?: AdminSection;
    tone?: 'default' | 'warn';
  }[] = [
    {
      label: '文档',
      value: fileCount,
      icon: FileText,
      hint: `另有 ${folderCount} 个文件夹`,
    },
    {
      label: '加密文档',
      value: lockedCount,
      icon: Lock,
      hint: '正文只存密文',
      section: 'access',
    },
    {
      label: '待审批申请',
      value: pendingAccessCount,
      icon: Users,
      hint: pendingAccessCount > 0 ? '有人等着你点头' : '暂时没有',
      section: 'access',
      tone: pendingAccessCount > 0 ? 'warn' : 'default',
    },
    {
      label: '有效授权',
      value: grantCount ?? '—',
      icon: ShieldCheck,
      hint: '凭授权免密访问',
      section: 'access',
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {cards.map((c) => {
          const Icon = c.icon;
          const body = (
            <>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                {c.label}
              </div>
              <div
                className={
                  'mt-1 text-2xl font-semibold tabular-nums ' +
                  (c.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')
                }
              >
                {c.value}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{c.hint}</div>
            </>
          );
          return c.section ? (
            <button
              key={c.label}
              type="button"
              onClick={() => onNavigate(c.section as AdminSection)}
              className="group cursor-pointer rounded-xl border border-border/70 bg-white/50 px-3 py-2.5 text-left transition-colors hover:border-indigo-300/70 hover:bg-indigo-50/40 dark:bg-white/5 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/20"
            >
              {body}
              <span className="mt-1.5 inline-flex items-center gap-0.5 text-[11px] text-indigo-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-indigo-400">
                去处理 <ArrowRight className="h-3 w-3" />
              </span>
            </button>
          ) : (
            <div
              key={c.label}
              className="rounded-xl border border-border/70 bg-white/50 px-3 py-2.5 dark:bg-white/5"
            >
              {body}
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-border/70 bg-white/50 p-3.5 dark:bg-white/5">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-indigo-500" />
          <h4 className="text-sm font-semibold">AI Agent</h4>
          <span
            className={
              'ml-auto rounded-full px-2 py-0.5 text-[11px] ' +
              (agentConfig.hasApiKey
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400')
            }
          >
            {agentConfig.hasApiKey ? '已配置' : '未配置'}
          </span>
        </div>
        <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">模型</dt>
            <dd className="truncate font-medium">{agentConfig.model || '—'}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">访客可用</dt>
            <dd className="font-medium">{agentConfig.allowGuest ? '是' : '否'}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">检索文档数</dt>
            <dd className="font-medium tabular-nums">{agentConfig.topK}</dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={() => onNavigate('agent')}
          className="mt-3 inline-flex cursor-pointer items-center gap-1 text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
        >
          配置 Agent <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onNavigate('access')}
          className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border/70 bg-white/50 px-3 py-2.5 text-left transition-colors hover:border-indigo-300/70 hover:bg-indigo-50/40 dark:bg-white/5 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/20"
        >
          <Users className="h-4 w-4 text-indigo-500" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">访问权限</span>
            <span className="block text-[11px] text-muted-foreground">
              加密文档清单、审批访客申请，随时收回已放行的权限
            </span>
          </span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>

        <button
          type="button"
          onClick={() => onNavigate('security')}
          className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border/70 bg-white/50 px-3 py-2.5 text-left transition-colors hover:border-indigo-300/70 hover:bg-indigo-50/40 dark:bg-white/5 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/20"
        >
          <ShieldCheck className="h-4 w-4 text-indigo-500" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">账号安全</span>
            <span className="block text-[11px] text-muted-foreground">修改管理员密码</span>
          </span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>

        <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-white/50 px-3 py-2.5 dark:bg-white/5">
          <FolderTree className="h-4 w-4 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">文档本身</span>
            <span className="block text-[11px] text-muted-foreground">
              加密、换发密码等操作在文档菜单里，就近处理
            </span>
          </span>
          {agentConfig.hasApiKey ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
          ) : null}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        当前分区：{ADMIN_SECTION_LABELS.overview}。左侧导航可切换到其它功能分区。
      </p>
    </div>
  );
}
