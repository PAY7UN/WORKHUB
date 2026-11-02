import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Bot, Send, Square, Trash2, Settings, X, ShieldAlert, Gauge, Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useApp } from '@/context/AppContext';
import { api, type AgentScopeInfo, type AgentUsageSummary } from '@/lib/api';
import type { PolishTask, RagScope } from '../../../shared/types';
import { stripPolishArtifacts } from '../../../shared/polish';
import { cn } from '@/lib/utils';
import { AgentMessageList, type AgentMessage, type AgentSource } from './AgentMessageList';
import { PolishTaskList } from './PolishTaskList';
import { usePolishTasks } from './usePolishTasks';

interface AgentPanelProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** token 数按量级缩写：面板一行放不下完整数字，也没人想读 6 位整数 */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

export function AgentPanel({ open, onOpenChange }: AgentPanelProps) {
  const {
    isAdmin,
    canUseAgent,
    agentReason,
    agentConfig,
    openAdminConsole,
    applyExternalContent,
    polishTaskEpoch,
    repos,
  } = useApp();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [applyingId, setApplyingId] = useState('');
  const [usage, setUsage] = useState<AgentUsageSummary | null>(null);
  const [lastUsage, setLastUsage] = useState(0);
  /** 显式指定的仓库；空串表示「默认」（由服务端按默认仓库落点） */
  const [scopeRepoId, setScopeRepoId] = useState('');
  /** 服务端回传的实际检索仓库名；为空说明范围由管理员的配置决定 */
  const [scopeRepos, setScopeRepos] = useState<string[]>([]);
  const [scopeResolved, setScopeResolved] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 润色任务属管理员能力；访客不订阅，避免 403 噪声与越权暗示。
  // epoch 来自提交方（编辑器里的润色弹窗），任务一提交这里立刻重新拉列表——
  // 少了它，面板开着时提交的任务会停在「看不见」的状态，只能关开面板才出现
  const { tasks, live, reasoning, remove, clearFinished } = usePolishTasks(open && isAdmin, polishTaskEpoch);

  // token 用量属成本数据，接口同样限管理员：拉取失败只让这一行缺席，
  // 面板其余功能必须照常可用，故此处不提示错误
  useEffect(() => {
    if (!open || !isAdmin) return;
    let alive = true;
    api
      .getAgentUsage()
      .then((r) => {
        if (alive) setUsage(r.usage);
      })
      .catch(() => {
        if (alive) setUsage(null);
      });
    return () => {
      alive = false;
    };
  }, [open, isAdmin]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /**
   * 本次提问的检索范围。
   *
   * 默认不传范围：服务端会按「默认仓库」落点——问的是这个站点的默认资料，
   * 而不是把各项目的资料混在一起答。
   *
   * 只有用户在面板里明确选了某个仓库，才把范围收窄到那个仓库；
   * 另外，服务端还会认出问题里点名的仓库（「B 仓库里怎么…」），
   * 那次就只答 B 仓库的内容。
   *
   * 只能收窄不能放宽：服务端会把请求范围与全局配置取交集，
   * 这里给的越窄越安全，想放宽只能由管理员在后台显式改。
   */
  const scope = useMemo<RagScope | undefined>(
    () =>
      scopeRepoId
        ? { mode: 'repos', repoIds: [scopeRepoId], docIds: [], includeAttachments: true }
        : undefined,
    [scopeRepoId],
  );

  /**
   * 检索范围的实际落点。
   *
   * 服务端回传优先：范围可能因为问题里点了某个仓库而临时改变，
   * 照抄本地选择会显示得与实际不符。
   */
  const scopeLabel = useMemo(() => {
    if (scopeRepos.length === 1) return `仅「${scopeRepos[0]}」`;
    if (scopeRepos.length > 1) return `仅 ${scopeRepos.join('、')}`;
    if (scopeResolved) return '管理员设定的范围';
    if (scopeRepoId) {
      const name = repos.find((r) => r.id === scopeRepoId)?.name;
      return name ? `仅「${name}」` : '仅选定仓库';
    }
    // 仓库按创建时间排序，第一个即服务端认定的默认仓库
    const defaultName = repos[0]?.name;
    return defaultName ? `默认仓库「${defaultName}」` : '默认仓库';
  }, [scopeRepos, scopeResolved, scopeRepoId, repos]);

  /**
   * 把润色结果写回原文档。
   *
   * 走 applyExternalContent 而非编辑器的 onApply：任务在面板里发起时编辑器可能已关闭，
   * 只有按 docId 回写才能覆盖这种情况；而该方法会同时通知打开中的编辑器跟随，
   * 单靠 updateDoc 时编辑器不响应（doc.id 不变，其非受控 content 不会同步）。
   *
   * 不传 instruction 做二次清洗是安全的：服务端在流结束时已用
   * stripPolishArtifacts(buffer, instruction) 清洗并落库，task.result 本身即净文。
   *
   * 所有提前返回都必须给出提示。此处任一分支静默 return，用户看到的就是
   * 「点��到文档但文档没变」且无从判断原因。
   */
  const applyPolishResult = useCallback(
    async (task: PolishTask) => {
      if (applyingId) {
        toast.error('另一个润色结果正在应用，请稍候');
        return;
      }
      if (!task.docId) {
        toast.error('该任务缺少文档标识，无法应用');
        return;
      }
      const finalText = stripPolishArtifacts(task.result);
      if (!finalText.trim()) {
        toast.error('润色结果为空，无法应用', { description: '模型未产出可用正文，请重试或更换模型' });
        return;
      }
      setApplyingId(task.id);
      try {
        const res = applyExternalContent(task.docId, finalText);
        if (res.ok) {
          toast.success(`已应用到「${task.docName}」，任务记录已清理`);
          // 仅在成功回填后删除。失败时必须留着记录，否则用户拿不到已生成的
          // 结果也无从重试，而重新润色一次要再等几十秒
          void remove(task.id);
        } else toast.error(res.reason);
      } catch (e) {
        toast.error('应用失败', { description: (e as Error)?.message });
      } finally {
        setApplyingId('');
      }
    },
    [applyingId, applyExternalContent, remove],
  );

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || loading) return;
      setError('');
      setInput('');
      setLoading(true);

      const userMsg: AgentMessage = { id: `u-${Date.now()}`, role: 'user', content: q };
      const botId = `a-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: botId, role: 'assistant', content: '', sources: [], pending: true },
      ]);

      const history = messages
        .filter((m) => !m.pending && m.content)
        .map((m) => ({ role: m.role, content: m.content }));

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (m: AgentMessage) => AgentMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === botId ? fn(m) : m)));

      try {
        await api.ask(q, history, {
          signal: controller.signal,
          onSources: (sources: AgentSource[], meta?: AgentScopeInfo) => {
            patch((m) => ({ ...m, sources }));
            setScopeRepos(meta?.scopeRepos ?? []);
            setScopeResolved(true);
          },
          onReasoning: (text: string) => patch((m) => ({ ...m, reasoning: (m.reasoning ?? '') + text })),
          onDelta: (text: string) =>
            patch((m) => ({ ...m, content: m.content + text, pending: false })),
          onUsage: (u) => {
            const total = u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
            setLastUsage(total);
            // 乐观累加，避免为了一次统计再发一轮请求；
            // 重新打开面板时会以服务端数据为准校正
            setUsage((prev) =>
              prev
                ? {
                    ...prev,
                    totalTokens: prev.totalTokens + total,
                    promptTokens: prev.promptTokens + (u.prompt_tokens ?? 0),
                    completionTokens: prev.completionTokens + (u.completion_tokens ?? 0),
                    callCount: prev.callCount + 1,
                  }
                : prev,
            );
          },
        }, scope);
        patch((m) => ({ ...m, pending: false }));
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          patch((m) => ({ ...m, pending: false, content: m.content || '（已停止生成）' }));
        } else {
          const message = (e as Error)?.message ?? '提问失败';
          setError(message);
          patch((m) => ({
            ...m,
            pending: false,
            content: m.content || `抱歉，${message}`,
          }));
        }
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    },
    [loading, messages, scope],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError('');
  }, []);

  if (!open) return null;

  return (
    <>
      {/* 窄屏：面板浮在正文之上，用遮罩兜住点击关闭。
          宽屏（lg+）：改为与主区并排的 flex 兄弟节点 —— 浮层会直接盖住
          文章右侧一整块，表格、长链接这类贴右边的内容被遮掉且无法滚到，
          并排后主区只是变窄，内容随容器重新排版。 */}
      <div className="fixed inset-0 z-40 bg-black/20 lg:hidden" onClick={() => onOpenChange(false)} />
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col overflow-hidden border-l bg-background shadow-2xl lg:static lg:z-auto lg:w-[26rem] lg:max-w-md lg:shrink-0 lg:shadow-none">
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500">
            <Bot className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">AI 助手</h3>
            <p className="truncate text-[11px] text-muted-foreground">
              {agentConfig.model || '未配置模型'} · 基于你有权限查看的文档
            </p>
          </div>
          {messages.length > 0 && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={clear} title="清空对话">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {isAdmin && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => openAdminConsole('agent')}
              title="Agent 配置（管理后台 · AI Agent）"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onOpenChange(false)} title="关闭">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* 未就绪提示 */}
        {!canUseAgent && (
          <div className="flex items-start gap-2 border-b bg-amber-50 px-4 py-2.5 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {agentReason === 'GUEST_DISABLED'
                ? '管理员尚未开放访客使用 Agent。'
                : 'Agent 尚未配置：请在设置中填写 API Key。'}
            </span>
          </div>
        )}

        {/* 润色任务：生成在后台进行，此处只做进度与结果的跟踪 */}
        {isAdmin && (
          <PolishTaskList
            tasks={tasks}
            live={live}
            reasoning={reasoning}
            onApply={(task) => void applyPolishResult(task)}
            onRemove={(id) => void remove(id)}
            onClearFinished={async () => {
              try {
                const result = await clearFinished();
                toast.success(`已清空 ${result.removed.length} 个已结束的任务`);
              } catch {
                toast.error('清空失败，列表已刷新');
              }
            }}
            applyingId={applyingId}
          />
        )}

        {/* 消息区 */}
        <AgentMessageList
          messages={messages}
          isAdmin={isAdmin}
          onSuggest={(q) => {
            setInput(q);
            void ask(q);
          }}
          loading={loading}
        />

        {/* 错误提示 */}
        {error && (
          <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] leading-relaxed text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* 输入区：固定在面板底部 */}
        <div className="shrink-0 border-t bg-muted/20 px-3 pb-3 pt-2.5">
          <div
            className={cn(
              'rounded-xl border bg-card shadow-xs transition-[border-color,box-shadow]',
              'focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-500/15',
              'dark:focus-within:border-indigo-500',
            )}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void ask(input);
                }
              }}
              placeholder={canUseAgent ? '问点什么…（Enter 发送，Shift+Enter 换行）' : 'Agent 当前不可用'}
              disabled={!canUseAgent || loading}
              rows={2}
              className="max-h-40 min-h-[52px] w-full resize-none border-0 bg-transparent px-3 pt-2.5 text-sm leading-relaxed shadow-none outline-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5">
              <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted-foreground">
                <Boxes className="h-3 w-3 shrink-0" />
                <select
                  value={scopeRepoId}
                  onChange={(e) => {
                    setScopeRepoId(e.target.value);
                    // 换范围后旧的那次结论已不适用于新范围，别再显示
                    setScopeRepos([]);
                    setScopeResolved(false);
                  }}
                  title="默认只检索默认仓库；选定某个仓库则只检索该仓库"
                  className="min-w-0 max-w-[8.5rem] shrink rounded border border-border bg-background px-1 py-0.5 text-[11px] text-foreground outline-none focus:border-indigo-400"
                >
                  <option value="">默认仓库</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <span className="truncate">{scopeLabel}</span>
              </span>
              {loading ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={stop}
                  className="h-7 shrink-0 rounded-full px-2.5 text-xs"
                >
                  <Square className="mr-1 h-3 w-3" />
                  停止
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void ask(input)}
                  disabled={!canUseAgent || !input.trim()}
                  title="发送"
                  className="h-7 w-7 shrink-0 rounded-full bg-indigo-500 text-white shadow-sm hover:bg-indigo-600 disabled:bg-muted disabled:text-muted-foreground"
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>

          {/* token 用量：仅管理员可见（数据接口同样限管理员）。悬浮可看输入/输出拆分 */}
          {isAdmin && usage && (
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground/80">
              <Gauge className="h-3 w-3 shrink-0" />
              <span
                title={
                  `输入 ${usage.promptTokens.toLocaleString()} / 输出 ${usage.completionTokens.toLocaleString()} tokens` +
                  `\n问答 ${usage.byScene.chat.calls} 次 · 润色 ${usage.byScene.polish.calls} 次` +
                  `\n累计 ${usage.callCount} 次调用`
                }
              >
                {lastUsage > 0 && (
                  <>
                    本次 {formatTokens(lastUsage)} · 累计{' '}
                  </>
                )}
                {formatTokens(usage.totalTokens)} tokens
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
