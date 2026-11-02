import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { api, type AgentConfigView } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { RagScopeMode } from '@/types';

type Draft = Omit<AgentConfigView, 'hasApiKey'> & { apiKey: string; clearApiKey: boolean };

const TEMPERATURE_PRESETS = [
  { label: '严谨', value: 0.1 },
  { label: '平衡', value: 0.3 },
  { label: '发散', value: 0.7 },
];

/** 检索范围的三种模式，标签顺序即界面上呈现的顺序 */
const SCOPE_MODES: Array<{ value: RagScopeMode; label: string; hint: string }> = [
  { value: 'all', label: '全站', hint: '所有仓库的资料都可被检索（加密文档除外）' },
  { value: 'repos', label: '限定仓库', hint: '只检索选中仓库里的资料' },
  { value: 'docs', label: '限定文档', hint: '只检索逐篇指定的文档' },
];

/**
 * AI Agent 配置（管理后台 · AI Agent 分区）。
 *
 * 配置存在服务端 SQLite，API Key 经 AES-256-GCM 加密后落库，不下发到浏览器。
 * 访客能否使用由「允许访客使用 Agent」开关决定，关掉后服务端直接拒绝访客提问。
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
        ? '已配置（保持不变）'
        : '未配置';

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
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        配置存储在服务端 SQLite，API Key 经 AES-256-GCM 加密保存，不下发到浏览器。
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="agent-base">接口地址 (baseURL)</Label>
        <Input
          id="agent-base"
          value={draft.baseUrl}
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1"
        />
        <p className="text-[11px] text-muted-foreground">
          需为 OpenAI 兼容接口（Chat Completions），填写到 <code>/v1</code> 为止，不要带{' '}
          <code>/chat/completions</code>。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agent-model">模型名称</Label>
        <Input
          id="agent-model"
          value={draft.model}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          placeholder="填写服务商提供的模型 ID"
        />
      </div>

      {isMiniMax && (
        <div className="space-y-1.5">
          <Label htmlFor="agent-group">GroupId（MiniMax 账号 ID）</Label>
          <Input
            id="agent-group"
            value={draft.groupId}
            onChange={(e) => setDraft({ ...draft, groupId: e.target.value })}
            placeholder="在开放平台「账户管理」中获取"
          />
          <p className="text-[11px] text-muted-foreground">
            作为 <code>MiniMax-Group-Id</code> 请求头由服务端下发；控制台提示需要时才填。
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="agent-key">API Key</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="agent-key"
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value, clearApiKey: false })}
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
        <p className="text-[11px] text-muted-foreground">当前状态：{keyState}</p>
      </div>

      <div className="space-y-1.5">
        <Label>回答创造性（Temperature）</Label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={draft.temperature}
            onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })}
            className="flex-1"
          />
          <span className="w-8 text-right text-xs tabular-nums">{draft.temperature.toFixed(1)}</span>
        </div>
        <div className="flex gap-1.5">
          {TEMPERATURE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setDraft({ ...draft, temperature: p.value })}
              className="cursor-pointer rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="agent-topk">检索文档数</Label>
          <Input
            id="agent-topk"
            type="number"
            min={1}
            max={20}
            value={draft.topK}
            onChange={(e) => setDraft({ ...draft, topK: Math.max(1, Number(e.target.value) || 1) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-budget">上下文预算（字符）</Label>
          <Input
            id="agent-budget"
            type="number"
            min={2000}
            step={1000}
            value={draft.contextBudget}
            onChange={(e) =>
              setDraft({ ...draft, contextBudget: Math.max(2000, Number(e.target.value) || 2000) })
            }
          />
        </div>
      </div>

      {/* 检索范围：决定「模型能看到哪些资料」 */}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            检索范围
          </Label>
          <p className="text-[11px] text-muted-foreground">
            决定模型能看到哪些资料。范围收紧后，被排除的文档与附件不会出现在引用里，
            也不会经由回答泄露。加密文档任何情况下都不进入范围。
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {SCOPE_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setDraft({ ...draft, ragScope: { ...draft.ragScope, mode: m.value } })}
              className={`cursor-pointer rounded border px-2 py-1 text-[11px] transition-colors ${
                draft.ragScope.mode === m.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {SCOPE_MODES.find((m) => m.value === draft.ragScope.mode)?.hint}
        </p>

        {draft.ragScope.mode === 'repos' && (
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">参与检索的仓库</Label>
            {repos.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">还没有仓库。请先在「仓库管理」里建一个。</p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded border p-1.5">
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
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
                      <span className="truncate">{r.name}</span>
                      {!r.ragEnabled && (
                        <span className="shrink-0 text-muted-foreground">（已关闭检索）</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {draft.ragScope.mode === 'docs' && (
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">参与检索的文档</Label>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded border p-1.5">
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
          </div>
        )}

        <div className="flex items-start justify-between gap-4 rounded border p-2.5">
          <div className="space-y-1">
            <Label className="text-[11px]">纳入附件正文</Label>
            <p className="text-[11px] text-muted-foreground">
              开启后，附件里能抽出文字的内容（txt/md/docx/pdf 等）也参与检索。
            </p>
          </div>
          <Switch
            checked={draft.ragScope.includeAttachments}
            onCheckedChange={(v) =>
              setDraft({ ...draft, ragScope: { ...draft.ragScope, includeAttachments: v } })
            }
          />
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-1">
          <Label htmlFor="agent-guest" className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            允许访客使用 Agent
          </Label>
          <p className="text-[11px] text-muted-foreground">
            关闭后访客提问将被服务端拒绝；加密文档的正文不进入任何人的检索范围。
          </p>
        </div>
        <Switch
          id="agent-guest"
          checked={draft.allowGuest}
          onCheckedChange={(v) => setDraft({ ...draft, allowGuest: v })}
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          保存配置
        </Button>
      </div>
    </div>
  );
}
