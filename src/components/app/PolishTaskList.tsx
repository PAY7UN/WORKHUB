import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Trash2,
  ChevronDown,
  ChevronRight,
  Undo2,
  Square,
} from 'lucide-react';
import type { PolishTask } from '../../../shared/types';
import { summarizePolishDiff } from '../../../shared/polish';
import { Button } from '@/components/ui/button';
import { MarkdownPreview } from './MarkdownPreview';
import { cn } from '@/lib/utils';

interface PolishTaskListProps {
  tasks: PolishTask[];
  /** 进行中任务的实时增量；最终结果以 task.result 为准 */
  live: Record<string, string>;
  reasoning: Record<string, string>;
  onApply: (task: PolishTask) => void;
  onRemove: (id: string) => void;
  /** 清空全部已结束的任务，进行中的保留 */
  onClearFinished: () => Promise<void>;
  /** 正在回填的任务 id，用于禁用重复提交 */
  applyingId: string;
}

/** 时间戳格式化为相对时间，避免任务列表被生硬的绝对时间占满 */
function relTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ts).toLocaleDateString();
}

interface PaneProps {
  label: string;
  source: string;
  /** 无内容时的占位文案 */
  placeholder: string;
  tone?: 'plain' | 'result' | 'pending';
}

/** 对比中的单栏：标题 + 可滚动正文 */
function Pane({ label, source, placeholder, tone = 'plain' }: PaneProps) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          'scrollbar-thin max-h-60 overflow-y-auto overflow-x-hidden rounded-lg border px-2.5 py-2',
          tone === 'result' &&
            'border-indigo-200 bg-indigo-50/50 dark:border-indigo-900/60 dark:bg-indigo-950/20',
          tone === 'pending' && 'border-dashed',
          tone === 'plain' && 'bg-muted/20',
        )}
      >
        {source ? (
          <MarkdownPreview source={source} compact className="text-xs" />
        ) : (
          <p className="text-[11px] text-muted-foreground">{placeholder}</p>
        )}
      </div>
    </div>
  );
}

/** 头部操作区的小按钮：图标 + 文案，禁用时不响应点击 */
function IconBtn({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] transition-colors',
        'text-muted-foreground hover:bg-accent hover:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/**
 * 改动摘要：删了多少、加了什么。
 *
 * 只给一个数字不够——「改动 12 处」不告诉用户改了什么，而用户点开任务的目的
 * 恰恰是这个。列出被删除与被新增的代表性行，比逐行比对两侧全文快得多。
 *
 * 做成独立组件而非在列表的 map 回调里现算：diff 要跑一次行级最长公共子序列，
 * 放回调里每次渲染都重算；独立组件用 useMemo 依赖原值，只在结果真正变化时算一次，
 * 且没展开的任务根本不渲染它，也就不算。
 */
function DiffSummary({ task }: { task: PolishTask }) {
  const diff = useMemo(
    () =>
      task.status === 'done' && task.result
        ? summarizePolishDiff(task.content ?? '', task.result)
        : null,
    [task.status, task.result, task.content],
  );
  if (!diff) return null;

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] leading-relaxed dark:border-slate-700 dark:bg-slate-800/40">
      <div className="text-muted-foreground">
        删除 <span className="font-medium text-rose-600 dark:text-rose-400">{diff.removed}</span> 行 · 新增{' '}
        <span className="font-medium text-emerald-600 dark:text-emerald-400">{diff.added}</span> 行
        {diff.sourceLines > 0 && <span className="text-muted-foreground/70"> · 原文 {diff.sourceLines} 行</span>}
      </div>
      {diff.removedSamples.length > 0 && (
        <div className="mt-1 min-w-0">
          <span className="text-muted-foreground">删除：</span>
          {diff.removedSamples.map((line, i) => (
            <div key={i} className="truncate text-rose-600/90 line-through dark:text-rose-400/80">
              {line}
            </div>
          ))}
        </div>
      )}
      {diff.addedSamples.length > 0 && (
        <div className="mt-1 min-w-0">
          <span className="text-muted-foreground">新增：</span>
          {diff.addedSamples.map((line, i) => (
            <div key={i} className="truncate text-emerald-600/90 dark:text-emerald-400/80">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 润色任务列表。
 *
 * 润色的收益集中在结构与排版上，纯文本下标题、列表的差异看不出来，用户会
 * 误判为「没有提升」，因此结果一律按 Markdown 渲染后再做对比。
 *
 * 删除分两个层次，对应不同的意图：行尾图标删单条、「清空已完成」收尾历史。
 * 破坏性操作统一走内联确认条，因为面板只有 448px 宽，弹窗会遮住用户正要确认
 * 删除的内容。
 */
export function PolishTaskList({
  tasks,
  live,
  reasoning,
  onApply,
  onRemove,
  onClearFinished,
  applyingId,
}: PolishTaskListProps) {
  const [expanded, setExpanded] = useState<string>('');
  /**
   * 已自动展开过的任务 id。
   *
   * 润色是**同步输出**的任务：模型边生成边推增量，展开就能实时看着文档被改写。
   * 原先新任务默认折叠，用户只看到一个转圈的小条，必须点开才知道有没有在动，
   * 于是「在流式输出」被感知成「卡住了」。自动展开能把这个差别直接抹掉。
   *
   * 用 ref 记录而非每次 tasks 变化都强制展开：否则用户手动折叠后，下一次增量
   * 推送又把它弹开，折叠这个动作就永远做不到。
   */
  const autoExpanded = useRef<Set<string>>(new Set());
  /**
   * 思考期的计时快照。
   *
   * 推理模型开头可能几十秒到几分钟不吐字（实测 M3 在深度润色下可达 235 秒），
   * 此时界面上一个字都没有。只放一个转圈，用户无法区分「正在思考」「已经死了」
   * 和「网断了」。显示已用时能明确传达「还活着，在等」，也让长等待有了进度感。
   * 仅在存在进行中任务时才起定时器，任务全部结束后不再空转。
   */
  const [now, setNow] = useState(() => Date.now());
  const hasRunning = tasks.some((t) => t.status === 'running');
  useEffect(() => {
    const fresh = tasks.find((t) => t.status === 'running' && !autoExpanded.current.has(t.id));
    if (fresh) {
      autoExpanded.current.add(fresh.id);
      setExpanded(fresh.id);
    }
  }, [tasks]);

  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);
  /**
   * 默认单栏而非左右并排。
   *
   * 面板宽度上限 448px，两列并排后每栏净宽仅约 210px，行内代码几乎没有
   * 不折行的余地：`cd /mnt/ubstate/front/` 这类无空格路径会被
   * word-wrap: break-word 拦腰截断，命令看起来像被写错了。对比视图
   * 交由用户按需切换，默认展示宽度翻倍的结果栏。
   */
  const [view, setView] = useState<'result' | 'source' | 'diff'>('result');
  /** 待确认的破坏性操作文案。用内联确认条而非弹窗：面板仅 448px 宽，弹窗会遮住待删内容 */
  const [confirm, setConfirm] = useState<string | null>(null);

  /** 执行确认条里的「清空已完成」 */
  const runConfirmed = async () => {
    if (!confirm) return;
    setConfirm(null);
    try {
      await onClearFinished();
    } catch {
      /* 失败已由父级提示并刷新列表，这里只需避免未处理的 rejection */
    }
  };

  if (!tasks.length) return null;

  const runningCount = tasks.filter((t) => t.status === 'running').length;
  const finishedCount = tasks.length - runningCount;
  const views: Array<{ key: typeof view; label: string }> = [
    { key: 'result', label: '润色结果' },
    { key: 'source', label: '原文' },
    { key: 'diff', label: '对比' },
  ];

  return (
    <div className="border-b bg-muted/10">
      <div className="flex items-center gap-1.5 px-4 py-2">
        <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
        <span className="text-[11px] font-medium text-muted-foreground">润色任务</span>
        <span className="text-[11px] text-muted-foreground/70">
          {runningCount > 0 ? `${runningCount} 个进行中 / 共 ${tasks.length} 个` : `共 ${tasks.length} 个`}
        </span>

        <div className="ml-auto flex items-center gap-0.5">
          {finishedCount > 0 && (
            <IconBtn
              title="清空所有已结束的任务，进行中的保留"
              onClick={() =>
                setConfirm(
                  `将删除 ${finishedCount} 个已结束的任务` +
                    (runningCount
                      ? `，${runningCount} 个正在生成的任务会继续运行。删除后无法恢复。`
                      : '。删除后无法恢复。'),
                )
              }
            >
              <Trash2 className="h-3 w-3" />
              清空已完成
            </IconBtn>
          )}
        </div>
      </div>

      {confirm && (
        <div className="mx-2 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <p>{confirm}</p>
          <div className="mt-1.5 flex gap-1">
            <Button size="sm" className="h-7 text-xs" variant="destructive" onClick={() => void runConfirmed()}>
              确认删除
            </Button>
            <Button size="sm" className="h-7 text-xs" variant="ghost" onClick={() => setConfirm(null)}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* 48vh 而非固定 288px：任务展开后正文可达数百像素，
          固定高度会把「应用到文档」挤到需要滚动才能看见的位置 */}
      <div className="scrollbar-thin max-h-[48vh] overflow-y-auto px-2 pb-2">
        {tasks.map((task) => {
          const open = expanded === task.id;
          const running = task.status === 'running';
          const resultText = running ? live[task.id] ?? '' : task.result;
          const thinkText = reasoning[task.id] ?? '';
          /** 已用时。流式输出前没有任何内容可显示，它就是用户唯一能看到的进度 */
          const elapsedSec = running ? Math.max(0, Math.round((now - task.createdAt) / 1000)) : 0;
          /** 尚未收到任何增量（含思考过程）：此时界面是空的，必须显式说明在等什么 */
          const waiting = running && !resultText && !thinkText;
          /**
           * 「几乎没改」的判定与提示。
           *
           * 没有它，用户看到的是「任务已完成、文档却几乎没变」，只能靠猜是失败了
           * 还是本来就没什么可改——命令清单这类文档即使走默认的排版整理也常如此。
           *
           * 措辞上只陈述事实，不替用户下结论说「原文本身已较规范」：改动少有多种
           * 可能（原文规范、模型保守、范围收得太窄），断言其中一种会让用户照着
           * 错误的前提去改设置。
           *
           * 必须以 changedLines 是否存在为准：旧任务没有这个字段，按 0 处理会误报
           * 「改动 0 处」。短文档低于 8 行不提示——只改一两行本来就不算少。
           */
          const sourceLines = (task.content ?? '').split('\n').filter((l) => l.trim()).length;
          const changed = typeof task.changedLines === 'number' ? task.changedLines : null;
          const barelyChanged =
            task.status === 'done' && changed !== null && sourceLines >= 8 && changed / sourceLines < 0.1;
          const changeTip =
            barelyChanged && changed !== null
              ? `本次改动仅 ${changed} 处（约 ${Math.round((changed / sourceLines) * 100)}%），幅度很小。` +
                '想明显压缩篇幅可改用「只精简」预设；想收窄到某一项，可在提交时用「高级选项」写明。'
              : '';
          const statusText = running
            ? elapsedSec >= 1
              ? `生成中 ${elapsedSec}s`
              : '生成中'
            : task.status === 'done'
              ? '已完成'
              : '失败';
          const statusClass = running
            ? 'text-indigo-500'
            : task.status === 'done'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-amber-600 dark:text-amber-400';
          return (
            <div key={task.id} className="relative mb-1.5 overflow-hidden rounded-lg border bg-background/60">
              {/* 行尾删除做成整行 button 的兄弟节点：嵌套 button 在 HTML
                  中非法，且点击会冒泡到整行、把任务误展开 */}
              {!open && (
                <button
                  type="button"
                  onClick={() => onRemove(task.id)}
                  title={running ? '取消生成并删除' : '删除记录'}
                  className="absolute right-1.5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  {running ? <Square className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                </button>
              )}

              <button
                type="button"
                onClick={() => setExpanded(open ? '' : task.id)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-accent/40',
                  !open && 'pr-9',
                )}
              >
                {open ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                {running ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500" />
                ) : task.status === 'done' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.docName}</span>
                {/* 折叠态也要看得出结果：原先只有一个含义不明的图标，
                    任务成功与否要展开才知道 */}
                <span className={cn('shrink-0 text-[10px] font-medium', statusClass)}>{statusText}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground/70">
                  {relTime(task.finishedAt || task.createdAt)}
                </span>
              </button>

              {task.error && !open && (
                <div className="px-2.5 pb-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                  {task.error}
                </div>
              )}

              {changeTip && !open && (
                <div className="px-2.5 pb-2 text-[11px] leading-relaxed text-muted-foreground">{changeTip}</div>
              )}

              {open && (
                <div className="space-y-2 border-t px-2.5 py-2">
                  {task.error ? (
                    <div className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{task.error}</span>
                    </div>
                  ) : (
                    <>
                      {/* 改动幅度提示放在结果视图之上：用户展开就是为了看改了什么，
                          先告诉他「几乎没改」比让他自己逐行比对更省事 */}
                      {changeTip && (
                        <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground dark:border-slate-700 dark:bg-slate-800/40">
                          {changeTip}
                        </div>
                      )}

                      {/* 改动摘要：直接列出被删掉与新加的行，比只给一个数字有用得多 */}
                      <DiffSummary task={task} />

                      {/* 推理模型的思考内容单独展示：它解释「模型在想什么」，
                          但绝不能混进正文，否则会污染最终写回的文档 */}
                      {thinkText && (
                        <details className="rounded-md bg-muted/40 px-2 py-1.5">
                          <summary className="cursor-pointer text-[11px] text-muted-foreground">
                            模型思考过程
                          </summary>
                          <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                            {thinkText}
                          </div>
                        </details>
                      )}

                      <div className="flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5">
                        {views.map((v) => (
                          <button
                            key={v.key}
                            type="button"
                            onClick={() => setView(v.key)}
                            className={cn(
                              'flex-1 rounded-md px-2 py-1 text-[11px] transition-colors',
                              view === v.key
                                ? 'bg-background font-medium text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {v.label}
                          </button>
                        ))}
                      </div>

                      {view === 'diff' ? (
                        <div className="flex gap-2">
                          <Pane label="原文" source={task.content} placeholder="无原文" />
                          <Pane
                            label={running ? '生成中' : '润色结果'}
                            source={resultText}
                            placeholder={running ? (waiting ? `模型正在思考，已用时 ${elapsedSec} 秒…` : '等待下一段输出…') : '无内容'}
                            tone={running ? 'pending' : 'result'}
                          />
                        </div>
                      ) : view === 'source' ? (
                        <Pane label="原文" source={task.content} placeholder="无原文" />
                      ) : (
                        <Pane
                          label={running ? '生成中' : '润色结果'}
                          source={resultText}
                          placeholder={running ? (waiting ? `模型正在思考，已用时 ${elapsedSec} 秒…` : '等待下一段输出…') : '无内容'}
                          tone={running ? 'pending' : 'result'}
                        />
                      )}
                    </>
                  )}

                  <div className="flex items-center justify-end gap-1">
                    {task.status === 'done' && (
                      <Button
                        size="sm"
                        className="h-7 bg-indigo-600 text-xs text-white hover:bg-indigo-700"
                        disabled={applyingId === task.id}
                        onClick={() => onApply(task)}
                      >
                        {applyingId === task.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Undo2 className="mr-1 h-3 w-3" />
                        )}
                        应用到文档
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => onRemove(task.id)}
                      title={running ? '取消生成并删除' : '删除记录'}
                    >
                      {running ? <Square className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}