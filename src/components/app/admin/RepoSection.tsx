import { useState } from 'react';
import { Boxes, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatBytes } from '@/lib/attachments';
import type { Repo } from '@/types';

const PRESET_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

/** 体积上限的可选档位（MB） */
const SIZE_PRESETS = [5, 10, 25, 50, 100];

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
 * 仓库管理（管理后台 · 仓库管理分区）。
 *
 * 仓库是「一个项目」的容器，存在是为了让差异各归其位：
 * - 不同项目留存的格式不同 → 允许格式按仓库设；
 * - 不同项目涉及的资料敏感度不同 → 检索开关按仓库设；
 * - 不同项目要整体搬走 → 迁移以仓库为单位。
 *
 * 把这些做成全局配置，则每个项目都要迁就别人的规矩。
 */
export function RepoSection() {
  const { repos, repoStats, refreshRepos } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRepo>(emptyDraft());
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const statOf = (id: string) => repoStats.find((s) => s.repoId === id);

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
        toast.success(`仓库「${name}」已创建`);
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
          <Switch checked={draft.ragEnabled} onCheckedChange={(v) => setDraft({ ...draft, ragEnabled: v })} />
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Boxes className="h-4 w-4 text-indigo-500" />
            仓库管理
          </h3>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            按「项目」把资料分块留存。每个仓库自带一套留存规则（允许格式、体积上限）与检索开关，
            不同项目的差异因此不必互相迁就。删除仓库会连带清掉其中的文档与附件，没有回收站。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={startCreate} className="shrink-0">
          <Plus className="h-3.5 w-3.5" />
          新建仓库
        </Button>
      </div>

      {/* 新建 / 编辑表单 */}
      {(creating || editing) && (
        <div className="space-y-3 rounded-lg border border-indigo-200/70 bg-indigo-50/30 p-3 dark:border-indigo-900/50 dark:bg-indigo-950/20">
          <p className="text-xs font-medium">{creating ? '新建仓库' : '编辑仓库设置'}</p>
          {(['name', 'description', 'color', 'allowedExtsText', 'maxFileSizeMb', 'ragEnabled'] as const).map((k) => (
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

      {/* 仓库列表 */}
      {repos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground">
          还没有仓库。建一个之后，就能给不同项目各自设定留存格式与检索范围了。
        </p>
      ) : (
        <ul className="space-y-2">
          {repos.map((r) => {
            const stat = statOf(r.id);
            return (
              <li key={r.id} className="rounded-lg border p-3">
                <div className="flex items-start gap-2.5">
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{r.name}</span>
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
                    {r.description && <p className="text-[11px] text-muted-foreground">{r.description}</p>}
                    <p className="text-[10px] text-muted-foreground">
                      {stat
                        ? `${stat.docCount} 篇文档 · ${stat.attachmentCount} 个附件 · ${formatBytes(stat.totalSize)}`
                        : '暂无文档'}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(r)}>
                      设置
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void remove(r)}
                      title="删除仓库（连带其中的文档与附件）"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-600" />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
