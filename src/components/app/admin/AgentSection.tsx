import { useEffect, useState, type ReactNode } from 'react';
import { Eye, EyeOff, Loader2, Plug, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { api, type AgentConfigView } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { RagScopeMode } from '@/types';

type Draft = Omit<AgentConfigView, 'hasApiKey'> & { apiKey: string; clearApiKey: boolean };

const TEMPERATURE_PRESETS = [
  { label: '严谨', value: 0.1 },
  { label: '平衡', value: 0.3 },
  { label: '发散', value: 0.7 },
];

/** 检索范围的三种模式，标签顺序即界面上呈现的顺序 */
const SCOPE_MODES: Array<{ value: RagScopeMode; label: string; hint: string }> = [
  { value: 'all', label: '全站', hint: '全部资料都可被检索（加密文档除外）' },
  { value: 'repos', label: '限定仓库', hint: '只检索选中的仓库' },
  { value: 'docs', label: '限定文档', hint: '只检索选中的文档' },
];

/**
 * 一个设置分组。
 *
 * 以前这页是十几行表单一路往下排，每项底下各挂一句灰字，读的人得自己
 * 拼出「哪几项是一件事」。现在按「模型接入 / 回答与检索 / 检索范围 / 访客权限」
 * 分成四组，组名说清归属，其余说明一概不写——控件旁边的灰字越少，
 * 眼睛落点越准。
 */
function Group({
  icon,
  title,
  desc,
  children,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-card/40 p-5">
      <header className="mb-4 flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium leading-tight">{title}</h3>
          {desc && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{desc}</p>}
        </div>
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** 字段：标签 + 控件（说明一律不写，必要时用 placeholder 承载） */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * AI Agent 配置（管理后台 · AI Agent 分区）。
 *
 * 配置存在服务端 SQLite，API Key 经 AES-256-GCM 加密后落库，不下发到浏览器。
 * 访客能否使用由「允许访客使用 Agent」开关决定，关掉后服务端直接拒绝访客提问。
 *
 * 布局：宽屏下左右两栏——左边是「接什么模型、怎么答」，右边是「能看哪些资料、
 * 谁能用」。保存按钮放在页头右上：这一页一屏就能看完，不值得为它单挂一条
 * 吸底栏把页面切碎。
 */
export function AgentSection() {
  const { agentConfig, refreshAgentStatus, repos, docs } = useApp();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft({
      baseUrl: agentConfig.baseUrl,
      model: agentConfig.model,
      groupId: agentConfig.groupId,
      temperature: agentConfig.temperature,
      allowGuest: agentConfig.allowGuest,
      topK: agentConfig.topK,
      contextBudget: agentConfig.contextBudget,
      ragScope: agentConfig.ragScope,
      // Key 不回显：留空表示保持原值
      apiKey: '',
      clearApiKey: false,
    });
  }, [agentConfig]);

  if (!draft) return null;

  const isMiniMax = /minimax/i.test(draft.baseUrl);
  const keyState = draft.clearApiKey
    ? '待清除'
    : draft.apiKey.trim()
      ? '待更新'
      : agentConfig.hasApiKey
        ? '已配置'
        : '未配置';
  /** 只有「还没生效的改动」才需要提醒，已配置的存量状态不用天天挂个黄标 */
  const keyPending = draft.clearApiKey || !!draft.apiKey.trim();

  const handleSave = async () => {
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      toast.error('接口地址与模型名称不能为空');
      return;
    }
    setSaving(true);
    try {
      await api.saveAgentConfig({
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        groupId: draft.groupId.trim(),
        temperature: draft.temperature,
        allowGuest: draft.allowGuest,
        topK: draft.topK,
        contextBudget: draft.contextBudget,
        ragScope: draft.ragScope,
        // 仅在填写了新 Key 时才下发，空值表示沿用已存密文
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft.clearApiKey ? { clearApiKey: true } : {}),
      });
      await refreshAgentStatus();
      toast.success('Agent 配置已保存到服务端数据库');
    } catch (e) {
      toast.error((e as Error)?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* 页头：标题 + 一句话 + Key 状态 + 保存 */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">AI Agent 配置</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            配置与 API Key 都存在服务端，不下发到浏览器。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px]',
              keyPending
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'bg-muted text-muted-foreground',
            )}
          >
            API Key {keyState}
          </span>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            保存配置
          </Button>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {/* 左栏：接什么模型、怎么答 */}
        <div className="space-y-5">
          <Group icon={<Plug className="h-3.5 w-3.5" />} title="模型接入">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="接口地址 (baseURL)" htmlFor="agent-base">
                <Input
                  id="agent-base"
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
              <Field label="模型名称" htmlFor="agent-model">
                <Input
                  id="agent-model"
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  placeholder="填写服务商提供的模型 ID"
                />
              </Field>
            </div>

            {isMiniMax && (
              <Field label="GroupId（MiniMax 账号 ID）" htmlFor="agent-group">
                <Input
                  id="agent-group"
                  value={draft.groupId}
                  onChange={(e) => setDraft({ ...draft, groupId: e.target.value })}
                  placeholder="在开放平台「账户管理」中获取"
                />
              </Field>
            )}

            <Field label="API Key" htmlFor="agent-key">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="agent-key"
                    type={showKey ? 'text' : 'password'}
                    value={draft.apiKey}
                    onChange={(e) =>
                      setDraft({ ...draft, apiKey: e.target.value, clearApiKey: false })
                    }
                    placeholder={agentConfig.hasApiKey ? '已加密存储，留空则保持不变' : 'sk-...'}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                    title={showKey ? '隐藏' : '显示'}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {agentConfig.hasApiKey && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 text-[11px]"
                    onClick={() => setDraft({ ...draft, clearApiKey: !draft.clearApiKey, apiKey: '' })}
                  >
                    {draft.clearApiKey ? '取消清除' : '清除'}
                  </Button>
                )}
              </div>
            </Field>
          </Group>

          <Group icon={<SlidersHorizontal className="h-3.5 w-3.5" />} title="回答与检索">
            <Field label="回答创造性 (Temperature)">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={draft.temperature}
                  onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })}
                  className="min-w-0 flex-1"
                />
                <span className="w-8 shrink-0 text-right text-xs tabular-nums">
                  {draft.temperature.toFixed(1)}
                </span>
                {/* 预设做成跟检索范围一样的分段按钮：一眼看出当前选的是哪个 */}
                <div className="flex shrink-0 rounded-md border border-border p-0.5">
                  {TEMPERATURE_PRESETS.map((p) => {
                    const on = draft.temperature === p.value;
                    return (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => setDraft({ ...draft, temperature: p.value })}
                        className={cn(
                          'cursor-pointer rounded px-1.5 py-0.5 text-[11px] transition-colors',
                          on
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="检索文档数" htmlFor="agent-topk">
                <Input
                  id="agent-topk"
                  type="number"
                  min={1}
                  max={20}
                  value={draft.topK}
                  onChange={(e) =>
                    setDraft({ ...draft, topK: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </Field>
              <Field label="上下文预算（字符）" htmlFor="agent-budget">
                <Input
                  id="agent-budget"
                  type="number"
                  min={2000}
                  step={1000}
                  value={draft.contextBudget}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      contextBudget: Math.max(2000, Number(e.target.value) || 2000),
                    })
                  }
                />
              </Field>
            </div>
          </Group>
        </div>

        {/* 右栏：能看哪些资料、谁能用 */}
        <div className="space-y-5">
          <Group
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
            title="检索范围"
            desc="决定模型能看到哪些资料。"
          >
            {/* 分段控件：三种模式是互斥的一档，用按钮组比三个药丸更像个开关 */}
            <div className="flex rounded-md border border-border p-0.5">
              {SCOPE_MODES.map((m) => {
                const on = draft.ragScope.mode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setDraft({ ...draft, ragScope: { ...draft.ragScope, mode: m.value } })}
                    className={cn(
                      'flex-1 cursor-pointer rounded px-2 py-1 text-[11px] transition-colors',
                      on
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {SCOPE_MODES.find((m) => m.value === draft.ragScope.mode)?.hint}
            </p>

            {draft.ragScope.mode === 'repos' && (
              <Field label="参与检索的仓库">
                {repos.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">还没有仓库</p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-border/70 p-1.5">
                    {repos.map((r) => {
                      const on = draft.ragScope.repoIds.includes(r.id);
                      return (
                        <label key={r.id} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                ragScope: {
                                  ...draft.ragScope,
                                  repoIds: e.target.checked
                                    ? [...draft.ragScope.repoIds, r.id]
                                    : draft.ragScope.repoIds.filter((id) => id !== r.id),
                                },
                              })
                            }
                          />
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: r.color }}
                          />
                          <span className="truncate">{r.name}</span>
                          {!r.ragEnabled && (
                            <span className="shrink-0 text-muted-foreground">（已关闭检索）</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </Field>
            )}

            {draft.ragScope.mode === 'docs' && (
              <Field label="参与检索的文档">
                <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-border/70 p-1.5">
                  {draft.ragScope.docIds.length === 0 ? (
                    <p className="px-1 py-1 text-[11px] text-muted-foreground">尚未指定任何文档</p>
                  ) : (
                    draft.ragScope.docIds.map((id) => {
                      const doc = docs.find((d) => d.id === id);
                      return (
                        <div key={id} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                          <span className="flex-1 truncate">{doc?.name ?? id}</span>
                          <button
                            type="button"
                            className="cursor-pointer text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                ragScope: {
                                  ...draft.ragScope,
                                  docIds: draft.ragScope.docIds.filter((x) => x !== id),
                                },
                              })
                            }
                          >
                            移除
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </Field>
            )}

            <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 px-3 py-2">
              <Label className="text-xs font-medium">纳入附件正文</Label>
              <Switch
                checked={draft.ragScope.includeAttachments}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, ragScope: { ...draft.ragScope, includeAttachments: v } })
                }
              />
            </div>
          </Group>

          <Group icon={<Users className="h-3.5 w-3.5" />} title="访客权限">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border/70 px-3 py-2">
              <Label htmlFor="agent-guest" className="text-xs font-medium">
                允许访客使用 Agent
              </Label>
              <Switch
                id="agent-guest"
                checked={draft.allowGuest}
                onCheckedChange={(v) => setDraft({ ...draft, allowGuest: v })}
              />
            </div>
          </Group>
        </div>
      </div>
    </div>
  );
}
