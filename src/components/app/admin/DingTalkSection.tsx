import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlarmClock,
  BellRing,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Play,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type {
  DingTalkChannel,
  DingTalkConfigView,
  Reminder,
  ReminderRepeat,
} from '@/types';

/**
 * 钉钉同步（管理后台 · 钉钉同步分区）。
 *
 * 两件事：
 * - 接入配置：把 WorkHub 接到自己的钉钉上（群机器人 / 工作通知 / 钉钉待办）。
 * - 提醒记录：到点由服务端推送，过程与结果都留痕，可手动补发、标记完成。
 *
 * 配置与密钥都存在服务端：加签密钥与 AppSecret 加密落库，浏览器只拿到
 * 「已配置 / 未配置」，与 Agent 的 API Key 同一口径。
 */

interface Draft {
  enabled: boolean;
  channel: DingTalkChannel;
  webhookUrl: string;
  webhookSecret: string;
  clearWebhookSecret: boolean;
  appKey: string;
  appSecret: string;
  clearAppSecret: boolean;
  robotCode: string;
  userIds: string;
  unionId: string;
  executorIds: string;
  todoBaseUrl: string;
}

const CHANNELS: { id: DingTalkChannel; label: string; desc: string }[] = [
  { id: 'webhook', label: '群机器人', desc: '最省事，只要一个 Webhook 地址（个人自用首选）' },
  { id: 'notify', label: '工作通知', desc: '单聊推给指定成员，不受群机器人频率限制' },
  { id: 'todo', label: '钉钉待办', desc: '在钉钉「待办」列表里留下条目，可点回 WorkHub' },
];

const REPEATS: { id: ReminderRepeat; label: string }[] = [
  { id: 'once', label: '仅一次' },
  { id: 'daily', label: '每天' },
  { id: 'weekly', label: '每周' },
  { id: 'monthly', label: '每月' },
];

const STATUS_META: Record<Reminder['status'], { label: string; cls: string }> = {
  pending: { label: '待触发', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  sent: { label: '已推送', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  done: { label: '已完成', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  cancelled: { label: '已取消', cls: 'bg-slate-500/15 text-slate-600 dark:text-slate-400' },
  failed: { label: '推送失败', cls: 'bg-red-500/15 text-red-600 dark:text-red-400' },
};

/** 时间戳 → datetime-local 输入框的值（本地时区） */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local 的值 → 时间戳；非法输入返回 0 */
function fromLocalInput(value: string): number {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/** 逗号分隔的 id 串 → 数组 */
function splitIds(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 展示用的时间文本 */
function formatTime(ts: number): string {
  return toLocalInput(ts).replace('T', ' ');
}

export function DingTalkSection() {
  const { visibleDocs } = useApp();
  const [config, setConfig] = useState<DingTalkConfigView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loadingReminders, setLoadingReminders] = useState(false);
  const [busyId, setBusyId] = useState('');

  // 新建提醒的表单
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [remindAt, setRemindAt] = useState(() => toLocalInput(Date.now() + 60 * 60 * 1000));
  const [repeat, setRepeat] = useState<ReminderRepeat>('once');
  const [docId, setDocId] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api
      .getDingTalkConfig()
      .then(({ config: c }) => {
        setConfig(c);
        setDraft({
          enabled: c.enabled,
          channel: c.channel,
          webhookUrl: c.webhookUrl,
          // 密钥不回显：留空表示保持原值
          webhookSecret: '',
          clearWebhookSecret: false,
          appKey: c.appKey,
          appSecret: '',
          clearAppSecret: false,
          robotCode: c.robotCode,
          userIds: c.userIds.join(', '),
          unionId: c.unionId,
          executorIds: c.executorIds.join(', '),
          todoBaseUrl: c.todoBaseUrl,
        });
      })
      .catch((e) => toast.error((e as Error)?.message || '读取钉钉配置失败'));
  }, []);

  const loadReminders = useCallback(async (silent = false) => {
    if (!silent) setLoadingReminders(true);
    try {
      const { reminders: list } = await api.listReminders();
      setReminders(list);
    } catch (e) {
      if (!silent) toast.error((e as Error)?.message || '读取提醒记录失败');
    } finally {
      if (!silent) setLoadingReminders(false);
    }
  }, []);

  useEffect(() => {
    void loadReminders();
    // 提醒由服务端在后台触发，前端列表得跟着变，轮询刷新即可
    const timer = setInterval(() => void loadReminders(true), 15000);
    return () => clearInterval(timer);
  }, [loadReminders]);

  const pendingCount = useMemo(() => reminders.filter((r) => r.status === 'pending').length, [reminders]);

  if (!draft) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const { config: saved } = await api.saveDingTalkConfig({
        enabled: draft.enabled,
        channel: draft.channel,
        webhookUrl: draft.webhookUrl.trim(),
        appKey: draft.appKey.trim(),
        robotCode: draft.robotCode.trim(),
        userIds: splitIds(draft.userIds),
        unionId: draft.unionId.trim(),
        executorIds: splitIds(draft.executorIds),
        todoBaseUrl: draft.todoBaseUrl.trim(),
        ...(draft.webhookSecret.trim() ? { webhookSecret: draft.webhookSecret.trim() } : {}),
        ...(draft.clearWebhookSecret ? { clearWebhookSecret: true } : {}),
        ...(draft.appSecret.trim() ? { appSecret: draft.appSecret.trim() } : {}),
        ...(draft.clearAppSecret ? { clearAppSecret: true } : {}),
      });
      setConfig(saved);
      setDraft((d) =>
        d
          ? {
              ...d,
              webhookSecret: '',
              appSecret: '',
              clearWebhookSecret: false,
              clearAppSecret: false,
            }
          : d,
      );
      toast.success('钉钉配置已保存');
    } catch (e) {
      toast.error((e as Error)?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      // 用草稿测试：改完不必先保存就能验证对错
      const { message } = await api.testDingTalk({
        channel: draft.channel,
        webhookUrl: draft.webhookUrl.trim(),
        appKey: draft.appKey.trim(),
        robotCode: draft.robotCode.trim(),
        userIds: splitIds(draft.userIds),
        unionId: draft.unionId.trim(),
        executorIds: splitIds(draft.executorIds),
        todoBaseUrl: draft.todoBaseUrl.trim(),
        ...(draft.webhookSecret.trim() ? { webhookSecret: draft.webhookSecret.trim() } : {}),
        ...(draft.appSecret.trim() ? { appSecret: draft.appSecret.trim() } : {}),
      });
      toast.success(message);
    } catch (e) {
      toast.error((e as Error)?.message || '测试失败');
    } finally {
      setTesting(false);
    }
  };

  const handleCreate = async () => {
    if (!title.trim()) {
      toast.error('提醒标题不能为空');
      return;
    }
    const ts = fromLocalInput(remindAt);
    if (!ts) {
      toast.error('提醒时间无效');
      return;
    }
    setCreating(true);
    try {
      await api.createReminder({
        title: title.trim(),
        content,
        remindAt: ts,
        repeat,
        ...(docId ? { docId } : {}),
      });
      toast.success('提醒已创建，到点会自动推送到钉钉');
      setTitle('');
      setContent('');
      setDocId('');
      setFormOpen(false);
      await loadReminders(true);
    } catch (e) {
      toast.error((e as Error)?.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleFire = async (id: string) => {
    setBusyId(id);
    try {
      await api.fireReminder(id);
      toast.success('已推送到钉钉');
      await loadReminders(true);
    } catch (e) {
      toast.error((e as Error)?.message || '推送失败');
      await loadReminders(true);
    } finally {
      setBusyId('');
    }
  };

  const handleStatus = async (id: string, status: 'done' | 'cancelled') => {
    setBusyId(id);
    try {
      await api.updateReminder(id, { status });
      await loadReminders(true);
    } catch (e) {
      toast.error((e as Error)?.message || '操作失败');
    } finally {
      setBusyId('');
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await api.deleteReminder(id);
      toast.success('已删除');
      await loadReminders(true);
    } catch (e) {
      toast.error((e as Error)?.message || '删除失败');
    } finally {
      setBusyId('');
    }
  };

  const secretState = (has: boolean, filled: boolean, clearing: boolean): string => {
    if (clearing) return '待清除';
    if (filled) return '待更新';
    return has ? '已配置（保持不变）' : '未配置';
  };

  return (
    <div className="space-y-6">
      {/* ---------------- 接入配置 ---------------- */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <Label htmlFor="dingtalk-enabled" className="flex items-center gap-1.5">
              <BellRing className="h-3.5 w-3.5" />
              开启钉钉同步
            </Label>
            <p className="text-[11px] text-muted-foreground">
              关闭后服务端不再自动推送任何提醒；已建的提醒记录仍会保留。
            </p>
          </div>
          <Switch
            id="dingtalk-enabled"
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
          />
        </div>

        <div className="space-y-1.5">
          <Label>推送通道</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {CHANNELS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setDraft({ ...draft, channel: c.id })}
                className={
                  'rounded-lg border p-2.5 text-left transition-colors ' +
                  (draft.channel === c.id
                    ? 'border-indigo-400 bg-indigo-50/70 dark:bg-indigo-900/30'
                    : 'hover:bg-accent/50')
                }
              >
                <span className="block text-sm font-medium">{c.label}</span>
                <span className="block text-[11px] text-muted-foreground">{c.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {draft.channel === 'webhook' && (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="ding-webhook">机器人 Webhook 地址</Label>
              <Input
                id="ding-webhook"
                value={draft.webhookUrl}
                onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })}
                placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxx"
              />
              <p className="text-[11px] text-muted-foreground">
                钉钉群里「智能群助手 → 添加机器人 → 自定义」，复制 Webhook 地址。
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ding-webhook-secret">加签密钥（SEC 开头）</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ding-webhook-secret"
                    type={showSecret ? 'text' : 'password'}
                    value={draft.webhookSecret}
                    onChange={(e) =>
                      setDraft({ ...draft, webhookSecret: e.target.value, clearWebhookSecret: false })
                    }
                    placeholder={config?.hasWebhookSecret ? '已加密存储，留空则保持不变' : 'SEC...'}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                    title={showSecret ? '隐藏' : '显示'}
                  >
                    {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {config?.hasWebhookSecret && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 text-[11px]"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        clearWebhookSecret: !draft.clearWebhookSecret,
                        webhookSecret: '',
                      })
                    }
                  >
                    {draft.clearWebhookSecret ? '取消清除' : '清除'}
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                当前状态：
                {secretState(
                  Boolean(config?.hasWebhookSecret),
                  Boolean(draft.webhookSecret.trim()),
                  draft.clearWebhookSecret,
                )}
                。机器人安全设置若选了「加签」则必填；若只选了关键词 / IP 白名单可留空。
              </p>
            </div>
          </div>
        )}

        {draft.channel !== 'webhook' && (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="ding-appkey">AppKey</Label>
              <Input
                id="ding-appkey"
                value={draft.appKey}
                onChange={(e) => setDraft({ ...draft, appKey: e.target.value })}
                placeholder="dingxxxxxxxxxxxxxxxx"
              />
              <p className="text-[11px] text-muted-foreground">
                钉钉开放平台 → 应用开发 → 企业内部应用，取 AppKey 与 AppSecret。
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ding-appsecret">AppSecret</Label>
              <Input
                id="ding-appsecret"
                type={showSecret ? 'text' : 'password'}
                value={draft.appSecret}
                onChange={(e) => setDraft({ ...draft, appSecret: e.target.value, clearAppSecret: false })}
                placeholder={config?.hasAppSecret ? '已加密存储，留空则保持不变' : 'AppSecret'}
              />
              <p className="text-[11px] text-muted-foreground">
                当前状态：
                {secretState(
                  Boolean(config?.hasAppSecret),
                  Boolean(draft.appSecret.trim()),
                  draft.clearAppSecret,
                )}
              </p>
            </div>
          </div>
        )}

        {draft.channel === 'notify' && (
          <div className="space-y-3 rounded-lg border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ding-robotcode">机器人 Code</Label>
                  <Input
                    id="ding-robotcode"
                    value={draft.robotCode}
                    onChange={(e) => setDraft({ ...draft, robotCode: e.target.value })}
                    placeholder="留空则与 AppKey 相同"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ding-users">接收人 userid</Label>
                  <Input
                    id="ding-users"
                    value={draft.userIds}
                    onChange={(e) => setDraft({ ...draft, userIds: e.target.value })}
                    placeholder="多个用英文逗号分隔，如 zhangsan,lisi"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    需在开放平台为应用开通「机器人工作通知」权限点。
                  </p>
                </div>
          </div>
        )}

        {draft.channel === 'todo' && (
          <div className="space-y-3 rounded-lg border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ding-unionid">待办归属人 unionId</Label>
                  <Input
                    id="ding-unionid"
                    value={draft.unionId}
                    onChange={(e) => setDraft({ ...draft, unionId: e.target.value })}
                    placeholder="钉钉通讯录成员的 unionId"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    需在开放平台为应用开通「待办应用中待办写权限」。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ding-executors">待办执行人 userid</Label>
                  <Input
                    id="ding-executors"
                    value={draft.executorIds}
                    onChange={(e) => setDraft({ ...draft, executorIds: e.target.value })}
                    placeholder="多个用英文逗号分隔"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ding-baseurl">WorkHub 访问地址</Label>
                  <Input
                    id="ding-baseurl"
                    value={draft.todoBaseUrl}
                    onChange={(e) => setDraft({ ...draft, todoBaseUrl: e.target.value })}
                    placeholder="http://192.168.1.10:5173"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    钉钉工作待办必须带跳转链接，点待办才能回到 WorkHub。
                  </p>
                </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => void handleTest()} disabled={testing}>
            {testing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            <Send className="mr-1.5 h-3.5 w-3.5" />
            发送测试消息
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            保存配置
          </Button>
        </div>
      </section>

      {/* ---------------- 提醒记录 ---------------- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-0.5">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <AlarmClock className="h-4 w-4 text-indigo-500" />
              提醒记录
              <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-normal text-indigo-600 dark:text-indigo-400">
                {pendingCount} 条待触发
              </span>
            </h3>
            <p className="text-[11px] text-muted-foreground">
              到点由服务端推送，浏览器关着也一样会响。
            </p>
          </div>
          <Button variant={formOpen ? 'ghost' : 'outline'} size="sm" onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? '收起' : '新建提醒'}
          </Button>
        </div>

        {formOpen && (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="rem-title">提醒标题</Label>
              <Input
                id="rem-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="如：发布前检查清单"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rem-content">提醒内容（可选）</Label>
              <Textarea
                id="rem-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                placeholder="推送到钉钉时一并带上的正文"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rem-time">提醒时间</Label>
                <Input
                  id="rem-time"
                  type="datetime-local"
                  value={remindAt}
                  onChange={(e) => setRemindAt(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rem-repeat">重复</Label>
                <div className="flex gap-1.5">
                  {REPEATS.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRepeat(r.id)}
                      className={
                        'cursor-pointer rounded border border-border px-2 py-1 text-[11px] transition-colors ' +
                        (repeat === r.id
                          ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
                          : 'text-muted-foreground hover:bg-accent')
                      }
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rem-doc">关联文档（可选）</Label>
              <select
                id="rem-doc"
                value={docId}
                onChange={(e) => setDocId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring"
              >
                <option value="">不关联</option>
                {visibleDocs
                  .filter((d) => d.type === 'file')
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void handleCreate()} disabled={creating}>
                {creating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                创建提醒
              </Button>
            </div>
          </div>
        )}

        {loadingReminders ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            读取中…
          </div>
        ) : reminders.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
            还没有提醒记录。点「新建提醒」排一条，到点会自动推到钉钉。
          </p>
        ) : (
          <ul className="space-y-2">
            {reminders.map((r) => {
              const meta = STATUS_META[r.status];
              const busy = busyId === r.id;
              return (
                <li key={r.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{r.title}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${meta.cls}`}>{meta.label}</span>
                        {r.repeat !== 'once' && (
                          <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] text-slate-600 dark:text-slate-400">
                            {REPEATS.find((x) => x.id === r.repeat)?.label}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {formatTime(r.remindAt)}
                        {r.docName ? ` · 关联《${r.docName}》` : ''}
                        {r.fireCount > 0 ? ` · 已推送 ${r.fireCount} 次` : ''}
                      </p>
                      {r.content && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.content}</p>}
                      {r.lastError && (
                        <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">上次失败：{r.lastError}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="立即推送"
                        disabled={busy}
                        onClick={() => void handleFire(r.id)}
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="标记完成"
                        disabled={busy || r.status === 'done'}
                        onClick={() => void handleStatus(r.id, 'done')}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="取消提醒"
                        disabled={busy || r.status === 'cancelled' || r.status === 'done'}
                        onClick={() => void handleStatus(r.id, 'cancelled')}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500"
                        title="删除记录"
                        disabled={busy}
                        onClick={() => void handleDelete(r.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
