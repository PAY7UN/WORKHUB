import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, FileText, Loader2, Paperclip, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentSource } from '@/lib/api';

/**
 * 检索来源统一用 api.ts 里的那份定义。
 *
 * 之前这里另写了一份，字段比服务端下发的少（没有 kind 与 docId），
 * 于是「这条依据来自附件还是来自正文」这个信息在类型层就被丢掉了，
 * 界面上只能一律画成文档图标——附件依据与正文依据看起来没有区别。
 */
export type { AgentSource };

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 本轮回答的检索来源 */
  sources?: AgentSource[];
  /** 推理模型的思考过程（部分模型才有） */
  reasoning?: string;
  /** 等待模型首个输出 */
  pending?: boolean;
}

interface AgentMessageListProps {
  messages: AgentMessage[];
  loading: boolean;
  isAdmin: boolean;
  onSuggest: (q: string) => void;
}

const SUGGESTIONS = [
  '这些文档的核心内容是什么？请分点总结',
  '文档中提到的风险与待办事项有哪些？',
  '帮我梳理这些文档之间的关联与脉络',
];

/** Agent 对话消息区：空态引导、消息气泡、本轮检索来源 */
export function AgentMessageList({ messages, isAdmin, onSuggest }: AgentMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新消息与流式增量都跟随到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 切换到长对话时定位到最后一条
  useEffect(() => {
    const el = scrollRef.current;
    if (el && messages.length > 0) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin">
      {messages.length === 0 ? (
        <EmptyState onSuggest={onSuggest} />
      ) : (
        <div className="space-y-3 px-4 py-3">
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onSuggest }: { onSuggest: (q: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-6">
      <Sparkles className="h-8 w-8 text-indigo-400" />
      <p className="text-sm font-medium">基于可见文档自动问答</p>
      <p className="text-xs text-muted-foreground leading-relaxed">
        提问后服务端自动检索你有权限查看的文档片段，据此作答并标注来源。
      </p>
      <div className="mt-3 w-full space-y-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggest(s)}
            className="w-full text-left text-xs px-3 py-2 rounded-lg border border-border hover:bg-accent/60 cursor-pointer transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ msg, isAdmin }: { msg: AgentMessage; isAdmin: boolean }) {
  const showSpinner = msg.role === 'assistant' && msg.pending && !msg.content && !msg.reasoning;
  // 正文为空时不再渲染空气泡（模型只返回思考内容或本轮失败）
  const hasBody = showSpinner || !!msg.content;

  return (
    <div className="space-y-1">
      {/* 推理过程：折叠展示，避免长思考刷屏 */}
      {msg.role === 'assistant' && !!msg.reasoning && <ReasoningBlock text={msg.reasoning} />}
      {hasBody && (
        <div className={cn('flex gap-2', msg.role === 'user' && 'justify-end')}>
          {msg.role === 'assistant' && (
            <div className="h-6 w-6 shrink-0 rounded-md bg-indigo-500/90 flex items-center justify-center mt-0.5">
              <Bot className="h-3.5 w-3.5 text-white" />
            </div>
          )}
          <div
            className={cn(
              'max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words',
              msg.role === 'user'
                ? 'bg-indigo-500 text-white'
                : 'bg-white/70 dark:bg-white/5 border border-indigo-100/60 dark:border-indigo-900/40',
            )}
          >
            {showSpinner ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在检索并生成…
              </span>
            ) : (
              msg.content
            )}
          </div>
        </div>
      )}
      {msg.role === 'assistant' && !!msg.sources?.length && !msg.pending && (
        <SourceList sources={msg.sources} note={isAdmin ? '含仅管理员可检索的文档' : undefined} />
      )}
    </div>
  );
}

/** 推理过程折叠块：默认收起，仅展示长度提示 */
function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.trim().replace(/\s+/g, ' ').slice(0, 60);

  return (
    <div className="pl-8">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        思考过程（{text.length} 字）
      </button>
      {open ? (
        <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground scrollbar-thin">
          {text}
        </p>
      ) : (
        <p className="mt-0.5 max-w-[85%] truncate text-[11px] text-muted-foreground/80">{preview}…</p>
      )}
    </div>
  );
}

function SourceList({ sources, note }: { sources: AgentSource[]; note?: string }) {
  return (
    <div className="pl-8">
      <p className="text-[11px] text-muted-foreground mb-1">本轮检索依据{note ? `（${note}）` : ''}：</p>
      <div className="flex flex-wrap gap-1">
        {sources.map((s) => {
          // 附件依据与正文依据要能一眼分出来：图标不同，颜色也不同
          const isAttachment = s.kind === 'attachment';
          return (
            <span
              key={s.id}
              title={s.snippet}
              className={cn(
                'inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border',
                isAttachment
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-100/70 dark:border-emerald-900/50'
                  : 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-300 border-indigo-100/70 dark:border-indigo-900/50',
              )}
            >
              {isAttachment ? <Paperclip className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
              {s.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}
