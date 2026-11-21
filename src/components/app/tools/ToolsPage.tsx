import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cable, ChevronRight, Loader2, Network, RefreshCw, Square, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api, type ToolsCatalog } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ChannelSession, ToolCategory } from '../../../../shared/tools';
import type { SkillSummary } from '../../../../shared/skills';

/** 大类的图标：串口是接一根线，网口是走网络 */
const CATEGORY_ICONS: Record<ToolCategory, typeof Cable> = {
  serial: Cable,
  tcp: Network,
};

/** 跑了多久 */
function duration(startedAt: number, stoppedAt?: number): string {
  const seconds = Math.max(0, Math.floor(((stoppedAt ?? Date.now()) - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

/**
 * 工具：**入口页**。
 *
 * 这一页只干三件事：
 *
 * 1. **接入方式**：数据从哪儿进来——点进去定端口、波特率与协议；
 * 2. **正在跑的接入**：谁在跑，怎么打开、怎么停；
 * 3. **再往里看**：协议与能力各去各的页面看。
 *
 * 以前这里还摆着「协议」「解析插件」「文档技能」三块橱窗，看着热闹，
 * 其实是同一件事说了三遍：
 *
 * - 协议与解析插件在「支持的协议」那一页里已经摊得开；
 * - 说明书住在记录区，这儿再抄一份摘要，只是让人多点一次；
 * - 能力平时是跟 AI 助手说的，列在这儿等于把模型的清单再抄一遍。
 *
 * 所以这里只留入口。想细看，点过去看。
 */
export function ToolsPage() {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<ToolsCatalog | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [sessions, setSessions] = useState<ChannelSession[]>([]);
  const [loading, setLoading] = useState(true);
  /** 工具目录读不到时的原因（空串 = 读到了） */
  const [catalogError, setCatalogError] = useState('');
  /** 通道列表读不到时的原因（空串 = 读到了） */
  const [sessionsError, setSessionsError] = useState('');
  /** 能力清单读到没有：读不到时不能拿 0 冒充「一项都没有」 */
  const [skillsLoaded, setSkillsLoaded] = useState(false);

  /** 读工具目录 */
  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      setCatalog(await api.tools.catalog());
      setCatalogError('');
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : '读取工具目录失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /** 读正在跑的通道 */
  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.tools.sessions());
      setSessionsError('');
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : '读不到通道列表');
    }
  }, []);

  /** 读能力清单：只在跳转入口上要个数量 */
  const loadSkills = useCallback(async () => {
    try {
      const result = await api.skills.list();
      setSkills(result.skills);
      setSkillsLoaded(true);
    } catch {
      /* 拿不到就不显示数量，不影响别的 */
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void loadSessions();
    void loadSkills();
  }, [loadCatalog, loadSessions, loadSkills]);

  /** 通道可能是在别的窗口开的，定期刷一下列表 */
  useEffect(() => {
    const timer = setInterval(() => {
      void loadSessions();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadSessions]);

  /** 协议名：会话只带协议 id，名字要从模板里查 */
  const protocolName = useCallback(
    (session: ChannelSession) =>
      catalog?.protocols.find((t) => t.id === session.templateId)?.name ?? session.templateId,
    [catalog],
  );

  /** 工具名 */
  const toolName = useCallback(
    (session: ChannelSession) => catalog?.tools.find((t) => t.id === session.tool)?.name ?? session.tool,
    [catalog],
  );

  /** 停掉一个通道 */
  const handleStop = async (session: ChannelSession) => {
    try {
      await api.tools.stopSession(session.id);
      await loadSessions();
      toast.success(`${session.name} 已停止`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const categories = catalog?.categories ?? [];
  const protocols = catalog?.protocols ?? [];
  const running = sessions.filter((s) => s.status === 'running');
  const stopped = sessions.filter((s) => s.status !== 'running');

  /** 这一类下现在有几个在跑 */
  const runningCount = useCallback(
    (kinds: string[]) => sessions.filter((s) => kinds.includes(s.tool) && s.status === 'running').length,
    [sessions],
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto px-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">工具</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          外部数据从这儿进来：接进来，按协议拆成一条条记录。
        </p>
      </header>

      {/* ① 接入方式：数据从哪儿进来 */}
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[13px] font-medium">接入方式</h2>
        {loading ? (
          <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取工具目录…
          </div>
        ) : catalogError ? (
          <ErrorBox message={catalogError} onRetry={() => void loadCatalog()} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {categories.map((category) => {
              const Icon = CATEGORY_ICONS[category.id] ?? Cable;
              const count = runningCount(category.kinds);
              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => navigate(`/tools/${category.id}`)}
                  className="group flex flex-col gap-2.5 rounded-xl border border-border/70 bg-card/40 p-4 text-left transition-colors hover:border-indigo-500/50 hover:bg-card/70"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-500">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-[14px] font-medium">{category.name}</span>
                    {count ? (
                      <Badge className="ml-auto">{count} 个在跑</Badge>
                    ) : (
                      <Badge variant="secondary" className="ml-auto">
                        空闲
                      </Badge>
                    )}
                  </div>
                  <p className="text-[12px] leading-relaxed text-muted-foreground">{category.summary}</p>
                  <p className="mt-auto text-[11px] text-muted-foreground/80">{category.hint}</p>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ② 正在跑的接入：活的摆在这里 */}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-medium">正在跑的接入</h2>
          <Badge variant={running.length ? 'default' : 'secondary'}>{running.length}</Badge>
        </div>

        {sessionsError ? (
          <ErrorBox message={`读不到通道列表：${sessionsError}`} onRetry={() => void loadSessions()} />
        ) : running.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-[12px] text-muted-foreground">
            现在没有通道在跑。上面挑一个接入方式，进去开一个。
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {running.map((session) => (
              <article
                key={session.id}
                className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-card/40 p-3.5"
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                  <span className="truncate text-[13px] font-medium">{session.name}</span>
                  <Badge variant="outline" className="ml-auto shrink-0">
                    {toolName(session)}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <Badge variant="secondary">{protocolName(session)}</Badge>
                  <span>收 {session.bytesIn} / 发 {session.bytesOut} 字节</span>
                  <span>· {session.recordCount} 条</span>
                  <span>· 已运行 {duration(session.startedAt)}</span>
                </div>
                <div className="mt-auto flex items-center gap-2 pt-1">
                  <Button size="sm" onClick={() => navigate(`/tools/${session.tool}?session=${session.id}`)}>
                    打开控制台
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void handleStop(session)}>
                    <Square className="h-3.5 w-3.5" />
                    停止
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}

        {/* 停掉的：还留着记录，随时能回去看 */}
        {stopped.length ? (
          <details className="rounded-xl border border-border/70 bg-card/20 px-3.5 py-2.5">
            <summary className="cursor-pointer text-[12px] text-muted-foreground">
              已停止的通道（{stopped.length}）
            </summary>
            <div className="mt-2.5 flex flex-col gap-2">
              {stopped.map((session) => (
                <div key={session.id} className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span className="truncate">{session.name}</span>
                  <span>· {protocolName(session)}</span>
                  <span>· {session.recordCount} 条</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-7"
                    onClick={() => navigate(`/tools/${session.tool}?session=${session.id}`)}
                  >
                    看记录
                  </Button>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      {/* ③ 再往里看：只给入口，不在这里摊开 */}
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[13px] font-medium">再往里看</h2>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <JumpCard
            title="支持的协议"
            count={catalogError ? '—' : `${protocols.length} 套`}
            desc="字节按哪一套切帧、按哪一套读"
            onClick={() => navigate('/tools/protocols')}
          />
          <JumpCard
            title="能力清单"
            count={skillsLoaded ? `${skills.length} 项` : '—'}
            desc="接进来之后能干哪些活"
            onClick={() => navigate('/tools/capabilities')}
          />
        </div>
      </section>
    </div>
  );
}

/**
 * 读不到东西时要说清楚。
 *
 * 早先这里把失败当成「空」：读不到通道就摆一句「现在没有通道在跑」，
 * 读不到能力就摆一个「0 项」。看着像「本来就没有」，
 * 实际上是没连上——人于是盯着空页面找原因，越找越没头绪。
 */
function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-rose-500/40 bg-rose-500/5 px-3.5 py-3">
      <span className="flex items-start gap-1.5 text-[12px] leading-relaxed text-rose-600">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{message}</span>
      </span>
      <Button size="sm" variant="outline" className="w-fit" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5" />
        重试
      </Button>
    </div>
  );
}

/**
 * 一个跳转入口：点一下换一页，不在当前页摊开内容。
 *
 * 工具区现在只办事：想看协议就去协议页，想看能力就去能力页。
 * 同一份清单在两处摆着，两处都会过期，也会让人不知道该信哪一处。
 */
function JumpCard({
  title,
  count,
  desc,
  onClick,
}: {
  title: string;
  count: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-1.5 rounded-xl border border-border/70 bg-card/40 p-3.5 text-left transition-colors hover:border-indigo-500/50 hover:bg-card/70"
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{title}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {count}
        </Badge>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{desc}</p>
    </button>
  );
}
