import { useEffect, useState } from 'react';
import { Sparkles, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useApp } from '@/context/AppContext';
import { toast } from 'sonner';
import { PRESET_INSTRUCTIONS, MAX_RUNNING_POLISH_TASKS, composePolishInstruction } from '../../../shared/polish';

interface PolishDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  docId: string;
  /** 编辑器中的当前正文（含尚未落库的改动） */
  content: string;
  docName: string;
  docType: string;
}

/**
 * 预设按钮列表，取值必须与 shared/polish.ts 的 PRESET_INSTRUCTIONS 一一对应。
 *
 * 只有两个，且都不越出「排版优化 / 精简」这两项：
 * 默认的「排版整理」两项全做；「只精简」是它覆盖不到的方向（压篇幅但不碰版面），
 * 需要时收窄到这一项。曾有的「校对」「结构整理」都是默认预设的子集，单列反而
 * 让人以为这几件事必须三选一；要更细的收窄，写在下面的「你的要求」里即可。
 */
const PRESETS = [
  {
    key: 'polish',
    label: '排版整理',
    hint: '默认：排版优化与精简两项一次做到位——段落拆分归拢、标题与编号规范、整段移动理顺次序、删掉独立成句的套话与完全重复的内容；3 条以上同构的并列内容（命令说明、键值对清单、属性与故障对照）统一建表，有先后依赖的操作步骤保持有序列表。不改写措辞，原文图片原样保留',
  },
  {
    key: 'concise',
    label: '只精简',
    hint: '只删不写：删掉独立成句的套话与口水词、相邻重复的多余词，以及完全重复的段落与条目；不删句子内部的成分，不拆句也不合句。排版优化一律不动，不拆段、不重建表格、不调整段落次序',
  },
] as const;

/**
 * 「你的要求」的快捷模板。
 *
 * 个性化要真正好用，前提是用户不用自己想措辞——「只把参数说明改成表格」这种
 * 需求人人都想得到，但让它写成模型听得懂的一句话却要花心思。模板把常见意图
 * 落成可点击的成品，点一下即写入，比留一个空框等用户自己想更快。
 */
const REQUIREMENT_TEMPLATES: Array<{ label: string; text: string }> = [
  { label: '只改排版', text: '只调整排版（段落、编号、表格），一个字都别删' },
  { label: '只删冗余', text: '只删掉冗余套话与完全重复的内容，版面一律不动' },
  { label: '清单建表', text: '把并列的清单（命令、参数、依赖、选项等）改成表格，除清单外其余部分一律不动' },
  { label: '保留代码块', text: '所有代码块原样保留，只调整标题层级与编号' },
  { label: '只调次序', text: '只把段落移动到更合适的位置，段落内部一个字都不动' },
];

/**
 * 润色任务的提交入口。
 *
 * 这里只负责收集参数并提交任务，不持有任何流式连接：生成在服务端后台推进，
 * 关窗、刷新页面都不会中断。因此「误触关闭导致几十秒工作作废」这一类问题
 * 在结构上就不存在了，任务进度与结果改由 Agent 面板跟踪。
 */
export function PolishDialog({ open, onOpenChange, docId, content, docName, docType }: PolishDialogProps) {
  const { notifyPolishTaskCreated } = useApp();
  // 默认「排版整理」：排版优化与精简两项全做，是一次把版面收拾干净的主入口。
  // 不可写成已删除的 key——PRESET_INSTRUCTIONS[preset] ?? '' 会把失效
  // key 静默兜底为空指令，用户以为选中了某个预设，实际提交时一条改写要求都没有
  const [preset, setPreset] = useState<string>('polish');
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  /**
   * 提交前的并发预检，**仅用于提前提示**。
   *
   * 权威判定在服务端（超限返回 429），这里拉一次列表只是为了让用户不必填完
   * 一整套预设与补充要求才被拒。拉取失败时归零而非沿用上次值：一次网络抖动
   * 不该让人连润色都做不了，而沿用陈旧值会误判成满载、把提交按钮错误地禁掉。
   */
  const [runningCount, setRunningCount] = useState(0);

  useEffect(() => {
    if (open) {
      setError('');
      setInstruction('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRunningCount(0);
    void api
      .listPolishTasks()
      .then((list) => {
        if (alive) setRunningCount(list.filter((t) => t.status === 'running').length);
      })
      .catch(() => {
        /* 拉取失败不阻塞提交，服务端会给出权威拒绝 */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const atCapacity = runningCount >= MAX_RUNNING_POLISH_TASKS;

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError('');

    // 预设指令与用户要求必须合并：PRESET_INSTRUCTIONS 覆盖了全部预设 key，
    // 若写成 A || B 则 B 永远不会被求值，用户填的要求会被静默丢弃且毫无提示。
    // 拼接交给 composePolishInstruction：它给用户要求单独加小标题与优先级声明，
    // 否则两段指令糊成一片，模型只能靠语序去猜哪句才是真正要照做的
    const presetInstruction = PRESET_INSTRUCTIONS[preset] ?? '';
    const combinedInstruction = composePolishInstruction(presetInstruction, instruction);

    try {
      await api.polish({ content, instruction: combinedInstruction, docId, docName, type: docType });
      // 通知 Agent 面板刷新任务列表。本组件与面板没有父子关系，面板持有的列表是
      // 自己的本地副本，不通知它就停在提交前——面板正开着时表现为「提交成功但什么都没有」
      notifyPolishTaskCreated();
      // 提交即离场：结果与进度去 Agent 面板看，不在这里等待。
      // 必须给一句交代：弹窗瞬间消失、生成还要几十秒，没有任何提示时用户无法判断
      // 到底是提交失败还是要去别处看，只能反复点提交
      toast.success('润色任务已提交', { description: '生成在后台进行，完成后可在 Agent 助手的任务列表中查看并应用' });
      onOpenChange(false);
    } catch (e) {
      setError((e as Error)?.message || '润色任务提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 底层的 DialogContent 是 fixed top-[50%] translate-y-[-50%] 居中定位，
          自身没有高度上限与滚动容器。内容比视口高时上下两端都会被裁掉，且滚不动。
          这个弹窗把「高级选项」展开成常驻的「你的要求」后比原来高约 100px，
          矮屏（如 600px 高的笔记本）上底部的「提交润色任务」按钮会正好落在裁切线以下，
          所以必须自己补上高度上限与纵向滚动。 */}
      <DialogContent className="glass-strong sm:max-w-lg border-0 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-500" />
            AI 润色
          </DialogTitle>
          <DialogDescription>
            对「{docName}」提交润色任务。生成在后台进行，可随时关闭本窗口，进度与结果在 Agent 助手中查看。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                title={p.hint}
                onClick={() => setPreset(p.key)}
                className={`cursor-pointer rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  preset === p.key
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300'
                    : 'border-slate-200 text-slate-600 hover:border-indigo-200 hover:text-indigo-600 dark:border-slate-700 dark:text-slate-400'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* 「你的要求」是本弹窗的个性化入口，常驻可见。
              早前把它收在默认折叠的「高级选项」里，理由是「多数任务用不上」——
              但个性化恰恰是用户最想要的能力，折起来等于没有。

              常驻展开原本有两个副作用，现在都已化解：
              ① 「占位、像必填项」——靠「（可選）」标签与一行说明化解；
              ② 「极短的补充要求会被模型当成文档标题输出」——这是提示词拼接时的
                 定界问题，已由 buildPolishMessages 的 <instruction> 包裹解决，
                 与是否折叠无关。 */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="polish-requirement" className="text-xs font-medium">
                你的要求
                <span className="ml-1 font-normal text-muted-foreground/70">（可選）</span>
              </label>
              <span className="text-[11px] text-muted-foreground/70">优先于预设与默认范围</span>
            </div>
            <Textarea
              id="polish-requirement"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={submitting}
              rows={2}
              placeholder="写清楚「做什么」与「不动什么」，例如：把并列的清单改成表格，其余不动"
              className="text-sm"
            />
            <div className="flex flex-wrap gap-1">
              {REQUIREMENT_TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  disabled={submitting}
                  title={t.text}
                  onClick={() => setInstruction((v) => (v.trim() ? `${v.trim()}\n${t.text}` : t.text))}
                  className="cursor-pointer rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 transition-colors hover:border-indigo-200 hover:text-indigo-600 disabled:cursor-not-allowed dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-700 dark:hover:text-indigo-300"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* 满载提示常驻而非复用 error：它是提交前的状态而非本次操作的失败，
              且用户取消其他任务后可能立刻变为可提交，不该和错误一样只出现一次 */}
          {atCapacity && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                已有 {runningCount} 个润色任务正在生成，最多同时支持 {MAX_RUNNING_POLISH_TASKS} 个。
                可在 Agent 助手的任务列表中等待完成，或取消部分任务后再提交。
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !content.trim() || atCapacity}
            title={atCapacity ? `同时最多 ${MAX_RUNNING_POLISH_TASKS} 个润色任务` : undefined}
          >
            {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
            提交润色任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}