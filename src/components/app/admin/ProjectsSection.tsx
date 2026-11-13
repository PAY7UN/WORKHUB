import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Boxes,
  History,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatBytes } from '@/lib/attachments';
import { formatRelativeTime } from '@/utils';
import type { Repo, RepoEvent, RepoEventAction } from '@/types';

const PRESET_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

/** 体积上限的可选档位（MB） */
const SIZE_PRESETS = [5, 10, 25, 50, 100];

/** 事件的动作样式：一眼分清「建了」「改了」「搬了」「没了」 */
const ACTION_STYLE: Record<RepoEventAction, { icon: typeof Plus; cls: string; label: string }> = {
  created: { icon: Plus, cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', label: '新建' },
  updated: { icon: Pencil, cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', label: '调整' },
  migrated: { icon: ArrowRightLeft, cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', label: '迁移' },
  deleted: { icon: Trash2, cls: 'bg-red-500/15 text-red-600 dark:text-red-400', label: '删除' },
};

interface DraftRepo {
  name: string;
  description: string;
  color: string;
  /** 允许格式，用逗号分隔的文本编辑，保存时拆成数组 */
  allowedExtsText: string;
  maxFileSizeMb: number;
  ragEnabled: boolean;
}

const emptyDraft = (): DraftRepo => ({
  name: '',
  description: '',
  color: PRESET_COLORS[0],
  allowedExtsText: '',
  maxFileSizeMb: 25,
  ragEnabled: true,
});

const draftFrom = (r: Repo): DraftRepo => ({
  name: r.name,
  description: r.description,
  color: r.color,
  allowedExtsText: r.allowedExts.join(', '),
  maxFileSizeMb: Math.round(r.maxFileSize / 1024 / 1024),
  ragEnabled: r.ragEnabled,
});

/**
 * 项目仓库（管理后台）。
 *
 * 仓库是「一个项目」的容器，存在是为了让差异各归其位：
 * - 不同项目留存的格式不同 → 允许格式按仓库设；
 * - 不同项目涉及的资料敏感度不同 → 检索开关按仓库设；
 * - 不同项目要整体搬走 → 迁移以仓库为单位。
 *
 * 把这些做成全局配置，则每个项目都要迁就别人的规矩。
 *
 * 这里有两块：**当前项目**（还在架上的仓库）与**历史**（它们发生过什么）。
 * 历史不是从当前状态反推的——更新会覆盖旧值、删除会连行一起没，
 * 所以每一次变动都是当场记下来的流水，仓库没了以后那条记录仍留得住。
 */
export function ProjectsSection() {
  const { repos, repoStats, refreshRepos } = useApp();
  const [view, setView] = useState<'current' | 'history'>('current');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRepo>(emptyDraft());
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [events, setEvents] = useState<RepoEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const statOf = (id: string) => repoStats.find((s) => s.repoId === id);

  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const { events: list } = await api.listRepoEvents();
      setEvents(list);
    } catch (e) {
      toast.error((e as Error)?.message ?? '历史加载失败');
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  // 切到历史时再拉：没人看历史时不必每次进后台都多打一次请求
  useEffect(() => {
    if (view === 'history') void loadEvents();
  }, [view, loadEvents]);

  const startCreate = () => {
    setCreating(true);
    setEditing(null);
    setDraft(emptyDraft());
  };

  const startEdit = (r: Repo) => {
    setCreating(false);
    setEditing(r.id);
    setDraft(draftFrom(r));
  };

  const submit = async () => {
    const name = draft.name.trim();
    if (!name) {
      toast.error('仓库名称不能为空');
      return;
    }
    const allowedExts = draft.allowedExtsText
      .split(/[,，\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .map((s) => (s.startsWith('.') ? s : `.${s}`));

    setBusy(true);
    try {
      if (creating) {
        await api.createRepo({
          name,
          description: draft.description.trim(),
          color: draft.color,
          allowedExts,
          maxFileSize: draft.maxFileSizeMb * 1024 * 1024,
          ragEnabled: draft.ragEnabled,
        });
        toast.success(`项目仓库「${name}」已创建`);
        setCreating(false);
      } else if (editing) {
        await api.updateRepo(editing, {
          name,
          description: draft.description.trim(),
          color: draft.color,
          allowedExts,
          maxFileSize: draft.maxFileSizeMb * 1024 * 1024,
          ragEnabled: draft.ragEnabled,
        });
        toast.success('仓库设置已保存');
        setEditing(null);
      }
      await refreshRepos();
      // 刚发生过的事要立刻出现在历史里，否则「保存了但历史没变」最让人不信
      if (view === 'history') void loadEvents();
    } catch (e) {
      toast.error((e as Error)?.message ?? '保存失败');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 删仓库就是真删：里面的文档与附件一并消失，没有回收站。
   *
   * 所以删之前必须让人知道会连带清掉多少东西——
   * 这一步省不得，否则一次误点就是一整块资料没了。
   */
  const remove = async (r: Repo) => {
    const stat = statOf(r.id);
    const docCount = stat?.docCount ?? 0;
    const attCount = stat?.attachmentCount ?? 0;
    const confirmed = window.confirm(
      `删除仓库「${r.name}」？\n\n` +
        (docCount || attCount
          ? `其中的 ${docCount} 篇文档、${attCount} 个附件会一并删除，且无法恢复。\n` +
            '确认内容已经导出或转移过了吗？'
          : '该操作无法恢复。'),
    );
    if (!confirmed) return;
    try {
      const res = await api.deleteRepo(r.id);
      toast.success(
        res.removed
          ? `仓库「${r.name}」已删除，连带清掉 ${res.docs} 篇文档、${res.attachments} 个附件`
          : '仓库已不存在',
      );
      await refreshRepos();
      if (view === 'history') void loadEvents();
    } catch (e) {
      toast.error((e as Error)?.message ?? '操作失败');
    }
  };

  const form = (key: keyof DraftRepo) => (
    <div className="space-y-1.5">
      <Label className="text-[11px] text-muted-foreground">
        {key === 'name' && '名称'}
        {key === 'description' && '说明'}
        {key === 'color' && '色标'}
        {key === 'allowedExtsText' && '允许的格式'}
        {key === 'maxFileSizeMb' && '单文件体积上限'}
        {key === 'ragEnabled' && '参与 AI 检索'}
      </Label>

      {key === 'name' && (
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="例如：客户 A 交付"
        />
      )}
      {key === 'description' && (
        <Input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="这个仓库放什么资料"
        />
      )}
      {key === 'color' && (
        <div className="flex gap-1.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setDraft({ ...draft, color: c })}
              className={
                'h-6 w-6 cursor-pointer rounded-full border-2 transition-transform ' +
                (draft.color === c ? 'border-foreground scale-110' : 'border-transparent')
              }
              style={{ background: c }}
              aria-label={`选择颜色 ${c}`}
            />
          ))}
        </div>
      )}
      {key === 'allowedExtsText' && (
        <>
          <Input
            value={draft.allowedExtsText}
            onChange={(e) => setDraft({ ...draft, allowedExtsText: e.target.value })}
            placeholder="留空 = 不限格式；例：.md .pdf .docx"
          />
          <p className="text-[10px] text-muted-foreground">
            留空表示不限格式——先放开再收紧，比一开始就锁死更实用。
          </p>
        </>
      )}
      {key === 'maxFileSizeMb' && (
        <div className="flex flex-wrap gap-1.5">
          {SIZE_PRESETS.map((mb) => (
            <button
              key={mb}
              type="button"
              onClick={() => setDraft({ ...draft, maxFileSizeMb: mb })}
              className={
                'cursor-pointer rounded border px-2 py-0.5 text-[11px] transition-colors ' +
                (draft.maxFileSizeMb === mb
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent')
              }
            >
              {mb}MB
            </button>
          ))}
        </div>
      )}
      {key === 'ragEnabled' && (
        <div className="flex items-start justify-between gap-3 rounded border p-2.5">
          <div className="space-y-0.5">
            <p className="text-[11px]">参与 AI 检索</p>
            <p className="text-[10px] text-muted-foreground">
              关掉后，这个仓库的资料只留档、不进入模型视野。范围控制里最粗的一档。
            </p>
          </div>
          <Switch
            checked={draft.ragEnabled}
            onCheckedChange={(v) => setDraft({ ...draft, ragEnabled: v })}
          />
        </div>
      )}
    </div>
  );

  /** 子视图切换：当前项目 / 历史 */
  const subTab = (id: 'current' | 'history', label: string, icon: typeof Boxes) => {
    const Icon = icon;
    const active = view === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => setView(id)}
        className={
          'flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] transition-colors ' +
          (active
            ? 'bg-indigo-500/12 font-medium text-indigo-600 dark:text-indigo-300'
            : 'text-muted-foreground hover:bg-slate-100 hover:text-foreground dark:hover:bg-white/5')
        }
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Boxes className="h-4 w-4 text-indigo-500" />
            项目仓库
          </h3>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            按「项目」把资料分块留存。每个仓库自带一套留存规则（允许格式、体积上限）与检索开关，
            不同项目的差异因此不必互相迁就。删除仓库会连带清掉其中的文档与附件，没有回收站。
          </p>
        </div>
        {view === 'current' && (
          <Button size="sm" variant="outline" onClick={startCreate} className="shrink-0">
            <Plus className="h-3.5 w-3.5" />
            新建仓库
          </Button>
        )}
      </div>

      {/* 内部再分两块：还活着的项目，和它们的历史 */}
      <div className="flex items-center gap-1">
        {subTab('current', '当前项目', Boxes)}
        {subTab('history', '历史', History)}
      </div>

      {view === 'current' && (
        <>
          {/* 新建 / 编辑表单 */}
          {(creating || editing) && (
            <div className="space-y-3 rounded-lg border border-indigo-200/70 bg-indigo-50/30 p-3 dark:border-indigo-900/50 dark:bg-indigo-950/20">
              <p className="text-xs font-medium">{creating ? '新建仓库' : '编辑仓库设置'}</p>
              {(
                [
                  'name',
                  'description',
                  'color',
                  'allowedExtsText',
                  'maxFileSizeMb',
                  'ragEnabled',
                ] as const
              ).map((k) => (
                <div key={k}>{form(k)}</div>
              ))}
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void submit()} disabled={busy}>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCreating(false);
                    setEditing(null);
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          )}

          {/* 项目卡片 */}
          {repos.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-[11px] text-muted-foreground">
              还没有仓库。建一个之后，就能给不同项目各自设定留存格式与检索范围了。
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {repos.map((r) => {
                const stat = statOf(r.id);
                return (
                  <li
                    key={r.id}
                    className="flex flex-col rounded-xl border border-border/60 bg-white/60 p-3.5 transition-shadow hover:shadow-sm dark:bg-white/5"
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: r.color }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{r.name}</p>
                        {r.description && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                            {r.description}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* 规模 */}
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      {stat
                        ? `${stat.docCount} 篇文档 · ${stat.attachmentCount} 个附件 · ${formatBytes(stat.totalSize)}`
                        : '暂无文档'}
                    </p>

                    {/* 规则 */}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {!r.ragEnabled && (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                          不参与检索
                        </span>
                      )}
                      {r.allowedExts.length > 0 && (
                        <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          仅 {r.allowedExts.join(' ')}
                        </span>
                      )}
                      <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        ≤{Math.round(r.maxFileSize / 1024 / 1024)}MB
                      </span>
                    </div>

                    {/* 来历 */}
                    <p className="mt-2 text-[10px] text-muted-foreground/80">
                      创建于 {formatRelativeTime(r.createdAt)}
                      {r.updatedAt > r.createdAt && ` · 最后调整 ${formatRelativeTime(r.updatedAt)}`}
                    </p>

                    {/*
                     * mt-auto：等高的卡片里，操作行贴着底边。
                     * 否则说明少的仓库（比如刚建的空仓库）下半截全是空白，
                     * 一屏看过去像几张没写完的卡。
                     */}
                    <div className="mt-auto flex gap-1 border-t border-border/50 pt-2.5">
                      <Button size="sm" variant="ghost" onClick={() => startEdit(r)}>
                        设置
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void remove(r)}
                        title="删除仓库（连带其中的文档与附件）"
                        className="ml-auto"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-600" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {view === 'history' && (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            每个仓库的每一次变动都记在这里。仓库删掉了也不抹掉这条记录——
            「这个项目是什么时候没的、当时带走了多少东西」日后一定会被问到。
          </p>

          {loadingEvents ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在取历史
            </div>
          ) : events.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-[11px] text-muted-foreground">
              还没有任何变动记录。新建、改设置、迁移、删除都会在这里留下一条。
            </p>
          ) : (
            <ol className="relative space-y-2 border-l border-border/60 pl-4">
              {events.map((e) => {
                const style = ACTION_STYLE[e.action];
                const Icon = style.icon;
                return (
                  <li key={e.id} className="relative">
                    <span
                      className={
                        'absolute -left-[22px] flex h-5 w-5 items-center justify-center rounded-full ' +
                        style.cls
                      }
                    >
                      <Icon className="h-3 w-3" />
                    </span>
                    <div className="rounded-lg border border-border/60 bg-white/60 px-3 py-2 dark:bg-white/5">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[12px] font-medium">{e.repoName}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {style.label} · {formatRelativeTime(e.createdAt)}
                        </span>
                      </div>
                      {e.detail && (
                        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                          {e.detail}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
